import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import {
  checkNames,
  contentDisposition,
  listDirectory,
  listRoots,
  makeDirectory,
  MAX_PAGE,
  openDownload,
  prepareDelete,
  prepareTransfer,
  renameEntry,
  startDelete,
  startTransfer,
  uploadFile,
  uploadLimit,
} from '../services/files.ts';

const folder = z.string().min(1).max(300);
const relPath = z.string().max(8_000);
const flag = z
  .enum(['0', '1', 'true', 'false'])
  .optional()
  .transform((v) => v === '1' || v === 'true');

const listQuery = z.object({
  folder,
  path: relPath.optional(),
  sort: z.enum(['name', 'size', 'type', 'modified']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
  hidden: flag,
  foldersOnly: flag,
});

const transferBody = z.object({
  folder,
  paths: z.array(relPath).min(1),
  destination: relPath,
  conflict: z.enum(['ask', 'keep-both', 'skip']).optional(),
});

export async function fileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/files', async () => listRoots(ctx));

  app.get('/api/files/list', async (req) => listDirectory(ctx, listQuery.parse(req.query)));

  app.post('/api/files/check', async (req) =>
    checkNames(ctx, z.object({ folder, path: relPath, names: z.array(z.string()).max(1_000) }).parse(req.body)),
  );

  app.post('/api/files/mkdir', async (req) =>
    makeDirectory(
      ctx,
      z
        .object({ folder, path: relPath, name: z.string().max(8_000), parents: z.boolean().optional(), conflict: z.enum(['ask', 'keep-both', 'skip']).optional() })
        .parse(req.body),
    ),
  );

  app.post('/api/files/rename', async (req) => renameEntry(ctx, z.object({ folder, path: relPath, newName: z.string().max(1_000) }).parse(req.body)));

  for (const kind of ['move', 'copy'] as const) {
    app.post(`/api/files/${kind}`, async (req) => {
      const plan = await prepareTransfer(ctx, kind, transferBody.parse(req.body));
      if (!plan.items.length) throw new UserError('Nothing to do: every item was skipped.', 409, 'NOTHING_TO_DO');
      return { task: startTransfer(ctx, plan) };
    });
  }

  app.post('/api/files/delete', async (req) => {
    const plan = await prepareDelete(ctx, z.object({ folder, paths: z.array(relPath).min(1) }).parse(req.body));
    return { task: startDelete(ctx, plan) };
  });

  app.get('/api/files/download', async (req, reply) => {
    const dl = await openDownload(ctx, z.object({ folder, path: relPath.min(1) }).parse(req.query));
    // Pass the bytes through, but only finish the response once TrueNAS confirms the job succeeded and
    // exactly the expected number of bytes arrived; otherwise the browser sees a failed download.
    const out = new PassThrough();
    let sent = 0;
    const abort = (err: Error) => {
      dl.stream.destroy();
      out.destroy(err);
    };
    dl.stream.on('data', (chunk: Buffer) => {
      sent += chunk.length;
      if (sent > dl.size) return abort(new Error(`“${dl.name}” changed while it was being downloaded`));
      if (!out.write(chunk)) dl.stream.pause();
    });
    out.on('drain', () => dl.stream.resume());
    out.on('close', () => {
      if (!dl.stream.readableEnded) dl.stream.destroy();
    });
    dl.stream.on('error', abort);
    dl.stream.on('end', () => {
      dl.finished.then(
        (job) => {
          if (job.state === 'SUCCESS' && sent === dl.size) out.end();
          else abort(new Error(`The download of “${dl.name}” failed: ${job.error ?? 'incomplete'}`));
        },
        (err: Error) => abort(err),
      );
    });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(dl.size))
      .header('content-disposition', contentDisposition(dl.name))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'no-store')
      .send(out);
  });

  // Uploads: the raw file is the request body (application/octet-stream), streamed straight to TrueNAS.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    scope.post('/api/files/upload', async (req, reply) => {
      const q = z
        .object({ folder, path: relPath.optional(), name: z.string().min(1).max(8_000), conflict: z.enum(['ask', 'replace', 'keep-both', 'skip']).optional() })
        .parse(req.query);
      const raw: IncomingMessage = req.raw;
      const declared = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
      const max = uploadLimit();
      let received = 0;
      async function* body(): AsyncGenerator<Buffer> {
        // Not destroyed on early exit, so an error answer can still be sent.
        for await (const chunk of raw.iterator({ destroyOnReturn: false })) {
          received += (chunk as Buffer).length;
          if (received > max) throw new UserError('That file is larger than the upload limit.', 413, 'TOO_LARGE');
          yield chunk as Buffer;
        }
        if (!raw.complete) throw new UserError('The upload was interrupted.', 400, 'INTERRUPTED');
      }
      try {
        return await uploadFile(ctx, q, body(), declared !== null && Number.isFinite(declared) ? declared : null);
      } catch (err) {
        // Whatever the browser is still sending isn't wanted: answer and close the connection.
        if (!raw.complete) {
          void reply.header('connection', 'close');
          raw.resume();
        }
        throw err;
      }
    });
  });
}
