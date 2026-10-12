/**
 * Pool data errors (damaged-file list, Repair, Reset error count) against the simulated TrueNAS.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolDataErrors, StorageOverview, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { forgetChecks } from '../src/services/pool-checks.ts';
import {
  classifyEntry,
  forgetPoolErrorState,
  isSafeCatalogPath,
  MAX_REPAIR_FILES,
  parseErrorList,
  summarize,
} from '../src/services/pool-errors.ts';

const CATALOG = '/mnt/.ix-apps/truenas_catalog';
const catalogFile = (i: number) => `${CATALOG}/trains/community/app${i}/app_versions.json`;

describe('classifying the permanent-error list', () => {
  it('sorts every kind of entry', () => {
    const kinds = (raw: string) => {
      const e = classifyEntry(raw, CATALOG);
      return [e.kind, e.path, e.snapshot];
    };
    expect(kinds(`${CATALOG}/trains/stable/plex/1.2.3/app.yaml`)).toEqual(['catalog', `${CATALOG}/trains/stable/plex/1.2.3/app.yaml`, null]);
    expect(kinds('/mnt/HDDs/Media/Movies/film.mkv')).toEqual(['user', '/mnt/HDDs/Media/Movies/film.mkv', null]);
    expect(kinds('/mnt/HDDs/Photos/me@home.jpg')).toEqual(['user', '/mnt/HDDs/Photos/me@home.jpg', null]);
    expect(kinds('HDDs/Media@auto-2026-10-01_00-00:/Movies/film.mkv')).toEqual(['snapshot', '/Movies/film.mkv', 'HDDs/Media@auto-2026-10-01_00-00']);
    expect(kinds('HDDs/my:data@snap:1:/a.txt')).toEqual(['snapshot', '/a.txt', 'HDDs/my:data@snap:1']);
    expect(kinds('HDDs/Media@daily:<0x2f>')).toEqual(['snapshot', null, 'HDDs/Media@daily']);
    expect(kinds('<0x40>:<0x1a0>')).toEqual(['unreadable', null, null]);
    expect(kinds('<metadata>:<0x1b>')).toEqual(['unreadable', null, null]);
    expect(kinds('HDDs/Media:<0x2f>')).toEqual(['unreadable', null, null]);
    // Unmounted dataset or unknown format: the user's, never deleted.
    expect(kinds('HDDs/Media:/Movies/film.mkv')[0]).toBe('user');
    expect(kinds('something odd')[0]).toBe('user');
  });

  it('only trusts clean paths strictly inside the catalog directory', () => {
    for (const bad of [
      `${CATALOG}/../../HDDs/secret`,
      `${CATALOG}/trains/./x`,
      `${CATALOG}//trains/x`,
      `${CATALOG}/trains/x/`,
      `${CATALOG}/trains/x\u0007`,
      `${CATALOG}/trains/x\u2028y`,
      CATALOG,
      `${CATALOG}_evil/x`,
      '/mnt/.ix-apps/other/x',
      'mnt/.ix-apps/truenas_catalog/x',
    ]) {
      expect(isSafeCatalogPath(bad, CATALOG), bad).toBe(false);
      expect(classifyEntry(bad, CATALOG).kind, bad).not.toBe('catalog');
    }
    expect(isSafeCatalogPath(`${CATALOG}/x`, '/')).toBe(false);
    expect(isSafeCatalogPath(`${CATALOG}/x`, '/mnt')).toBe(false);
    expect(isSafeCatalogPath(`${CATALOG}/trains/x`, CATALOG)).toBe(true);
  });

  it('parses zpool status -v and refuses output it does not understand', () => {
    const status = (errors: string) => `  pool: HDDs\n state: ONLINE\nconfig:\n\n\tNAME STATE\n\tHDDs ONLINE\n\n${errors}\n`;
    expect(parseErrorList(status('errors: No known data errors'), 'HDDs')).toEqual([]);
    expect(
      parseErrorList(status('errors: Permanent errors have been detected in the following files:\n\n        /mnt/HDDs/a b.txt\n        <0x1>:<0x2>'), 'HDDs'),
    ).toEqual(['/mnt/HDDs/a b.txt', '<0x1>:<0x2>']);
    expect(() => parseErrorList(status("errors: 2 data errors, use '-v' for a list"), 'HDDs')).toThrow();
    expect(() => parseErrorList(status('errors: List of errors unavailable: permission denied'), 'HDDs')).toThrow();
    expect(() => parseErrorList(status('errors: No known data errors'), 'SSDs')).toThrow();
    expect(() => parseErrorList('cannot open pool', 'HDDs')).toThrow();
  });

  it('derives the pool card state', () => {
    const entries = (...raws: string[]) => raws.map((r) => classifyEntry(r, CATALOG));
    expect(summarize([], null)).toMatchObject({ state: 'none', label: null });
    expect(summarize(entries(catalogFile(1)), null)).toMatchObject({ state: 'quick-repair', label: 'Needs a quick repair' });
    expect(summarize(entries(catalogFile(1), '/mnt/HDDs/a', 'HDDs/x@s:/b'), null)).toMatchObject({
      state: 'user-files',
      label: "2 files can't be read",
      userFiles: 2,
      catalogFiles: 1,
    });
    expect(summarize(entries('<0x1>:<0x2>'), null)).toMatchObject({ state: 'data-errors', label: 'Data errors', unreadable: 1 });
    expect(summarize([], 'timed out')).toMatchObject({ state: 'data-errors', readError: 'timed out' });
    const many = Array.from({ length: MAX_REPAIR_FILES + 1 }, (_, i) => catalogFile(i));
    expect(summarize(entries(...many), null).state).toBe('data-errors');
  });
});

describe('Repair, Check pool and Reset error count', () => {
  let mock: MockTrueNas;
  let app: FastifyInstance;
  let ctx: AppContext;
  let dataDir: string;
  let cookie = '';

  async function call<T>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
    const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
    return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T) };
  }
  async function ok<T>(method: string, url: string, payload?: unknown): Promise<T> {
    const res = await call<T>(method, url, payload);
    if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  }
  async function settled(started: { task: Task }): Promise<Task> {
    for (let i = 0; i < 1000; i++) {
      const t = ctx.tasks.get(started.task.id)!;
      if (t.status !== 'running') return t;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Task did not finish');
  }
  async function pool(name: string): Promise<Pool> {
    return (await ok<StorageOverview>('GET', '/api/storage')).pools.find((p) => p.name === name)!;
  }
  async function errorsOf(name: string): Promise<PoolDataErrors> {
    return ok<PoolDataErrors>('GET', `/api/storage/pools/${(await pool(name)).id}/errors?fresh=1`);
  }
  async function repair(name: string, fingerprint: string) {
    return call<{ task: Task } & { error?: { code: string; message: string } }>('POST', `/api/storage/pools/${(await pool(name)).id}/repair`, {
      fingerprint,
    });
  }
  async function checkAndWait(name: string): Promise<void> {
    await ok('POST', `/api/storage/pools/${(await pool(name)).id}/scrub`);
    for (let i = 0; i < 500; i++) {
      if (mock.state.pools.find((p) => p.name === name)!.scan?.state === 'FINISHED') return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('Check did not finish');
  }
  const ssds = () => mock.state.pools.find((p) => p.name === 'SSDs')!;

  beforeAll(async () => {
    forgetChecks();
    mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key', scenario: 'configured' });
    dataDir = await mkdtemp(join(tmpdir(), 'apexos-repair-test-'));
    const store = new StateStore(dataDir);
    await store.load();
    const truenas = new TrueNasManager();
    await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
    ctx = { store, truenas, tasks: new TaskManager(), bus: new Bus(), host: new HostCommands(truenas), scripts: new Map(), demo: true };
    app = await buildApp(ctx);
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'correct-horse' } });
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
  });

  beforeEach(() => {
    forgetPoolErrorState();
    mock.setDataErrors('SSDs', []);
    mock.setDataErrors('HDDs', []);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.truenas.close();
    await mock?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('reads the catalog location from TrueNAS and classifies the live list', async () => {
    mock.setDataErrors('HDDs', [
      '/mnt/HDDs/Media/Movies/film.mkv',
      'HDDs/Photos@auto-2026-10-01:/2024/beach.jpg',
      '<0x40>:<0x1a0>',
      catalogFile(1),
    ]);
    const list = await errorsOf('HDDs');
    expect(list.catalogLocation).toBe(CATALOG);
    expect(list.entries.map((e) => e.kind)).toEqual(['user', 'snapshot', 'unreadable', 'catalog']);
    expect(list).toMatchObject({ state: 'user-files', label: "2 files can't be read", singleCopy: false, drivesLookHealthy: true });
    expect(list.repair).toMatchObject({ allowed: false, code: 'USER_FILES' });
    expect(list.fingerprint).toMatch(/^[0-9a-f]{32}$/);

    // Pool cards get a summary only for pools that look damaged.
    const storage = await ok<StorageOverview>('GET', '/api/storage');
    expect(storage.pools.find((p) => p.name === 'HDDs')!.dataErrors).toMatchObject({ state: 'user-files', userFiles: 2, catalogFiles: 1 });
    expect(storage.pools.find((p) => p.name === 'SSDs')!.dataErrors).toBeUndefined();

    // Damage raises one notice, not one per page load.
    await ok('GET', '/api/storage');
    expect(ctx.store.get().notices.filter((n) => n.title.includes('HDDs'))).toHaveLength(1);
  });

  it('never reports "no errors" when the list cannot be read', async () => {
    mock.setDataErrors('HDDs', ['/mnt/HDDs/Media/a.mkv']);
    const helper = mock.state.users.find((u) => u.username === 'apexos_helper')!;
    const saved = helper.sudo_commands_nopasswd;
    helper.sudo_commands_nopasswd = [];
    // HostCommands re-checks the helper only per connection, so the broken sudo rule sticks.
    try {
      const list = await errorsOf('HDDs');
      expect(list.state).toBe('data-errors');
      expect(list.readError).toBeTruthy();
      expect(list.repair.code).toBe('LIST_UNREADABLE');
    } finally {
      helper.sudo_commands_nopasswd = saved;
    }
  });

  it('repairs damaged catalog files end to end without clearing counters', async () => {
    mock.setDataErrors('SSDs', [catalogFile(1), catalogFile(2), catalogFile(3)]);
    mock.addDriveErrors('nvme0n1', { checksum: 2 });
    mock.state.catalog.synced = false;
    const list = await errorsOf('SSDs');
    expect(list).toMatchObject({ state: 'quick-repair', label: 'Needs a quick repair', catalogFiles: 3 });
    expect(list.repair).toEqual({ allowed: true, code: null, reason: null });

    const res = await repair('SSDs', list.fingerprint);
    expect(res.status).toBe(200);
    const task = await settled(res.body);
    expect(task.error).toBeUndefined();
    expect(task).toMatchObject({ status: 'success', type: 'pool-repair' });
    expect(task.steps.map((s) => [s.name, s.status])).toEqual([
      ['Re-reading the list of damaged files', 'success'],
      ['Removing the damaged app catalog files', 'success'],
      ['Checking the whole pool', 'success'],
      ['Refreshing the app catalog', 'success'],
    ]);
    expect(ssds().dataErrors).toBeUndefined();
    expect(ssds().scan).toMatchObject({ function: 'SCRUB', state: 'FINISHED', errors: 0 });
    expect(mock.state.catalog.synced).toBe(true);
    // Counters are left alone; resetting them is a separate decision.
    const leaf = ssds().topology.data.flatMap((v) => v.children).find((l) => l.errors.checksum === 2);
    expect(leaf).toBeDefined();

    const after = await errorsOf('SSDs');
    expect(after.state).toBe('none');
    expect(after.entries).toEqual([]);
    // The repair's check counts as a clean ApexOs check.
    expect(after.lastCheck).toBe('clean');
    expect(after.resetErrors.allowed).toBe(true);
    mock.restoreDrive('nvme0n1');
  });

  it('refuses while any user file is listed, then allows Repair once it is gone', async () => {
    mock.setDataErrors('SSDs', [catalogFile(1), '/mnt/SSDs/Applications/notes.txt']);
    const list = await errorsOf('SSDs');
    expect(list.state).toBe('user-files');
    const res = await repair('SSDs', list.fingerprint);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('USER_FILES');
    expect(ssds().dataErrors).toEqual([catalogFile(1), '/mnt/SSDs/Applications/notes.txt']);

    // The user deletes their file over the share: ZFS keeps an object reference until the next check.
    await ctx.host.runChecked('rm', ['--', '/mnt/SSDs/Applications/notes.txt']);
    const next = await errorsOf('SSDs');
    expect(next.state).toBe('quick-repair');
    expect(next.repair.allowed).toBe(true);
  });

  it('refuses a fingerprint that does not match the current list', async () => {
    mock.setDataErrors('SSDs', [catalogFile(1)]);
    await errorsOf('SSDs');
    const res = await repair('SSDs', 'not-the-fingerprint');
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('FINGERPRINT_CHANGED');
    expect(ssds().dataErrors).toEqual([catalogFile(1)]);
  });

  it('aborts without deleting anything when the list changed after the click', async () => {
    mock.setDataErrors('SSDs', [catalogFile(1)]);
    const list = await errorsOf('SSDs');
    // Changes after the user looked (the cached read still matches what they saw).
    mock.setDataErrors('SSDs', [catalogFile(1), catalogFile(2)]);
    const res = await repair('SSDs', list.fingerprint);
    expect(res.status).toBe(200);
    const task = await settled(res.body);
    expect(task.status).toBe('failed');
    expect(task.error).toMatch(/^Re-reading the list of damaged files failed: .*changed.*Nothing was deleted/);
    expect(task.steps[1]!.status).toBe('pending');
    expect(ssds().dataErrors).toEqual([catalogFile(1), catalogFile(2)]);
  });

  it(`refuses more than ${MAX_REPAIR_FILES} damaged system files`, async () => {
    const files = Array.from({ length: MAX_REPAIR_FILES + 1 }, (_, i) => catalogFile(i));
    mock.setDataErrors('SSDs', files);
    const list = await errorsOf('SSDs');
    expect(list).toMatchObject({ state: 'data-errors', label: 'Data errors' });
    expect(list.repair.code).toBe('TOO_MANY_FILES');
    const res = await repair('SSDs', list.fingerprint);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('TOO_MANY_FILES');
    expect(ssds().dataErrors).toHaveLength(MAX_REPAIR_FILES + 1);
  });

  it('never deletes a path that escapes the catalog directory', async () => {
    const escaping = `${CATALOG}/../../HDDs/secret`;
    mock.setDataErrors('SSDs', [catalogFile(1), escaping]);
    const list = await errorsOf('SSDs');
    expect(list.entries.find((e) => e.raw === escaping)!.kind).toBe('user');
    const res = await repair('SSDs', list.fingerprint);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('USER_FILES');
    expect(ssds().dataErrors).toEqual([catalogFile(1), escaping]);
  });

  it('refuses when the pool is unavailable', async () => {
    mock.setDataErrors('SSDs', [catalogFile(1)]);
    const list = await errorsOf('SSDs');
    mock.failDrive('nvme0n1');
    mock.failDrive('nvme1n1');
    try {
      expect((await pool('SSDs')).health).toBe('offline');
      const res = await repair('SSDs', list.fingerprint);
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('POOL_UNAVAILABLE');
      expect((await errorsOf('SSDs')).resetErrors.code).toBe('POOL_UNAVAILABLE');
      expect(ssds().dataErrors).toEqual([catalogFile(1)]);
    } finally {
      mock.restoreDrive('nvme0n1');
      mock.restoreDrive('nvme1n1');
    }
  });

  it('fails clearly when the check finds damage the repair could not fix', async () => {
    mock.setDataErrors('SSDs', [catalogFile(1)]);
    mock.addLatentDataErrors('SSDs', ['/mnt/SSDs/Applications/db.sqlite']);
    mock.state.catalog.synced = false;
    const list = await errorsOf('SSDs');
    const task = await settled((await repair('SSDs', list.fingerprint)).body);
    expect(task.status).toBe('failed');
    expect(task.error).toMatch(/^Checking the whole pool failed: The check found 1 more damaged file\. 1 of them is one of your files/);
    expect(task.steps.map((s) => s.status)).toEqual(['success', 'success', 'failed', 'pending']);
    expect(mock.state.catalog.synced).toBe(false);
    const after = await errorsOf('SSDs');
    expect(after).toMatchObject({ state: 'user-files', lastCheck: 'errors' });
    expect(after.entries.map((e) => e.raw)).toEqual(['/mnt/SSDs/Applications/db.sqlite']);
  });

  it('points to memory or cables when the drives look healthy', async () => {
    mock.setDataErrors('HDDs', ['/mnt/HDDs/Media/a.mkv']);
    expect((await errorsOf('HDDs')).drivesLookHealthy).toBe(true);
    mock.addDriveErrors('sdb', { read: 1 });
    expect((await errorsOf('HDDs')).drivesLookHealthy).toBe(false);
    mock.restoreDrive('sdb');
  });

  it('resets error counts only after a clean ApexOs check, and not after a reboot', async () => {
    forgetChecks();
    mock.addDriveErrors('sdc', { checksum: 3 });
    const hdds = await pool('HDDs');
    const before = await errorsOf('HDDs');
    expect(before.resetErrors).toMatchObject({ allowed: false, code: 'NO_CLEAN_CHECK' });
    const refused = await call<{ error: { code: string } }>('POST', `/api/storage/pools/${hdds.id}/reset-errors`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NO_CLEAN_CHECK');

    await checkAndWait('HDDs');
    const clean = await errorsOf('HDDs');
    expect(clean.lastCheck).toBe('clean');
    expect(clean.resetErrors).toEqual({ allowed: true, code: null, reason: null });
    expect(await ok('POST', `/api/storage/pools/${hdds.id}/reset-errors`)).toEqual({ ok: true });
    expect((await pool('HDDs')).errors).toEqual({ read: 0, write: 0, checksum: 0 });

    mock.addDriveErrors('sdc', { checksum: 1 });
    await ctx.truenas.client().job('system.reboot', ['test']);
    const stale = await errorsOf('HDDs');
    expect(stale.resetErrors).toMatchObject({ allowed: false, code: 'RESTARTED' });
    expect((await call('POST', `/api/storage/pools/${hdds.id}/reset-errors`)).status).toBe(409);

    mock.failDrive('sdd', 'OFFLINE');
    expect((await errorsOf('HDDs')).resetErrors.code).toBe('DRIVE_MISSING');
    mock.restoreDrive('sdd');
    mock.restoreDrive('sdc');
  });
});
