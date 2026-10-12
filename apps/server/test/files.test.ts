/**
 * File browser against the simulated TrueNAS: listing, transfers, uploads and downloads, and every
 * safety refusal (folder roots, escapes, symlinks, snapshots, child datasets, unlisted folders, names).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { FileCheckResponse, FileEntry, FileListing, FileRootsResponse, FileUploadResponse, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { TrueNasClient, type UploadOptions } from '@apexos/truenas-client';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands, type HostBinary } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { asciiName, contentDisposition, nameProblem, numberedName, splitPath } from '../src/services/files.ts';

let mock: MockTrueNas;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let cookie = '';
let port = 0;
const hostCalls: Array<{ binary: HostBinary; args: string[] }> = [];

type ErrorBody = { error: { code: string; message: string; fields?: Record<string, string> } };

async function call<T>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T) };
}

async function ok<T>(method: string, url: string, payload?: unknown): Promise<T> {
  const res = await call<T>(method, url, payload);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function refused(method: string, url: string, payload?: unknown): Promise<{ status: number; code: string; message: string }> {
  const res = await call<ErrorBody>(method, url, payload);
  if (res.status < 400) throw new Error(`${method} ${url} should have been refused: ${JSON.stringify(res.body)}`);
  return { status: res.status, code: res.body.error.code, message: res.body.error.message };
}

async function settled(started: { task: Task }): Promise<Task> {
  for (let i = 0; i < 2000; i++) {
    const t = ctx.tasks.get(started.task.id)!;
    if (t.status !== 'running') return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Task did not finish');
}

async function done(started: { task: Task }): Promise<Task> {
  const t = await settled(started);
  if (t.status !== 'success') throw new Error(`Task "${t.title}" failed: ${t.error}`);
  return t;
}

const qs = (o: Record<string, string | number | boolean>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const list = (folder: string, path = '', extra: Record<string, string | number> = {}) => ok<FileListing>('GET', `/api/files/list?${qs({ folder, path, ...extra })}`);
const names = async (folder: string, path = '') => (await list(folder, path, { limit: 1000 })).entries.map((e) => e.name);
const exists = (path: string) => mock.state.fs.nodes.some((n) => n.path === path);

/** Uploads over a real HTTP connection, writing the body in pieces (optionally waiting between them). */
function upload(
  query: Record<string, string>,
  pieces: Buffer[],
  opts: { between?: () => Promise<void>; abortAfter?: number } = {},
): Promise<{ status: number; body: FileUploadResponse & Partial<ErrorBody> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: 'POST', path: `/api/files/upload?${qs(query)}`, headers: { cookie, 'content-type': 'application/octet-stream' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
      },
    );
    req.on('error', (err) => (opts.abortAfter !== undefined ? resolve({ status: 0, body: {} as never }) : reject(err)));
    void (async () => {
      for (let i = 0; i < pieces.length; i++) {
        if (opts.abortAfter !== undefined && i === opts.abortAfter) {
          req.destroy();
          return;
        }
        req.write(pieces[i]);
        if (i === 0 && opts.between) await opts.between();
      }
      req.end();
    })();
  });
}

function download(folder: string, path: string): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: `/api/files/download?${qs({ folder, path })}`, headers: { cookie } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    })
      .on('error', reject)
      .end();
  });
}

function pattern(size: number, seed = 7): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * seed + (i >> 8)) % 251;
  return b;
}

function addFiles(dir: string, count: number, size = 1000): void {
  const now = Date.now();
  for (let i = 0; i < count; i++) mock.state.fs.nodes.push({ path: `${dir}/file-${String(i).padStart(4, '0')}.bin`, type: 'FILE', size, mtime: now - i * 1000 });
}

beforeAll(async () => {
  mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key', scenario: 'configured' });
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-files-test-'));
  const store = new StateStore(dataDir);
  await store.load();
  const truenas = new TrueNasManager();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
  const host = new HostCommands(truenas);
  const run = host.run.bind(host);
  host.run = (binary, args, opts) => {
    hostCalls.push({ binary, args });
    return run(binary, args, opts);
  };
  ctx = { store, truenas, tasks: new TaskManager(), bus: new Bus(), host, scripts: new Map(), demo: true };
  app = await buildApp(ctx);
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'correct-horse' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  // Every host command ApexOs ran used an allow-listed binary, ended its options with `--`, and only
  // passed absolute paths inside a folder after it.
  expect(hostCalls.length).toBeGreaterThan(10);
  for (const { binary, args } of hostCalls) {
    expect(['mv', 'cp', 'rm']).toContain(binary);
    const end = args.indexOf('--');
    expect(end, args.join(' ')).toBeGreaterThanOrEqual(0);
    for (const p of args.slice(end + 1)) expect(p, args.join(' ')).toMatch(/^\/mnt\/HDDs\/(Documents|Photos|Media)\/./);
  }
});

describe('names and paths (pure)', () => {
  it('validates names and relative paths', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\nb', 'a\u0000b', 'a\rb', '\u2028', '.zfs', '.ZFS', 'x'.repeat(256)]) expect(nameProblem(bad), JSON.stringify(bad)).not.toBeNull();
    for (const good of ['a', 'it’s', `a'b; $(rm -rf ~) "c" | & > <`, '.hidden', 'Café', '-rf', '--', 'é'.repeat(127)]) expect(nameProblem(good), good).toBeNull();
    expect(nameProblem(' padded ', true)).not.toBeNull();
    expect(splitPath('')).toEqual([]);
    expect(splitPath('a/b c/d')).toEqual(['a', 'b c', 'd']);
    for (const bad of ['/etc', '../x', 'a/../../b', 'a//b', 'a/./b', 'a/', '.zfs/snapshot', 'a/.ZFS', 'a\n/b']) expect(() => splitPath(bad), bad).toThrow();
  });

  it('builds numbered names and safe download headers', () => {
    expect(numberedName('photo.jpg', 1)).toBe('photo (1).jpg');
    expect(numberedName('archive.tar.gz', 2)).toBe('archive.tar (2).gz');
    expect(numberedName('.bashrc', 1)).toBe('.bashrc (1)');
    expect(numberedName('My.Folder', 1, true)).toBe('My.Folder (1)');
    expect(asciiName('Café "menu";.txt')).toBe('Caf_ _menu__.txt');
    expect(contentDisposition("Café (1)'s.txt")).toBe(`attachment; filename="Caf_ (1)'s.txt"; filename*=UTF-8''Caf%C3%A9%20%281%29%27s.txt`);
  });
});

describe('browsing', () => {
  it('lists the folders ApexOs knows, with their lock state', async () => {
    const roots = await ok<FileRootsResponse>('GET', '/api/files');
    expect(roots.folders.map((f) => f.name)).toEqual(['Applications', 'Documents', 'Media', 'Photos']);
    expect(roots.folders.every((f) => !f.locked)).toBe(true);
    expect(roots.uploadMaxBytes).toBeGreaterThan(1024 ** 3);
  });

  it('lists folders first, sorts, paginates and dates only what it returns', async () => {
    const root = await list('Documents');
    expect(root.entries.map((e) => e.name)).toEqual(['Recipes', 'Scans', 'Taxes', 'budget-2026.xlsx', 'passport-scan.pdf', 'Shopping list.txt']);
    expect(root.entries.find((e) => e.name === 'Scans')).toMatchObject({ type: 'folder', separate: true, size: null });
    expect(root.entries.find((e) => e.name === 'Taxes')).toMatchObject({ type: 'folder', separate: false });
    expect(root.entries.find((e) => e.name === 'passport-scan.pdf')).toMatchObject({ type: 'file', size: 1_204_331, path: 'passport-scan.pdf' });
    expect(root.entries.every((e) => typeof e.modified === 'string')).toBe(true);
    expect(root.separate).toBe(false);

    const bySize = await list('Documents', '', { sort: 'size', order: 'desc' });
    expect(bySize.entries.map((e) => e.name)).toEqual(['Taxes', 'Scans', 'Recipes', 'passport-scan.pdf', 'budget-2026.xlsx', 'Shopping list.txt']);
    const byDate = await list('Documents', 'Taxes', { sort: 'modified' });
    expect(byDate.entries.map((e) => e.name)).toEqual(['2024 return.pdf', '2025 return.pdf']);
    const byType = await list('Media', 'Music/Field Recordings', { sort: 'type' });
    expect(byType.entries.map((e) => e.name)).toEqual(['01 Morning Birds.flac', '02 Rain on the Roof.flac', '03 Harbour.flac', 'cover.jpg']);

    const page1 = await list('Documents', '', { limit: 2 });
    const page2 = await list('Documents', '', { limit: 2, offset: 2 });
    expect(page1).toMatchObject({ total: 6, offset: 0, limit: 2 });
    expect([...page1.entries, ...page2.entries].map((e) => e.name)).toEqual(root.entries.slice(0, 4).map((e) => e.name));
    expect((await list('Documents', 'Scans')).separate).toBe(true);
  });

  it('hides dotfiles unless asked and handles big directories', async () => {
    mock.state.fs.nodes.push({ path: '/mnt/HDDs/Documents/Taxes/.DS_Store', type: 'FILE', size: 6148, mtime: Date.now() });
    expect(await names('Documents', 'Taxes')).not.toContain('.DS_Store');
    const withHidden = await list('Documents', 'Taxes', { hidden: 1 });
    expect(withHidden.entries.find((e) => e.name === '.DS_Store')).toMatchObject({ hidden: true });

    mock.state.fs.nodes.push({ path: '/mnt/HDDs/Photos/Bulk', type: 'DIRECTORY', size: 2, mtime: Date.now() });
    addFiles('/mnt/HDDs/Photos/Bulk', 2100);
    const big = await list('Photos', 'Bulk', { sort: 'modified', limit: 50, offset: 100 });
    expect(big).toMatchObject({ total: 2100, sortFallback: true, truncated: false });
    expect(big.entries).toHaveLength(50);
    expect(big.entries[0]!.name).toBe('file-0100.bin');
    expect(big.entries.every((e) => e.modified)).toBe(true);
    const folders = await list('Photos', '', { foldersOnly: 1 });
    expect(folders.entries.every((e) => e.type === 'folder')).toBe(true);
  });
});

describe('new folder and rename', () => {
  it('creates folders, refuses taken names, keeps both on request and creates parents', async () => {
    const made = await ok<FileEntry>('POST', '/api/files/mkdir', { folder: 'Documents', path: 'Taxes', name: 'Receipts' });
    expect(made).toMatchObject({ name: 'Receipts', path: 'Taxes/Receipts', type: 'folder' });
    expect(await refused('POST', '/api/files/mkdir', { folder: 'Documents', path: 'Taxes', name: 'Receipts' })).toMatchObject({ status: 409, code: 'EXISTS' });
    const both = await ok<FileEntry>('POST', '/api/files/mkdir', { folder: 'Documents', path: 'Taxes', name: 'Receipts', conflict: 'keep-both' });
    expect(both.name).toBe('Receipts (1)');
    const deep = await ok<FileEntry>('POST', '/api/files/mkdir', { folder: 'Documents', path: 'Taxes', name: 'Receipts/2026/Q3', parents: true });
    expect(deep.path).toBe('Taxes/Receipts/2026/Q3');
  });

  it('renames without replacing anything', async () => {
    const entry = await ok<FileEntry>('POST', '/api/files/rename', { folder: 'Documents', path: 'Taxes/2024 return.pdf', newName: '2024 tax return.pdf' });
    expect(entry).toMatchObject({ name: '2024 tax return.pdf', path: 'Taxes/2024 tax return.pdf', type: 'file', size: 402_118 });
    expect(await names('Documents', 'Taxes')).toEqual(expect.arrayContaining(['2024 tax return.pdf']));
    const taken = await refused('POST', '/api/files/rename', { folder: 'Documents', path: 'Taxes/2024 tax return.pdf', newName: '2025 return.pdf' });
    expect(taken).toMatchObject({ status: 409, code: 'EXISTS' });
    expect(exists('/mnt/HDDs/Documents/Taxes/2024 tax return.pdf')).toBe(true);
    const gone = await refused('POST', '/api/files/rename', { folder: 'Documents', path: 'Taxes/2024 return.pdf', newName: 'x.pdf' });
    expect(gone).toMatchObject({ status: 409, code: 'STALE' });
  });
});

describe('uploads and downloads', () => {
  it('streams an upload to TrueNAS while it is still arriving, and downloads it again', async () => {
    const content = pattern(6 * 1024 * 1024 + 123);
    const pieces = [content.subarray(0, 100_000), content.subarray(100_000, 3_000_000), content.subarray(3_000_000)];
    // Hold back the rest of the body until the first bytes have reached TrueNAS: proves nothing is buffered first.
    let firstChunkSeen = false;
    const original = TrueNasClient.prototype.uploadStream;
    TrueNasClient.prototype.uploadStream = function (this: TrueNasClient, opts: UploadOptions) {
      const body = opts.body;
      return original.call(this, {
        ...opts,
        body: (async function* () {
          for await (const chunk of body) {
            firstChunkSeen = true;
            yield chunk;
          }
        })(),
      });
    };
    try {
      const res = await upload({ folder: 'Photos', path: '2026', name: 'big.bin' }, pieces, {
        between: async () => {
          for (let i = 0; i < 400 && !firstChunkSeen; i++) await new Promise((r) => setTimeout(r, 5));
          expect(firstChunkSeen).toBe(true);
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ action: 'created', entry: { name: 'big.bin', path: '2026/big.bin', size: content.length, type: 'file' } });
    } finally {
      TrueNasClient.prototype.uploadStream = original;
    }
    const dl = await download('Photos', '2026/big.bin');
    expect(dl.status).toBe(200);
    expect(dl.headers['content-length']).toBe(String(content.length));
    expect(dl.body.length).toBe(content.length);
    expect(dl.body.subarray(0, 16 * 1024).equals(content.subarray(0, 16 * 1024))).toBe(true);
  });

  it('round-trips small files exactly, with safe download headers', async () => {
    const text = Buffer.from('Soup of the day: tomato\n');
    const res = await upload({ folder: 'Documents', path: 'Recipes', name: 'Café menu.txt' }, [text]);
    expect(res.status).toBe(200);
    const dl = await download('Documents', 'Recipes/Café menu.txt');
    expect(dl.body.equals(text)).toBe(true);
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="Caf_ menu.txt"; filename*=UTF-8''Caf%C3%A9%20menu.txt`);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect((await refused('GET', `/api/files/download?${qs({ folder: 'Documents', path: 'Recipes' })}`)).code).toBe('NOT_A_FILE');
  });

  it('never overwrites silently: asks, then replaces, keeps both or skips', async () => {
    const q = { folder: 'Documents', path: '', name: 'Shopping list.txt' };
    const check = await ok<FileCheckResponse>('POST', '/api/files/check', { folder: 'Documents', path: '', names: ['Shopping list.txt', 'new.txt', 'bad\nname'] });
    expect(check.existing).toEqual([{ name: 'Shopping list.txt', type: 'file' }]);
    expect(check.invalid.map((i) => i.name)).toEqual(['bad\nname']);

    const asked = await upload(q, [Buffer.from('replacement\n')]);
    expect(asked.status).toBe(409);
    expect(asked.body.error?.code).toBe('CONFLICT');
    expect((await download('Documents', 'Shopping list.txt')).body.toString()).toBe('Milk\nBread\nCoffee\nBatteries (AA)\n');

    const kept = await upload({ ...q, conflict: 'keep-both' }, [Buffer.from('second list\n')]);
    expect(kept.body).toMatchObject({ action: 'renamed', entry: { name: 'Shopping list (1).txt' } });
    const skipped = await upload({ ...q, conflict: 'skip' }, [Buffer.from('ignored\n')]);
    expect(skipped.body.action).toBe('skipped');
    mock.state.fs.owners['/mnt/HDDs/Documents/Shopping list.txt'] = { uid: 3000, gid: 3000, mode: 0o770 };
    const replaced = await upload({ ...q, conflict: 'replace' }, [Buffer.from('replacement\n')]);
    expect(replaced.body).toMatchObject({ action: 'replaced', entry: { name: 'Shopping list.txt', size: 12 } });
    expect((await download('Documents', 'Shopping list.txt')).body.toString()).toBe('replacement\n');
    // The replaced file keeps its owner, and no temporary file is left behind.
    expect(mock.state.fs.owners['/mnt/HDDs/Documents/Shopping list.txt']).toMatchObject({ uid: 3000, gid: 3000 });
    expect(mock.state.fs.nodes.filter((n) => n.path.includes('.apexos-upload-'))).toEqual([]);
  });

  it('recreates folder structure and gives new files the folder’s owner', async () => {
    const alice = mock.state.users.find((u) => u.username === 'alice')!;
    mock.state.fs.owners['/mnt/HDDs/Photos/2025'] = { uid: alice.uid, gid: alice.uid, mode: 0o770 };
    const res = await upload({ folder: 'Photos', path: '2025', name: 'Trip/Day 1/IMG_1.jpg' }, [pattern(5000)]);
    expect(res.body).toMatchObject({ action: 'created', entry: { path: '2025/Trip/Day 1/IMG_1.jpg' } });
    expect(await names('Photos', '2025/Trip')).toEqual(['Day 1']);
    // filesystem.put creates root-owned files; ApexOs hands them to the folder's owner.
    const stat = await ctx.truenas.client().call<{ uid: number }>('filesystem.stat', ['/mnt/HDDs/Photos/2025/Trip/Day 1/IMG_1.jpg']);
    expect(stat.uid).toBe(alice.uid);
  });

  it('cleans up after an interrupted upload and enforces the size limit', async () => {
    const res = await upload({ folder: 'Photos', path: '', name: 'partial.bin' }, [pattern(200_000), pattern(200_000), pattern(10)], {
      abortAfter: 2,
      between: async () => new Promise((r) => setTimeout(r, 50)),
    });
    expect(res.status).toBe(0);
    for (let i = 0; i < 200 && exists('/mnt/HDDs/Photos/partial.bin'); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    expect(exists('/mnt/HDDs/Photos/partial.bin')).toBe(false);

    process.env.APEXOS_UPLOAD_MAX_BYTES = '1000';
    try {
      const tooBig = await upload({ folder: 'Photos', path: '', name: 'huge.bin' }, [pattern(2000)]);
      expect(tooBig.status).toBe(413);
      expect(exists('/mnt/HDDs/Photos/huge.bin')).toBe(false);
    } finally {
      delete process.env.APEXOS_UPLOAD_MAX_BYTES;
    }
  });
});

describe('move, copy and delete', () => {
  it('moves items, asking about conflicts and keeping both on request', async () => {
    await upload({ folder: 'Documents', path: '', name: 'move-a.txt' }, [Buffer.from('a')]);
    await upload({ folder: 'Documents', path: '', name: 'move-b.txt' }, [Buffer.from('b')]);
    await done(await ok('POST', '/api/files/move', { folder: 'Documents', paths: ['move-a.txt', 'move-b.txt'], destination: 'Taxes' }));
    expect(await names('Documents', 'Taxes')).toEqual(expect.arrayContaining(['move-a.txt', 'move-b.txt']));
    expect(exists('/mnt/HDDs/Documents/move-a.txt')).toBe(false);

    await upload({ folder: 'Documents', path: '', name: 'move-a.txt' }, [Buffer.from('a2')]);
    const conflict = await refused('POST', '/api/files/move', { folder: 'Documents', paths: ['move-a.txt'], destination: 'Taxes' });
    expect(conflict).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(conflict.message).toContain('move-a.txt');
    await done(await ok('POST', '/api/files/move', { folder: 'Documents', paths: ['move-a.txt'], destination: 'Taxes', conflict: 'keep-both' }));
    expect((await download('Documents', 'Taxes/move-a (1).txt')).body.toString()).toBe('a2');
    expect((await download('Documents', 'Taxes/move-a.txt')).body.toString()).toBe('a');
    expect(await refused('POST', '/api/files/move', { folder: 'Documents', paths: ['Taxes/move-b.txt'], destination: 'Taxes' })).toMatchObject({ code: 'SAME_PLACE' });
  });

  it('copies folders, duplicates in place and never into themselves', async () => {
    await done(await ok('POST', '/api/files/copy', { folder: 'Documents', paths: ['Recipes'], destination: 'Taxes' }));
    expect(await names('Documents', 'Taxes/Recipes')).toEqual(expect.arrayContaining(['Pancakes.txt', 'Tomato soup.txt']));
    expect(await names('Documents', 'Recipes')).toEqual(expect.arrayContaining(['Pancakes.txt']));
    await done(await ok('POST', '/api/files/copy', { folder: 'Documents', paths: ['Recipes'], destination: '', conflict: 'keep-both' }));
    expect(await names('Documents')).toEqual(expect.arrayContaining(['Recipes', 'Recipes (1)']));
    const skip = await ok<{ task: Task }>('POST', '/api/files/copy', { folder: 'Documents', paths: ['Recipes', 'Taxes/move-b.txt'], destination: '', conflict: 'skip' });
    await done(skip);
    expect(await refused('POST', '/api/files/copy', { folder: 'Documents', paths: ['Recipes'], destination: 'Recipes' })).toMatchObject({ code: 'INTO_ITSELF' });
    expect(await refused('POST', '/api/files/move', { folder: 'Documents', paths: ['Taxes'], destination: 'Taxes/Receipts' })).toMatchObject({ code: 'INTO_ITSELF' });
  });

  it('deletes items (no trash) and refuses stale selections', async () => {
    await done(await ok('POST', '/api/files/delete', { folder: 'Documents', paths: ['Recipes (1)', 'Taxes/move-b.txt'] }));
    expect(await names('Documents')).not.toContain('Recipes (1)');
    expect(exists('/mnt/HDDs/Documents/Recipes (1)/Pancakes.txt')).toBe(false);
    expect(await refused('POST', '/api/files/delete', { folder: 'Documents', paths: ['Taxes/move-b.txt'] })).toMatchObject({ status: 409, code: 'STALE' });
  });

  it('runs large operations as tasks that report progress', async () => {
    mock.state.fs.nodes.push(
      { path: '/mnt/HDDs/Photos/Many', type: 'DIRECTORY', size: 2, mtime: Date.now() },
      { path: '/mnt/HDDs/Photos/Many copies', type: 'DIRECTORY', size: 2, mtime: Date.now() },
    );
    addFiles('/mnt/HDDs/Photos/Many', 120, 5_000_000);
    const paths = (await list('Photos', 'Many', { limit: 1000 })).entries.map((e) => e.path);
    const progress: number[] = [];
    const onTask = (t: Task) => {
      if (t.type === 'files-copy' && t.status === 'running') progress.push(t.progress);
    };
    ctx.tasks.on('task', onTask);
    const started = await ok<{ task: Task }>('POST', '/api/files/copy', { folder: 'Photos', paths, destination: 'Many copies' });
    expect(started.task).toMatchObject({ type: 'files-copy', ref: 'Photos', title: 'Copying 120 items to Many copies' });
    const finished = await done(started);
    ctx.tasks.off('task', onTask);
    expect(finished.progress).toBe(100);
    const steps = [...new Set(progress)].filter((p) => p > 0 && p < 100);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(await names('Photos', 'Many copies')).toHaveLength(120);
    // 120 items in batches: a handful of host commands, not one per file.
    const cps = hostCalls.filter((c) => c.binary === 'cp' && c.args.includes('/mnt/HDDs/Photos/Many copies'));
    expect(cps.length).toBe(3);

    const del = await done(await ok('POST', '/api/files/delete', { folder: 'Photos', paths: ['Many', 'Many copies'] }));
    expect(del.status).toBe('success');
    expect(mock.state.fs.nodes.some((n) => n.path.startsWith('/mnt/HDDs/Photos/Many'))).toBe(false);
  });
});

describe('safety refusals', () => {
  it('never touches a folder root', async () => {
    expect(await refused('POST', '/api/files/rename', { folder: 'Documents', path: '', newName: 'Docs' })).toMatchObject({ code: 'PROTECTED' });
    expect(await refused('POST', '/api/files/delete', { folder: 'Documents', paths: [''] })).toMatchObject({ code: 'PROTECTED' });
    expect(await refused('POST', '/api/files/move', { folder: 'Documents', paths: [''], destination: 'Taxes' })).toMatchObject({ code: 'PROTECTED' });
    expect(await refused('POST', '/api/files/copy', { folder: 'Documents', paths: [''], destination: 'Taxes' })).toMatchObject({ code: 'PROTECTED' });
    expect(await refused('GET', `/api/files/download?${qs({ folder: 'Documents', path: '' })}`)).toMatchObject({ status: 400 });
  });

  it('refuses .. and absolute escapes', async () => {
    for (const path of ['..', '../Photos', 'Taxes/../../Photos', '/etc', '/mnt/HDDs/Photos', 'Taxes/..']) {
      const res = await refused('GET', `/api/files/list?${qs({ folder: 'Documents', path })}`);
      expect(res.code, path).toBe('OUTSIDE_FOLDER');
    }
    expect(await refused('POST', '/api/files/move', { folder: 'Documents', paths: ['budget-2026.xlsx'], destination: '../Photos' })).toMatchObject({ code: 'OUTSIDE_FOLDER' });
    expect(await refused('POST', '/api/files/delete', { folder: 'Documents', paths: ['../Photos/IMG_4821.HEIC'] })).toMatchObject({ code: 'OUTSIDE_FOLDER' });
    expect(await refused('POST', '/api/files/rename', { folder: 'Documents', path: 'budget-2026.xlsx', newName: '../escaped.xlsx' })).toMatchObject({ code: 'INVALID_NAME' });
    expect(await refused('POST', '/api/files/mkdir', { folder: 'Documents', path: '', name: '..' })).toMatchObject({ code: 'INVALID_NAME' });
    const up = await upload({ folder: 'Documents', path: '', name: '../Photos/x.txt' }, [Buffer.from('x')]);
    expect(up.body.error?.code).toBe('OUTSIDE_FOLDER');
    expect(exists('/mnt/HDDs/Photos/x.txt')).toBe(false);
  });

  it('never follows or works through symlinks', async () => {
    mock.state.fs.nodes.push(
      { path: '/mnt/HDDs/Documents/escape', type: 'SYMLINK', size: 4, mtime: Date.now(), target: '/mnt/HDDs/Photos' },
      { path: '/mnt/HDDs/Documents/link.txt', type: 'SYMLINK', size: 30, mtime: Date.now(), target: '/mnt/HDDs/Photos/IMG_4821.HEIC' },
    );
    const entries = (await list('Documents')).entries;
    expect(entries.find((e) => e.name === 'escape')).toMatchObject({ type: 'link' });
    expect(await refused('GET', `/api/files/list?${qs({ folder: 'Documents', path: 'escape' })}`)).toMatchObject({ code: 'SYMLINK' });
    expect(await refused('GET', `/api/files/list?${qs({ folder: 'Documents', path: 'escape/2024' })}`)).toMatchObject({ code: 'SYMLINK' });
    expect(await refused('GET', `/api/files/download?${qs({ folder: 'Documents', path: 'link.txt' })}`)).toMatchObject({ code: 'SYMLINK' });
    expect(await refused('GET', `/api/files/download?${qs({ folder: 'Documents', path: 'escape/IMG_4821.HEIC' })}`)).toMatchObject({ code: 'SYMLINK' });
    expect(await refused('POST', '/api/files/move', { folder: 'Documents', paths: ['budget-2026.xlsx'], destination: 'escape' })).toMatchObject({ code: 'SYMLINK' });
    expect(await refused('POST', '/api/files/delete', { folder: 'Documents', paths: ['escape/IMG_4821.HEIC'] })).toMatchObject({ code: 'SYMLINK' });
    expect(await refused('POST', '/api/files/mkdir', { folder: 'Documents', path: 'escape', name: 'x' })).toMatchObject({ code: 'SYMLINK' });
    const intoLink = await upload({ folder: 'Documents', path: 'escape', name: 'x.txt' }, [Buffer.from('x')]);
    expect(intoLink.body.error?.code).toBe('SYMLINK');
    const throughLink = await upload({ folder: 'Documents', path: '', name: 'escape/x.txt' }, [Buffer.from('x')]);
    expect(throughLink.body.error?.code).toBe('SYMLINK');
    const overLink = await upload({ folder: 'Documents', path: '', name: 'link.txt', conflict: 'replace' }, [Buffer.from('x')]);
    expect(overLink.body.error?.code).toBe('SYMLINK');
    expect(exists('/mnt/HDDs/Photos/x.txt')).toBe(false);
    expect(mock.state.fs.nodes.find((n) => n.path === '/mnt/HDDs/Photos/IMG_4821.HEIC')?.size).toBe(3_481_220);
    // Removing the link itself is fine and leaves its target alone.
    await done(await ok('POST', '/api/files/delete', { folder: 'Documents', paths: ['escape'] }));
    expect(exists('/mnt/HDDs/Documents/escape')).toBe(false);
    expect(await names('Photos')).toContain('2024');
  });

  it('refuses the snapshot directory', async () => {
    for (const path of ['.zfs', '.zfs/snapshot', 'Taxes/.ZFS/snapshot/x']) {
      expect((await refused('GET', `/api/files/list?${qs({ folder: 'Documents', path })}`)).code, path).toBe('SNAPSHOTS');
    }
    expect(await refused('POST', '/api/files/mkdir', { folder: 'Documents', path: '', name: '.zfs' })).toMatchObject({ code: 'INVALID_NAME' });
    expect(await refused('POST', '/api/files/delete', { folder: 'Documents', paths: ['.zfs/snapshot/auto'] })).toMatchObject({ code: 'SNAPSHOTS' });
  });

  it('never crosses into a child dataset', async () => {
    expect(await refused('POST', '/api/files/move', { folder: 'Documents', paths: ['budget-2026.xlsx'], destination: 'Scans' })).toMatchObject({ code: 'CROSSES_DATASET' });
    const out = await refused('POST', '/api/files/copy', { folder: 'Documents', paths: ['Scans/Receipt 2026-09-14.pdf'], destination: '' });
    expect(out).toMatchObject({ code: 'CROSSES_DATASET' });
    expect(out.message).toContain('stored separately');
    for (const [url, body] of [
      ['/api/files/rename', { folder: 'Documents', path: 'Scans', newName: 'Scanned' }],
      ['/api/files/delete', { folder: 'Documents', paths: ['Scans'] }],
      ['/api/files/move', { folder: 'Documents', paths: ['Scans'], destination: 'Taxes' }],
    ] as const) {
      expect(await refused('POST', url, body), url).toMatchObject({ code: 'PROTECTED' });
    }
    // A folder containing a child dataset can't be moved, copied or deleted as a whole.
    mock.state.datasets.push({ ...mock.state.datasets.find((d) => d.id === 'HDDs/Documents/Scans')!, id: 'HDDs/Documents/Taxes/Archive', createtxg: 999 });
    try {
      for (const url of ['/api/files/delete', '/api/files/copy', '/api/files/move']) {
        const res = await refused('POST', url, { folder: 'Documents', paths: ['Taxes'], destination: 'Recipes' });
        expect(res.code, url).toBe('CONTAINS_DATASET');
      }
    } finally {
      mock.state.datasets = mock.state.datasets.filter((d) => d.id !== 'HDDs/Documents/Taxes/Archive');
    }
    // Working inside the separate area is fine; reaching into it from outside isn't.
    expect((await upload({ folder: 'Documents', path: 'Scans', name: 'inside.pdf' }, [Buffer.from('%PDF')])).status).toBe(200);
    const reach = await upload({ folder: 'Documents', path: '', name: 'Scans/reach.pdf' }, [Buffer.from('%PDF')]);
    expect(reach.body.error?.code).toBe('CROSSES_DATASET');
    await done(await ok('POST', '/api/files/delete', { folder: 'Documents', paths: ['Scans/inside.pdf'] }));
  });

  it('only opens folders ApexOs lists', async () => {
    for (const folder of ['Movies', 'HDDs', 'ix-apps', 'SSDs/ix-apps', 'Documents/Scans', 'HDDs/Documents/Scans', '../etc']) {
      const res = await refused('GET', `/api/files/list?${qs({ folder, path: '' })}`);
      expect(res, folder).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
    expect((await list('HDDs/Documents')).folder).toBe('Documents');
    expect((await list('documents')).folder).toBe('Documents');
  });

  it('refuses names with line breaks or NUL', async () => {
    expect(await refused('POST', '/api/files/mkdir', { folder: 'Documents', path: '', name: 'two\nlines' })).toMatchObject({ code: 'INVALID_NAME' });
    expect(await refused('POST', '/api/files/rename', { folder: 'Documents', path: 'budget-2026.xlsx', newName: 'nul\u0000name' })).toMatchObject({ code: 'INVALID_NAME' });
    expect(await refused('POST', '/api/files/rename', { folder: 'Documents', path: 'budget-2026.xlsx', newName: 'a/b' })).toMatchObject({ code: 'INVALID_NAME' });
    expect(await refused('GET', `/api/files/list?${qs({ folder: 'Documents', path: 'Taxes\n' })}`)).toMatchObject({ code: 'INVALID_PATH' });
    expect(await refused('POST', '/api/files/delete', { folder: 'Documents', paths: ['budget-2026.xlsx\nShopping list.txt'] })).toMatchObject({ code: 'INVALID_PATH' });
    const up = await upload({ folder: 'Documents', path: '', name: 'line\nbreak.txt' }, [Buffer.from('x')]);
    expect(up.body.error?.code).toBe('INVALID_PATH');
    expect(exists('/mnt/HDDs/Documents/budget-2026.xlsx')).toBe(true);
  });

  it('keeps hostile names literal through every operation', async () => {
    const hostile = `it's; $(touch pwned) & "quoted" | rm -rf --no-preserve-root ~ \`id\``;
    const up = await upload({ folder: 'Documents', path: '', name: hostile }, [Buffer.from('still a file')]);
    expect(up.body).toMatchObject({ action: 'created', entry: { name: hostile } });
    const renamed = `${hostile} (renamed) -n -T`;
    await ok('POST', '/api/files/rename', { folder: 'Documents', path: hostile, newName: renamed });
    await done(await ok('POST', '/api/files/copy', { folder: 'Documents', paths: [renamed], destination: 'Taxes' }));
    await done(await ok('POST', '/api/files/move', { folder: 'Documents', paths: [`Taxes/${renamed}`], destination: 'Recipes' }));
    expect((await download('Documents', `Recipes/${renamed}`)).body.toString()).toBe('still a file');
    await done(await ok('POST', '/api/files/delete', { folder: 'Documents', paths: [renamed, `Recipes/${renamed}`] }));
    expect(mock.state.fs.nodes.filter((n) => n.path.includes('it\'s') || n.path.includes('pwned'))).toEqual([]);
    expect(exists('/mnt/HDDs/Documents/Recipes/Pancakes.txt')).toBe(true);
  });

  it('shows locked folders as locked and refuses to browse them', async () => {
    const photos = mock.state.datasets.find((d) => d.id === 'HDDs/Photos')! as unknown as { locked?: boolean };
    photos.locked = true;
    // The simulator only reports `locked` once encryption is modelled; patch what pool.dataset.query returns.
    const client = ctx.truenas.client();
    const call = client.call.bind(client);
    client.call = (async (method: string, params?: unknown[]) => {
      const result = await call(method, params);
      if (method === 'pool.dataset.query' && Array.isArray(result)) {
        return result.map((d: { id: string }) => (d.id === 'HDDs/Photos' ? { ...d, locked: true, encrypted: true } : d));
      }
      return result;
    }) as typeof client.call;
    try {
      const roots = await ok<FileRootsResponse>('GET', '/api/files');
      expect(roots.folders.find((f) => f.name === 'Photos')).toMatchObject({ locked: true, encrypted: true });
      expect(await refused('GET', `/api/files/list?${qs({ folder: 'Photos', path: '' })}`)).toMatchObject({ status: 423, code: 'LOCKED' });
      const up = await upload({ folder: 'Photos', path: '', name: 'x.txt' }, [Buffer.from('x')]);
      expect(up.body.error?.code).toBe('LOCKED');
    } finally {
      client.call = call;
      photos.locked = false;
    }
  });
});
