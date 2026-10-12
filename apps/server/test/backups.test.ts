/**
 * Backups between two of the user's own servers, end to end: the ApexOs HTTP API on server A against two
 * (later three) simulated TrueNAS boxes in the same process, which replicate to each other over simulated SSH.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { BackupsResponse, DestinationCheck, FoldersResponse, RestoreInfo, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { loadScripts } from '../src/lib/install-script.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { checkBackups, forgetProbes, nextRunAt, receiverUsername, toCron, UNREACHABLE_NOTICE_AFTER_MS } from '../src/services/backups.ts';
import { isShareUser } from '../src/services/users.ts';

const catalogDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../catalog');
const GiB = 1024 ** 3;
const TiB = 1024 ** 4;
const DAY = 86400_000;

let a: MockTrueNas;
let b: MockTrueNas;
let c: MockTrueNas | undefined;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let bState: string;
let bPort: number;
let cookie = '';
const B_PASSWORD = 'backup-password';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

async function call<T = Any>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T) };
}

async function ok<T = Any>(method: string, url: string, payload?: unknown): Promise<T> {
  const res = await call<T>(method, url, payload);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function settle(id: string): Promise<Task> {
  for (let i = 0; i < 1000; i++) {
    const t = ctx.tasks.get(id)!;
    if (t.status !== 'running') return t as Task;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Task did not finish');
}

async function finished(started: { task: Task }): Promise<Task> {
  const t = await settle(started.task.id);
  if (t.status === 'failed') throw new Error(`Task "${t.title}" failed: ${t.error}`);
  return t;
}

/** Waits for every running task of a type (e.g. the first backups started after setting one up). */
async function drain(type: string): Promise<Task[]> {
  const running = ctx.tasks.list().filter((t) => t.type === type && t.status === 'running');
  return Promise.all(running.map((t) => settle(t.id)));
}

async function backups(fresh = true): Promise<BackupsResponse> {
  forgetProbes();
  return ok<BackupsResponse>('GET', `/api/backups${fresh ? '?fresh=1' : ''}`);
}

function notices(title: RegExp): number {
  return ctx.store.get().notices.filter((n) => title.test(n.title)).length;
}

const addressOf = (m: MockTrueNas) => `http://127.0.0.1:${m.server.port}`;
/** Makes a simulated dataset an encryption root (the simulator's `DatasetEncryptionState`). */
const encrypted = (keyFormat: 'HEX' | 'PASSPHRASE', secret: string) => ({ keyFormat, secret, algorithm: 'AES-256-GCM', pbkdf2iters: keyFormat === 'PASSPHRASE' ? 350000 : 0, keyLoaded: true, keylocation: 'prompt' });
const daily = { schedule: { frequency: 'daily', time: '02:30', weekday: 0 }, keepDays: 14, speedLimitMbps: 100 };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-backups-'));
  bState = join(dataDir, 'b.json');
  a = await startMockTrueNas({ jobDelayMs: 0, scenario: 'configured', apiKey: 'a-key' });
  b = await startMockTrueNas({ jobDelayMs: 0, scenario: 'configured', hostname: 'backup-nas', lanIp: '192.168.1.30', adminPassword: B_PASSWORD, stateFile: bState });
  bPort = b.server.port;
  const store = new StateStore(join(dataDir, 'apexos'));
  await store.load();
  await store.update((s) => {
    s.server.name = 'truenas';
    s.server.setupCompletedAt = new Date().toISOString();
  });
  const truenas = new TrueNasManager();
  await truenas.configure({ url: a.url, auth: { type: 'apiKey', apiKey: 'a-key' } });
  ctx = {
    store,
    truenas,
    tasks: new TaskManager(),
    bus: new Bus(),
    host: new HostCommands(truenas),
    scripts: (await loadScripts(catalogDir)).scripts,
    demo: true,
  };
  app = await buildApp(ctx);
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'admin', password: 'correct-horse' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await a?.close();
  await b?.close();
  await c?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('helpers', () => {
  it('builds receiver names and TrueNAS schedules', () => {
    expect(receiverUsername('My Server!')).toBe('apexosbk_my-server');
    expect(receiverUsername('x'.repeat(40))).toHaveLength(32);
    expect(toCron({ frequency: 'daily', time: '02:30', weekday: 0 })).toEqual({ minute: '30', hour: '2', dom: '*', month: '*', dow: '*' });
    expect(toCron({ frequency: 'weekly', time: '23:00', weekday: 0 })).toMatchObject({ hour: '23', dow: '7' });
    expect(toCron({ frequency: 'hourly', time: '00:15', weekday: 0 })).toMatchObject({ minute: '15', hour: '*' });
    const now = Date.UTC(2026, 9, 12, 12, 0); // Monday 12:00 UTC = 05:00 in Los Angeles
    expect(nextRunAt({ frequency: 'daily', time: '02:30', weekday: 0 }, 'America/Los_Angeles', now)).toBe('2026-10-13T09:30:00.000Z');
    expect(nextRunAt({ frequency: 'weekly', time: '23:00', weekday: 0 }, 'UTC', now)).toBe('2026-10-18T23:00:00.000Z');
    expect(nextRunAt({ frequency: 'hourly', time: '00:15', weekday: 0 }, 'UTC', now)).toBe('2026-10-12T12:15:00.000Z');
  });

  it('hides the backup receiving accounts from share users', () => {
    const dir = { adminUid: 950, adminUsername: 'truenas_admin', users: [] };
    expect(isShareUser({ uid: 3001, username: 'apexosbk_truenas', smb: true, roles: [] } as never, dir)).toBe(false);
    expect(isShareUser({ uid: 3002, username: 'alice', smb: true, roles: [] } as never, dir)).toBe(true);
  });
});

describe('backups between two servers', () => {
  let destId = '';
  let photosId = '';
  let documentsId = '';

  it('refuses addresses it can’t use', async () => {
    const creds = { method: 'password', username: 'truenas_admin', password: B_PASSWORD };
    const offline = await call('POST', '/api/backups/destinations/check', { ...creds, address: 'http://127.0.0.1:1' });
    expect(offline.status).toBe(409);
    expect(offline.body.error.code).toBe('DESTINATION_UNREACHABLE');
    expect(offline.body.error.message).toMatch(/Couldn’t reach/);
    const plain = await call('POST', '/api/backups/destinations/check', { ...creds, address: 'http://192.168.1.30' });
    expect(plain.status).toBe(400);
    expect(plain.body.error.fields.address).toBe('Use https');
    const wrong = await call('POST', '/api/backups/destinations/check', { ...creds, address: addressOf(b), password: 'nope' });
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const badKey = await call('POST', '/api/backups/destinations/check', { method: 'apiKey', apiKey: 'not-a-real-key-123', address: addressOf(b) });
    expect(badKey.body.error.code).toBe('INVALID_CREDENTIALS');
    // This server itself is refused.
    a.state.apiKeys.push({ ...a.state.apiKeys[0]!, id: 99, name: 'self', key: 'a-self-key-long-enough' });
    const same = await call('POST', '/api/backups/destinations/check', { method: 'apiKey', apiKey: 'a-self-key-long-enough', address: addressOf(a) });
    expect(same.body.error.code).toBe('SAME_SERVER');
  });

  it('checks the other server and sets both sides up', async () => {
    const creds = { method: 'password', username: 'truenas_admin', password: B_PASSWORD, address: addressOf(b) };
    const check = await ok<DestinationCheck>('POST', '/api/backups/destinations/check', creds);
    expect(check).toMatchObject({ name: 'backup-nas', sshEnabled: false });
    expect(check.pools.map((p) => p.name).sort()).toEqual(['HDDs', 'SSDs']);
    expect(check.pools.find((p) => p.name === 'HDDs')).toMatchObject({ usable: true, encrypted: false });
    expect(check.foldersBytes).toBeGreaterThan(2 * TiB);
    const keysBefore = b.state.apiKeys.length;

    const tooBig = await call('POST', '/api/backups/destinations', { ...creds, pool: 'SSDs', spaceBytes: 50 * TiB });
    expect(tooBig.status).toBe(200);
    const failedTask = await settle(tooBig.body.task.id);
    expect(failedTask.status).toBe('failed');
    expect(failedTask.error).toMatch(/has only .* free/);
    // Nothing is left behind after a failed setup.
    expect(b.state.apiKeys.length).toBe(keysBefore);
    expect(b.state.datasets.some((d) => d.id.includes('apexos-backups'))).toBe(false);
    expect(a.state.keychain).toEqual([]);

    await finished(await ok('POST', '/api/backups/destinations', { ...creds, pool: 'HDDs', spaceBytes: 1 * TiB }));
    const dest = ctx.store.get().backups.destinations[0]!;
    destId = dest.id;
    expect(dest).toMatchObject({ name: 'backup-nas', pool: 'HDDs', rootDataset: 'HDDs/apexos-backups/truenas', username: 'apexosbk_truenas', sshHost: '127.0.0.1', sshEnabledByApexOs: true });
    expect(dest.sshPort).toBe(b.sshAddress.port);
    expect(JSON.stringify(ctx.store.get())).not.toContain(B_PASSWORD);

    // On B: restricted account, SSH on, space set aside, ApexOs's own API key.
    const user = b.state.users.find((u) => u.username === 'apexosbk_truenas')!;
    expect(user).toMatchObject({ password_disabled: true, smb: false, shell: '/usr/bin/bash', sudo_commands: [], sudo_commands_nopasswd: ['/usr/sbin/zfs'] });
    const pair = a.state.keychain.find((k) => k.type === 'SSH_KEY_PAIR')!;
    expect(user.sshpubkey).toContain(String(pair.attributes.public_key).split(' ')[1]);
    expect(b.state.services.find((s) => s.service === 'ssh')).toMatchObject({ enable: true, state: 'RUNNING' });
    const root = b.state.datasets.find((d) => d.id === 'HDDs/apexos-backups/truenas')!;
    expect(root).toMatchObject({ quota: TiB, reservation: TiB });
    expect(root.user_properties['apexos:backup-source']).toBe(ctx.store.get().backups.serverId);
    expect(b.state.apiKeys.length).toBe(keysBefore + 1);
    expect(dest.apiKeyId).toBe(b.state.apiKeys.at(-1)!.id);

    // On A: key pair and SSH credentials pinned to B's host key.
    const cred = a.state.keychain.find((k) => k.type === 'SSH_CREDENTIALS')!;
    expect(cred.attributes).toMatchObject({ host: '127.0.0.1', port: b.sshAddress.port, username: 'apexosbk_truenas', private_key: pair.id });
    expect(String(cred.attributes.remote_host_key)).toContain(b.state.ssh.hostKeys.ed25519);

    const again = await call('POST', '/api/backups/destinations/check', creds);
    expect(again.body.error.code).toBe('ALREADY_ADDED');
    // B's own folder list doesn't show the backup area.
    expect(b.state.datasets.find((d) => d.id === 'HDDs/apexos-backups')).toBeDefined();

    const list = await backups();
    expect(list.destinations[0]).toMatchObject({ name: 'backup-nas', health: 'online', grantedBytes: TiB, backupCount: 0, encryptedOnly: false });
  });

  it('refuses a backup that doesn’t fit in the space set aside', async () => {
    const res = await call('POST', '/api/backups', { destinationId: destId, folders: ['Media'], ...daily });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_ENOUGH_SPACE');
    expect(res.body.error.message).toMatch(/only .* of the .* set aside on backup-nas is free/);
    const weekly = await call('POST', '/api/backups', { destinationId: destId, folders: ['Photos'], ...daily, schedule: { frequency: 'weekly', time: '23:00', weekday: 0 }, keepDays: 3 });
    expect(weekly.body.error.fields.keepDays).toMatch(/7 days/);
  });

  it('backs up a folder: snapshot task, replication task and a read-only copy on B', async () => {
    await finished(await ok('POST', '/api/backups', { destinationId: destId, folders: ['Photos'], ...daily }));
    const runs = await drain('backup-run');
    expect(runs.map((t) => t.status)).toEqual(['success']);
    const rec = ctx.store.get().backups.jobs[0]!;
    photosId = rec.id;

    const task = a.state.snapshotTasks.find((t) => t.id === rec.snapshotTaskId)!;
    expect(task).toMatchObject({ dataset: 'HDDs/Photos', recursive: true, lifetime_value: 14, lifetime_unit: 'DAY', allow_empty: false, enabled: true });
    expect(task.schedule).toMatchObject({ minute: '30', hour: '2', dom: '*', month: '*', dow: '*' });
    const repl = a.state.replications.find((r) => r.id === rec.replicationId)!;
    expect(repl.fields).toMatchObject({
      direction: 'PUSH',
      transport: 'SSH',
      sudo: true,
      properties: true,
      encryption: false,
      readonly: 'SET',
      retention_policy: 'SOURCE',
      hold_pending_snapshots: true,
      allow_from_scratch: false,
      auto: true,
      periodic_snapshot_tasks: [task.id],
      speed_limit: 12_500_000,
      target_dataset: 'HDDs/apexos-backups/truenas/Photos',
    });

    const copy = b.state.datasets.find((d) => d.id === 'HDDs/apexos-backups/truenas/Photos')!;
    expect(copy.props.readonly).toBe('ON');
    expect(copy.usedBytes).toBeGreaterThan(400 * GiB);
    expect(b.state.snapshots.filter((s) => s.dataset === copy.id)).toHaveLength(1);

    const list = await backups();
    const backup = list.backups.find((x) => x.id === photosId)!;
    expect(backup).toMatchObject({ folder: 'Photos', destinationName: 'backup-nas', encrypted: false, paused: false, restorePoints: 1, keepDays: 14, speedLimitMbps: 100 });
    expect(backup.status).toMatchObject({ state: 'ok', label: 'Up to date', detail: null });
    expect(backup.status.lastSuccessAt).not.toBeNull();
    expect(new Date(backup.status.nextRunAt!).toLocaleTimeString('en-US', { timeZone: list.timezone, hour12: false })).toBe('02:30:00');
    expect(list.destinations[0]!.usedBytes).toBeGreaterThan(400 * GiB);
    expect(list.destinations[0]!.backupCount).toBe(1);
    // The same folder can't be added twice to one destination.
    const dup = await call('POST', '/api/backups', { destinationId: destId, folders: ['Photos'], ...daily });
    expect(dup.body.error.code).toBe('ALREADY_BACKED_UP');
  });

  it('sends only the changes with “Back up now”', async () => {
    a.state.datasets.find((d) => d.id === 'HDDs/Photos')!.usedBytes += 3 * GiB;
    await new Promise((r) => setTimeout(r, 1100)); // snapshot names have one-second resolution
    await finished(await ok('POST', `/api/backups/${photosId}/run`));
    expect(b.state.snapshots.filter((s) => s.dataset === 'HDDs/apexos-backups/truenas/Photos')).toHaveLength(2);
    expect(b.state.datasets.find((d) => d.id === 'HDDs/apexos-backups/truenas/Photos')!.usedBytes).toBe(a.state.datasets.find((d) => d.id === 'HDDs/Photos')!.usedBytes);
  });

  it('sends an encrypted folder raw: it arrives encrypted and locked', async () => {
    const docs = a.state.datasets.find((d) => d.id === 'HDDs/Documents')!;
    docs.encryption = encrypted('PASSPHRASE', 'correct horse battery staple');
    await finished(await ok('POST', '/api/backups', { destinationId: destId, folders: ['Documents'], ...daily }));
    await drain('backup-run');
    documentsId = ctx.store.get().backups.jobs.find((j) => j.folder === 'Documents')!.id;
    const ds = b.state.datasets.find((d) => d.id === 'HDDs/apexos-backups/truenas/Documents')!;
    expect(ds.encryption).toMatchObject({ keyFormat: 'PASSPHRASE', keyLoaded: false });
    expect(b.state.fs.nodes.some((n) => n.path.startsWith('/mnt/HDDs/apexos-backups/truenas/Documents/'))).toBe(false);
    const backup = (await backups()).backups.find((x) => x.id === documentsId)!;
    expect(backup).toMatchObject({ encrypted: true, status: { state: 'ok' } });
  });

  it('changes the schedule, retention and speed, and pauses', async () => {
    const updated = await ok('PUT', `/api/backups/${photosId}`, { schedule: { frequency: 'weekly', time: '23:00', weekday: 0 }, keepDays: 30, speedLimitMbps: null });
    expect(updated).toMatchObject({ keepDays: 30, speedLimitMbps: null, schedule: { frequency: 'weekly', time: '23:00', weekday: 0 } });
    const rec = ctx.store.get().backups.jobs.find((j) => j.id === photosId)!;
    expect(a.state.snapshotTasks.find((t) => t.id === rec.snapshotTaskId)).toMatchObject({ lifetime_value: 30, schedule: { minute: '0', hour: '23', dow: '7' } });
    expect(a.state.replications.find((r) => r.id === rec.replicationId)!.fields.speed_limit).toBeNull();
    const paused = await ok('PUT', `/api/backups/${photosId}`, { paused: true });
    expect(paused).toMatchObject({ paused: true, status: { state: 'paused', nextRunAt: null } });
    expect((await call('POST', `/api/backups/${photosId}/run`)).body.error.code).toBe('PAUSED');
    expect(await ok('PUT', `/api/backups/${photosId}`, { paused: false, ...daily })).toMatchObject({ paused: false, status: { state: 'ok' } });
  });

  it('reports overdue backups with one notice per change', async () => {
    await checkBackups(ctx);
    expect(notices(/may have stopped/)).toBe(0);
    const later = Date.now() + 3 * DAY;
    await checkBackups(ctx, { now: later });
    await checkBackups(ctx, { now: later + 60_000 });
    expect(notices(/Backups of Photos to backup-nas may have stopped/)).toBe(1);
    const overdue = ctx.store.get().notices.find((n) => /Photos.*may have stopped/.test(n.title))!;
    expect(overdue).toMatchObject({ level: 'warning', link: '/backups' });
    await checkBackups(ctx);
    expect(notices(/Backups of Photos to backup-nas are working again/)).toBe(1);
  });

  it('explains a full destination and notices the space problem', async () => {
    const root = b.state.datasets.find((d) => d.id === 'HDDs/apexos-backups/truenas')!;
    const used = (await backups()).destinations[0]!.usedBytes!;
    const shrink = await call('PUT', `/api/backups/destinations/${destId}`, { spaceBytes: Math.round(used / 2) });
    expect(shrink.body.error.fields.spaceBytes).toMatch(/At least/);
    root.quota = used + 2 * GiB;
    root.reservation = root.quota;
    a.state.datasets.find((d) => d.id === 'HDDs/Photos')!.usedBytes += 10 * GiB;
    await new Promise((r) => setTimeout(r, 1100));
    const run = await settle((await ok('POST', `/api/backups/${photosId}/run`)).task.id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/There isn’t enough room on backup-nas/);
    const list = await backups();
    expect(list.backups.find((x) => x.id === photosId)!.status).toMatchObject({ state: 'failed', detail: expect.stringMatching(/enough room/) });
    expect(['nearly-full', 'full']).toContain(list.destinations[0]!.health);
    await checkBackups(ctx);
    expect(notices(/Backing up Photos to backup-nas failed/)).toBe(1);
    expect(notices(/Backup space on backup-nas is almost full|No room left for backups on backup-nas/)).toBe(1);
    // More space fixes it.
    await ok('PUT', `/api/backups/destinations/${destId}`, { spaceBytes: TiB });
    await finished(await ok('POST', `/api/backups/${photosId}/run`));
    await checkBackups(ctx);
    expect(notices(/Backups of Photos to backup-nas are working again/)).toBe(2);
  });

  it('restores a folder into a new folder and shares it', async () => {
    const info = await ok<RestoreInfo>('GET', `/api/backups/${photosId}/restore`);
    expect(info.restorePoints.length).toBeGreaterThanOrEqual(2);
    expect(info).toMatchObject({ encrypted: false, keyFormat: null, defaultPool: 'HDDs', originalExists: true });
    expect(info.suggestedName).toMatch(/^Photos-restored-\d{8}$/);
    const taken = await call('POST', `/api/backups/${photosId}/restore`, { restorePoint: null, name: 'Documents', pool: 'HDDs' });
    expect(taken.status).toBe(409);
    const t = await finished(await ok('POST', `/api/backups/${photosId}/restore`, { restorePoint: info.restorePoints.at(-1)!.name, name: info.suggestedName, pool: 'HDDs' }));
    expect(t.steps.map((s) => s.status)).toEqual(['success', 'success', 'success']);
    const ds = a.state.datasets.find((d) => d.id === `HDDs/${info.suggestedName}`)!;
    expect(ds.props.readonly).toBeUndefined();
    expect(a.state.snapshots.some((s) => s.dataset === ds.id)).toBe(false);
    expect(a.state.fs.nodes.some((n) => n.path === `/mnt/HDDs/${info.suggestedName}/IMG_4821.HEIC`)).toBe(true);
    const { folders } = await ok<FoldersResponse>('GET', '/api/folders');
    const restored = folders.find((f) => f.name === info.suggestedName)!;
    // Same access as the original: private to alice.
    expect(restored).toMatchObject({ shared: true, access: 'private', users: [{ username: 'alice', level: 'full' }] });
    expect(notices(new RegExp(`Photos was restored as ${info.suggestedName}`))).toBe(1);
  });

  it('restores an encrypted folder locked, and unlocks it with the passphrase', async () => {
    const info = await ok<RestoreInfo>('GET', `/api/backups/${documentsId}/restore`);
    expect(info).toMatchObject({ encrypted: true, keyFormat: 'passphrase' });
    const locked = await finished(await ok('POST', `/api/backups/${documentsId}/restore`, { restorePoint: null, name: 'Documents-locked', pool: 'HDDs' }));
    expect(locked.steps.at(-1)!.message).toMatch(/still locked/);
    expect(a.state.datasets.find((d) => d.id === 'HDDs/Documents-locked')!.encryption).toMatchObject({ keyLoaded: false });
    expect(a.state.shares.some((s) => s.name === 'Documents-locked')).toBe(false);
    await finished(await ok('POST', `/api/backups/${documentsId}/restore`, { restorePoint: null, name: 'Documents-open', pool: 'SSDs', secret: 'correct horse battery staple' }));
    expect(a.state.datasets.find((d) => d.id === 'SSDs/Documents-open')!.encryption).toMatchObject({ keyLoaded: true });
    expect(a.state.shares.some((s) => s.name === 'Documents-open')).toBe(true);
  });

  it('needs a fresh copy after the folder was encrypted, and makes one', async () => {
    const photos = a.state.datasets.find((d) => d.id === 'HDDs/Photos')!;
    photos.encryption = encrypted('HEX', 'ab'.repeat(32));
    const before = (await backups()).backups.find((x) => x.id === photosId)!;
    expect(before.status).toMatchObject({ state: 'needs-fresh-copy', detail: expect.stringMatching(/was encrypted after its backup started/) });
    await new Promise((r) => setTimeout(r, 1100));
    await finished(await ok('POST', `/api/backups/${photosId}/fresh-copy`));
    expect(b.state.datasets.find((d) => d.id === 'HDDs/apexos-backups/truenas/Photos')!.encryption).toMatchObject({ keyLoaded: false });
    expect((await backups()).backups.find((x) => x.id === photosId)!).toMatchObject({ encrypted: true, status: { state: 'ok' } });
  });

  it('treats an offline destination as unreachable and cleans up when it is back', async () => {
    await b.close();
    const list = await backups();
    expect(list.destinations[0]).toMatchObject({ health: 'unreachable', usedBytes: null });
    expect(list.destinations[0]!.problem).toMatch(/Couldn’t reach backup-nas/);
    const run = await call('POST', `/api/backups/${photosId}/run`);
    expect(run.status).toBe(409);
    expect(run.body.error.code).toBe('DESTINATION_UNREACHABLE');
    const restore = await call('GET', `/api/backups/${photosId}/restore`);
    expect(restore.body.error.code).toBe('DESTINATION_UNREACHABLE');

    // A notice only after it stayed unreachable for a while.
    await checkBackups(ctx);
    expect(notices(/Can’t reach backup-nas/)).toBe(0);
    await checkBackups(ctx, { now: Date.now() + UNREACHABLE_NOTICE_AFTER_MS + 60_000 });
    expect(notices(/Can’t reach backup-nas/)).toBe(1);

    // Removing a backup while B is off: tasks go now, the copy is deleted when B is back.
    await finished(await ok('DELETE', `/api/backups/${documentsId}`));
    const rec = { replication: a.state.replications.length, tasks: a.state.snapshotTasks.length };
    expect(rec).toEqual({ replication: 1, tasks: 1 });
    expect(a.state.snapshots.some((s) => s.dataset === 'HDDs/Documents' && s.name.startsWith('apexosbk-'))).toBe(false);
    const pending = (await backups()).pendingCleanups;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ destinationName: 'backup-nas', description: expect.stringMatching(/Documents/) });

    b = await startMockTrueNas({ jobDelayMs: 0, stateFile: bState, port: bPort });
    expect(b.state.datasets.some((d) => d.id === 'HDDs/apexos-backups/truenas/Documents')).toBe(true);
    await checkBackups(ctx);
    expect(b.state.datasets.some((d) => d.id === 'HDDs/apexos-backups/truenas/Documents')).toBe(false);
    expect(ctx.store.get().backups.cleanups).toEqual([]);
    expect(notices(/Finished cleaning up on backup-nas/)).toBe(1);
    expect(notices(/backup-nas is reachable again/)).toBe(1);
  });

  it('removes a backup: tasks and snapshots here, the copy there', async () => {
    const rec = ctx.store.get().backups.jobs.find((j) => j.id === photosId)!;
    await finished(await ok('DELETE', `/api/backups/${photosId}`));
    expect(a.state.replications.some((r) => r.id === rec.replicationId)).toBe(false);
    expect(a.state.snapshotTasks.some((t) => t.id === rec.snapshotTaskId)).toBe(false);
    expect(a.state.snapshots.some((s) => s.dataset === 'HDDs/Photos' && s.name.startsWith('apexosbk-'))).toBe(false);
    expect(b.state.datasets.some((d) => d.id === 'HDDs/apexos-backups/truenas/Photos')).toBe(false);
    expect(ctx.store.get().backups.jobs).toEqual([]);
  });

  it('removes a destination and everything ApexOs set up there', async () => {
    const dest = ctx.store.get().backups.destinations[0]!;
    await finished(await ok('POST', '/api/backups', { destinationId: destId, folders: ['Photos'], ...daily }));
    await drain('backup-run');
    await finished(await ok('DELETE', `/api/backups/destinations/${destId}`));
    expect(b.state.users.some((u) => u.username === 'apexosbk_truenas')).toBe(false);
    expect(b.state.groups.some((g) => g.name === 'apexosbk_truenas')).toBe(false);
    expect(b.state.datasets.some((d) => d.id.startsWith('HDDs/apexos-backups'))).toBe(false);
    expect(b.state.services.find((s) => s.service === 'ssh')).toMatchObject({ enable: false, state: 'STOPPED' });
    expect(b.state.apiKeys.some((k) => k.id === dest.apiKeyId)).toBe(false);
    expect(a.state.keychain).toEqual([]);
    expect(a.state.replications).toEqual([]);
    expect(a.state.snapshotTasks).toEqual([]);
    expect(ctx.store.get().backups).toMatchObject({ destinations: [], jobs: [], cleanups: [] });
  });

  it('refuses unencrypted folders on an encrypted destination pool, and cleans up an offline destination later', async () => {
    const cState = join(dataDir, 'c.json');
    c = await startMockTrueNas({ jobDelayMs: 0, scenario: 'configured', hostname: 'vault', adminPassword: 'vault-password', stateFile: cState });
    const ssds = c.state.datasets.find((d) => d.id === 'SSDs')!;
    ssds.encryption = encrypted('HEX', 'ef'.repeat(32));
    const creds = { method: 'password', username: 'truenas_admin', password: 'vault-password', address: addressOf(c) };
    const check = await ok<DestinationCheck>('POST', '/api/backups/destinations/check', creds);
    expect(check.pools.find((p) => p.name === 'SSDs')).toMatchObject({ encrypted: true, usable: true, note: expect.stringMatching(/only encrypted folders/) });
    await finished(await ok('POST', '/api/backups/destinations', { ...creds, pool: 'SSDs', spaceBytes: 100 * GiB }));
    const dest = ctx.store.get().backups.destinations[0]!;
    expect(dest.encryptedOnly).toBe(true);
    expect((await backups()).destinations[0]).toMatchObject({ name: 'vault', encryptedOnly: true });

    const plain = await call('POST', '/api/backups', { destinationId: dest.id, folders: ['Media'], ...daily });
    expect(plain.status).toBe(400);
    expect(plain.body.error.code).toBe('ENCRYPTED_DESTINATION');
    expect(plain.body.error.message).toMatch(/only encrypted folders can be stored there/);
    // The encrypted folder is accepted and arrives raw (its own encryption, not the pool's).
    await finished(await ok('POST', '/api/backups', { destinationId: dest.id, folders: ['Documents'], ...daily }));
    await drain('backup-run');
    const copy = c.state.datasets.find((d) => d.id === 'SSDs/apexos-backups/truenas/Documents')!;
    expect(copy.encryption).toMatchObject({ keyFormat: 'PASSPHRASE', keyLoaded: false });
    // The backup area itself only inherits the pool's encryption.
    expect(c.state.datasets.find((d) => d.id === 'SSDs/apexos-backups/truenas')!.encryption).toBeUndefined();

    // Removing the destination while it's off: this side now, the other side once it's back.
    const port = c.server.port;
    await c.close();
    await finished(await ok('DELETE', `/api/backups/destinations/${dest.id}`));
    expect(a.state.keychain).toEqual([]);
    expect(ctx.store.get().backups.destinations).toEqual([]);
    expect(ctx.store.get().backups.cleanups).toHaveLength(1);
    c = await startMockTrueNas({ jobDelayMs: 0, stateFile: cState, port });
    await checkBackups(ctx);
    expect(ctx.store.get().backups.cleanups).toEqual([]);
    expect(c.state.datasets.some((d) => d.id.startsWith('SSDs/apexos-backups'))).toBe(false);
    expect(c.state.users.some((u) => u.username.startsWith('apexosbk_'))).toBe(false);
    expect(c.state.services.find((s) => s.service === 'ssh')).toMatchObject({ enable: false });
  });
});
