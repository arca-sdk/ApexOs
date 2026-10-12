/**
 * End-to-end tests: the real ApexOs HTTP API against the simulated TrueNAS middleware.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppsResponse, CatalogAppDetail, CatalogResponse, FoldersResponse, PoolPlan, SetupInfo, SetupReview, ShareUser, StorageOverview, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { loadScripts } from '../src/lib/install-script.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { recordTaskNotices } from '../src/services/notifications.ts';

const catalogDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../catalog');

let mock: MockTrueNas;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let cookie = '';

async function call<T>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: cookie ? { cookie } : {} });
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

beforeAll(async () => {
  mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key' });
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-test-'));
  const store = new StateStore(dataDir);
  await store.load();
  const truenas = new TrueNasManager();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
  ctx = {
    store,
    truenas,
    tasks: new TaskManager(),
    bus: new Bus(),
    host: new HostCommands(truenas),
    scripts: (await loadScripts(catalogDir)).scripts,
    demo: true,
  };
  recordTaskNotices(ctx);
  app = await buildApp(ctx);
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('ApexOs against a fresh simulated TrueNAS', () => {
  it('requires an account, then signs in', async () => {
    expect((await call('GET', '/api/storage')).status).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'correct-horse' } });
    expect(res.statusCode).toBe(200);
    cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const status = await ok<{ authenticated: boolean; setupComplete: boolean }>('GET', '/api/status');
    expect(status).toMatchObject({ authenticated: true, setupComplete: false });
  });

  let setup: SetupInfo;
  it('scans hardware for the wizard', async () => {
    setup = await ok<SetupInfo>('GET', '/api/setup');
    expect(setup.scan.cards.map((c) => c.id)).toEqual(['system', 'storage', 'apps', 'virtualization']);
    const storageCard = setup.scan.cards.find((c) => c.id === 'storage')!;
    expect(storageCard.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['smr', 'existing-data']));
    expect(setup.drives.some((d) => d.kind === 'NVME')).toBe(true);
  });

  let plan: PoolPlan;
  it('recommends a layout per drive kind', async () => {
    plan = await ok<PoolPlan>('POST', '/api/storage/plan', { priority: 'balanced' });
    const layouts = Object.fromEntries(plan.pools.map((p) => [p.name, [p.layout, p.drives.length]]));
    expect(layouts.NVMEs).toEqual(['MIRROR', 2]);
    expect(layouts.HDDs).toEqual(['RAIDZ1', 4]);
  });

  it('reviews and finishes setup', async () => {
    const request = {
      serverName: 'homeserver',
      timezone: setup.timezone,
      keepPools: [],
      importPools: [],
      newPools: plan.pools.map((p) => ({ name: p.name, layout: p.layout, drives: p.drives })),
      consentErase: true,
      consentKeep: false,
    };
    const review = await ok<SetupReview>('POST', '/api/setup/review', request);
    expect(review).toMatchObject({ ok: true, appsPool: 'NVMEs', needsEraseConsent: true });
    const missingConsent = await call('POST', '/api/setup/finish', { ...request, consentErase: false });
    expect(missingConsent.status).toBe(400);
    await finished(await ok<{ task: Task }>('POST', '/api/setup/finish', request));
    expect((await ok<{ setupComplete: boolean }>('GET', '/api/status')).setupComplete).toBe(true);

    const storage = await ok<StorageOverview>('GET', '/api/storage');
    expect(storage.pools.map((p) => [p.name, p.health, p.scrubScheduled]).sort()).toEqual([
      ['HDDs', 'healthy', true],
      ['NVMEs', 'healthy', true],
    ]);
    expect(storage.pools.find((p) => p.name === 'NVMEs')!.isAppsPool).toBe(true);
    expect(storage.pools.find((p) => p.name === 'HDDs')!.layout).toMatchObject({ faultTolerance: 1, expandable: true });
  });

  it('manages users and private folders', async () => {
    const alice = await ok<ShareUser>('POST', '/api/users', { username: 'alice', password: 'alice-password' });
    await ok('POST', '/api/users', { username: 'bob', password: 'bob-password' });
    expect((await call('POST', '/api/users', { username: 'alice', password: 'whatever123' })).status).toBe(409);

    await finished(
      await ok<{ task: Task }>('POST', '/api/folders', {
        name: 'Family',
        pool: 'HDDs',
        access: 'private',
        users: [{ username: 'alice', level: 'full' }],
        quotaBytes: 50 * 1024 ** 3,
        timeMachine: false,
      }),
    );
    let { folders } = await ok<FoldersResponse>('GET', '/api/folders');
    const family = folders.find((f) => f.name === 'Family')!;
    expect(family).toMatchObject({ access: 'private', shared: true, users: [{ username: 'alice', level: 'full' }], quotaBytes: 50 * 1024 ** 3 });
    expect(family.smbUrl).toMatch(/^smb:\/\/.+\/Family$/);

    await finished(
      await ok<{ task: Task }>('PUT', '/api/folders/Family', {
        access: 'private',
        users: [
          { username: 'alice', level: 'read' },
          { username: 'bob', level: 'full' },
        ],
        quotaBytes: null,
        timeMachine: true,
      }),
    );
    ({ folders } = await ok<FoldersResponse>('GET', '/api/folders'));
    expect(folders.find((f) => f.name === 'Family')).toMatchObject({ timeMachine: true, quotaBytes: null });
    const users = await ok<ShareUser[]>('GET', '/api/users');
    expect(users.find((u) => u.id === alice.id)!.folders).toEqual([{ name: 'Family', level: 'read' }]);

    await ok('DELETE', `/api/users/${alice.id}`);
    ({ folders } = await ok<FoldersResponse>('GET', '/api/folders'));
    expect(folders.find((f) => f.name === 'Family')!.users).toEqual([{ username: 'bob', level: 'full' }]);
  });

  it('frees a username after renaming the user', async () => {
    const carol = await ok<ShareUser>('POST', '/api/users', { username: 'carol', password: 'carol-password' });
    await ok('PUT', `/api/users/${carol.id}`, { username: 'caroline' });
    const again = await ok<ShareUser>('POST', '/api/users', { username: 'carol', password: 'carol-password' });
    expect(again.username).toBe('carol');
  });

  it('rejects invalid folders', async () => {
    const res = await call<{ error: { fields?: Record<string, string> } }>('POST', '/api/folders', {
      name: 'bad/name',
      pool: 'HDDs',
      access: 'public',
      users: [],
      quotaBytes: null,
      timeMachine: false,
    });
    // Validation happens inside the task for creates; either an immediate 400 or a failed task is acceptable.
    if (res.status === 200) await expect(finished(res.body as unknown as { task: Task })).rejects.toThrow(/Folder names/);
    else expect(res.status).toBe(400);
  });

  it('installs a curated app with its locations', async () => {
    const catalog = await ok<CatalogResponse>('GET', '/api/apps/catalog?category=curated');
    expect(catalog.apps.find((a) => a.id === 'jellyfin')).toMatchObject({ tier: 'curated' });
    const detail = await ok<CatalogAppDetail>('GET', '/api/apps/catalog/jellyfin');
    expect(detail.requirements?.ok).toBe(true);

    await finished(await ok<{ task: Task }>('POST', '/api/apps/install', { catalogApp: 'jellyfin', train: detail.train, answers: {} }));
    const { apps } = await ok<AppsResponse>('GET', '/api/apps');
    const jellyfin = apps.find((a) => a.catalogApp === 'jellyfin')!;
    expect(jellyfin).toMatchObject({ state: 'running', tier: 'curated' });
    expect(jellyfin.locations).toContain('Movies');

    const locations = await ok<{ id: string; path: string | null; created: boolean; usedBy: unknown[] }[]>('GET', '/api/locations');
    const movies = locations.find((l) => l.id === 'Movies')!;
    expect(movies).toMatchObject({ path: '/mnt/HDDs/Media/Movies', created: true });
    expect(movies.usedBy).toHaveLength(1);

    // A folder holding an in-use location can't be deleted.
    const del = await call('DELETE', '/api/folders/Media', { confirmName: 'Media' });
    expect(del.status).toBe(409);

    await finished(await ok<{ task: Task }>('DELETE', `/api/apps/${jellyfin.name}`, { removeData: true }));
    expect((await ok<AppsResponse>('GET', '/api/apps')).apps.find((a) => a.name === jellyfin.name)).toBeUndefined();
  });

  it('installs a non-curated catalog app with TrueNAS defaults', async () => {
    const catalog = await ok<CatalogResponse>('GET', '/api/apps/catalog?search=uptime');
    const app = catalog.apps.find((a) => a.tier === 'catalog')!;
    expect(app).toBeDefined();
    await finished(await ok<{ task: Task }>('POST', '/api/apps/install', { catalogApp: app.id, train: app.train, answers: {} }));
    const { apps } = await ok<AppsResponse>('GET', '/api/apps');
    expect(apps.find((a) => a.catalogApp === app.id)).toMatchObject({ tier: 'catalog' });
  });

  it('grows and repairs a pool', async () => {
    let storage = await ok<StorageOverview>('GET', '/api/storage');
    const hdds = storage.pools.find((p) => p.name === 'HDDs')!;
    // Only the 4 TB SMR drive is left, which is smaller than the pool's drives.
    const small = storage.unassigned.find((d) => d.kind === 'HDD')!;
    const tooSmall = await call('POST', `/api/storage/pools/${hdds.id}/drives`, { drive: small.identifier });
    if (tooSmall.status === 200) await expect(finished(tooSmall.body as { task: Task })).rejects.toThrow(/at least as large/);
    else expect(tooSmall.status).toBe(400);

    await ok('POST', `/api/storage/pools/${hdds.id}/scrub`);
    storage = await ok<StorageOverview>('GET', '/api/storage');
    expect(storage.pools.find((p) => p.name === 'HDDs')!.scan?.kind).toBe('scrub');

    const renamed = await ok<{ displayName: string }>('PATCH', `/api/storage/pools/${hdds.id}`, { displayName: 'Big storage' });
    expect(renamed.displayName).toBe('Big storage');
  });

  it('reports notifications for finished tasks', async () => {
    const { notices } = await ok<{ notices: { title: string; source: string }[] }>('GET', '/api/notifications');
    expect(notices.some((n) => n.source === 'apexos' && n.title === 'Your server is ready')).toBe(true);
  });
});
