/**
 * Moving a location's folder, with its files, to another pool. ZFS can't rename across pools, so the
 * folder is copied with a local replication into a hidden dataset on the new pool while everything keeps
 * running; then the apps using it stop and its share pauses, the latest changes are copied and checked,
 * and the copy is swapped in. ApexOs's locations and records, the share and every app's folder settings
 * follow the new path. The old folder is kept, hidden, for a week.
 */
import { randomUUID } from 'node:crypto';
import type { FolderMove, LocationMoveCheck } from '@apexos/api-types';
import type { Job, TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import type { FolderMoveRecord } from '../lib/store.ts';
import { errorMessage, type Task, type TaskContext } from '../lib/tasks.ts';
import { formatBytes, GiB, propNumber } from '../truenas/helpers.ts';
import type { TnApp, TnSmbShare } from '../truenas/types.ts';
import { assertAppsNotMoving } from './apps-pool.ts';
import {
  attachments,
  compareDatasetTrees,
  compareTrees,
  dateStamp,
  dropSnapshot,
  durationOf,
  ensureSnapshot,
  getDataset,
  inside,
  isAppAttachment,
  isSmbAttachment,
  joinList,
  queryDatasets,
  replicationsTouching,
  snapshotNames,
  treeFilter,
  type TnReplicationTask,
} from './datasets.ts';
import { LOCATION_DEFS, locationDef } from './locations.ts';
import { addNotice } from './notifications.ts';
import { getStorage } from './storage.ts';

const TEMP_PREFIX = '.apexos-move-';
const OLD_PREFIX = '.apexos-moved-';
const SNAPSHOT_PREFIX = 'apexos-move-';

/**
 * The move's own snapshot names (`apexos-move-<id>-1`, `-2`): a later move of the same folder never reuses
 * snapshots an earlier one failed to clean up, and cleanup only deletes this move's.
 */
function snapshotName(r: Pick<FolderMoveRecord, 'id'>, n: 1 | 2): string {
  return `${SNAPSHOT_PREFIX}${r.id.slice(0, 8)}-${n}`;
}
/** How soon a move that failed after its switch-over is finished again. */
const RETRY_AFTER_FAILURE_MS = 60_000;
/** How long the old folder is kept on the old pool. */
export const OLD_COPY_DAYS = 7;
const DAY = 24 * 3600_000;

const MOVE_STEPS = [
  'Checking',
  'Copying files',
  'Stopping apps and sharing',
  'Copying the latest changes',
  'Checking the copy',
  'Switching over',
  'Updating apps',
  'Starting apps again',
  'Cleaning up',
];

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function records(ctx: AppContext): FolderMoveRecord[] {
  return ctx.store.get().folderMoves ?? [];
}

function recordById(ctx: AppContext, id: string): FolderMoveRecord {
  const r = records(ctx).find((x) => x.id === id);
  if (!r) throw new UserError('That move no longer exists.', 404, 'NOT_FOUND');
  return r;
}

async function patch(ctx: AppContext, id: string, change: Partial<FolderMoveRecord>): Promise<FolderMoveRecord> {
  await ctx.store.update((s) => {
    const r = s.folderMoves?.find((x) => x.id === id);
    if (r) Object.assign(r, change);
  });
  return recordById(ctx, id);
}

async function forget(ctx: AppContext, id: string): Promise<void> {
  await ctx.store.update((s) => {
    s.folderMoves = (s.folderMoves ?? []).filter((x) => x.id !== id);
  });
  ctx.bus.changed('locations');
}

/** A move whose task is alive, or that stopped half-way and still has to be cleaned up or finished. */
function unfinished(ctx: AppContext): FolderMoveRecord | undefined {
  return records(ctx).find((r) => r.status !== 'done');
}

/** Refuses folder changes while that folder is being moved. */
export function assertFolderNotMoving(ctx: AppContext, dataset: string): void {
  const r = unfinished(ctx);
  if (r && (inside(dataset, r.source) || inside(dataset, r.target))) {
    throw new UserError(`${r.name} is being moved to another pool. Wait until that has finished.`, 409, 'BUSY');
  }
}

// ---------------------------------------------------------------------------
// Paths inside app settings
// ---------------------------------------------------------------------------

function underPath(value: string, root: string): boolean {
  return value === root || value.startsWith(`${root}/`);
}

/** Whether any text value in an app's settings is the folder's path or a path inside it. */
function usesPath(value: unknown, root: string): boolean {
  if (typeof value === 'string') return underPath(value, root);
  if (Array.isArray(value)) return value.some((v) => usesPath(v, root));
  if (value && typeof value === 'object') return Object.values(value).some((v) => usesPath(v, root));
  return false;
}

function rewritePaths(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return underPath(value, from) ? `${to}${value.slice(from.length)}` : value;
  if (Array.isArray(value)) return value.map((v) => rewritePaths(v, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewritePaths(v, from, to)]));
  return value;
}

function appTitle(app: TnApp): string {
  return app.metadata?.title ?? app.name;
}

/** Apps whose settings point into the folder (installed by ApexOs or not). Fails rather than guessing. */
async function appsUsing(client: TrueNasClient, path: string): Promise<TnApp[]> {
  const apps = await client.call<TnApp[]>('app.query', [[], { extra: { retrieve_config: true } }]);
  return apps.filter((a) => usesPath(a.config, path));
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

interface FolderRef {
  name: string;
  pool: string;
  dataset: string;
  path: string;
}

/** The top-level folder a location lives in: Movies at /mnt/HDDs/Media/Movies lives in HDDs/Media. */
function locationFolder(ctx: AppContext, id: string): FolderRef {
  const def = locationDef(id);
  const path = ctx.store.get().preferences.locations[def.id];
  if (!path) throw new UserError(`${def.name} isn’t set up yet, so there is nothing to move.`, 409, 'NOT_SET');
  const [pool, name] = path.replace(/^\/mnt\//, '').split('/');
  if (!pool || !name) throw new UserError(`${def.name} isn’t inside a folder ApexOs can move.`, 409, 'NOT_MOVABLE');
  return { name, pool, dataset: `${pool}/${name}`, path: `/mnt/${pool}/${name}` };
}

interface MovePlan extends LocationMoveCheck {
  ref: FolderRef;
  original: string;
}

async function checkFolder(ctx: AppContext, ref: FolderRef, opts: { ownRun?: string } = {}): Promise<MovePlan> {
  const client = ctx.truenas.client();
  const blockers: LocationMoveCheck['blockers'] = [];
  const block = (code: string, message: string) => blockers.push({ code, message });

  // Every one of these must answer: a check that fails can't be taken as "nothing uses the folder".
  const required = <T>(p: Promise<T>): Promise<T> =>
    p.catch((err: Error) => {
      throw new UserError(`ApexOs couldn’t check what uses ${ref.name}: ${errorMessage(err)}. Try again in a moment.`, 503, 'CHECK_FAILED');
    });
  const [storage, tree, apps, attached, replications, snapshotTasks, ownShares, parked] = await Promise.all([
    getStorage(ctx),
    queryDatasets(client, [treeFilter(ref.dataset)]),
    required(appsUsing(client, ref.path)),
    required(attachments(client, ref.dataset)),
    required(client.call<TnReplicationTask[]>('replication.query')),
    required(client.call<TnSnapshotTask[]>('pool.snapshottask.query')),
    required(client.call<TnSmbShare[]>('sharing.smb.query', [[['path', '=', ref.path]]])),
    required(client.call<{ id: string }[]>('pool.dataset.query', [[['id', '^', `${ref.pool}/${OLD_PREFIX}${ref.name}-`]], { extra: { retrieve_children: false, properties: [] } }])),
  ]);
  const notes: string[] = [];
  const source = storage.pools.find((p) => p.name === ref.pool);
  const self = tree.find((d) => d.id === ref.dataset);
  const locations = LOCATION_DEFS.filter((d) => {
    const p = ctx.store.get().preferences.locations[d.id];
    return p && underPath(p, ref.path);
  }).map((d) => d.name);

  if (!self) block('NOT_CREATED', `${ref.name} hasn’t been created yet (ApexOs creates it when an app first needs it), so there’s nothing to move.`);
  if (source?.health === 'offline') block('SOURCE_OFFLINE', `${source.displayName} is offline. Reconnect its drives first.`);
  if (tree.some((d) => d.encrypted)) block('ENCRYPTED', `${ref.name} is encrypted. ApexOs can’t move encrypted folders yet.`);
  const backups = replicationsTouching(replications, ref.dataset);
  if (backups.length || ctx.store.get().backups.jobs.some((j) => inside(j.dataset, ref.dataset) || inside(ref.dataset, j.dataset))) {
    block('BACKUPS', `${ref.name} is backed up to another server. Remove its backup on the Backups page first, move it, then add the backup again.`);
  } else if (snapshotTasks.some((t) => inside(t.dataset, ref.dataset))) {
    block('SNAPSHOT_TASKS', `TrueNAS takes scheduled snapshots of ${ref.name}. Remove that snapshot task in TrueNAS first; it would keep pointing at the old pool.`);
  }
  // A recursive task on the pool (or a folder above) covers this folder today but not at its new place.
  for (const t of snapshotTasks) {
    if (t.dataset !== ref.dataset && inside(ref.dataset, t.dataset) && t.recursive && !(t.exclude ?? []).some((e) => inside(ref.dataset, e))) {
      notes.push(`TrueNAS’s scheduled snapshots of ${t.dataset} include ${ref.name} today. After the move they no longer do; add a snapshot task for ${ref.name} on its new pool in TrueNAS if you want them.`);
    }
  }
  const ownShareNames = new Set(ownShares.map((s) => s.name.toLowerCase()));
  for (const a of attached.filter((x) => !isAppAttachment(x))) {
    if (isSmbAttachment(a)) {
      const extra = a.attachments.filter((s) => !ownShareNames.has(s.toLowerCase()));
      if (extra.length) block('CHILD_SHARED', `The network share${extra.length === 1 ? '' : 's'} ${joinList(extra.map((s) => `“${s}”`))} ${extra.length === 1 ? 'points' : 'point'} into ${ref.name}. Remove ${extra.length === 1 ? 'it' : 'them'} in TrueNAS first; ApexOs only moves the folder’s own share.`);
    } else {
      block('IN_USE', `TrueNAS uses ${ref.name} for ${a.type} (${joinList(a.attachments)}). Remove that first.`);
    }
  }
  const custom = apps.filter((a) => a.custom_app);
  if (custom.length) {
    block('CUSTOM_APP', `${joinList(custom.map(appTitle))} ${custom.length === 1 ? 'is a custom app that uses' : 'are custom apps that use'} ${ref.name}. ApexOs can’t update custom apps, so change ${custom.length === 1 ? 'it' : 'them'} in TrueNAS first.`);
  }
  const conversion = Object.values(ctx.store.get().encryption?.conversions ?? {}).find((c) => c.status !== 'done' && inside(c.dataset, ref.dataset));
  if (conversion) block('BUSY', `Encryption is being turned on for ${conversion.folder}. Wait until that has finished.`);
  const other = unfinished(ctx);
  if (other && other.id !== opts.ownRun) block('BUSY', `${other.name} is being moved. One folder at a time, so wait until that has finished.`);
  const busyTask = conflictingTask(ctx);
  if (busyTask) block('BUSY', `Wait until “${busyTask.title}” has finished.`);

  const usedBytes = self ? propNumber(self.used) : 0;
  const spaceNeededBytes = Math.ceil(usedBytes * 1.03) + GiB;
  const roots = await required(queryDatasets(client, [['id', 'in', storage.pools.map((p) => p.name)]]));
  const encryptedRoots = new Set(roots.filter((d) => d.encrypted).map((d) => d.id));
  const targets: LocationMoveCheck['targets'] = storage.pools
    .filter((p) => p.name !== ref.pool)
    .map((p) => {
      let problem: string | null = null;
      if (p.health === 'offline') problem = `${p.displayName} is offline.`;
      else if (p.health === 'degraded' || p.health === 'rebuilding') problem = `${p.displayName} needs attention first (a drive failed or is being rebuilt).`;
      else if (encryptedRoots.has(p.name)) problem = `${p.displayName} is encrypted as a whole; ApexOs can’t move folders into it.`;
      else if (p.freeBytes < spaceNeededBytes) problem = `${p.displayName} has ${formatBytes(p.freeBytes)} free; ${ref.name} needs about ${formatBytes(spaceNeededBytes)}.`;
      return { name: p.name, displayName: p.displayName, kind: p.kind, freeBytes: p.freeBytes, problem };
    });

  let original = `${ref.pool}/${OLD_PREFIX}${ref.name}-${dateStamp()}`;
  for (let i = 2; parked.some((d) => d.id === original); i++) original = `${ref.pool}/${OLD_PREFIX}${ref.name}-${dateStamp()}-${i}`;

  return {
    ref,
    original,
    folder: ref.name,
    pool: ref.pool,
    poolDisplayName: source?.displayName ?? ref.pool,
    locations,
    apps: apps.map(appTitle).sort((a, b) => a.localeCompare(b)),
    usedBytes,
    spaceNeededBytes,
    duration: durationOf(usedBytes),
    blockers,
    notes,
    targets,
  };
}

interface TnSnapshotTask {
  id: number;
  dataset: string;
  recursive: boolean;
  exclude?: string[];
}

/** Work that must not overlap a move: app changes, moving apps, and setting up backups or encryption. */
function conflictingTask(ctx: AppContext): Task | undefined {
  return ctx.tasks
    .list()
    .find(
      (t) =>
        t.status === 'running' &&
        (t.type.startsWith('app-') || t.type.startsWith('apps-') || t.type.startsWith('remote-') || t.type === 'backup-create' || t.type === 'folder-encrypt'),
    );
}

/** Names of datasets that exist on a pool: the destination folder must not be one of them. */
async function nameTaken(client: TrueNasClient, dataset: string): Promise<boolean> {
  return (await getDataset(client, dataset)) !== null;
}

export async function checkLocationMove(ctx: AppContext, id: string): Promise<LocationMoveCheck> {
  const { ref: _ref, original: _original, ...check } = await checkFolder(ctx, locationFolder(ctx, id));
  const client = ctx.truenas.client();
  // A pool that already has a folder with this name can't take it.
  await Promise.all(
    check.targets.map(async (t) => {
      if (!t.problem && (await nameTaken(client, `${t.name}/${check.folder}`))) t.problem = `${t.displayName} already has a folder called ${check.folder}.`;
    }),
  );
  return check;
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

export async function startLocationMove(ctx: AppContext, id: string, pool: string): Promise<Task> {
  const plan = await checkFolder(ctx, locationFolder(ctx, id));
  if (plan.blockers.length) throw new UserError(plan.blockers.map((b) => b.message).join(' '), 409, 'CANNOT_MOVE');
  const target = plan.targets.find((t) => t.name === pool);
  if (!target) throw new UserError('That pool can’t take this folder.', 400, 'VALIDATION', { pool: 'Choose another pool' });
  if (target.problem) throw new UserError(target.problem, 409, 'CANNOT_MOVE');
  const client = ctx.truenas.client();
  if (await nameTaken(client, `${pool}/${plan.folder}`)) throw new UserError(`${target.displayName} already has a folder called ${plan.folder}.`, 409, 'NAME_TAKEN');
  const temp = `${pool}/${TEMP_PREFIX}${plan.folder}`;
  if (await nameTaken(client, temp)) {
    throw new UserError(`A dataset called “${temp}” is in the way, maybe left from an earlier attempt. Remove it in TrueNAS, then try again.`, 409, 'NAME_TAKEN');
  }

  // Checked again after the awaits above; from here to registering the task nothing is awaited, so neither
  // another move nor an app change can start in between.
  if (unfinished(ctx)) throw new UserError('Another folder is being moved. Wait until that has finished.', 409, 'BUSY');
  assertAppsNotMoving(ctx);
  const busyTask = conflictingTask(ctx);
  if (busyTask) throw new UserError(`Wait until “${busyTask.title}” has finished.`, 409, 'BUSY');

  const record: FolderMoveRecord = {
    id: randomUUID(),
    name: plan.folder,
    source: plan.ref.dataset,
    target: `${pool}/${plan.folder}`,
    temp,
    tempCreated: false,
    original: plan.original,
    status: 'running',
    step: null,
    error: null,
    taskId: null,
    renamedOriginal: false,
    switched: false,
    share: null,
    stoppedApps: [],
    warnings: [...plan.notes],
    startedAt: new Date().toISOString(),
    removeAfter: null,
  };
  // The record is in memory as soon as update() is called; only writing it to disk is awaited.
  const saved = ctx.store.update((s) => {
    s.folderMoves = [...(s.folderMoves ?? []), record];
  });
  const task = ctx.tasks.start({ type: 'folder-move', title: `Moving ${plan.folder} to ${target.displayName}`, ref: plan.folder, steps: MOVE_STEPS }, (t) =>
    runMove(ctx, record.id, t),
  );
  await saved;
  await patch(ctx, record.id, { taskId: task.id });
  ctx.bus.changed('locations');
  return task;
}

function replicationArgs(r: FolderMoveRecord, fromScratch: boolean): Record<string, unknown> {
  return {
    direction: 'PUSH',
    transport: 'LOCAL',
    source_datasets: [r.source],
    target_dataset: r.temp,
    recursive: true,
    properties: true,
    // Every snapshot, so the folder keeps its restore points ("Previous versions").
    name_regex: '.*',
    retention_policy: 'NONE',
    // The default (SET) would leave the folder read-only.
    readonly: 'IGNORE',
    allow_from_scratch: false,
    only_from_scratch: fromScratch,
    mount: true,
  };
}

const pathOf = (dataset: string) => `/mnt/${dataset}`;

async function runMove(ctx: AppContext, id: string, t: TaskContext): Promise<void> {
  const client = ctx.truenas.client();
  let r = recordById(ctx, id);
  const step = async <T>(name: string, fn: (report: (percent: number, message?: string) => void) => Promise<T>): Promise<T> => {
    r = await patch(ctx, id, { step: name });
    return t.step(name, fn);
  };
  const report = (fn: (percent: number, message?: string) => void) => (job: Job) => fn(job.progress.percent ?? 0, job.progress.description ?? undefined);

  try {
    await step('Checking', async () => {
      const plan = await checkFolder(ctx, { name: r.name, pool: r.source.split('/')[0]!, dataset: r.source, path: pathOf(r.source) }, { ownRun: id });
      if (plan.blockers.length) throw new UserError(plan.blockers.map((b) => b.message).join(' '), 409, 'CANNOT_MOVE');
      if (await nameTaken(client, r.target)) throw new UserError(`The new pool already has a folder called ${r.name}.`, 409, 'NAME_TAKEN');
    });

    await step('Copying files', async (progress) => {
      await ensureSnapshot(client, r.source, snapshotName(r, 1));
      if (await getDataset(client, r.temp)) {
        if (!r.tempCreated) throw new UserError(`A dataset called “${r.temp}” is in the way. Remove it in TrueNAS, then try again.`, 409, 'NAME_TAKEN');
        if ((await snapshotNames(client, r.temp)).includes(snapshotName(r, 1))) return;
        // A copy this move started but that never got its first snapshot is a half-received leftover: start again.
        await client.call('pool.dataset.delete', [r.temp, { recursive: true }]);
      }
      r = await patch(ctx, id, { tempCreated: true });
      await client.job('replication.run_onetime', [replicationArgs(r, true)], report(progress));
    });

    await step('Stopping apps and sharing', async () => {
      const running = (await appsUsing(client, pathOf(r.source))).filter((a) => a.state === 'RUNNING' || a.state === 'DEPLOYING');
      // Written down before stopping, so a restart in the middle still knows which apps to start again
      // (starting is skipped for apps that are still running).
      r = await patch(ctx, id, { stoppedApps: [...new Set([...r.stoppedApps, ...running.map((a) => a.name)])] });
      for (const app of running) await client.job('app.stop', [app.name]);
      if (!r.share) {
        const [share] = await client.call<TnSmbShare[]>('sharing.smb.query', [[['path', '=', pathOf(r.source)]]]);
        if (share) {
          r = await patch(ctx, id, { share: { id: share.id, wasEnabled: share.enabled } });
          if (share.enabled) await client.call('sharing.smb.update', [share.id, { enabled: false }]);
        }
      }
    });

    await step('Copying the latest changes', async (progress) => {
      await ensureSnapshot(client, r.source, snapshotName(r, 2));
      if ((await snapshotNames(client, r.temp)).includes(snapshotName(r, 2))) return;
      await client.job('replication.run_onetime', [replicationArgs(r, false)], report(progress));
    });

    await step('Checking the copy', async () => {
      await compareDatasetTrees(client, r.source, r.temp, snapshotName(r, 2)).catch((err: Error) => {
        throw new UserError(err.message, 500, 'COPY_MISMATCH');
      });
      const diff = await compareTrees(client, pathOf(r.source), pathOf(r.temp));
      if (diff) throw new UserError(`The copy doesn’t match the original at “${diff}”.`, 500, 'COPY_MISMATCH');
    });

    await step('Switching over', async () => {
      if (!r.renamedOriginal) {
        await client.call('pool.dataset.rename', [r.source, { new_name: r.original, force: true }]);
        r = await patch(ctx, id, { renamedOriginal: true });
      }
      try {
        await client.call('pool.dataset.rename', [r.temp, { new_name: r.target, force: true }]);
      } catch (err) {
        // Put the original back under its name so the folder never stays missing.
        const restored = await client.call('pool.dataset.rename', [r.original, { new_name: r.source, force: true }]).then(
          () => true,
          () => false,
        );
        if (restored) r = await patch(ctx, id, { renamedOriginal: false });
        throw err;
      }
      r = await patch(ctx, id, { switched: true });
      await followNewPath(ctx, r);
    });
  } catch (err) {
    const message = errorMessage(err);
    r = recordById(ctx, id);
    if (r.switched) {
      // The folder is already on its new pool: finishing is retried soon (not inside this task, which still
      // counts as the running move until it ends) rather than at the next hourly run.
      await patch(ctx, id, { status: 'failed', error: message });
      await addNotice(ctx, {
        level: 'error',
        title: `Moving ${r.name} needs to finish`,
        message: `${message} ${r.name} is already on its new pool; ApexOs tries again to finish the move in a minute.`,
        link: '/settings',
      }).catch(() => undefined);
      setTimeout(() => void folderMoveHousekeeping(ctx).catch(() => undefined), RETRY_AFTER_FAILURE_MS).unref();
      throw err;
    }
    const left = await undoBeforeSwitch(ctx, r);
    if (left) await patch(ctx, id, { status: 'failed', error: `${message} ${left}` });
    else await forget(ctx, id);
    await addNotice(ctx, {
      level: 'error',
      title: `Moving ${r.name} didn’t finish`,
      message: left
        ? `${message} ${left}`
        : `${message} Nothing changed: ${r.name} is still on its pool and everything that was stopped runs again.`,
      link: '/settings',
    }).catch(() => undefined);
    throw err;
  } finally {
    ctx.bus.changed('locations');
    ctx.bus.changed('folders');
  }

  await finishMove(ctx, id, t);
}

/**
 * After the switch-over: the share and ApexOs's own records point at the new path. Idempotent (only the old
 * path is replaced), so an interrupted move can run it again.
 */
async function followNewPath(ctx: AppContext, r: FolderMoveRecord): Promise<void> {
  const client = ctx.truenas.client();
  const from = pathOf(r.source);
  const to = pathOf(r.target);
  if (r.share) await client.call('sharing.smb.update', [r.share.id, { path: to, enabled: r.share.wasEnabled }]);
  await ctx.store.update((s) => {
    for (const [key, path] of Object.entries(s.preferences.locations)) {
      if (path && underPath(path, from)) s.preferences.locations[key as keyof typeof s.preferences.locations] = `${to}${path.slice(from.length)}`;
    }
    for (const record of Object.values(s.apps)) {
      record.directories = record.directories.map((d) =>
        inside(d.dataset, r.source) ? { ...d, dataset: `${r.target}${d.dataset.slice(r.source.length)}`, path: `${to}${d.path.slice(from.length)}` } : d,
      );
    }
  });
  ctx.bus.changed('locations');
}

/** Updates the apps, starts the ones ApexOs stopped and removes the move's snapshots. Problems become warnings. */
async function finishMove(ctx: AppContext, id: string, t?: TaskContext): Promise<void> {
  const client = ctx.truenas.client();
  let r = recordById(ctx, id);
  const warnings: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => (t ? t.step(name, fn) : fn());
  const from = pathOf(r.source);
  const to = pathOf(r.target);

  await step('Updating apps', async () => {
    const apps = await appsUsing(client, from).catch((err: Error) => {
      warnings.push(`ApexOs couldn’t check which apps use ${r.name} (${errorMessage(err)}). In TrueNAS, change any app folders from ${from} to ${to}.`);
      return [] as TnApp[];
    });
    for (const app of apps) {
      try {
        // TrueNAS replaces each top-level key that is sent, so changed keys go along whole.
        const config = await client.call<Record<string, unknown>>('app.config', [app.name]);
        const values = Object.fromEntries(Object.entries(config).filter(([, v]) => usesPath(v, from)).map(([k, v]) => [k, rewritePaths(v, from, to)]));
        if (Object.keys(values).length) await client.job('app.update', [app.name, { values }]);
      } catch (err) {
        warnings.push(`${appTitle(app)} couldn’t be updated (${errorMessage(err)}). In TrueNAS, change its folders from ${from} to ${to}.`);
      }
    }
  });

  await step('Starting apps again', async () => {
    const apps = await client.call<TnApp[]>('app.query').catch(() => [] as TnApp[]);
    for (const name of r.stoppedApps) {
      const app = apps.find((a) => a.name === name);
      if (!app || app.state === 'RUNNING' || app.state === 'DEPLOYING') continue;
      await client.job('app.start', [name]).catch((err: Error) => warnings.push(`${appTitle(app)} didn’t start again (${errorMessage(err)}). Start it from the Apps page.`));
    }
  });

  await step('Cleaning up', async () => {
    for (const ds of [r.target, r.original]) {
      for (const n of [1, 2] as const) await dropSnapshot(client, ds, snapshotName(r, n)).catch(() => undefined);
    }
  });

  r = await patch(ctx, id, {
    status: 'done',
    step: null,
    error: null,
    stoppedApps: [],
    warnings: [...r.warnings, ...warnings],
    removeAfter: new Date(Date.now() + OLD_COPY_DAYS * DAY).toISOString(),
  });
  await addNotice(ctx, {
    level: r.warnings.length ? 'warning' : 'info',
    title: `${r.name} moved to ${r.target.split('/')[0]}`,
    message: r.warnings.length ? r.warnings.join(' ') : `The old copy stays on ${r.source.split('/')[0]} for ${OLD_COPY_DAYS} days, then ApexOs removes it.`,
    link: '/settings',
  }).catch(() => undefined);
  ctx.bus.changed('apps');
  ctx.bus.changed('locations');
  ctx.bus.changed('folders');
  ctx.bus.changed('storage');
}

/** Before the switch-over the original is untouched: share it again, start the apps, drop the copy. Returns what's left over. */
async function undoBeforeSwitch(ctx: AppContext, r: FolderMoveRecord): Promise<string | null> {
  const client = ctx.truenas.client();
  r = await reconcile(ctx, r);
  const problems: string[] = [];
  const attempt = (what: string, fn: () => Promise<unknown>) => fn().catch((err: Error) => problems.push(`${what}: ${errorMessage(err)}`));
  if (r.renamedOriginal) {
    await attempt('putting the folder back', async () => {
      await client.call('pool.dataset.rename', [r.original, { new_name: r.source, force: true }]);
      await patch(ctx, r.id, { renamedOriginal: false });
    });
  }
  if (r.share?.wasEnabled) await attempt('sharing it again', () => client.call('sharing.smb.update', [r.share!.id, { enabled: true }]));
  const states = new Map((await client.call<TnApp[]>('app.query').catch(() => [] as TnApp[])).map((a) => [a.name, a.state]));
  for (const name of r.stoppedApps) {
    const state = states.get(name);
    if (state === 'RUNNING' || state === 'DEPLOYING') continue; // never got stopped
    await attempt(`starting ${name}`, () => client.job('app.start', [name]));
  }
  await attempt('removing the copy', async () => {
    if (r.tempCreated && (await getDataset(client, r.temp))) await client.call('pool.dataset.delete', [r.temp, { recursive: true }]);
  });
  for (const n of [1, 2] as const) await attempt('removing snapshots', () => dropSnapshot(client, r.source, snapshotName(r, n)));
  return problems.length ? `ApexOs couldn’t finish cleaning up (${problems.join('; ')}); it tries again later.` : null;
}

// ---------------------------------------------------------------------------
// Listing, the old copy, housekeeping
// ---------------------------------------------------------------------------

export async function listFolderMoves(ctx: AppContext): Promise<FolderMove[]> {
  const list = records(ctx);
  if (!list.length) return [];
  const client = ctx.truenas.client();
  const [storage, old] = await Promise.all([
    getStorage(ctx).catch(() => null),
    queryDatasets(client, [['id', 'in', list.filter((r) => r.status === 'done').map((r) => r.original)]]).catch(() => []),
  ]);
  const display = (dataset: string) => {
    const pool = dataset.split('/')[0]!;
    return storage?.pools.find((p) => p.name === pool)?.displayName ?? pool;
  };
  return list.map((r) => {
    const copy = r.status === 'done' ? old.find((d) => d.id === r.original) : undefined;
    const running = r.status === 'running' && r.taskId ? ctx.tasks.get(r.taskId)?.status === 'running' : false;
    return {
      id: r.id,
      folder: r.name,
      fromPool: display(r.source),
      toPool: display(r.target),
      state: r.status === 'running' && !running ? 'failed' : r.status,
      error: r.status === 'running' && !running ? 'ApexOs restarted during the move; it finishes or cleans up by itself shortly.' : r.error,
      taskId: r.taskId,
      warnings: r.warnings,
      oldCopy: copy && r.removeAfter ? { usedBytes: propNumber(copy.used), removeAfter: r.removeAfter } : null,
    };
  });
}

export async function startOldCopyRemoval(ctx: AppContext, id: string): Promise<Task> {
  const r = recordById(ctx, id);
  if (r.status !== 'done') throw new UserError('This move hasn’t finished yet.', 409, 'BUSY');
  if (ctx.tasks.findRunning('folder-move-old', r.name)) throw new UserError('The old copy is already being removed.', 409, 'BUSY');
  return startRemoval(ctx, r);
}

function startRemoval(ctx: AppContext, r: FolderMoveRecord): Task {
  return ctx.tasks.start({ type: 'folder-move-old', title: `Removing the old copy of ${r.name}`, ref: r.name }, (t) =>
    t.step('Removing the old copy', () => removeOldCopy(ctx, r)),
  );
}

/** Only ever deletes the hidden dataset this move parked the old folder under. */
async function removeOldCopy(ctx: AppContext, r: FolderMoveRecord): Promise<void> {
  const client = ctx.truenas.client();
  const pool = r.source.split('/')[0]!;
  if (r.original.startsWith(`${pool}/${OLD_PREFIX}`) && (await getDataset(client, r.original))) {
    await client.call('pool.dataset.delete', [r.original, { recursive: true, force: true }]);
  }
  await forget(ctx, r.id);
  ctx.bus.changed('storage');
}

/**
 * After a restart the saved flags can lag one rename behind what happened (ApexOs may have stopped between a
 * rename and saving it), so they are set from the datasets that actually exist.
 */
async function reconcile(ctx: AppContext, r: FolderMoveRecord): Promise<FolderMoveRecord> {
  const found = new Set((await queryDatasets(ctx.truenas.client(), [['id', 'in', [r.source, r.original, r.temp, r.target]]])).map((d) => d.id));
  const change: Partial<FolderMoveRecord> = {};
  if (!r.renamedOriginal && !found.has(r.source) && found.has(r.original)) change.renamedOriginal = true;
  // The copy was renamed into place: it is gone under its hidden name and the folder exists on the new pool.
  if (!r.switched && r.tempCreated && !found.has(r.temp) && found.has(r.target) && found.has(r.original)) change.switched = true;
  return Object.keys(change).length ? patch(ctx, r.id, change) : r;
}

/**
 * Hourly (and once TrueNAS is reachable after start-up): finishes moves that were switched over when ApexOs
 * stopped, undoes ones that weren't, and removes old copies whose week is up. Each runs as a registered task,
 * started with nothing awaited after its checks, so app changes wait for it and runs never overlap.
 */
export async function folderMoveHousekeeping(ctx: AppContext): Promise<void> {
  if (!ctx.truenas.connected) return;
  for (const r of records(ctx)) {
    if (r.taskId && ctx.tasks.get(r.taskId)?.status === 'running') continue;
    if (r.status === 'done') {
      if (r.removeAfter && Date.parse(r.removeAfter) <= Date.now() && !ctx.tasks.findRunning('folder-move-old', r.name)) startRemoval(ctx, r);
    } else if (!ctx.tasks.findRunning('folder-move')) {
      startRecovery(ctx, r);
    }
  }
}

function startRecovery(ctx: AppContext, r: FolderMoveRecord): Task {
  const task = ctx.tasks.start({ type: 'folder-move', title: `Recovering the move of ${r.name}`, ref: r.name }, async (t) => {
    const current = await reconcile(ctx, recordById(ctx, r.id));
    if (current.switched) {
      await t.step('Following the new place', () => followNewPath(ctx, current));
      await finishMove(ctx, r.id, t);
      return;
    }
    const left = await t.step('Undoing the move', () => undoBeforeSwitch(ctx, current));
    if (left) {
      await patch(ctx, r.id, { status: 'failed', error: left });
      throw new UserError(left, 500, 'CLEANUP_INCOMPLETE');
    }
    await forget(ctx, r.id);
    await addNotice(ctx, {
      level: 'warning',
      title: `Moving ${r.name} didn’t finish`,
      message: `ApexOs restarted during the move, so it was undone: ${r.name} is still on its pool and everything that was stopped runs again.`,
      link: '/settings',
    }).catch(() => undefined);
  });
  // Saved in memory right away (only the disk write is awaited), so another housekeeping run sees it.
  void ctx.store.update((s) => {
    const rec = s.folderMoves?.find((x) => x.id === r.id);
    if (rec) rec.taskId = task.id;
  });
  return task;
}
