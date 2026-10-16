/**
 * Moving a location's folder, with its files, to another pool: the copy, the switch-over, apps and the share
 * following the new path, the old copy kept and removed, and cleaning up after an interrupted move.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { FolderMove, FoldersResponse, LocationMoveCheck, LocationPreferenceId, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { folderMoveHousekeeping } from '../src/services/folder-move.ts';

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
  for (let i = 0; i < 800; i++) {
    const t = ctx.tasks.get(started.task.id)!;
    if (t.status !== 'running') {
      if (t.status === 'failed') throw new Error(`Task "${t.title}" failed: ${t.error}`);
      return t;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Task did not finish');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const tn = <T = any>(method: string, params: unknown[] = []) => ctx.truenas.client().call<T>(method, params);
const datasetIds = async (prefix: string) => (await tn<{ id: string }[]>('pool.dataset.query', [[['id', '^', prefix]], { extra: { retrieve_children: false } }])).map((d) => d.id);
const share = async (name: string) => (await tn<{ path: string; enabled: boolean }[]>('sharing.smb.query', [[['name', '=', name]]]))[0]!;
const jellyfin = () => tn<{ state: string; config: any }>('app.get_instance', ['jellyfin', { extra: { retrieve_config: true } }]);

beforeAll(async () => {
  // Configured scenario: HDDs (Media, Photos, Documents shared) and SSDs; Jellyfin uses /mnt/HDDs/Media.
  mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key', scenario: 'configured' });
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-folder-move-'));
  const store = new StateStore(dataDir);
  await store.load();
  const truenas = new TrueNasManager();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
  ctx = { store, truenas, tasks: new TaskManager(), bus: new Bus(), host: new HostCommands(truenas), scripts: new Map(), demo: true };
  app = await buildApp(ctx);
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'correct-horse' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;

  await store.update((s) => {
    s.server.setupCompletedAt = new Date().toISOString();
    s.preferences.locations = { Media: '/mnt/HDDs/Media', Movies: '/mnt/HDDs/Media/Movies', Photos: '/mnt/HDDs/Photos', Documents: '/mnt/HDDs/Documents' };
    s.apps.jellyfin = {
      catalogApp: 'jellyfin',
      train: 'community',
      scriptVersion: '1',
      locations: ['Media', 'Photos'] as LocationPreferenceId[],
      directories: [{ dataset: 'HDDs/Photos/.jellyfin', path: '/mnt/HDDs/Photos/.jellyfin' }],
      installedAt: new Date().toISOString(),
    };
  });
  // Jellyfin also gets a photo library inside Photos.
  const config = (await jellyfin()).config;
  const extra = { type: 'host_path', read_only: true, mount_path: '/photos', host_path_config: { acl_enable: false, path: '/mnt/HDDs/Photos/2025' } };
  await ctx.truenas.client().job('app.update', ['jellyfin', { values: { storage: { ...config.storage, additional_storage: [...config.storage.additional_storage, extra] } } }]);
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('moving a location to another pool', () => {
  it('explains what moves, who is affected and where it can go', async () => {
    const check = await ok<LocationMoveCheck>('GET', '/api/locations/Photos/move');
    expect(check).toMatchObject({ folder: 'Photos', pool: 'HDDs', locations: ['Photos'], apps: ['Jellyfin'], blockers: [], notes: [] });

    // A recursive snapshot task on the pool covers the folder today, but not at its new place.
    const snap = await tn<{ id: number }>('pool.snapshottask.create', [
      { dataset: 'HDDs', recursive: true, naming_schema: 'auto-%Y%m%d-%H%M', lifetime_value: 2, lifetime_unit: 'WEEK', schedule: { minute: '0', hour: '*', dom: '*', month: '*', dow: '*' } },
    ]);
    expect((await ok<LocationMoveCheck>('GET', '/api/locations/Photos/move')).notes).toEqual([expect.stringMatching(/snapshots of HDDs include Photos/)]);
    await tn('pool.snapshottask.delete', [snap.id]);
    expect(check.targets).toEqual([expect.objectContaining({ name: 'SSDs', problem: null })]);

    // A child location moves its whole folder; Media doesn't fit on the SSDs.
    const media = await ok<LocationMoveCheck>('GET', '/api/locations/Movies/move');
    expect(media).toMatchObject({ folder: 'Media', locations: ['Media', 'Movies'] });
    expect(media.targets[0]!.problem).toMatch(/needs about/);
  });

  it('moves the folder, its share, the locations inside it and the apps using it', async () => {
    const started = await ok<{ task: Task }>('POST', '/api/locations/Photos/move', { pool: 'SSDs' });
    expect(started.task.title).toBe('Moving Photos to SSDs');
    // One move at a time, and the folder can't be changed meanwhile.
    expect((await call('POST', '/api/locations/Documents/move', { pool: 'SSDs' })).status).toBe(409);
    // App changes wait too: an app started now could write into the copy that is about to be left behind.
    const stop = await call<{ error: { code: string } }>('POST', '/api/apps/jellyfin/stop');
    expect([stop.status, stop.body.error.code]).toEqual([409, 'BUSY']);
    const task = await finished(started);
    expect(task.steps.every((s) => s.status === 'success')).toBe(true);

    expect(await datasetIds('SSDs/Photos')).toEqual(expect.arrayContaining(['SSDs/Photos']));
    expect(await datasetIds('HDDs/Photos')).toEqual([]);
    expect(await datasetIds('HDDs/.apexos-moved-Photos-')).toHaveLength(1);
    expect(await share('Photos')).toMatchObject({ path: '/mnt/SSDs/Photos', enabled: true });
    expect((await tn<{ name: string }[]>('filesystem.listdir', ['/mnt/SSDs/Photos/2025'])).map((e) => e.name)).toContain('Beach day');
    expect(await tn('pool.snapshot.query', [[['snapshot_name', '^', 'apexos-move-']]])).toEqual([]);

    expect(ctx.store.get().preferences.locations).toMatchObject({ Photos: '/mnt/SSDs/Photos', Media: '/mnt/HDDs/Media' });
    expect(ctx.store.get().apps.jellyfin!.directories).toEqual([{ dataset: 'SSDs/Photos/.jellyfin', path: '/mnt/SSDs/Photos/.jellyfin' }]);
    const app = await jellyfin();
    expect(app.state).toBe('RUNNING');
    expect(app.config.storage.additional_storage.map((e: any) => e.host_path_config.path)).toEqual(['/mnt/HDDs/Media', '/mnt/SSDs/Photos/2025']);

    const folders = await ok<FoldersResponse>('GET', '/api/folders');
    expect(folders.folders.filter((f) => f.name === 'Photos').map((f) => f.pool)).toEqual(['SSDs']);
    expect(folders.folders.some((f) => f.name.startsWith('.'))).toBe(false);
  });

  it('keeps the old copy for a week, and removes it on request', async () => {
    const [move] = await ok<FolderMove[]>('GET', '/api/locations/moves');
    expect(move).toMatchObject({ folder: 'Photos', fromPool: 'HDDs', toPool: 'SSDs', state: 'done', warnings: [] });
    expect(move!.oldCopy!.usedBytes).toBeGreaterThan(0);
    expect(Date.parse(move!.oldCopy!.removeAfter) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);

    await finished(await ok<{ task: Task }>('DELETE', `/api/locations/moves/${move!.id}/old-copy`));
    expect(await datasetIds('HDDs/.apexos-moved-Photos-')).toEqual([]);
    expect(await ok<FolderMove[]>('GET', '/api/locations/moves')).toEqual([]);
  });

  it('undoes an interrupted move that hadn’t switched over yet', async () => {
    // As if ApexOs stopped while copying Documents: share paused, Jellyfin stopped, half a copy on SSDs.
    const [docs] = await tn<{ id: number }[]>('sharing.smb.query', [[['name', '=', 'Documents']]]);
    await tn('sharing.smb.update', [docs!.id, { enabled: false }]);
    await ctx.truenas.client().job('app.stop', ['jellyfin']);
    await tn('pool.snapshot.create', [{ dataset: 'HDDs/Documents', name: 'apexos-move-1', recursive: true }]);
    await ctx.truenas.client().job('replication.run_onetime', [
      { direction: 'PUSH', transport: 'LOCAL', source_datasets: ['HDDs/Documents'], target_dataset: 'SSDs/.apexos-move-Documents', recursive: true, properties: true, name_regex: '.*', retention_policy: 'NONE', readonly: 'IGNORE', only_from_scratch: true },
    ]);
    expect(await datasetIds('SSDs/.apexos-move-Documents')).toContain('SSDs/.apexos-move-Documents');
    await ctx.store.update((s) => {
      s.folderMoves = [
        {
          id: 'interrupted',
          name: 'Documents',
          source: 'HDDs/Documents',
          target: 'SSDs/Documents',
          temp: 'SSDs/.apexos-move-Documents',
          tempCreated: true,
          original: 'HDDs/.apexos-moved-Documents-20261015',
          status: 'running',
          step: 'Copying the latest changes',
          error: null,
          taskId: null,
          renamedOriginal: false,
          switched: false,
          share: { id: docs!.id, wasEnabled: true },
          stoppedApps: ['jellyfin'],
          warnings: [],
          startedAt: new Date().toISOString(),
          removeAfter: null,
        },
      ];
    });
    expect((await ok<FolderMove[]>('GET', '/api/locations/moves'))[0]).toMatchObject({ state: 'failed' });

    await folderMoveHousekeeping(ctx);
    // Recovery runs as a folder-move task, so app changes wait for it.
    const recovery = ctx.tasks.findRunning('folder-move', 'Documents')!;
    expect(recovery.title).toBe('Recovering the move of Documents');
    const stop = await call<{ error: { code: string } }>('POST', '/api/apps/jellyfin/stop');
    expect(stop.status).toBe(409);
    await finished({ task: recovery });
    expect(ctx.store.get().folderMoves).toEqual([]);
    expect(await share('Documents')).toMatchObject({ path: '/mnt/HDDs/Documents', enabled: true });
    expect((await jellyfin()).state).toBe('RUNNING');
    expect(await datasetIds('SSDs/.apexos-move-')).toEqual([]);
    expect(await tn('pool.snapshot.query', [[['snapshot_name', '^', 'apexos-move-']]])).toEqual([]);
  });

  it('refuses a dataset in the way of its hidden copy, and leaves it alone', async () => {
    await tn('pool.snapshot.create', [{ dataset: 'HDDs/Documents', name: 'in-the-way', recursive: true }]);
    await ctx.truenas.client().job('replication.run_onetime', [
      { direction: 'PUSH', transport: 'LOCAL', source_datasets: ['HDDs/Documents'], target_dataset: 'SSDs/.apexos-move-Documents', recursive: true, properties: true, name_regex: '.*', retention_policy: 'NONE', readonly: 'IGNORE', only_from_scratch: true },
    ]);
    const refused = await call<{ error: { code: string } }>('POST', '/api/locations/Documents/move', { pool: 'SSDs' });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'NAME_TAKEN']);
    expect(await datasetIds('SSDs/.apexos-move-Documents')).toContain('SSDs/.apexos-move-Documents');
    await tn('pool.dataset.delete', ['SSDs/.apexos-move-Documents', { recursive: true }]);
    await tn('pool.snapshot.delete', ['HDDs/Documents@in-the-way', { recursive: true }]);
  });

  it('finishes a move that had switched over when ApexOs stopped, even before it saved that', async () => {
    // As if ApexOs stopped right after both renames, before writing either of them down.
    const [docs] = await tn<{ id: number }[]>('sharing.smb.query', [[['name', '=', 'Documents']]]);
    await tn('sharing.smb.update', [docs!.id, { enabled: false }]);
    await tn('pool.snapshot.create', [{ dataset: 'HDDs/Documents', name: 'apexos-move-1', recursive: true }]);
    await ctx.truenas.client().job('replication.run_onetime', [
      { direction: 'PUSH', transport: 'LOCAL', source_datasets: ['HDDs/Documents'], target_dataset: 'SSDs/.apexos-move-Documents', recursive: true, properties: true, name_regex: '.*', retention_policy: 'NONE', readonly: 'IGNORE', only_from_scratch: true },
    ]);
    await tn('pool.dataset.rename', ['HDDs/Documents', { new_name: 'HDDs/.apexos-moved-Documents-20261016', force: true }]);
    await tn('pool.dataset.rename', ['SSDs/.apexos-move-Documents', { new_name: 'SSDs/Documents', force: true }]);
    await ctx.store.update((s) => {
      s.folderMoves = [
        {
          id: 'crashed',
          name: 'Documents',
          source: 'HDDs/Documents',
          target: 'SSDs/Documents',
          temp: 'SSDs/.apexos-move-Documents',
          tempCreated: true,
          original: 'HDDs/.apexos-moved-Documents-20261016',
          status: 'running',
          step: 'Switching over',
          error: null,
          taskId: null,
          renamedOriginal: false,
          switched: false,
          share: { id: docs!.id, wasEnabled: true },
          stoppedApps: [],
          warnings: [],
          startedAt: new Date().toISOString(),
          removeAfter: null,
        },
      ];
    });

    await folderMoveHousekeeping(ctx);
    await finished({ task: ctx.tasks.findRunning('folder-move', 'Documents')! });
    expect(ctx.store.get().folderMoves).toEqual([expect.objectContaining({ id: 'crashed', status: 'done', switched: true, renamedOriginal: true })]);
    expect(ctx.store.get().preferences.locations).toMatchObject({ Documents: '/mnt/SSDs/Documents' });
    expect(await share('Documents')).toMatchObject({ path: '/mnt/SSDs/Documents', enabled: true });
  });
});
