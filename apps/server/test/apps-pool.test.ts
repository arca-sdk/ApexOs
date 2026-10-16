/**
 * Choosing and changing the pool apps run from, after setup: moving installed apps, erasing app data left
 * on a pool from an earlier time (with consent), and giving apps a new pool after theirs was deleted.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppsPoolPreview, AppsResponse, Notice, Pool, StorageOverview, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { oldAppDataHousekeeping } from '../src/services/apps-pool.ts';
import { recordTaskNotices } from '../src/services/notifications.ts';

let mock: MockTrueNas;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let cookie = '';
const DAY = 24 * 3600_000;

async function call<T>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T) };
}

async function ok<T>(method: string, url: string, payload?: unknown): Promise<T> {
  const res = await call<T>(method, url, payload);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function finished(started: { task: Task }): Promise<Task> {
  for (let i = 0; i < 400; i++) {
    const t = ctx.tasks.get(started.task.id)!;
    if (t.status !== 'running') {
      if (t.status === 'failed') throw new Error(`Task "${t.title}" failed: ${t.error}`);
      return t;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Task did not finish');
}

const preview = (pool: string) => ok<AppsPoolPreview>('GET', `/api/apps/pool?pool=${pool}`);
const engine = async () => (await ok<AppsResponse>('GET', '/api/apps')).engine;

beforeAll(async () => {
  // Configured scenario: HDDs and SSDs pools, apps (Jellyfin, running) on SSDs.
  mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key', scenario: 'configured' });
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-apps-pool-'));
  const store = new StateStore(dataDir);
  await store.load();
  const truenas = new TrueNasManager();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
  ctx = { store, truenas, tasks: new TaskManager(), bus: new Bus(), host: new HostCommands(truenas), scripts: new Map(), demo: true };
  recordTaskNotices(ctx);
  app = await buildApp(ctx);
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'correct-horse' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('the apps pool', () => {
  it('explains what moving apps involves', async () => {
    expect((await preview('SSDs')).problem).toBe('Apps already run from SSDs.');
    expect((await call('GET', '/api/apps/pool?pool=nope')).status).toBe(404);
    const p = await preview('HDDs');
    expect(p).toMatchObject({ pool: 'HDDs', currentPool: 'SSDs', currentPoolOffline: false, moving: ['Jellyfin'], oldAppData: false, needsEraseConsent: false, problem: null });
    expect(p.copyBytes).toBeGreaterThan(0);
  });

  it('moves installed apps to another pool and starts them again', async () => {
    const started = await ok<{ task: Task }>('PUT', '/api/apps/pool', { pool: 'HDDs' });
    expect(started.task).toMatchObject({ type: 'apps-pool', title: 'Moving apps to HDDs' });
    // App changes wait while apps move.
    const stop = await call<{ error: { code: string } }>('POST', '/api/apps/jellyfin/stop');
    expect(stop.status).toBe(409);
    expect(stop.body.error.code).toBe('BUSY');
    expect((await call('PUT', '/api/apps/pool', { pool: 'HDDs' })).status).toBe(409);

    const task = await finished(started);
    expect(task.steps.map((s) => [s.name, s.status])).toEqual([['Moving apps', 'success']]);
    const apps = await ok<AppsResponse>('GET', '/api/apps');
    expect(apps.engine).toMatchObject({ pool: 'HDDs', status: 'RUNNING' });
    expect(apps.apps.map((a) => [a.name, a.state])).toEqual([['jellyfin', 'running']]);
    const storage = await ok<StorageOverview>('GET', '/api/storage');
    expect(storage.pools.filter((p) => p.isAppsPool).map((p) => p.name)).toEqual(['HDDs']);
    // The copy TrueNAS left on SSDs is shown there and kept for a week.
    const left = (await pool('SSDs')).oldAppData!;
    expect(left).toMatchObject({ movedTo: 'HDDs' });
    expect(left.usedBytes).toBeGreaterThan(0);
    expect(Date.parse(left.removeAfter) - Date.now()).toBeGreaterThan(6.9 * DAY);
    expect((await pool('HDDs')).oldAppData).toBeUndefined();
    const { notices } = await ok<{ notices: Notice[] }>('GET', '/api/notifications');
    expect(notices.map((n) => n.title)).toContain('Apps now run from HDDs');
  });

  it('erases app data left on a pool only with consent', async () => {
    // TrueNAS kept the old copy on SSDs and won't copy over it.
    const p = await preview('SSDs');
    expect(p).toMatchObject({ currentPool: 'HDDs', moving: ['Jellyfin'], oldAppData: true, needsEraseConsent: true, problem: null });
    const refused = await call<{ error: { code: string } }>('PUT', '/api/apps/pool', { pool: 'SSDs' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('CONSENT_REQUIRED');

    const task = await finished(await ok<{ task: Task }>('PUT', '/api/apps/pool', { pool: 'SSDs', eraseOldAppData: true }));
    expect(task.steps.map((s) => s.name)).toEqual(['Erasing old app data', 'Moving apps']);
    expect(await engine()).toMatchObject({ pool: 'SSDs', status: 'RUNNING' });
    expect((await ok<AppsResponse>('GET', '/api/apps')).apps.map((a) => [a.name, a.state])).toEqual([['jellyfin', 'running']]);
    expect((await pool('SSDs')).oldAppData).toBeUndefined();
    expect((await pool('HDDs')).oldAppData).toMatchObject({ movedTo: 'SSDs' });
  });

  it('removes the copy left behind after a week', async () => {
    await ctx.store.update((s) => {
      s.oldAppData!.HDDs!.removeAfter = new Date(Date.now() - 1000).toISOString();
    });
    // Nothing is removed while apps move (the cleanup runs as a task that moves wait for, and vice versa).
    let release!: () => void;
    const moving = ctx.tasks.start({ type: 'apps-pool', title: 'Moving apps', ref: 'SSDs' }, () => new Promise<void>((r) => (release = r)));
    expect(await oldAppDataHousekeeping(ctx)).toBeNull();
    release();
    await finished({ task: moving });

    const task = await oldAppDataHousekeeping(ctx);
    expect(task).toMatchObject({ type: 'apps-old-data', title: 'Removing old app data from HDDs' });
    await finished({ task: task! });
    expect((await pool('HDDs')).oldAppData).toBeUndefined();
    expect((await preview('HDDs')).oldAppData).toBe(false);
    expect(ctx.store.get().oldAppData).toEqual({});
  });

  it('removes the copy left behind on request, never the one apps run from', async () => {
    // HDDs has no app data any more, so nothing needs erasing this time.
    expect((await preview('HDDs')).needsEraseConsent).toBe(false);
    await finished(await ok<{ task: Task }>('PUT', '/api/apps/pool', { pool: 'HDDs' }));
    const ssds = await pool('SSDs');
    expect(ssds.oldAppData).toBeDefined();
    expect((await call('DELETE', `/api/storage/pools/${(await pool('HDDs')).id}/old-app-data`)).status).toBe(404);

    const task = await finished(await ok<{ task: Task }>('DELETE', `/api/storage/pools/${ssds.id}/old-app-data`));
    expect(task.title).toBe('Removing old app data from SSDs');
    expect((await pool('SSDs')).oldAppData).toBeUndefined();
    expect((await preview('SSDs')).oldAppData).toBe(false);
    expect(await engine()).toMatchObject({ pool: 'HDDs', status: 'RUNNING' });

    // Back to SSDs for the next test (nothing to erase there now).
    await finished(await ok<{ task: Task }>('PUT', '/api/apps/pool', { pool: 'SSDs' }));
    expect(await engine()).toMatchObject({ pool: 'SSDs' });
  });

  it('gives apps a newly created pool after their pool was deleted', async () => {
    await finished(await ok<{ task: Task }>('DELETE', '/api/storage/pools/' + (await poolId('SSDs')), { confirmName: 'SSDs' }));
    expect(await engine()).toMatchObject({ pool: null });

    // Choosing an existing pool is possible too; nothing moves and nothing is erased.
    expect(await preview('HDDs')).toMatchObject({ currentPool: null, moving: [], oldAppData: true, needsEraseConsent: false, problem: null });

    const storage = await ok<StorageOverview>('GET', '/api/storage');
    const nvme = storage.unassigned.filter((d) => d.available && d.kind === 'NVME').map((d) => d.identifier);
    expect(nvme).toHaveLength(2);
    await finished(await ok<{ task: Task }>('POST', '/api/storage/pools', { name: 'Fast', layout: 'MIRROR', drives: nvme }));
    expect(await engine()).toMatchObject({ pool: 'Fast', status: 'RUNNING' });
  });

  it('leaves the apps pool alone when another pool is created', async () => {
    const storage = await ok<StorageOverview>('GET', '/api/storage');
    const free = storage.unassigned.filter((d) => d.available && d.kind !== 'USB').map((d) => d.identifier);
    expect(free.length).toBeGreaterThan(0);
    await finished(await ok<{ task: Task }>('POST', '/api/storage/pools', { name: 'Extra', layout: 'STRIPE', drives: free.slice(0, 1) }));
    expect(await engine()).toMatchObject({ pool: 'Fast' });
  });
});

async function pool(name: string): Promise<Pool> {
  const storage = await ok<StorageOverview>('GET', '/api/storage');
  return storage.pools.find((p) => p.name === name)!;
}

async function poolId(name: string): Promise<number> {
  return (await pool(name)).id;
}
