/**
 * Graphics cards for apps: offered when installing apps that can use one, and turned on or off for
 * installed apps without touching their other settings.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppsResponse, CatalogAppDetail, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';

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

type Values = { resources: { limits: unknown; gpus?: { use_all_gpus?: boolean } } };
const config = (name: string) => ctx.truenas.client().call<Values>('app.config', [name]);
const appNamed = async (name: string) => (await ok<AppsResponse>('GET', '/api/apps')).apps.find((a) => a.name === name)!;

beforeAll(async () => {
  // Configured scenario: Jellyfin installed; the simulated server has an AMD graphics card.
  mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key', scenario: 'configured' });
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-gpus-'));
  const store = new StateStore(dataDir);
  await store.load();
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
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('graphics cards for apps', () => {
  it('lists the cards apps can use and which apps could use them', async () => {
    const apps = await ok<AppsResponse>('GET', '/api/apps');
    expect(apps.gpus.usable).toEqual([expect.stringContaining('Radeon')]);
    expect(apps.gpus.nvidiaNeedsDriver).toBe(false);
    expect(apps.apps.find((a) => a.name === 'jellyfin')!.gpu).toEqual({ enabled: false });

    expect((await ok<CatalogAppDetail>('GET', '/api/apps/catalog/emby?train=stable')).gpu).toMatchObject({ usable: [expect.stringContaining('Radeon')] });
    expect((await ok<CatalogAppDetail>('GET', '/api/apps/catalog/syncthing?train=stable')).gpu).toBeNull();
  });

  it('turns the graphics card on and off for an installed app, keeping its other settings', async () => {
    const before = await config('jellyfin');
    const on = await finished(await ok<{ task: Task }>('POST', '/api/apps/jellyfin/gpu', { enabled: true }));
    expect(on.title).toBe('Turning on the graphics card for Jellyfin');
    expect((await appNamed('jellyfin')).gpu).toEqual({ enabled: true });
    const after = await config('jellyfin');
    expect(after.resources.gpus).toMatchObject({ use_all_gpus: true });
    expect(after.resources.limits).toEqual(before.resources.limits);

    await finished(await ok<{ task: Task }>('POST', '/api/apps/jellyfin/gpu', { enabled: false }));
    expect((await appNamed('jellyfin')).gpu).toEqual({ enabled: false });
  });

  it('installs an app with the graphics card turned on', async () => {
    await finished(await ok<{ task: Task }>('POST', '/api/apps/install', { catalogApp: 'emby', train: 'stable', answers: {}, useGpu: true }));
    expect((await config('emby')).resources.gpus).toMatchObject({ use_all_gpus: true });
    expect((await appNamed('emby')).gpu).toEqual({ enabled: true });
  });

  it('refuses apps that can’t use a graphics card', async () => {
    await finished(await ok<{ task: Task }>('POST', '/api/apps/install', { catalogApp: 'syncthing', train: 'stable', answers: {}, useGpu: true }));
    expect((await config('syncthing')).resources.gpus).toBeUndefined();
    expect((await appNamed('syncthing')).gpu).toBeNull();
    const refused = await call<{ error: { code: string } }>('POST', '/api/apps/syncthing/gpu', { enabled: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('NO_GPU_SUPPORT');
  });
});
