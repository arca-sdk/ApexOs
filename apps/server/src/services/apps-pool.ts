import type { AppsPoolPreview, Pool, StorageOverview } from '@apexos/api-types';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { errorMessage, type Task } from '../lib/tasks.ts';
import { formatBytes, propNumber } from '../truenas/helpers.ts';
import type { TnApp, TnDataset, TnDockerConfig } from '../truenas/types.ts';
import { displayName, invalidateCatalog } from './apps.ts';
import { addNotice } from './notifications.ts';
import { getStorage } from './storage.ts';

const ERASE_STEP = 'Erasing old app data';
/** Room to spare on the new pool when copying apps there. */
const COPY_MARGIN = 1.1;
/** How long the copy TrueNAS leaves on the old pool is kept, in case something is wrong after a move. */
export const OLD_APP_DATA_DAYS = 7;
const DAY = 24 * 3600_000;

/** Where TrueNAS keeps apps (images, settings, app-managed data) on the apps pool. */
function appsDataset(pool: string): string {
  return `${pool}/ix-apps`;
}

/** A running task that changes apps; a move waits for it (and the other way round). */
function appTaskRunning(ctx: AppContext): Task | undefined {
  return ctx.tasks.list().find((t) => t.status === 'running' && (t.type.startsWith('app-') || t.type.startsWith('apps-') || t.type.startsWith('remote-')));
}

/** Refuses app changes while apps move to another pool (the app engine is stopped for most of it). */
export function assertAppsNotMoving(ctx: AppContext): void {
  const move = ctx.tasks.findRunning('apps-pool');
  if (move) throw new UserError(`Wait until “${move.title}” has finished.`, 409, 'BUSY');
}

interface Plan extends AppsPoolPreview {
  target: Pool;
  migrate: boolean;
}

async function plan(ctx: AppContext, poolName: string): Promise<Plan> {
  const client = ctx.truenas.client();
  // Read without a fallback: guessing "no apps pool" after a failed read would switch pools without moving the apps.
  const [storage, engine] = await Promise.all([getStorage(ctx), client.call<TnDockerConfig>('docker.config')]);
  const target = storage.pools.find((p) => p.name === poolName);
  if (!target) throw new UserError('That pool no longer exists', 404, 'NOT_FOUND');
  const current = engine.pool ? (storage.pools.find((p) => p.name === engine.pool) ?? null) : null;
  const currentPoolOffline = engine.pool !== null && (!current || current.health === 'offline');
  const canMove = current !== null && !currentPoolOffline && current !== target;

  const [apps, datasets] = await Promise.all([
    canMove ? client.call<TnApp[]>('app.query') : Promise.resolve([] as TnApp[]),
    client.call<TnDataset[]>('pool.dataset.query', [
      [['id', 'in', [appsDataset(target.name), ...(current ? [appsDataset(current.name)] : [])]]],
      { extra: { retrieve_children: false } },
    ]),
  ]);
  // TrueNAS copies everything in ix-apps, but only does so when apps actually move.
  const migrate = apps.length > 0;
  const used = (pool: string) => propNumber(datasets.find((d) => d.id === appsDataset(pool))?.used);
  const copyBytes = migrate && current ? used(current.name) : 0;
  const oldAppData = datasets.some((d) => d.id === appsDataset(target.name));
  const needsEraseConsent = migrate && oldAppData;
  const freeBytes = target.freeBytes + (needsEraseConsent ? used(target.name) : 0);

  const busy = appTaskRunning(ctx);
  let problem: string | null = null;
  if (target === current) problem = `Apps already run from ${target.displayName}.`;
  else if (target.health === 'offline') problem = `${target.displayName} is offline. Reconnect its drives first.`;
  else if (busy) problem = `Wait until “${busy.title}” has finished.`;
  else if (copyBytes * COPY_MARGIN > freeBytes) {
    problem = `${target.displayName} doesn’t have enough free space for your apps: they need about ${formatBytes(copyBytes * COPY_MARGIN)} and ${formatBytes(freeBytes)} is free.`;
  }

  return {
    pool: target.name,
    currentPool: engine.pool,
    currentPoolOffline,
    moving: apps.map(displayName).sort((a, b) => a.localeCompare(b)),
    copyBytes,
    oldAppData,
    needsEraseConsent,
    problem,
    target,
    migrate,
  };
}

export async function previewAppsPool(ctx: AppContext, pool: string): Promise<AppsPoolPreview> {
  const { target: _target, migrate: _migrate, ...preview } = await plan(ctx, pool);
  return preview;
}

/**
 * Runs apps from another pool. Installed apps move along (TrueNAS copies `ix-apps` and starts the apps that
 * were running); the old copy stays on the old pool. TrueNAS won't copy over an existing `ix-apps`, so app
 * data left on the new pool from an earlier time is erased first, with the user's consent.
 */
export async function startAppsPoolChange(ctx: AppContext, pool: string, eraseOldAppData: boolean): Promise<Task> {
  const p = await plan(ctx, pool);
  if (p.problem) throw new UserError(p.problem, 409, 'APPS_POOL');
  if (p.needsEraseConsent && !eraseOldAppData) {
    throw new UserError(`${p.target.displayName} still holds app data from when apps last ran there. Confirm that it may be erased.`, 400, 'CONSENT_REQUIRED');
  }
  // Checked again right before starting: another request may have started a task meanwhile.
  const busy = appTaskRunning(ctx);
  if (busy) throw new UserError(`Wait until “${busy.title}” has finished.`, 409, 'BUSY');

  const name = p.target.displayName;
  const mainStep = p.migrate ? 'Moving apps' : 'Starting the app engine';
  return ctx.tasks.start(
    {
      type: 'apps-pool',
      title: p.migrate ? `Moving apps to ${name}` : `Setting up apps on ${name}`,
      ref: name,
      steps: [...(p.needsEraseConsent ? [ERASE_STEP] : []), mainStep],
    },
    async (task) => {
      const client = ctx.truenas.client();
      if (p.needsEraseConsent) {
        await task.step(ERASE_STEP, () => client.call('pool.dataset.delete', [appsDataset(p.pool), { recursive: true, force: true }]));
      }
      await task.step(mainStep, (report) =>
        client.job('docker.update', [{ pool: p.pool, ...(p.migrate ? { migrate_applications: true } : {}) }], (job) =>
          report(job.progress.percent ?? 0, job.progress.description ?? undefined),
        ),
      );
      await ctx.store.update((s) => {
        const old = { ...s.oldAppData };
        delete old[p.pool]; // apps run from this copy now
        if (p.migrate && p.currentPool) {
          const now = Date.now();
          old[p.currentPool] = { movedTo: p.pool, movedAt: new Date(now).toISOString(), removeAfter: new Date(now + OLD_APP_DATA_DAYS * DAY).toISOString() };
        }
        s.oldAppData = old;
      });
      invalidateCatalog();
      ctx.bus.changed('apps');
      ctx.bus.changed('storage');
    },
  );
}

/**
 * Gives apps a home on a pool that was just created when they have none (for example after their pool was
 * deleted). A failure leaves the pool as created and is reported as a notice; the Apps page still offers
 * to choose a pool.
 */
export async function adoptPoolForApps(ctx: AppContext, pool: string): Promise<boolean> {
  try {
    const client = ctx.truenas.client();
    const config = await client.call<TnDockerConfig>('docker.config');
    if (config.pool) return false;
    await client.job('docker.update', [{ pool }]);
    invalidateCatalog();
    ctx.bus.changed('apps');
    return true;
  } catch (err) {
    await addNotice(ctx, {
      level: 'warning',
      title: `Apps couldn’t be set up on ${pool}`,
      message: `${errorMessage(err)} Choose a pool for apps on the Apps page.`,
      link: '/apps',
    }).catch(() => undefined);
    return false;
  }
}

// ---------------------------------------------------------------------------
// The copy TrueNAS leaves behind when apps move
// ---------------------------------------------------------------------------

/** Adds `oldAppData` to pools that still hold the copy left when ApexOs moved apps away. */
export async function withOldAppData(ctx: AppContext, overview: StorageOverview): Promise<StorageOverview> {
  const records = ctx.store.get().oldAppData ?? {};
  const pools = overview.pools.filter((p) => records[p.name] && !p.isAppsPool);
  if (!pools.length) return overview;
  const datasets = await ctx.truenas
    .client()
    .call<TnDataset[]>('pool.dataset.query', [[['id', 'in', pools.map((p) => appsDataset(p.name))]], { extra: { retrieve_children: false } }])
    .catch(() => null);
  if (!datasets) return overview;
  return {
    ...overview,
    pools: overview.pools.map((p) => {
      const record = records[p.name];
      const ds = datasets.find((d) => d.id === appsDataset(p.name));
      if (!record || !ds || p.isAppsPool) return p;
      const movedTo = overview.pools.find((x) => x.name === record.movedTo)?.displayName ?? record.movedTo;
      return { ...p, oldAppData: { usedBytes: propNumber(ds.used), movedTo, removeAfter: record.removeAfter } };
    }),
  };
}

export async function startOldAppDataRemoval(ctx: AppContext, pool: Pool): Promise<Task> {
  if (!ctx.store.get().oldAppData?.[pool.name]) throw new UserError('There’s no old app data on this pool.', 404, 'NOT_FOUND');
  assertAppsNotMoving(ctx);
  if (ctx.tasks.findRunning('apps-old-data')) throw new UserError('Old app data is already being removed. Wait until that has finished.', 409, 'BUSY');
  return startRemovalTask(ctx, pool);
}

/**
 * Removals always run as an `apps-old-data` task, so a move (which waits for `apps-*` tasks) can't start while one
 * deletes, and none starts while apps move. Callers check and call this with no `await` in between.
 */
function startRemovalTask(ctx: AppContext, pool: Pool): Task {
  return ctx.tasks.start({ type: 'apps-old-data', title: `Removing old app data from ${pool.displayName}`, ref: pool.displayName }, (t) =>
    t.step('Removing old app data', () => deleteOldAppData(ctx, pool.name)),
  );
}

/** Only ever deletes app data ApexOs recorded as left behind, and never the copy apps run from. */
async function deleteOldAppData(ctx: AppContext, pool: string): Promise<void> {
  const client = ctx.truenas.client();
  const config = await client.call<TnDockerConfig>('docker.config');
  if (config.pool !== pool) {
    const [ds] = await client.call<TnDataset[]>('pool.dataset.query', [[['id', '=', appsDataset(pool)]], { extra: { retrieve_children: false } }]);
    if (ds) await client.call('pool.dataset.delete', [ds.id, { recursive: true, force: true }]);
  }
  await ctx.store.update((s) => {
    if (s.oldAppData) delete s.oldAppData[pool];
  });
  ctx.bus.changed('storage');
}

/** Hourly: starts removing old app data whose time is up, one pool at a time. Returns the task it started. */
export async function oldAppDataHousekeeping(ctx: AppContext): Promise<Task | null> {
  if (!ctx.truenas.connected) return null;
  const due = Object.entries(ctx.store.get().oldAppData ?? {}).filter(([, r]) => Date.parse(r.removeAfter) <= Date.now());
  if (!due.length) return null;
  const pools = (await getStorage(ctx)).pools;
  for (const [name] of due) {
    const pool = pools.find((p) => p.name === name);
    // A missing pool may only be exported (its data is still on the drives), and an offline one can come back:
    // both keep their record and wait. Deleting a pool through ApexOs clears its record.
    if (!pool || pool.health === 'offline') continue;
    if (ctx.tasks.findRunning('apps-pool') || ctx.tasks.findRunning('apps-old-data')) return null;
    return startRemovalTask(ctx, pool);
  }
  return null;
}
