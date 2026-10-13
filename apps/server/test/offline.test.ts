/**
 * A TrueNAS without internet access: its app catalog and update check fail slowly (minutes / ~15 s on a
 * real box). Pages that only use them as extras must not wait, and failures are remembered for a while.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppsResponse, DashboardResponse, UpdateInfo } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { appTimings, invalidateCatalog } from '../src/services/apps.ts';
import { dashboardTimings } from '../src/services/dashboard.ts';
import { invalidateUpdateCheck } from '../src/services/system.ts';

const OFFLINE_DELAY_MS = 1_500;

let mock: MockTrueNas;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let cookie = '';

async function timed<T>(url: string): Promise<{ status: number; body: T; ms: number }> {
  const start = Date.now();
  const res = await app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T, ms: Date.now() - start };
}

beforeAll(async () => {
  Object.assign(appTimings, { catalogWaitMs: 100 });
  Object.assign(dashboardTimings, { updateWaitMs: 100 });
  mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key', scenario: 'configured' });
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-offline-'));
  const store = new StateStore(dataDir);
  await store.load();
  const truenas = new TrueNasManager();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
  ctx = { store, truenas, tasks: new TaskManager(), bus: new Bus(), host: new HostCommands(truenas), scripts: new Map(), demo: true };
  app = await buildApp(ctx);
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'correct-horse' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
  invalidateCatalog();
  invalidateUpdateCheck();
  mock.setOffline(OFFLINE_DELAY_MS);
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('a server without internet access', () => {
  it('shows the dashboard and installed apps without waiting for the catalog or the update check', async () => {
    const dashboard = await timed<DashboardResponse>('/api/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.ms).toBeLessThan(OFFLINE_DELAY_MS - 500);
    expect(dashboard.body.apps.length).toBeGreaterThan(0);
    expect(dashboard.body.apps[0]!.title).toBeTruthy();
    expect(dashboard.body.update).toMatchObject({ available: null, error: null });

    const apps = await timed<AppsResponse>('/api/apps');
    expect(apps.status).toBe(200);
    expect(apps.ms).toBeLessThan(OFFLINE_DELAY_MS - 500);
    expect(apps.body.apps.map((a) => a.name)).toEqual(dashboard.body.apps.map((a) => a.name));
  });

  it('explains that the catalog needs internet access, and remembers the failure', async () => {
    const first = await timed<{ error: { code: string; message: string } }>('/api/apps/catalog');
    expect(first.status).toBe(503);
    expect(first.body.error.code).toBe('CATALOG_UNAVAILABLE');
    expect(first.body.error.message).toMatch(/needs internet access/);

    const again = await timed<{ error: { code: string } }>('/api/apps/catalog');
    expect(again.status).toBe(503);
    expect(again.ms).toBeLessThan(300);
  });

  it('reports the failed update check in Settings, then answers from memory', async () => {
    const first = await timed<UpdateInfo>('/api/system/update');
    expect(first.status).toBe(200);
    expect(first.body.error).toMatch(/Connection timeout/);
    const again = await timed<UpdateInfo>('/api/system/update');
    expect(again.body.error).toMatch(/Connection timeout/);
    expect(again.ms).toBeLessThan(300);
  });

  it('loads the catalog again once the server is back online', async () => {
    mock.setOffline(null);
    invalidateCatalog();
    const catalog = await timed<{ apps: unknown[] }>('/api/apps/catalog');
    expect(catalog.status).toBe(200);
    expect(catalog.body.apps.length).toBeGreaterThan(0);
  });
});
