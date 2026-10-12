import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrueNasClient } from '@apexos/truenas-client';
import { startMockTrueNas, type MockTrueNas } from '../src/index.ts';
import { failure, setup, type Any } from './helpers.ts';

const BOUNDARY = 'testboundary7MA4YWxkTrZu0gW';

function multipart(data: unknown, file: Buffer): { head: Buffer; tail: Buffer } {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="data"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  return { head, tail: Buffer.from(`\r\n--${BOUNDARY}--\r\n`) };
}

/** POSTs a multipart body to /_upload in uneven chunks (so boundaries straddle network chunks). */
function upload(mock: MockTrueNas, body: Buffer, auth = 'Bearer demo-api-key'): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${mock.baseUrl}/_upload`,
      { method: 'POST', headers: { authorization: auth, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    let offset = 0;
    let step = 7;
    while (offset < body.length) {
      req.write(body.subarray(offset, offset + step));
      offset += step;
      step = step === 7 ? 4093 : step === 4093 ? 31 : 7;
    }
    req.end();
  });
}

async function put(mock: MockTrueNas, client: TrueNasClient, path: string, content: Buffer, options: Any = { append: false }): Promise<Any> {
  const { head, tail } = multipart({ method: 'filesystem.put', params: [path, options] }, content);
  const res = await upload(mock, Buffer.concat([head, content, tail]));
  expect(res.status, res.text).toBe(200);
  const { job_id } = JSON.parse(res.text);
  return client.waitForJob(job_id);
}

function get(mock: MockTrueNas, url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    request(`${mock.baseUrl}${url}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    })
      .on('error', reject)
      .end();
  });
}

async function download(mock: MockTrueNas, client: TrueNasClient, path: string): Promise<{ status: number; body: Buffer; job: Any }> {
  const [jobId, url] = await client.call<[number, string]>('core.download', ['filesystem.get', [path], 'file.bin', false]);
  const res = await get(mock, url);
  return { ...res, job: await client.waitForJob(jobId) };
}

/** Runs a shell line as root through a temporary cron job, like ApexOs's host helper. */
async function sh(client: TrueNasClient, line: string): Promise<{ output: string; ok: boolean }> {
  const cron = await client.call<Any>('cronjob.create', [{ command: line, user: 'root', enabled: false, stdout: false, stderr: false }]);
  const jobId = await client.call<number>('cronjob.run', [cron.id, false]);
  const job = await client.waitForJob(jobId);
  const url = await client.call<string>('core.job_download_logs', [jobId, 'log', true]).catch(() => null);
  const output = url ? await client.downloadText(url) : '';
  await client.call('cronjob.delete', [cron.id]);
  return { output, ok: job.state === 'SUCCESS' };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const names = async (client: TrueNasClient, dir: string) => (await client.call<Any[]>('filesystem.listdir', [dir])).map((e) => e.name);

describe('file tree', () => {
  it('lists seeded files, with child datasets as mountpoint directories', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const docs = await client.call<Any[]>('filesystem.listdir', ['/mnt/HDDs/Documents', [], { order_by: ['name'] }]);
    expect(docs.map((e) => e.name)).toEqual(['Recipes', 'Scans', 'Shopping list.txt', 'Taxes', 'budget-2026.xlsx', 'passport-scan.pdf']);
    expect(docs.find((e) => e.name === 'Scans')).toMatchObject({ type: 'DIRECTORY', is_mountpoint: true });
    expect(docs.find((e) => e.name === 'Taxes')).toMatchObject({ type: 'DIRECTORY', is_mountpoint: false });
    const movie = await client.call<Any>('filesystem.stat', ['/mnt/HDDs/Media/Movies/Sintel (2010)/Sintel (2010).mkv']);
    expect(movie).toMatchObject({ type: 'FILE', size: 2_146_883_901 });
    expect(typeof movie.mtime).toBe('number');
  });

  it('reports symlinks without following them', async () => {
    const { mock, client } = await setup({ scenario: 'configured' });
    mock.state.fs.nodes.push({ path: '/mnt/HDDs/Photos/escape', type: 'SYMLINK', size: 4, mtime: Date.now(), target: '/etc' });
    const entry = (await client.call<Any[]>('filesystem.listdir', ['/mnt/HDDs/Photos', [['name', '=', 'escape']]]))[0];
    expect(entry).toMatchObject({ type: 'SYMLINK', realpath: '/etc' });
    expect(await client.call<Any>('filesystem.stat', ['/mnt/HDDs/Photos/escape'])).toMatchObject({ type: 'SYMLINK', realpath: '/etc' });
  });
});

describe('POST /_upload and core.download', () => {
  it('stores uploads (creating parents, owned by root) and streams them back once', async () => {
    const { mock, client } = await setup({ scenario: 'configured' });
    const text = Buffer.from(`hello ${'x'.repeat(5000)}\n--${BOUNDARY}-not-a-boundary\r\n`);
    const job = await put(mock, client, '/mnt/HDDs/Photos/new/deeper/note.txt', text);
    expect(job.state).toBe('SUCCESS');
    const stat = await client.call<Any>('filesystem.stat', ['/mnt/HDDs/Photos/new/deeper/note.txt']);
    expect(stat).toMatchObject({ type: 'FILE', size: text.length, uid: 0, gid: 0 });
    expect(await client.call<Any>('filesystem.stat', ['/mnt/HDDs/Photos/new'])).toMatchObject({ type: 'DIRECTORY', uid: 0 });

    const [jobId, url] = await client.call<[number, string]>('core.download', ['filesystem.get', ['/mnt/HDDs/Photos/new/deeper/note.txt'], 'note.txt', false]);
    const res = await get(mock, url);
    expect(res.status).toBe(200);
    expect(res.body.equals(text)).toBe(true);
    expect((await client.waitForJob(jobId)).state).toBe('SUCCESS');
    expect((await get(mock, url)).status).toBe(401);
  });

  it('keeps the size and the first bytes of large files', async () => {
    const { mock, client } = await setup({ scenario: 'configured' });
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
    const used = mock.state.datasets.find((d) => d.id === 'HDDs/Photos')!.usedBytes;
    expect((await put(mock, client, '/mnt/HDDs/Photos/big.bin', big)).state).toBe('SUCCESS');
    expect(mock.state.datasets.find((d) => d.id === 'HDDs/Photos')!.usedBytes).toBe(used + big.length);
    const { body } = await download(mock, client, '/mnt/HDDs/Photos/big.bin');
    expect(body.length).toBe(big.length);
    expect(body.subarray(0, 16 * 1024).equals(big.subarray(0, 16 * 1024))).toBe(true);
  });

  it('overwrites silently and appends', async () => {
    const { mock, client } = await setup({ scenario: 'configured' });
    await put(mock, client, '/mnt/HDDs/Documents/Shopping list.txt', Buffer.from('eggs\n'));
    expect((await download(mock, client, '/mnt/HDDs/Documents/Shopping list.txt')).body.toString()).toBe('eggs\n');
    await put(mock, client, '/mnt/HDDs/Documents/Shopping list.txt', Buffer.from('ham\n'), { append: true });
    expect((await download(mock, client, '/mnt/HDDs/Documents/Shopping list.txt')).body.toString()).toBe('eggs\nham\n');
  });

  it('refuses bad requests like the middleware', async () => {
    const { mock, client } = await setup({ scenario: 'configured' });
    const { head, tail } = multipart({ method: 'filesystem.put', params: ['/mnt/HDDs/Photos/x', {}] }, Buffer.from('x'));
    const body = Buffer.concat([head, Buffer.from('x'), tail]);
    expect((await upload(mock, body, 'Bearer wrong')).status).toBe(401);
    expect((await upload(mock, body, '')).status).toBe(401);
    const wrongOrder = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"\r\n\r\nx\r\n--${BOUNDARY}--\r\n`);
    expect((await upload(mock, wrongOrder)).status).toBe(405);
    const other = multipart({ method: 'filesystem.setperm', params: [] }, Buffer.from('x'));
    expect((await upload(mock, Buffer.concat([other.head, Buffer.from('x'), other.tail]))).status).toBe(422);
    // Over the websocket, the pipe methods can't be called directly.
    expect((await failure(client.call('filesystem.put', ['/mnt/HDDs/Photos/x', {}]))).message).toMatch(/_upload/);
    // Writing over a directory fails the job.
    expect((await put(mock, client, '/mnt/HDDs/Photos/2024', Buffer.from('x'))).state).toBe('FAILED');
  });

  it('gives an empty download when the job fails (not a file)', async () => {
    const { mock, client } = await setup({ scenario: 'configured' });
    const res = await download(mock, client, '/mnt/HDDs/Photos/2024');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
    expect(res.job.state).toBe('FAILED');
    expect(res.job.error).toMatch(/is not a file/);
  });

  it('persists uploaded samples in the state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-files-'));
    const stateFile = join(dir, 'state.json');
    try {
      const first = await startMockTrueNas({ jobDelayMs: 0, stateFile, scenario: 'configured' });
      const c1 = new TrueNasClient({ url: first.url, auth: { type: 'apiKey', apiKey: 'demo-api-key' }, pingIntervalMs: 0, reconnect: false });
      await c1.connect();
      await put(first, c1, '/mnt/HDDs/Photos/kept.txt', Buffer.from('still here'));
      await c1.close();
      await first.close();
      const second = await startMockTrueNas({ jobDelayMs: 0, stateFile, scenario: 'configured' });
      const c2 = new TrueNasClient({ url: second.url, auth: { type: 'apiKey', apiKey: 'demo-api-key' }, pingIntervalMs: 0, reconnect: false });
      await c2.connect();
      expect((await download(second, c2, '/mnt/HDDs/Photos/kept.txt')).body.toString()).toBe('still here');
      await c2.close();
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('host mv, cp and rm on the file tree', () => {
  it('renames without clobbering and keeps hostile names literal', async () => {
    const { mock, client } = await setup({ scenario: 'configured' });
    const hostile = `/mnt/HDDs/Documents/a'b; $(touch pwned) "c"`;
    await put(mock, client, hostile, Buffer.from('odd'));
    let res = await sh(client, `/usr/bin/mv -n -T -- ${q(hostile)} ${q('/mnt/HDDs/Documents/plain.txt')}`);
    expect(res.ok).toBe(true);
    expect(await names(client, '/mnt/HDDs/Documents')).toContain('plain.txt');
    expect(await names(client, '/mnt/HDDs/Documents')).not.toContain('pwned');
    // -n never replaces an existing file
    res = await sh(client, `/usr/bin/mv -n -T -- '/mnt/HDDs/Documents/plain.txt' '/mnt/HDDs/Documents/Shopping list.txt'`);
    expect(res.ok).toBe(true);
    expect((await client.call<Any>('filesystem.stat', ['/mnt/HDDs/Documents/plain.txt'])).size).toBe(3);
    // moving a folder into itself
    res = await sh(client, `/usr/bin/mv -n -T -- '/mnt/HDDs/Documents/Taxes' '/mnt/HDDs/Documents/Taxes/inner'`);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('subdirectory of itself');
  });

  it('refuses to move dataset mountpoints and moves across datasets', async () => {
    const { client } = await setup({ scenario: 'configured' });
    let res = await sh(client, `/usr/bin/mv -n -T -- '/mnt/HDDs/Documents/Scans' '/mnt/HDDs/Documents/Scans2'`);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('Device or resource busy');
    res = await sh(client, `/usr/bin/mv -n -t '/mnt/HDDs/Documents/Scans' -- '/mnt/HDDs/Documents/budget-2026.xlsx' '/mnt/HDDs/Documents/passport-scan.pdf'`);
    expect(res.ok).toBe(true);
    expect(await names(client, '/mnt/HDDs/Documents/Scans')).toEqual(expect.arrayContaining(['budget-2026.xlsx', 'passport-scan.pdf']));
  });

  it('copies trees, honouring -n, -x and -r', async () => {
    const { client } = await setup({ scenario: 'configured' });
    let res = await sh(client, `/usr/bin/cp -a -n --reflink=auto -x -T -- '/mnt/HDDs/Documents' '/mnt/HDDs/Photos/Docs copy'`);
    expect(res.ok).toBe(true);
    expect(await names(client, '/mnt/HDDs/Photos/Docs copy')).toEqual(expect.arrayContaining(['Recipes', 'Scans', 'Taxes', 'Shopping list.txt']));
    // -x: the child dataset's mount point is created, its contents are not copied
    expect(await names(client, '/mnt/HDDs/Photos/Docs copy/Scans')).toEqual([]);
    expect(await names(client, '/mnt/HDDs/Photos/Docs copy/Recipes')).toEqual(['Pancakes.txt', 'Tomato soup.txt']);
    res = await sh(client, `/usr/bin/cp -- '/mnt/HDDs/Documents/Taxes' '/mnt/HDDs/Photos/Taxes'`);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('-r not specified');
    res = await sh(client, `/usr/bin/cp -a -T -- '/mnt/HDDs/Documents/Taxes' '/mnt/HDDs/Documents/Taxes/again'`);
    expect(res.output).toContain('into itself');
  });

  it('removes trees but stops at other datasets with --one-file-system', async () => {
    const { client } = await setup({ scenario: 'configured' });
    let res = await sh(client, `/usr/bin/rm -r --one-file-system -- '/mnt/HDDs/Documents/Recipes' '/mnt/HDDs/Documents/budget-2026.xlsx'`);
    expect(res.ok).toBe(true);
    expect(await names(client, '/mnt/HDDs/Documents')).not.toContain('Recipes');
    res = await sh(client, `/usr/bin/rm -- '/mnt/HDDs/Documents/Taxes'`);
    expect(res.output).toContain('Is a directory');
    res = await sh(client, `/usr/bin/rm -r --one-file-system -- '/mnt/HDDs/Documents'`);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("skipping '/mnt/HDDs/Documents/Scans'");
    expect(await names(client, '/mnt/HDDs/Documents/Scans')).toHaveLength(2);
    // Without the guard, rm descends into the child dataset (which is why ApexOs refuses mountpoints up front).
    res = await sh(client, `/usr/bin/rm -r -- '/mnt/HDDs/Documents/Scans'`);
    expect(res.output).toContain('Device or resource busy');
    expect(await names(client, '/mnt/HDDs/Documents/Scans')).toEqual([]);
  });
});

describe('locked datasets', () => {
  it('hide their contents and refuse writes', async () => {
    const { mock, client } = await setup({ scenario: 'configured' });
    // A passphrase encryption root whose key isn't loaded (see src/encryption.ts).
    mock.state.datasets.find((d) => d.id === 'HDDs/Photos')!.encryption = {
      keyFormat: 'PASSPHRASE',
      algorithm: 'AES-256-GCM',
      pbkdf2iters: 350000,
      secret: 'correct horse battery staple',
      keyLoaded: false,
      keylocation: 'prompt',
    };
    expect(await client.call('filesystem.listdir', ['/mnt/HDDs/Photos'])).toEqual([]);
    expect((await failure(client.call('filesystem.stat', ['/mnt/HDDs/Photos/2024']))).errname).toBe('ENOENT');
    const job = await put(mock, client, '/mnt/HDDs/Photos/x.txt', Buffer.from('x'));
    expect(job.state).toBe('FAILED');
    expect(job.error).toMatch(/locked dataset/);
    expect((await download(mock, client, '/mnt/HDDs/Photos/IMG_4821.HEIC')).job.state).toBe('FAILED');
    expect((await sh(client, `/usr/bin/rm -r -- '/mnt/HDDs/Photos/2024'`)).ok).toBe(false);
  });
});
