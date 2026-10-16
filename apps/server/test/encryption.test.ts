/**
 * Folder encryption against the simulated TrueNAS: key modes, lock/unlock, key-mode changes, turning on
 * encryption for an existing folder (Copy strategy) and the recovery file.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ConversionCheck, Folder, FoldersResponse, RecoveryKeyStatus, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { TrueNasClient } from '@apexos/truenas-client';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { encryptionHousekeeping } from '../src/services/encryption.ts';

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

let mock: MockTrueNas;
let tn: TrueNasClient;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let cookie = '';

async function call<T>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  let body: unknown = undefined;
  try {
    body = res.body ? res.json() : undefined;
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body: body as T, headers: res.headers };
}

async function ok<T>(method: string, url: string, payload?: unknown): Promise<T> {
  const res = await call<T>(method, url, payload);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function settled(started: { task: Task }): Promise<Task> {
  for (let i = 0; i < 2000; i++) {
    const t = ctx.tasks.get(started.task.id)!;
    if (t.status !== 'running') return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Task did not finish');
}

async function finished(started: { task: Task }): Promise<Task> {
  const t = await settled(started);
  if (t.status === 'failed') throw new Error(`Task "${t.title}" failed: ${t.error}`);
  return t;
}

async function folder(name: string): Promise<Folder> {
  return ok<Folder>('GET', `/api/folders/${encodeURIComponent(name)}`);
}

async function createFolder(name: string, encryption: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): Promise<Folder> {
  await finished(
    await ok<{ task: Task }>('POST', '/api/folders', { name, pool: 'HDDs', access: 'private', users: [], quotaBytes: null, timeMachine: false, ...(encryption ? { encryption } : {}), ...extra }),
  );
  return folder(name);
}

const tnDataset = async (id: string): Promise<Any> => (await tn.call<Any[]>('pool.dataset.query', [[['id', '=', id]]]))[0];
const tnShare = async (name: string): Promise<Any> => (await tn.call<Any[]>('sharing.smb.query', [[['name', '=', name]]]))[0];
const reboot = () => tn.job('system.reboot', ['test']);

beforeAll(async () => {
  mock = await startMockTrueNas({ scenario: 'configured', jobDelayMs: 1, apiKey: 'test-key' });
  tn = new TrueNasClient({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' }, reconnect: false, pingIntervalMs: 0 });
  await tn.connect();
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-enc-test-'));
  const store = new StateStore(dataDir);
  await store.load();
  await store.update((s) => {
    s.server = { name: 'homeserver', setupCompletedAt: new Date().toISOString() };
    s.preferences.locations = { ApplicationsPerformance: '/mnt/SSDs/Applications', Media: '/mnt/HDDs/Media', Photos: '/mnt/HDDs/Photos', Documents: '/mnt/HDDs/Documents' };
  });
  const truenas = new TrueNasManager();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
  ctx = { store, truenas, tasks: new TaskManager(), bus: new Bus(), host: new HostCommands(truenas), scripts: new Map(), demo: true };
  app = await buildApp(ctx);
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'correct-horse' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await tn?.close();
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('creating encrypted folders', () => {
  it('creates folders in each mode, each its own encryption root', async () => {
    const plain = await createFolder('Plain', undefined);
    expect(plain.encryption).toEqual({ mode: 'none', locked: false, root: null, inherited: false, notInRecoveryFile: false, appsAffected: [] });

    const auto = await createFolder('Auto', { mode: 'key' });
    expect(auto.encryption).toMatchObject({ mode: 'key', locked: false, root: 'HDDs/Auto', inherited: false, notInRecoveryFile: true });
    expect(mock.state.encryptionKeys!['HDDs/Auto']).toMatch(/^[0-9a-f]{64}$/);

    const vault = await createFolder('Vault', { mode: 'passphrase', passphrase: 'correct horse battery' });
    expect(vault.encryption).toMatchObject({ mode: 'passphrase', locked: false, root: 'HDDs/Vault', notInRecoveryFile: false });
    expect(mock.state.encryptionKeys!['HDDs/Vault']).toBeUndefined();
    expect(vault.shared).toBe(true);
    // ApexOs never writes the passphrase anywhere.
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(dataDir, 'state.json'), 'utf8')).not.toContain('correct horse battery');

    const short = await call<Any>('POST', '/api/folders', { name: 'Short', pool: 'HDDs', access: 'private', users: [], quotaBytes: null, timeMachine: false, encryption: { mode: 'passphrase', passphrase: 'short' } });
    expect(short.status).toBe(400);
    expect(short.body.error.fields['encryption.passphrase']).toBeDefined();
    const pool = await tnDataset('HDDs');
    expect(pool.encrypted).toBe(false);
  });
});

describe('locking and unlocking', () => {
  it('locks a passphrase folder, hides its share, and unlocks it with the right passphrase only', async () => {
    // Jellyfin also keeps something in the folder.
    const jellyfin = mock.state.apps.find((a) => a.name === 'jellyfin')!;
    (jellyfin.config.storage as Any).additional_storage.push({ type: 'host_path', read_only: false, mount_path: '/vault', host_path_config: { acl_enable: false, path: '/mnt/HDDs/Vault' } });
    jellyfin.state = 'RUNNING';

    const autoLock = await call<Any>('POST', '/api/folders/Auto/lock');
    expect(autoLock.status).toBe(409);
    expect(autoLock.body.error.code).toBe('NOT_LOCKABLE');

    await finished(await ok<{ task: Task }>('POST', '/api/folders/Vault/lock'));
    const locked = await folder('Vault');
    expect(locked.encryption).toMatchObject({ mode: 'passphrase', locked: true, appsAffected: ['jellyfin'] });
    expect(locked.usedBytes).toBeGreaterThan(0);
    expect((await tnShare('Vault')).locked).toBe(true);
    expect(jellyfin.state).toBe('STOPPED');

    const edit = await call<Any>('PUT', '/api/folders/Vault', { access: 'private', users: [], quotaBytes: null, timeMachine: false });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('LOCKED');

    const wrong = await call<Any>('POST', '/api/folders/Vault/unlock', { passphrase: 'not the passphrase' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields.passphrase).toMatch(/doesn’t unlock/);
    expect((await folder('Vault')).encryption!.locked).toBe(true);

    await finished(await ok<{ task: Task }>('POST', '/api/folders/Vault/unlock', { passphrase: 'correct horse battery' }));
    const open = await folder('Vault');
    expect(open.encryption).toMatchObject({ locked: false, appsAffected: [] });
    expect((await tnShare('Vault')).locked).toBe(false);
    // TrueNAS doesn't restart apps after an unlock; ApexOs does.
    expect(jellyfin.state).toBe('RUNNING');
    (jellyfin.config.storage as Any).additional_storage.pop();

    const again = await call<Any>('POST', '/api/folders/Vault/unlock', { passphrase: 'correct horse battery' });
    expect(again.body.error.code).toBe('NOT_LOCKED');
  });

  it('waits while apps move to another pool, since locking stops the apps using a folder', async () => {
    let release!: () => void;
    const moving = ctx.tasks.start({ type: 'apps-pool', title: 'Moving apps to SSDs', ref: 'SSDs' }, () => new Promise<void>((r) => (release = r)));
    const lock = await call<Any>('POST', '/api/folders/Vault/lock');
    expect([lock.status, lock.body.error.code, lock.body.error.message]).toEqual([409, 'BUSY', 'Wait until “Moving apps to SSDs” has finished.']);
    release();
    await finished({ task: moving });
    expect((await folder('Vault')).encryption!.locked).toBe(false);
  });

  it('keeps passphrase folders locked after a restart and automatic-key folders unlocked', async () => {
    await reboot();
    expect((await folder('Vault')).encryption!.locked).toBe(true);
    expect((await folder('Auto')).encryption!.locked).toBe(false);
    await finished(await ok<{ task: Task }>('POST', '/api/folders/Vault/unlock', { passphrase: 'correct horse battery' }));
  });
});

describe('changing key mode', () => {
  it('switches automatic key → passphrase → automatic key', async () => {
    await finished(await ok<{ task: Task }>('PUT', '/api/folders/Auto/encryption', { mode: 'passphrase', passphrase: 'a new passphrase' }));
    expect((await folder('Auto')).encryption).toMatchObject({ mode: 'passphrase', notInRecoveryFile: false });
    expect(mock.state.encryptionKeys!['HDDs/Auto']).toBeUndefined();
    await reboot();
    expect((await folder('Auto')).encryption!.locked).toBe(true);

    // While locked, the current passphrase is needed.
    const missing = await call<Any>('PUT', '/api/folders/Auto/encryption', { mode: 'key' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.fields.currentPassphrase).toBeDefined();
    const wrong = await call<Any>('PUT', '/api/folders/Auto/encryption', { mode: 'key', currentPassphrase: 'nope nope nope' });
    expect(wrong.status).toBe(400);
    await finished(await ok<{ task: Task }>('PUT', '/api/folders/Auto/encryption', { mode: 'key', currentPassphrase: 'a new passphrase' }));
    const back = await folder('Auto');
    expect(back.encryption).toMatchObject({ mode: 'key', locked: false, notInRecoveryFile: true });
    expect(mock.state.encryptionKeys!['HDDs/Auto']).toMatch(/^[0-9a-f]{64}$/);
    await reboot();
    expect((await folder('Auto')).encryption!.locked).toBe(false);
    await finished(await ok<{ task: Task }>('POST', '/api/folders/Vault/unlock', { passphrase: 'correct horse battery' }));

    const same = await call<Any>('PUT', '/api/folders/Auto/encryption', { mode: 'key' });
    expect(same.body.error.code).toBe('NO_CHANGE');
    const plain = await call<Any>('PUT', '/api/folders/Plain/encryption', { mode: 'key' });
    expect(plain.body.error.code).toBe('NOT_ENCRYPTED');
  });
});

describe('turning on encryption for an existing folder', () => {
  const alice = () => mock.state.users.find((u) => u.username === 'alice')!;

  async function seedFamily(name: string): Promise<void> {
    await createFolder(name, undefined, { users: [{ username: 'alice', level: 'full' }], quotaBytes: 50 * 1e9 });
    const ds = mock.state.datasets.find((d) => d.id === `HDDs/${name}`)!;
    ds.usedBytes = 3 * GiB;
    const now = Date.now();
    mock.state.fs.nodes.push(
      { path: `/mnt/HDDs/${name}/Holidays`, type: 'DIRECTORY', size: 4, mtime: now },
      { path: `/mnt/HDDs/${name}/Holidays/beach.jpg`, type: 'FILE', size: 2_400_000, mtime: now },
      { path: `/mnt/HDDs/${name}/notes.txt`, type: 'FILE', size: 1200, mtime: now },
    );
    mock.state.fs.owners[`/mnt/HDDs/${name}/notes.txt`] = { uid: alice().uid, gid: 0, mode: 0o640 };
    await tn.call('pool.snapshot.create', [{ dataset: `HDDs/${name}`, name: 'auto-2026-10-01_00-00' }]);
  }

  it('copies the folder into an encrypted one and swaps it in, keeping files, share, access and quota', async () => {
    await seedFamily('Family');
    const before = await folder('Family');
    const shareBefore = await tnShare('Family');
    const aclBefore = await tn.call<Any>('sharing.smb.getacl', [{ share_name: 'Family' }]);
    const filesBefore = await tn.call<Any[]>('filesystem.listdir', ['/mnt/HDDs/Family']);

    const check = await ok<ConversionCheck>('GET', '/api/folders/Family/encryption/convert');
    expect(check).toMatchObject({ allowed: true, blockers: [], duration: 'minutes', snapshots: 1, childDatasets: [] });
    expect(check.spaceNeededBytes).toBeGreaterThan(3 * GiB);

    const task = await finished(await ok<{ task: Task }>('POST', '/api/folders/Family/encryption/convert', { mode: 'key' }));
    expect(task.steps.map((s) => s.status)).toEqual(Array(10).fill('success'));

    const after = await folder('Family');
    expect(after.encryption).toMatchObject({ mode: 'key', locked: false, root: 'HDDs/Family', inherited: false, notInRecoveryFile: true });
    expect(after.conversion).toMatchObject({ state: 'done', switched: true, passphrasePending: false });
    expect(after.conversion!.safetyCopy!.dataset).toMatch(/^HDDs\/Family-unencrypted-\d{8}$/);
    expect(after.users).toEqual(before.users);
    expect(after.access).toBe('private');
    expect(after.quotaBytes).toBeGreaterThanOrEqual(before.quotaBytes!);
    expect(after.shared).toBe(true);

    const share = await tnShare('Family');
    expect(share).toMatchObject({ id: shareBefore.id, path: '/mnt/HDDs/Family', enabled: true, locked: false });
    expect((await tn.call<Any>('sharing.smb.getacl', [{ share_name: 'Family' }])).share_acl).toEqual(aclBefore.share_acl);
    const files = await tn.call<Any[]>('filesystem.listdir', ['/mnt/HDDs/Family']);
    expect(files.map((f) => [f.name, f.size, f.uid, f.mode])).toEqual(filesBefore.map((f) => [f.name, f.size, f.uid, f.mode]));
    const snaps = await tn.call<Any[]>('pool.snapshot.query', [[['dataset', '=', 'HDDs/Family']]]);
    expect(snaps.map((s) => s.snapshot_name)).toEqual(['auto-2026-10-01_00-00']);
    const ds = await tnDataset('HDDs/Family');
    expect(ds.readonly.value).toBe('OFF');

    // The key is stored under the folder's own name, so it survives a restart.
    expect(mock.state.encryptionKeys!['HDDs/Family']).toMatch(/^[0-9a-f]{64}$/);
    expect(mock.state.datasets.find((d) => d.id === 'HDDs/Family')!.encryption!.keylocation).toBe('prompt');
    await reboot();
    expect((await folder('Family')).encryption!.locked).toBe(false);
    await finished(await ok<{ task: Task }>('POST', '/api/folders/Vault/unlock', { passphrase: 'correct horse battery' }));

    // The unencrypted original is kept (hidden) until removed.
    const { folders } = await ok<FoldersResponse>('GET', '/api/folders');
    expect(folders.map((f) => f.name)).not.toContain(after.conversion!.safetyCopy!.dataset.split('/')[1]);
    expect(folders.some((f) => f.name.startsWith('.apexos'))).toBe(false);
    const original = await tnDataset(after.conversion!.safetyCopy!.dataset);
    expect(original.encrypted).toBe(false);
    expect(original.user_properties['apexos:safety-copy'].value).toBe('HDDs/Family');
    await finished(await ok<{ task: Task }>('DELETE', '/api/folders/Family/encryption/safety-copy'));
    expect(await tnDataset(after.conversion!.safetyCopy!.dataset)).toBeUndefined();
    expect((await folder('Family')).conversion).toBeNull();
    const done = await call<Any>('GET', '/api/folders/Family/encryption/convert');
    expect(done.body.blockers.map((b: Any) => b.code)).toContain('ALREADY_ENCRYPTED');
  });

  it('applies a chosen passphrase at the end; the folder is locked after a restart', async () => {
    await seedFamily('Diary');
    // A dataset inside the folder is copied along and ends up under the folder's key.
    await tn.call('pool.dataset.create', [{ name: 'HDDs/Diary/Archive', share_type: 'SMB' }]);
    await tn.call('filesystem.mkdir', [{ path: '/mnt/HDDs/Diary/Archive/2025' }]);
    expect((await ok<ConversionCheck>('GET', '/api/folders/Diary/encryption/convert')).childDatasets).toEqual(['Archive']);
    await finished(await ok<{ task: Task }>('POST', '/api/folders/Diary/encryption/convert', { mode: 'passphrase', passphrase: 'dear diary 2026', keepOriginal: false }));
    expect(await tnDataset('HDDs/Diary/Archive')).toMatchObject({ encrypted: true, encryption_root: 'HDDs/Diary' });
    expect((await tn.call<Any[]>('filesystem.listdir', ['/mnt/HDDs/Diary/Archive'])).map((e) => e.name)).toEqual(['2025']);
    const diary = await folder('Diary');
    expect(diary.encryption).toMatchObject({ mode: 'passphrase', locked: false });
    expect(diary.conversion).toBeNull();
    expect(mock.state.encryptionKeys!['HDDs/Diary']).toBeUndefined();
    expect(mock.state.datasets.some((d) => d.id.startsWith('HDDs/Diary-unencrypted'))).toBe(false);
    await reboot();
    expect((await folder('Diary')).encryption!.locked).toBe(true);
    await finished(await ok<{ task: Task }>('POST', '/api/folders/Diary/unlock', { passphrase: 'dear diary 2026' }));
    await finished(await ok<{ task: Task }>('POST', '/api/folders/Vault/unlock', { passphrase: 'correct horse battery' }));
  });

  it('refuses folders used by apps, without enough space, or managed by ApexOs', async () => {
    await createFolder('Busy', undefined);
    const jellyfin = mock.state.apps.find((a) => a.name === 'jellyfin')!;
    (jellyfin.config.storage as Any).additional_storage.push({ type: 'host_path', read_only: false, mount_path: '/busy', host_path_config: { acl_enable: false, path: '/mnt/HDDs/Busy/sub' } });
    const busy = await ok<ConversionCheck>('GET', '/api/folders/Busy/encryption/convert');
    expect(busy.allowed).toBe(false);
    expect(busy.blockers).toEqual([expect.objectContaining({ code: 'APPS', message: expect.stringMatching(/jellyfin keeps files in this folder/) })]);
    const refused = await call<Any>('POST', '/api/folders/Busy/encryption/convert', { mode: 'key' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CANNOT_CONVERT');
    (jellyfin.config.storage as Any).additional_storage.pop();

    await createFolder('Huge', undefined);
    mock.state.datasets.find((d) => d.id === 'HDDs/Huge')!.usedBytes = 12 * TiB;
    const huge = await ok<ConversionCheck>('GET', '/api/folders/Huge/encryption/convert');
    expect(huge.blockers.map((b) => b.code)).toEqual(['SPACE']);
    expect(huge.blockers[0]!.message).toMatch(/needs about .* of free space on HDDs, but only .* is free/);
    expect(huge.freeBytes).toBeLessThan(huge.spaceNeededBytes);
    expect(huge.duration).toBe('a-day-or-more');
    mock.state.datasets.find((d) => d.id === 'HDDs/Huge')!.usedBytes = GiB;

    // Something else shared from inside the folder, or a sub-dataset with its own key.
    await createFolder('Nested', undefined);
    await tn.call('filesystem.mkdir', [{ path: '/mnt/HDDs/Nested/inner' }]);
    await tn.call('sharing.smb.create', [{ name: 'NestedInner', path: '/mnt/HDDs/Nested/inner', purpose: 'DEFAULT_SHARE' }]);
    await tn.call('pool.dataset.create', [{ name: 'HDDs/Nested/Keys', encryption: true, inherit_encryption: false, encryption_options: { generate_key: true } }]);
    const nested = await ok<ConversionCheck>('GET', '/api/folders/Nested/encryption/convert');
    expect(nested.blockers.map((b) => b.code).sort()).toEqual(['CHILD_ENCRYPTED', 'CHILD_SHARED']);
    expect(nested.blockers.find((b) => b.code === 'CHILD_SHARED')!.message).toMatch(/“NestedInner”/);

    const media = await ok<ConversionCheck>('GET', '/api/folders/Media/encryption/convert');
    expect(media.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['SYSTEM_FOLDER', 'APPS']));
    const vault = await ok<ConversionCheck>('GET', '/api/folders/Vault/encryption/convert');
    expect(vault.blockers.map((b) => b.code)).toEqual(['ALREADY_ENCRYPTED']);
  });

  it('fails safely on a name collision, can be retried, and resumes after an ApexOs restart', async () => {
    await seedFamily('Retry');
    const check = await ok<ConversionCheck>('GET', '/api/folders/Retry/encryption/convert');
    expect(check.allowed).toBe(true);
    // Something takes the original's new name while the copy is being made.
    const started = await ok<{ task: Task }>('POST', '/api/folders/Retry/encryption/convert', { mode: 'key' });
    const stamp = (() => {
      const d = new Date();
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    })();
    await tn.call('pool.dataset.create', [{ name: `HDDs/Retry-unencrypted-${stamp}` }]);
    const failed = await settled(started);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/already exists, so the original folder can’t be moved aside/);
    const broken = await folder('Retry');
    expect(broken.encryption!.mode).toBe('none');
    expect(broken.conversion).toMatchObject({ state: 'failed', switched: false });
    // The untouched original is shared again.
    expect((await tnShare('Retry')).enabled).toBe(true);
    const edit = await call<Any>('PUT', '/api/folders/Retry', { access: 'private', users: [], quotaBytes: null, timeMachine: false });
    expect(edit.body.error.code).toBe('CONVERTING');

    await tn.call('pool.dataset.delete', [`HDDs/Retry-unencrypted-${stamp}`]);
    await finished(await ok<{ task: Task }>('POST', '/api/folders/Retry/encryption/convert/retry', {}));
    expect((await folder('Retry')).encryption!.mode).toBe('key');
    await finished(await ok<{ task: Task }>('DELETE', '/api/folders/Retry/encryption/safety-copy'));

    // Discard before the switch-over puts everything back.
    await seedFamily('Discard');
    const s2 = await ok<{ task: Task }>('POST', '/api/folders/Discard/encryption/convert', { mode: 'key' });
    await tn.call('pool.dataset.create', [{ name: `HDDs/Discard-unencrypted-${stamp}` }]);
    expect((await settled(s2)).status).toBe('failed');
    expect(await tnDataset('HDDs/.apexos-enc-Discard')).toBeDefined();
    await finished(await ok<{ task: Task }>('POST', '/api/folders/Discard/encryption/convert/discard'));
    expect(await tnDataset('HDDs/.apexos-enc-Discard')).toBeUndefined();
    expect((await tn.call<Any[]>('pool.snapshot.query', [[['dataset', '=', 'HDDs/Discard']]])).map((s) => s.snapshot_name)).toEqual(['auto-2026-10-01_00-00']);
    expect((await folder('Discard')).conversion).toBeNull();
    await tn.call('pool.dataset.delete', [`HDDs/Discard-unencrypted-${stamp}`]);

    // An automatic-key run cut short by an ApexOs restart is resumed at start-up.
    await ctx.store.update((s) => {
      s.encryption!.conversions!['HDDs/Discard'] = {
        folder: 'Discard',
        dataset: 'HDDs/Discard',
        pool: 'HDDs',
        path: '/mnt/HDDs/Discard',
        temp: 'HDDs/.apexos-enc-Discard',
        original: `HDDs/Discard-unencrypted-${stamp}`,
        mode: 'key',
        key: 'b'.repeat(64),
        keepOriginal: true,
        status: 'running',
        step: 'Making an encrypted copy',
        error: null,
        taskId: 'gone-with-the-restart',
        renamedOriginal: false,
        switched: false,
        share: null,
        quota: null,
        refquota: null,
        passphrasePending: false,
        startedAt: new Date().toISOString(),
        removeAfter: null,
      };
    });
    expect((await folder('Discard')).conversion!.state).toBe('interrupted');
    await encryptionHousekeeping(ctx, { startup: true });
    const resumed = ctx.tasks.findRunning('folder-encrypt', 'Discard')!;
    await finished({ task: resumed });
    const discard = await folder('Discard');
    expect(discard.encryption).toMatchObject({ mode: 'key', root: 'HDDs/Discard' });
    expect(mock.state.encryptionKeys!['HDDs/Discard']).toBe('b'.repeat(64));
  });
});

describe('recovery file', () => {
  it('contains every automatic key and tracks what changed since the download', async () => {
    const before = await ok<RecoveryKeyStatus>('GET', '/api/encryption/recovery');
    expect(before.lastDownloadedAt).toBeNull();
    const keyDatasets = before.keyFolders.map((f) => f.dataset).sort();
    expect(keyDatasets).toEqual(['HDDs/Auto', 'HDDs/Discard', 'HDDs/Family', 'HDDs/Retry']);
    expect(before.addedSinceDownload).toBe(4);
    expect(before.passphraseFolders.sort()).toEqual(['Diary', 'Vault']);
    expect(before.keyFolders.every((f) => f.keyStored)).toBe(true);

    const res = await call<Record<string, string>>('POST', '/api/encryption/recovery/file');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-disposition'])).toMatch(/attachment; filename="apexos-recovery-homeserver-\d{4}-\d{2}-\d{2}\.json"/);
    const file = res.body;
    for (const ds of keyDatasets) expect(file[ds]).toBe(mock.state.encryptionKeys![ds]);
    expect(file['HDDs/Vault']).toBeUndefined();
    expect(Object.keys(file).sort()).toEqual(Object.keys(mock.state.encryptionKeys!).sort());

    const after = await ok<RecoveryKeyStatus>('GET', '/api/encryption/recovery');
    expect(after.addedSinceDownload).toBe(0);
    expect(after.lastDownloadedAt).not.toBeNull();
    expect((await folder('Auto')).encryption!.notInRecoveryFile).toBe(false);

    await createFolder('Later', { mode: 'key' });
    expect((await ok<RecoveryKeyStatus>('GET', '/api/encryption/recovery')).addedSinceDownload).toBe(1);
    // Re-keying a folder also makes the old file stale for it.
    await finished(await ok<{ task: Task }>('PUT', '/api/folders/Auto/encryption', { mode: 'passphrase', passphrase: 'another passphrase' }));
    await finished(await ok<{ task: Task }>('PUT', '/api/folders/Auto/encryption', { mode: 'key' }));
    const status = await ok<RecoveryKeyStatus>('GET', '/api/encryption/recovery');
    expect(status.addedSinceDownload).toBe(2);

    // A key from the recovery file unlocks a folder TrueNAS lost the key for (e.g. after moving the drives).
    delete mock.state.encryptionKeys!['HDDs/Family'];
    await reboot();
    const lost = await folder('Family');
    expect(lost.encryption).toMatchObject({ mode: 'key', locked: true });
    expect((await ok<RecoveryKeyStatus>('GET', '/api/encryption/recovery')).keyFolders.find((f) => f.dataset === 'HDDs/Family')!.keyStored).toBe(false);
    const bad = await call<Any>('POST', '/api/folders/Family/unlock', { key: 'c'.repeat(64) });
    expect(bad.status).toBe(400);
    await finished(await ok<{ task: Task }>('POST', '/api/folders/Family/unlock', { key: file['HDDs/Family'] }));
    expect((await folder('Family')).encryption!.locked).toBe(false);
    expect(mock.state.encryptionKeys!['HDDs/Family']).toBe(file['HDDs/Family']);
  });
});
