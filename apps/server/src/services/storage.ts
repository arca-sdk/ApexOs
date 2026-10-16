import type {
  Drive,
  DriveRole,
  ImportablePool,
  NewPoolSpec,
  Pool,
  PoolHealth,
  PoolScan,
  StorageOverview,
} from '@apexos/api-types';
import type { TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { describeTopology, estimateLayout, MAX_EXPANDED_DRIVES, MIN_DRIVE_BYTES, poolKindFor } from '../lib/layout.ts';
import { dateToIso, driveKind, isSmr, propNumber } from '../truenas/helpers.ts';
import { attachDriveHealth } from './drive-health.ts';
import { recordCheckStarted } from './pool-checks.ts';
import type { TnDataset, TnDisk, TnDiskDetail, TnDockerConfig, TnPool, TnScrubTask, TnVdev } from '../truenas/types.ts';

/** Everything storage-related, fetched together so views are consistent. */
export interface StorageSnapshot {
  disks: TnDisk[];
  details: TnDiskDetail[];
  pools: TnPool[];
  rootDatasets: TnDataset[];
  temperatures: Record<string, number | null>;
  bootDisks: string[];
  scrubTasks: TnScrubTask[];
  docker: TnDockerConfig | null;
}

export async function readStorage(client: TrueNasClient): Promise<StorageSnapshot> {
  const [disks, details, pools, bootDisks, scrubTasks, docker] = await Promise.all([
    client.call<TnDisk[]>('disk.query', [[], { extra: { pools: true } }]),
    client.call<{ used: TnDiskDetail[]; unused: TnDiskDetail[] }>('disk.details', [{ type: 'BOTH' }]),
    client.call<TnPool[]>('pool.query'),
    client.call<string[]>('boot.get_disks').catch(() => [] as string[]),
    client.call<TnScrubTask[]>('pool.scrub.query').catch(() => [] as TnScrubTask[]),
    client.call<TnDockerConfig>('docker.config').catch(() => null),
  ]);
  const poolNames = pools.map((p) => p.name);
  const [rootDatasets, temperatures] = await Promise.all([
    poolNames.length
      ? client.call<TnDataset[]>('pool.dataset.query', [[['id', 'in', poolNames]], { extra: { retrieve_children: false } }])
      : Promise.resolve([] as TnDataset[]),
    client.call<Record<string, number | null>>('disk.temperatures', [[], false]).catch(() => ({})),
  ]);
  return {
    disks,
    details: [...(details.used ?? []), ...(details.unused ?? [])],
    pools,
    rootDatasets,
    temperatures,
    bootDisks,
    scrubTasks,
    docker,
  };
}

interface LeafInfo {
  pool: string;
  role: DriveRole;
  vdev: TnVdev;
}

function walkLeaves(pool: TnPool, visit: (leaf: TnVdev, role: DriveRole) => void): void {
  const sections: [keyof NonNullable<TnPool['topology']>, DriveRole][] = [
    ['data', 'data'],
    ['spare', 'spare'],
    ['cache', 'cache'],
    ['log', 'log'],
    ['special', 'special'],
    ['dedup', 'dedup'],
  ];
  const walk = (v: TnVdev, role: DriveRole) => {
    if (v.type === 'DISK') visit(v, role);
    for (const c of v.children ?? []) walk(c, role);
  };
  for (const [key, role] of sections) for (const v of pool.topology?.[key] ?? []) walk(v, role);
}

function leafErrors(v: TnVdev) {
  return { read: v.stats?.read_errors ?? 0, write: v.stats?.write_errors ?? 0, checksum: v.stats?.checksum_errors ?? 0 };
}

function toDrive(disk: TnDisk, snap: StorageSnapshot, leaf?: LeafInfo): Drive {
  const detail = snap.details.find((d) => d.identifier === disk.identifier || d.name === disk.name);
  const kind = driveKind(disk);
  const isBoot = snap.bootDisks.includes(disk.name);
  const warnings: Drive['warnings'] = [];
  if (kind === 'HDD' && isSmr(disk.model)) warnings.push('SMR');
  const exportedPool = detail?.exported_zpool ?? null;
  if (!leaf && !isBoot && (exportedPool || (detail?.partitions?.length ?? 0) > 0)) warnings.push('EXISTING_DATA');
  if ((detail?.duplicate_serial?.length ?? 0) > 0) warnings.push('DUPLICATE_SERIAL');

  let unavailableReason: string | null = null;
  if (isBoot) unavailableReason = 'Holds the operating system.';
  else if (leaf) unavailableReason = `Part of the ${leaf.pool} pool.`;
  else if (kind === 'USB') unavailableReason = 'USB drives are not used for storage pools.';
  else if (disk.size < MIN_DRIVE_BYTES) unavailableReason = 'Too small (under 1 GiB).';

  return {
    identifier: disk.identifier,
    name: disk.name,
    serial: disk.serial,
    model: disk.model,
    sizeBytes: disk.size,
    kind,
    rotationRate: disk.rotationrate,
    temperatureC: snap.temperatures[disk.name] ?? null,
    pool: leaf?.pool ?? (isBoot ? 'boot-pool' : null),
    role: leaf?.role ?? (isBoot ? 'boot' : null),
    status: leaf?.vdev.status ?? null,
    errors: leaf ? leafErrors(leaf.vdev) : { read: 0, write: 0, checksum: 0 },
    warnings,
    exportedPool,
    available: unavailableReason === null,
    unavailableReason,
    missing: false,
  };
}

/** A pool member that ZFS can no longer see (pulled, dead, or renamed). */
function missingDrive(leaf: TnVdev, pool: string, role: DriveRole): Drive {
  const known = leaf.unavail_disk;
  return {
    identifier: known?.identifier ?? `missing:${leaf.guid}`,
    name: known?.name ?? leaf.disk ?? leaf.name,
    serial: known?.serial ?? 'unknown',
    model: known?.model ?? 'Missing drive',
    sizeBytes: known?.size ?? 0,
    kind: known ? driveKind(known) : 'HDD',
    rotationRate: known?.rotationrate ?? null,
    temperatureC: null,
    pool,
    role,
    status: leaf.status,
    errors: leafErrors(leaf),
    warnings: [],
    exportedPool: null,
    available: false,
    unavailableReason: 'Missing from the server.',
    missing: true,
  };
}

function poolScan(pool: TnPool): PoolScan | null {
  if (pool.expand && pool.expand.state === 'EXPANDING') {
    return {
      kind: 'expand',
      state: 'running',
      percent: Math.round(pool.expand.percentage ?? 0),
      secondsLeft: pool.expand.total_secs_left ?? null,
      finishedAt: null,
      errors: 0,
    };
  }
  const scan = pool.scan;
  if (!scan || !scan.function) return null;
  const state: PoolScan['state'] =
    scan.pause ? 'paused' : scan.state === 'SCANNING' ? 'running' : scan.state === 'CANCELED' ? 'canceled' : 'finished';
  return {
    kind: scan.function === 'RESILVER' ? 'resilver' : 'scrub',
    state,
    percent: Math.round(scan.percentage ?? 0),
    secondsLeft: scan.total_secs_left ?? null,
    finishedAt: dateToIso(scan.end_time),
    errors: scan.errors ?? 0,
  };
}

function poolHealth(pool: TnPool, scan: PoolScan | null, errors: { read: number; write: number; checksum: number }): { health: PoolHealth; detail: string | null } {
  const status = pool.status?.toUpperCase();
  if (scan?.kind === 'resilver' && scan.state === 'running') {
    return { health: 'rebuilding', detail: 'A drive is being rebuilt. Your data is safe; avoid changing drives until this finishes.' };
  }
  if (['FAULTED', 'OFFLINE', 'UNAVAIL', 'SUSPENDED', 'REMOVED'].includes(status)) {
    return { health: 'offline', detail: 'This pool has stopped serving data. Check that all drives are connected and powered, then restart.' };
  }
  if (status === 'DEGRADED') {
    return { health: 'degraded', detail: 'A drive has failed or is missing. Your data is still safe, but replace the drive soon.' };
  }
  if (errors.checksum > 0 || errors.read > 0 || errors.write > 0 || pool.healthy === false) {
    return {
      health: 'errors',
      detail: pool.status_detail ?? 'Drives in this pool reported errors. Run "Check pool" to verify your data.',
    };
  }
  if (status === 'ONLINE') return { health: 'healthy', detail: null };
  return { health: 'unknown', detail: pool.status_detail };
}

export function buildOverview(ctx: AppContext, snap: StorageSnapshot): StorageOverview {
  const leaves = new Map<string, LeafInfo>();
  const missingByPool = new Map<string, Drive[]>();
  for (const pool of snap.pools) {
    walkLeaves(pool, (leaf, role) => {
      const disk = snap.disks.find((d) => (d.zfs_guid && d.zfs_guid === leaf.guid) || (leaf.disk && d.name === leaf.disk));
      if (disk) leaves.set(disk.identifier, { pool: pool.name, role, vdev: leaf });
      else missingByPool.set(pool.name, [...(missingByPool.get(pool.name) ?? []), missingDrive(leaf, pool.name, role)]);
    });
  }

  const drives = snap.disks.map((d) => toDrive(d, snap, leaves.get(d.identifier)));
  const names = ctx.store.get().poolNames;

  const pools: Pool[] = snap.pools.map((p) => {
    const members = [...drives.filter((d) => d.pool === p.name), ...(missingByPool.get(p.name) ?? [])];
    const dataDrives = members.filter((d) => d.role !== 'spare');
    const spares = members.filter((d) => d.role === 'spare');
    const errors = dataDrives.reduce(
      (acc, d) => ({ read: acc.read + d.errors.read, write: acc.write + d.errors.write, checksum: acc.checksum + d.errors.checksum }),
      { read: 0, write: 0, checksum: 0 },
    );
    const scan = poolScan(p);
    const { health, detail } = poolHealth(p, scan, errors);
    // Capacity as users see it: used + available of the root dataset (falls back to raw pool numbers).
    const root = snap.rootDatasets.find((d) => d.id === p.name);
    const used = root ? propNumber(root.used) : (p.allocated ?? 0);
    const free = root ? propNumber(root.available) : (p.free ?? 0);
    const size = used + free;
    const layout = describeTopology(p.topology?.data ?? []);
    if (layout.expandable && dataDrives.length >= MAX_EXPANDED_DRIVES) layout.expandable = false;
    return {
      id: p.id,
      name: p.name,
      displayName: names[p.name] ?? p.name,
      path: p.path,
      kind: poolKindFor(dataDrives.filter((d) => !d.missing).map((d) => d.kind)),
      health,
      healthDetail: detail,
      zfsStatus: p.status,
      sizeBytes: size,
      usedBytes: used,
      freeBytes: free,
      usedPercent: size > 0 ? Math.round((used / size) * 1000) / 10 : 0,
      layout,
      drives: dataDrives,
      spares,
      scan,
      scrubScheduled: snap.scrubTasks.some((t) => t.pool_name === p.name && t.enabled),
      isAppsPool: snap.docker?.pool === p.name,
      errors,
    };
  });

  attachDriveHealth(ctx, [...drives, ...[...missingByPool.values()].flat()]);
  return {
    pools,
    unassigned: drives.filter((d) => !d.pool),
    bootDrives: drives.filter((d) => d.role === 'boot'),
  };
}

export async function getStorage(ctx: AppContext): Promise<StorageOverview> {
  return buildOverview(ctx, await readStorage(ctx.truenas.client()));
}

/** Resolves stable identifiers to current kernel names right before a destructive call. */
export async function resolveDiskNames(client: TrueNasClient, identifiers: string[]): Promise<string[]> {
  const disks = await client.call<TnDisk[]>('disk.query', [[['identifier', 'in', identifiers]]]);
  return identifiers.map((id) => {
    const disk = disks.find((d) => d.identifier === id);
    if (!disk) throw new UserError('A selected drive is no longer present. Refresh and try again.', 409, 'DRIVE_GONE');
    return disk.name;
  });
}

export function findPool(overview: StorageOverview, id: number): Pool {
  const pool = overview.pools.find((p) => p.id === id);
  if (!pool) throw new UserError('That pool no longer exists', 404, 'NOT_FOUND');
  return pool;
}

const POOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,49}$/;

/** Validates a new pool against the current drive list and returns the drives it uses. */
export function validateNewPool(
  overview: StorageOverview,
  spec: NewPoolSpec,
  opts: { reusableDrives?: Set<string>; takenNames?: string[] } = {},
): Drive[] {
  if (!POOL_NAME_RE.test(spec.name) || /^(boot-pool|mirror|raidz|spare|log|draid)/i.test(spec.name)) {
    throw new UserError('Pool names start with a letter and use letters, numbers, dots, dashes or underscores (max 50).', 400, 'VALIDATION', {
      name: 'Invalid pool name',
    });
  }
  const taken = opts.takenNames ?? overview.pools.map((p) => p.name);
  if (taken.some((n) => n.toLowerCase() === spec.name.toLowerCase())) {
    throw new UserError(`A pool named ${spec.name} already exists.`, 409, 'VALIDATION', { name: 'Name already in use' });
  }
  if (new Set(spec.drives).size !== spec.drives.length) throw new UserError('A drive was selected twice.', 400, 'VALIDATION');
  const all = [...overview.unassigned, ...overview.pools.flatMap((p) => p.drives), ...overview.bootDrives];
  const drives = spec.drives.map((id) => {
    const drive = all.find((d) => d.identifier === id);
    if (!drive) throw new UserError('A selected drive is no longer present. Refresh and try again.', 409, 'DRIVE_GONE');
    const reusable = opts.reusableDrives?.has(id) ?? false;
    if (!drive.available && !reusable) {
      throw new UserError(`${drive.model} (${drive.serial}) can't be used: ${drive.unavailableReason}`, 400, 'DRIVE_UNAVAILABLE');
    }
    return drive;
  });
  const estimate = estimateLayout(spec.layout, drives);
  if (!estimate.valid) throw new UserError(estimate.problems.join(' '), 400, 'VALIDATION');
  return drives;
}

/** Creates a pool and makes sure it has a scheduled health check (scrub). */
export async function createPool(ctx: AppContext, spec: NewPoolSpec, report?: (percent: number, message?: string) => void): Promise<number> {
  const client = ctx.truenas.client();
  const names = await resolveDiskNames(client, spec.drives);
  const pool = await client.job<TnPool>(
    'pool.create',
    [{ name: spec.name, encryption: false, topology: { data: [{ type: spec.layout, disks: names }] } }],
    (job) => report?.(job.progress.percent ?? 0, job.progress.description ?? undefined),
  );
  await ensureScrubSchedule(client, pool.id, pool.name);
  return pool.id;
}

/** Weekly check (scrub) that only actually runs when the last one is older than 35 days, like TrueNAS's default. */
export async function ensureScrubSchedule(client: TrueNasClient, poolId: number, poolName: string): Promise<void> {
  const tasks = await client.call<TnScrubTask[]>('pool.scrub.query', [[['pool_name', '=', poolName]]]).catch(() => []);
  if (tasks.length) return;
  await client.call('pool.scrub.create', [
    {
      pool: poolId,
      threshold: 35,
      description: 'Created by ApexOs',
      schedule: { minute: '00', hour: '03', dom: '*', month: '*', dow: '7' },
      enabled: true,
    },
  ]);
}

export function anyPoolAtRisk(overview: StorageOverview): Pool | undefined {
  return overview.pools.find((p) => p.health === 'degraded' || p.health === 'rebuilding' || p.health === 'offline');
}

export async function deletePool(ctx: AppContext, pool: Pool): Promise<void> {
  const client = ctx.truenas.client();
  await client.job('pool.export', [pool.id, { cascade: true, restart_services: true, destroy: true }]);
  await ctx.store.update((s) => {
    delete s.poolNames[pool.name];
    if (s.oldAppData) delete s.oldAppData[pool.name];
    for (const [id, path] of Object.entries(s.preferences.locations)) {
      if (path && (path === pool.path || path.startsWith(`${pool.path}/`))) delete s.preferences.locations[id as keyof typeof s.preferences.locations];
    }
  });
}

/** Checks that a drive can join a pool (as a new member, replacement or spare). */
export function assertDriveFits(pool: Pool, drive: Drive): void {
  const members = pool.drives.filter((d) => !d.missing);
  const smallest = Math.min(...members.map((d) => d.sizeBytes));
  if (!drive.available) throw new UserError(`That drive can't be used: ${drive.unavailableReason}`, 400, 'DRIVE_UNAVAILABLE');
  if (drive.sizeBytes < smallest) {
    throw new UserError('The new drive must be at least as large as the smallest drive in the pool.', 400, 'DRIVE_TOO_SMALL');
  }
  const poolKind = pool.kind;
  const driveIsHdd = drive.kind === 'HDD';
  if ((poolKind === 'capacity' && !driveIsHdd) || (poolKind === 'performance' && driveIsHdd)) {
    throw new UserError('Use a drive of the same kind as the rest of the pool (hard drive vs SSD).', 400, 'DRIVE_WRONG_KIND');
  }
}

/** Grows a RAIDZ pool by one drive (RAIDZ expansion). */
export async function addDriveToPool(ctx: AppContext, pool: Pool, driveId: string, overview: StorageOverview, report?: (p: number, m?: string) => void) {
  if (!pool.layout.expandable) {
    throw new UserError('This pool can’t grow one drive at a time. Only single-group RAIDZ pools with fewer than 12 drives can.', 400, 'NOT_EXPANDABLE');
  }
  const drive = overview.unassigned.find((d) => d.identifier === driveId);
  if (!drive) throw new UserError('That drive is not available', 404, 'NOT_FOUND');
  assertDriveFits(pool, drive);
  const client = ctx.truenas.client();
  const [tnPool] = await client.call<TnPool[]>('pool.query', [[['id', '=', pool.id]]]);
  const vdev = tnPool?.topology?.data[0];
  if (!vdev) throw new UserError('Could not read the pool layout', 409, 'POOL_LAYOUT');
  const [name] = await resolveDiskNames(client, [driveId]);
  await client.job('pool.attach', [pool.id, { target_vdev: vdev.guid, new_disk: name }], (job) =>
    report?.(job.progress.percent ?? 0, job.progress.description ?? undefined),
  );
}

/** Swaps a (failed or healthy) pool drive for an unused one; the pool keeps its protection during the rebuild. */
export async function replaceDrive(
  ctx: AppContext,
  pool: Pool,
  oldDriveId: string,
  newDriveId: string,
  overview: StorageOverview,
  report?: (p: number, m?: string) => void,
) {
  const old = pool.drives.find((d) => d.identifier === oldDriveId) ?? pool.spares.find((d) => d.identifier === oldDriveId);
  if (!old) throw new UserError('That drive is not part of this pool', 404, 'NOT_FOUND');
  if (pool.drives.length < 2 && !old.missing) throw new UserError('Single-drive pools can’t replace drives.', 400, 'NOT_REPLACEABLE');
  if (pool.scan?.kind === 'resilver' && pool.scan.state === 'running') {
    throw new UserError('Wait for the current rebuild to finish before replacing another drive.', 409, 'BUSY');
  }
  const replacement = overview.unassigned.find((d) => d.identifier === newDriveId);
  if (!replacement) throw new UserError('That replacement drive is not available', 404, 'NOT_FOUND');
  assertDriveFits({ ...pool, drives: pool.drives.filter((d) => d.identifier !== oldDriveId) }, replacement);

  const client = ctx.truenas.client();
  const [tnPool] = await client.call<TnPool[]>('pool.query', [[['id', '=', pool.id]]]);
  let label: string | undefined;
  if (tnPool) {
    walkLeaves(tnPool, (leaf) => {
      if (label) return;
      if (old.missing ? `missing:${leaf.guid}` === old.identifier || leaf.unavail_disk?.identifier === old.identifier : leaf.disk === old.name) label = leaf.guid;
    });
  }
  if (!label) throw new UserError('Could not find that drive in the pool layout', 409, 'POOL_LAYOUT');
  const [name] = await resolveDiskNames(client, [newDriveId]);
  await client.job('pool.replace', [pool.id, { label, disk: name, force: false, preserve_settings: true }], (job) =>
    report?.(job.progress.percent ?? 0, job.progress.description ?? undefined),
  );
}

export async function addSpare(ctx: AppContext, pool: Pool, driveId: string, overview: StorageOverview) {
  if (pool.layout.faultTolerance === 0) throw new UserError('Spares only help pools that have protection.', 400, 'NO_SPARES');
  const drive = overview.unassigned.find((d) => d.identifier === driveId);
  if (!drive) throw new UserError('That drive is not available', 404, 'NOT_FOUND');
  if (drive.errors.read + drive.errors.write + drive.errors.checksum > 0) throw new UserError('A drive with errors can’t be a spare.', 400, 'FAILING');
  assertDriveFits(pool, drive);
  const client = ctx.truenas.client();
  const [name] = await resolveDiskNames(client, [driveId]);
  await client.job('pool.update', [pool.id, { topology: { spares: [name] } }]);
}

export async function startScrub(ctx: AppContext, pool: Pool): Promise<void> {
  if (pool.scan?.state === 'running') throw new UserError('A check is already running on this pool.', 409, 'BUSY');
  if (pool.health === 'offline') throw new UserError('The pool is offline; reconnect its drives first.', 409, 'POOL_OFFLINE');
  // The scrub job runs for as long as the scrub; progress is read from the pool's scan state.
  await ctx.truenas.client().call('pool.scrub', [pool.id, 'START']);
  await recordCheckStarted(ctx, pool.name);
}

export async function findImportable(ctx: AppContext): Promise<ImportablePool[]> {
  const found = await ctx.truenas.client().job<{ name: string; guid: string; status: string; hostname?: string | null }[]>('pool.import_find');
  return found.map((p) => ({ guid: String(p.guid), name: p.name, status: p.status, hostname: p.hostname ?? null }));
}

export async function importPool(ctx: AppContext, guid: string, report?: (p: number, m?: string) => void): Promise<void> {
  const client = ctx.truenas.client();
  await client.job('pool.import_pool', [{ guid }], (job) => report?.(job.progress.percent ?? 0, job.progress.description ?? undefined));
  const [pool] = await client.call<TnPool[]>('pool.query', [[['guid', '=', guid]]]);
  if (pool) await ensureScrubSchedule(client, pool.id, pool.name);
}
