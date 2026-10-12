/**
 * Downloads: `core.download` for jobs that write to an output pipe (e.g. `pool.dataset.export_keys`), job
 * logs from `core.job_download_logs`, and the `GET /_download/<job>?auth_token=…` endpoint serving both.
 *
 * Like the middleware (`service/core_service.py`, `apps/file_app.py`): tokens are single-use with a 300 s
 * TTL, the download window is 60 s (3600 s when `buffered`), the response is `application/octet-stream`
 * with the caller's filename, and a job that fails still answers 200 with whatever it wrote, so callers must
 * check the job state afterwards.
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Mock } from './context.ts';
import { callError, type JobControl } from './rpc.ts';

/** The output pipe a downloadable job writes to (null when the method was called directly). */
export interface OutputPipe {
  write(text: string): void;
}

export type DownloadableJobHandler = (params: unknown[], job: JobControl, output: OutputPipe | null) => Promise<unknown>;

interface Downloadable {
  handler: DownloadableJobHandler;
}

/** A download whose job streams straight into the HTTP response (e.g. `filesystem.get`). */
export type StreamingDownload = (params: unknown[], filename: string, windowMs: number) => { jobId: number; serve: (res: ServerResponse) => void };

const registries = new WeakMap<Mock, Map<string, Downloadable>>();
const streaming = new WeakMap<Mock, Map<string, StreamingDownload>>();

/** Registers a method whose `core.download` output is streamed to the `/_download` response as it is produced. */
export function registerStreamingDownload(mock: Mock, name: string, start: StreamingDownload): void {
  let reg = streaming.get(mock);
  if (!reg) {
    reg = new Map();
    streaming.set(mock, reg);
  }
  reg.set(name, start);
}

function registry(mock: Mock): Map<string, Downloadable> {
  let reg = registries.get(mock);
  if (!reg) {
    reg = new Map();
    registries.set(mock, reg);
  }
  return reg;
}

/**
 * Registers a job method with an output pipe. With `checkPipes` (the middleware default) calling it directly
 * fails with "Pipe 'output' is not open"; otherwise the handler runs with `output = null` and decides.
 */
export function registerDownloadableJob(mock: Mock, name: string, handler: DownloadableJobHandler, opts: { checkPipes: boolean }): void {
  registry(mock).set(name, { handler });
  mock.server.job(
    name,
    (params, job) => handler(params, job, null),
    opts.checkPipes
      ? () => {
          throw callError('EFAULT', "Pipe 'output' is not open");
        }
      : undefined,
  );
}

/** A single-use download grant for `/_download/<jobId>`. */
export function grantDownload(mock: Mock, jobId: number, opts: { buffered: boolean; filename?: string }): string {
  const token = randomBytes(16).toString('hex');
  mock.downloads.set(token, { jobId, expires: Date.now() + (opts.buffered ? 3_600_000 : 60_000), filename: opts.filename });
  return token;
}

export function registerDownloads(mock: Mock): void {
  const { server } = mock;

  server.method('core.download', (p) => {
    const [method, args, filename, buffered] = p;
    if (typeof method !== 'string' || !method) throw callError('EINVAL', 'core.download: method must be a string');
    if (!Array.isArray(args)) throw callError('EINVAL', 'core.download: args must be a list');
    if (typeof filename !== 'string') throw callError('EINVAL', 'core.download: filename must be a string');
    const stream = streaming.get(mock)?.get(method);
    if (stream) {
      const windowMs = buffered === true ? 3_600_000 : 60_000;
      const { jobId, serve } = stream(args, filename, windowMs);
      const token = randomBytes(16).toString('hex');
      mock.downloads.set(token, { jobId, expires: Date.now() + windowMs, filename, serve });
      return [jobId, `/_download/${jobId}?auth_token=${token}`];
    }
    const entry = registry(mock).get(method);
    if (!entry) {
      if (server.listMethods().some((m) => m.name === method)) throw callError('EINVAL', `${method} does not produce a download`);
      throw callError('ENOENT', `Method ${method} not found`);
    }
    const out = { text: '' };
    const jobId = server.startJob(method, args, (params, job) => entry.handler(params, job, { write: (t) => void (out.text += t) }));
    mock.downloadOutputs.set(jobId, out);
    const token = grantDownload(mock, jobId, { buffered: buffered === true, filename });
    return [jobId, `/_download/${jobId}?auth_token=${token}`];
  });

  server.httpRoute('/_download/', (_req, res, url) => {
    const id = Number(url.pathname.split('/')[2]);
    const token = url.searchParams.get('auth_token') ?? '';
    const grant = mock.downloads.get(token);
    if (!grant) return void res.writeHead(401, { 'content-type': 'text/plain' }).end('Invalid token');
    mock.downloads.delete(token);
    if (grant.jobId !== id) return void res.writeHead(401, { 'content-type': 'text/plain' }).end('Invalid token');
    if (!server.getJob(id)) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    if (grant.expires < Date.now()) return void res.writeHead(410, { 'content-type': 'text/plain' }).end('Download window expired');
    if (grant.serve) return grant.serve(res);
    const output = mock.downloadOutputs.get(id);
    if (output) {
      // The pipe is read until the job closes it; a failed job just ends the stream early.
      void server.waitJob(id).then(() => {
        mock.downloadOutputs.delete(id);
        res
          .writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${grant.filename ?? `${id}`}"` })
          .end(output.text);
      });
      return;
    }
    const text = server.jobLogs.get(id);
    if (text === undefined) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${grant.filename ?? `${id}.log`}"` }).end(text);
  });
}
