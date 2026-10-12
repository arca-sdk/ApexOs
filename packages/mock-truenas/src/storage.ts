/**
 * Storage model shared by the disk, pool, dataset, sharing and filesystem namespaces:
 * rendering of `disk.query` / `pool.query` / `pool.dataset.query` entries, pool health and
 * capacity, dataset property inheritance, path resolution and default ACLs.
 */
import type { Mock } from './context.ts';
import type {
  AclState,
  DatasetShareType,
  DatasetState,
  DiskState,
  ExportedPoolState,
  LeafState,
  MockState,
  Owner,
  PoolState,
  ScanState,
  VdevCategory,
  VdevState,
  VdevType,
} from './state.ts';
import { $date, GiB, MiB, randomGuid, uuid, zfsHuman, type Obj } from './util.ts';

export const TOP_CATEGORIES: VdevCategory[] = ['data', 'special', 'dedup', 'log', 'cache'];
export const PARITY: Record<VdevType, number> = { STRIPE: 0, MIRROR: 0, RAIDZ1: 1, RAIDZ2: 2, RAIDZ3: 3 };
export const MIN_DISKS: Record<VdevType, number> = { STRIPE: 1, MIRROR: 2, RAIDZ1: 3, RAIDZ2: 4, RAIDZ3: 5 };
const ZFS_PART_TYPE = '6a898cc3-1dd2-11b2-99a6-080020736631';
const BOOT_POOL_GUID = '12403771589012345678';

// ---------------------------------------------------------------------------
// Disks
// ---------------------------------------------------------------------------

export function diskByName(state: MockState, name: string): DiskState | undefined {
  return state.disks.find((d) => d.present && d.name === name);
}

export function diskById(state: MockState, identifier: string): DiskState | undefined {
  return state.disks.find((d) => d.identifier === identifier);
}

export function partName(d: DiskState, n: number): string {
  return d.subsystem === 'nvme' ? `${d.name}p${n}` : `${d.name}${n}`;
}

export interface LeafRef {
  pool: PoolState;
  category: VdevCategory | 'spare';
  vdev: VdevState | null;
  leaf: LeafState;
  /** The leaf this one is replacing (set when `leaf` is the new half of a REPLACING vdev). */
  replaces: LeafState | null;
}

export function* poolLeaves(pool: PoolState): Generator<LeafRef> {
  for (const category of TOP_CATEGORIES) {
    for (const vdev of pool.topology[category]) {
      for (const leaf of vdev.children) {
        yield { pool, category, vdev, leaf, replaces: null };
        if (leaf.replacing) yield { pool, category, vdev, leaf: leaf.replacing, replaces: leaf };
      }
    }
  }
  for (const leaf of pool.topology.spare) yield { pool, category: 'spare', vdev: null, leaf, replaces: null };
}

/** Pool membership of a disk among imported pools. */
export function findLeafByDisk(state: MockState, identifier: string): LeafRef | undefined {
  for (const pool of state.pools) {
    for (const ref of poolLeaves(pool)) if (ref.leaf.disk === identifier) return ref;
  }
  return undefined;
}

export function exportedPoolOf(state: MockState, d: DiskState): ExportedPoolState | undefined {
  return state.exportedPools.find((e) => [...poolLeaves(e.pool)].some((r) => r.leaf.disk === d.identifier));
}

/** Imported pool the disk belongs to (`boot-pool` for the boot disk). */
export function diskPoolName(state: MockState, d: DiskState): string | null {
  if (d.boot) return 'boot-pool';
  return findLeafByDisk(state, d.identifier)?.pool.name ?? null;
}

export function renderDisk(state: MockState, d: DiskState, withPool: boolean): Obj {
  return {
    identifier: d.identifier,
    name: d.name,
    subsystem: d.subsystem,
    number: d.number,
    serial: d.serial,
    lunid: d.lunid,
    size: d.size,
    description: d.description,
    transfermode: 'Auto',
    hddstandby: d.hddstandby,
    advpowermgmt: d.advpowermgmt,
    expiretime: d.expiretime ? $date(d.expiretime) : null,
    model: d.model,
    rotationrate: d.rotationrate,
    type: d.type,
    zfs_guid: d.zfs_guid,
    bus: d.bus,
    devname: d.name,
    enclosure: null,
    pool: withPool ? diskPoolName(state, d) : null,
    passwd: '',
    kmip_uid: null,
  };
}

function leafPartuuid(state: MockState, d: DiskState): string | null {
  const ref = findLeafByDisk(state, d.identifier);
  if (ref) return ref.leaf.partuuid;
  const exported = exportedPoolOf(state, d);
  if (!exported) return null;
  for (const r of poolLeaves(exported.pool)) if (r.leaf.disk === d.identifier) return r.leaf.partuuid;
  return null;
}

export function diskPartitions(state: MockState, d: DiskState): Obj[] {
  const parts: Array<{ n: number; size: number; type: string; uuid: string }> = [];
  if (d.boot) {
    parts.push({ n: 1, size: 1 * MiB, type: '21686148-6449-6e6f-744e-656564454649', uuid: 'b6c1a0de-27a4-4f0e-9a51-0c3c47e1c0a1' });
    parts.push({ n: 2, size: 512 * MiB, type: 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b', uuid: '2f0d3b9e-6a8b-4f36-b3c4-5e0e9d4b7f12' });
    parts.push({ n: 3, size: d.size - 515 * MiB, type: ZFS_PART_TYPE, uuid: '9d1c5b77-5c1e-4b8e-8f0a-1c7d2e3f4a5b' });
  } else {
    const partuuid = leafPartuuid(state, d);
    if (partuuid) parts.push({ n: 1, size: d.size - 2 * MiB, type: ZFS_PART_TYPE, uuid: partuuid });
    else for (const p of d.foreignPartitions) parts.push({ n: p.number, size: p.size, type: p.type, uuid: uuidFrom(d.serial, p.number) });
  }
  let start = 2048;
  return parts.map((p) => {
    const sectors = Math.floor(p.size / 512);
    const entry = {
      name: partName(d, p.n),
      id: partName(d, p.n),
      path: `/dev/${partName(d, p.n)}`,
      disk: d.name,
      fs_label: null,
      partition_type: p.type,
      partition_number: p.n,
      partition_uuid: p.uuid,
      start_sector: start,
      end_sector: start + sectors - 1,
      start: start * 512,
      end: (start + sectors) * 512,
      size: sectors * 512,
      encrypted_provider: null,
    };
    start += sectors;
    return entry;
  });
}

function uuidFrom(seed: string, n: number): string {
  const hex = Buffer.from(`${seed}-${n}-partition-seed`).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** `disk.details` entry (`partitions` is only filled with `join_partitions`, like the middleware). */
export function diskDetails(state: MockState, d: DiskState, joinPartitions = false): Obj {
  const imported = diskPoolName(state, d);
  const exported = imported ? null : (exportedPoolOf(state, d)?.pool.name ?? null);
  return {
    name: d.name,
    identifier: d.identifier,
    serial: d.serial,
    lunid: d.lunid,
    size: d.size,
    model: d.model,
    type: d.type,
    rotationrate: d.rotationrate,
    subsystem: d.subsystem,
    bus: d.bus,
    devname: d.name,
    number: d.number,
    sectorsize: 512,
    description: d.description,
    duplicate_serial: [],
    partitions: joinPartitions ? diskPartitions(state, d) : [],
    exported_zpool: exported,
    imported_zpool: imported,
    unsupported_md_devices: null,
    enclosure: {},
  };
}

/** True when the disk is not part of the boot pool or an imported pool. */
export function diskInUse(state: MockState, d: DiskState): string | null {
  if (d.boot) return 'boot-pool';
  return findLeafByDisk(state, d.identifier)?.pool.name ?? null;
}

// ---------------------------------------------------------------------------
// Vdevs, pool health and capacity
// ---------------------------------------------------------------------------

export function newLeaf(d: DiskState): LeafState {
  const guid = randomGuid();
  d.zfs_guid = guid;
  return { guid, partuuid: uuid(), disk: d.identifier, status: 'ONLINE', errors: { read: 0, write: 0, checksum: 0 }, replacing: null };
}

export function newVdev(type: VdevType, disks: DiskState[]): VdevState {
  return { type, guid: randomGuid(), children: disks.map(newLeaf) };
}

function leafHealthy(l: LeafState): boolean {
  return l.status === 'ONLINE';
}

export type VdevHealth = 'ONLINE' | 'DEGRADED' | 'UNAVAIL' | 'FAULTED';

export function vdevHealth(v: VdevState): VdevHealth {
  const bad = v.children.filter((l) => !leafHealthy(l)).length;
  if (bad === 0) return 'ONLINE';
  if (v.type === 'STRIPE') return v.children[0]?.status === 'FAULTED' ? 'FAULTED' : 'UNAVAIL';
  if (v.type === 'MIRROR') return bad >= v.children.length ? 'UNAVAIL' : 'DEGRADED';
  return bad > PARITY[v.type] ? 'UNAVAIL' : 'DEGRADED';
}

export interface PoolHealth {
  status: 'ONLINE' | 'DEGRADED' | 'UNAVAIL';
  healthy: boolean;
  warning: boolean;
  status_code: string;
  status_detail: string | null;
  /** Human summary used by the VolumeStatus alert. */
  summary: string;
}

const STATUS_DETAIL: Record<string, string> = {
  FAULTED_DEV_R:
    'One or more devices are faulted in response to persistent errors. Sufficient replicas exist for the pool to continue functioning in a degraded state.',
  FAULTED_DEV_NR:
    'One or more devices are faulted in response to persistent errors. There are insufficient replicas for the pool to continue functioning.',
  REMOVED_DEV:
    'One or more devices has been removed by the administrator. Sufficient replicas exist for the pool to continue functioning in a degraded state.',
  OFFLINE_DEV:
    'One or more devices has been taken offline by the administrator. Sufficient replicas exist for the pool to continue functioning in a degraded state.',
  RESILVERING: 'One or more devices is currently being resilvered. The pool will continue to function, possibly in a degraded state.',
  FAILING_DEV:
    'One or more devices has experienced an unrecoverable error. An attempt was made to correct the error. Applications are unaffected.',
  CORRUPT_DATA: 'One or more devices has experienced an error resulting in data corruption. Applications may be affected.',
};

export function poolHealth(pool: PoolState): PoolHealth {
  let status: PoolHealth['status'] = 'ONLINE';
  for (const cat of ['data', 'special', 'dedup'] as const) {
    for (const v of pool.topology[cat]) {
      const h = vdevHealth(v);
      if (h === 'UNAVAIL' || h === 'FAULTED') status = 'UNAVAIL';
      else if (h === 'DEGRADED' && status === 'ONLINE') status = 'DEGRADED';
    }
  }
  for (const v of pool.topology.log) if (vdevHealth(v) !== 'ONLINE' && status === 'ONLINE') status = 'DEGRADED';

  let errors = 0;
  const badStates = new Set<string>();
  for (const ref of poolLeaves(pool)) {
    errors += ref.leaf.errors.read + ref.leaf.errors.write + ref.leaf.errors.checksum;
    if (ref.category !== 'spare' && !leafHealthy(ref.leaf)) badStates.add(ref.leaf.status);
  }
  const resilvering = pool.scan?.function === 'RESILVER' && pool.scan.state === 'SCANNING';
  let code = 'OK';
  if (status === 'UNAVAIL') code = 'FAULTED_DEV_NR';
  else if (resilvering) code = 'RESILVERING';
  else if (status === 'DEGRADED') {
    code = badStates.has('FAULTED') ? 'FAULTED_DEV_R' : badStates.has('REMOVED') ? 'REMOVED_DEV' : badStates.has('OFFLINE') ? 'OFFLINE_DEV' : 'FAULTED_DEV_R';
  } else if (pool.dataErrors?.length) code = 'CORRUPT_DATA';
  else if (errors > 0) code = 'FAILING_DEV';
  const detail = STATUS_DETAIL[code] ?? null;
  return {
    status,
    healthy: status === 'ONLINE' && errors === 0 && !pool.dataErrors?.length,
    warning: status === 'ONLINE' && errors > 0,
    status_code: code,
    status_detail: detail,
    summary: detail ?? 'The pool is healthy.',
  };
}

function leafSize(state: MockState, l: LeafState): number {
  const own = diskById(state, l.disk)?.size ?? 0;
  if (!l.replacing) return own;
  const repl = diskById(state, l.replacing.disk)?.size ?? own;
  return Math.min(own, repl);
}

/** Usable bytes of one vdev: STRIPE = disk, MIRROR = smallest, RAIDZn = (n - p) * smallest - ~3%. */
export function vdevUsable(state: MockState, v: VdevState, expanding = false): number {
  const sizes = v.children.map((l) => leafSize(state, l));
  if (!sizes.length) return 0;
  const min = Math.min(...sizes);
  if (v.type === 'STRIPE') return sizes[0]!;
  if (v.type === 'MIRROR') return min;
  // While a RAIDZ expansion reflows, the new disk does not add capacity yet.
  const width = v.children.length - (expanding ? 1 : 0);
  return Math.floor((width - PARITY[v.type]) * min * 0.97);
}

export function poolSize(state: MockState, pool: PoolState): number {
  const expanding = pool.expand?.state === 'EXPANDING' ? pool.expand.expanding_vdev : -1;
  return pool.topology.data.reduce((sum, v, i) => sum + vdevUsable(state, v, i === expanding), 0);
}

export function poolAllocated(state: MockState, pool: PoolState): number {
  const root = getDataset(state, pool.name);
  return root ? datasetUsed(state, root) : 0;
}

function vdevStats(size: number, allocated: number, l?: LeafState): Obj {
  return {
    timestamp: Date.now() * 1_000_000,
    read_errors: l?.errors.read ?? 0,
    write_errors: l?.errors.write ?? 0,
    checksum_errors: l?.errors.checksum ?? 0,
    ops: [0, 0, 0, 0, 0, 0, 0],
    bytes: [0, 0, 0, 0, 0, 0, 0],
    size,
    allocated,
    fragmentation: 0,
    self_healed: 0,
    configured_ashift: 12,
    logical_ashift: 9,
    physical_ashift: 12,
  };
}

function renderLeaf(state: MockState, l: LeafState): Obj {
  const d = diskById(state, l.disk);
  const missing = !d || !d.present;
  return {
    name: missing ? l.guid : l.partuuid,
    type: 'DISK',
    path: `/dev/disk/by-partuuid/${l.partuuid}`,
    guid: l.guid,
    status: l.status,
    stats: vdevStats(missing ? 0 : (d?.size ?? 0) - 2 * MiB, 0, l),
    children: [],
    device: missing || !d ? null : partName(d, 1),
    disk: missing || !d ? null : d.name,
    unavail_disk: missing && d ? renderDisk(state, d, false) : null,
  };
}

function renderChild(state: MockState, l: LeafState, index: number): Obj {
  if (!l.replacing) return renderLeaf(state, l);
  const guid = (BigInt(l.guid) ^ BigInt(l.replacing.guid)).toString();
  return {
    name: `replacing-${index}`,
    type: 'REPLACING',
    path: null,
    guid,
    status: leafHealthy(l) ? 'ONLINE' : 'DEGRADED',
    stats: vdevStats(leafSize(state, l), 0),
    children: [renderLeaf(state, l), renderLeaf(state, l.replacing)],
    device: null,
    disk: null,
    unavail_disk: null,
  };
}

function renderVdev(state: MockState, v: VdevState, index: number, allocated: number): Obj {
  if (v.type === 'STRIPE' && v.children.length === 1) return renderChild(state, v.children[0]!, index);
  return {
    name: `${v.type.toLowerCase()}-${index}`,
    type: v.type,
    guid: v.guid,
    status: vdevHealth(v),
    path: null,
    stats: vdevStats(vdevUsable(state, v), allocated),
    children: v.children.map((l, i) => renderChild(state, l, i)),
    device: null,
    disk: null,
    unavail_disk: null,
  };
}

export function renderScan(scan: ScanState | null): Obj {
  if (!scan) {
    return {
      function: null,
      state: null,
      start_time: null,
      end_time: null,
      percentage: null,
      bytes_to_process: null,
      bytes_processed: null,
      bytes_issued: null,
      pause: null,
      errors: null,
      total_secs_left: null,
    };
  }
  return {
    ...scan,
    start_time: $date(scan.start_time),
    end_time: scan.end_time ? $date(scan.end_time) : null,
    pause: scan.pause ? $date(scan.pause) : null,
  };
}

export function renderTopology(state: MockState, pool: PoolState): Obj {
  const allocated = poolAllocated(state, pool);
  const size = poolSize(state, pool) || 1;
  let index = 0;
  const out: Obj = {};
  for (const cat of ['data', 'special', 'dedup', 'log'] as const) {
    out[cat] = pool.topology[cat].map((v) => {
      const share = cat === 'data' ? Math.floor((allocated * vdevUsable(state, v)) / size) : 0;
      return renderVdev(state, v, index++, share);
    });
  }
  out.cache = pool.topology.cache.flatMap((v) => v.children.map((l) => renderLeaf(state, l)));
  out.spare = pool.topology.spare.map((l) => ({ ...renderLeaf(state, l), status: 'AVAIL' }));
  return {
    data: out.data,
    log: out.log,
    cache: out.cache,
    spare: out.spare,
    special: out.special,
    dedup: out.dedup,
  };
}

export function renderPool(state: MockState, pool: PoolState, extra: Obj = {}): Obj {
  const h = poolHealth(pool);
  const size = poolSize(state, pool);
  const allocated = Math.min(poolAllocated(state, pool), size);
  const free = Math.max(0, size - allocated);
  return {
    id: pool.id,
    name: pool.name,
    guid: pool.guid,
    status: h.status,
    path: `/mnt/${pool.name}`,
    scan: renderScan(pool.scan),
    expand: pool.expand
      ? { ...pool.expand, start_time: $date(pool.expand.start_time), end_time: pool.expand.end_time ? $date(pool.expand.end_time) : null }
      : null,
    is_upgraded: extra.is_upgraded === true,
    healthy: h.healthy,
    warning: h.warning,
    status_code: h.status_code,
    status_detail: h.status_detail,
    size,
    allocated,
    free,
    freeing: 0,
    dedup_table_size: 0,
    dedup_table_quota: 'auto',
    fragmentation: String(size ? Math.min(40, Math.round((allocated / size) * 12)) : 0),
    size_str: String(size),
    allocated_str: String(allocated),
    free_str: String(free),
    freeing_str: '0',
    autotrim: pool.autotrim
      ? { parsed: 'on', rawvalue: 'on', source: 'LOCAL', value: 'on' }
      : { parsed: 'off', rawvalue: 'off', source: 'DEFAULT', value: 'off' },
    topology: renderTopology(state, pool),
  };
}

/** `boot.get_state`: the boot pool on sda3. */
export function renderBootPool(state: MockState, startedAt: number): Obj {
  const sda = state.disks.find((d) => d.boot);
  const size = sda ? Math.floor((sda.size - 515 * MiB) * 0.96) : 0;
  const allocated = Math.round(3.4 * GiB);
  const leaf = sda
    ? {
        name: 'sda3',
        type: 'DISK',
        path: `/dev/${partName(sda, 3)}`,
        guid: '5871094651983762103',
        status: 'ONLINE',
        stats: vdevStats(size, allocated),
        children: [],
        device: partName(sda, 3),
        disk: sda.name,
        unavail_disk: null,
      }
    : null;
  return {
    id: 'boot-pool',
    name: 'boot-pool',
    guid: BOOT_POOL_GUID,
    status: 'ONLINE',
    path: null,
    scan: renderScan({
      function: 'SCRUB',
      state: 'FINISHED',
      start_time: startedAt - 6 * 86400_000,
      end_time: startedAt - 6 * 86400_000 + 41_000,
      percentage: 100,
      bytes_to_process: allocated,
      bytes_processed: allocated,
      bytes_issued: allocated,
      pause: null,
      errors: 0,
      total_secs_left: null,
    }),
    expand: null,
    is_upgraded: true,
    healthy: true,
    warning: false,
    status_code: 'OK',
    status_detail: null,
    size,
    allocated,
    free: size - allocated,
    freeing: 0,
    dedup_table_size: 0,
    dedup_table_quota: 'auto',
    fragmentation: '2',
    size_str: String(size),
    allocated_str: String(allocated),
    free_str: String(size - allocated),
    freeing_str: '0',
    autotrim: { parsed: 'off', rawvalue: 'off', source: 'DEFAULT', value: 'off' },
    topology: { data: leaf ? [leaf] : [], log: [], cache: [], spare: [], special: [], dedup: [] },
  };
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export function parentId(id: string): string | null {
  const i = id.lastIndexOf('/');
  return i === -1 ? null : id.slice(0, i);
}

export function getDataset(state: MockState, id: string): DatasetState | undefined {
  return state.datasets.find((d) => d.id === id);
}

export function childDatasets(state: MockState, id: string): DatasetState[] {
  return sortDatasets(state.datasets.filter((d) => parentId(d.id) === id));
}

export function descendants(state: MockState, id: string): DatasetState[] {
  return state.datasets.filter((d) => d.id.startsWith(`${id}/`));
}

export function sortDatasets(list: DatasetState[]): DatasetState[] {
  return [...list].sort((a, b) => {
    const pa = a.id.split('/');
    const pb = b.id.split('/');
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
    }
    return pa.length - pb.length;
  });
}

/** Mountpoint: `/mnt/<id>`, except the apps dataset which mounts at the hidden `/mnt/.ix-apps`. */
export function mountpoint(ds: Pick<DatasetState, 'id' | 'pool'>): string {
  const apps = `${ds.pool}/ix-apps`;
  if (ds.id === apps || ds.id.startsWith(`${apps}/`)) return `/mnt/.ix-apps${ds.id.slice(apps.length)}`;
  return `/mnt/${ds.id}`;
}

export function datasetUsed(state: MockState, ds: DatasetState): number {
  let used = 0;
  for (const d of [ds, ...descendants(state, ds.id)]) {
    used += d.usedBytes;
    for (const s of state.snapshots) if (s.dataset === d.id) used += s.usedBytes;
  }
  return used;
}

function snapshotsUsed(state: MockState, id: string): number {
  return state.snapshots.filter((s) => s.dataset === id).reduce((a, s) => a + s.usedBytes, 0);
}

export function datasetAvailable(state: MockState, ds: DatasetState): number {
  const pool = state.pools.find((p) => p.name === ds.pool);
  let avail = pool ? Math.max(0, Math.floor(poolSize(state, pool) * 0.968) - poolAllocated(state, pool)) : 0;
  for (let id: string | null = ds.id; id; id = parentId(id)) {
    const cur = getDataset(state, id);
    if (cur?.quota) avail = Math.min(avail, Math.max(0, cur.quota - datasetUsed(state, cur)));
    if (cur?.refquota && cur.id === ds.id) avail = Math.min(avail, Math.max(0, cur.refquota - cur.usedBytes));
  }
  return avail;
}

type PropKind = 'onoff' | 'enum' | 'size' | 'num';
const PROPS: Record<string, { kind: PropKind; def: string }> = {
  compression: { kind: 'enum', def: 'OFF' },
  atime: { kind: 'onoff', def: 'ON' },
  exec: { kind: 'onoff', def: 'ON' },
  readonly: { kind: 'onoff', def: 'OFF' },
  sync: { kind: 'enum', def: 'STANDARD' },
  snapdir: { kind: 'enum', def: 'HIDDEN' },
  snapdev: { kind: 'enum', def: 'HIDDEN' },
  copies: { kind: 'num', def: '1' },
  deduplication: { kind: 'enum', def: 'OFF' },
  checksum: { kind: 'enum', def: 'ON' },
  recordsize: { kind: 'size', def: '128K' },
  xattr: { kind: 'enum', def: 'SA' },
  aclmode: { kind: 'enum', def: 'DISCARD' },
  acltype: { kind: 'enum', def: 'POSIX' },
  casesensitivity: { kind: 'enum', def: 'SENSITIVE' },
  special_small_block_size: { kind: 'size', def: '0' },
};
export const INHERITABLE_PROPS = Object.keys(PROPS);

export function parseSize(v: string): number {
  const m = /^(\d+(?:\.\d+)?)([KMGTP]?)B?$/i.exec(v.trim());
  if (!m) return Number(v) || 0;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }[m[2]!.toUpperCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

export function resolveProp(state: MockState, ds: DatasetState, key: string): { value: string; source: string; sourceInfo: string | null } {
  for (let id: string | null = ds.id; id; id = parentId(id)) {
    const cur = id === ds.id ? ds : getDataset(state, id);
    const v = cur?.props[key];
    if (v !== undefined) return { value: v, source: id === ds.id ? 'LOCAL' : 'INHERITED', sourceInfo: id === ds.id ? null : id };
  }
  return { value: PROPS[key]?.def ?? '', source: 'DEFAULT', sourceInfo: null };
}

function zprop(parsed: unknown, rawvalue: string | null, value: string | null, source: string, source_info: string | null = null): Obj {
  return { parsed, rawvalue, value, source, source_info };
}

function renderProp(state: MockState, ds: DatasetState, key: string): Obj {
  const { value, source, sourceInfo } = resolveProp(state, ds, key);
  const kind = PROPS[key]?.kind ?? 'enum';
  if (kind === 'onoff') return zprop(value === 'ON', value.toLowerCase(), value, source, sourceInfo);
  if (kind === 'size') {
    const bytes = parseSize(value);
    return zprop(bytes, String(bytes), bytes ? zfsHuman(bytes) : '0', source, sourceInfo);
  }
  if (kind === 'num') return zprop(Number(value), value, value, source, sourceInfo);
  return zprop(value.toLowerCase(), value.toLowerCase(), value, source, sourceInfo);
}

function bytesProp(n: number): Obj {
  return zprop(n, String(n), zfsHuman(n), 'NONE');
}

function quotaProp(n: number | null): Obj {
  return n ? zprop(n, String(n), zfsHuman(n), 'LOCAL') : zprop(null, '0', null, 'DEFAULT');
}

function userPropDefault(ds: DatasetState, key: string, def: string): Obj {
  const v = ds.user_properties[key];
  return v !== undefined ? zprop(Number(v), v, v, 'LOCAL') : zprop(Number(def), def, def, 'DEFAULT');
}

export interface RenderDatasetOptions {
  children?: boolean;
  snapshots?: boolean;
}

export function renderDataset(state: MockState, ds: DatasetState, opts: RenderDatasetOptions = {}): Obj {
  const used = datasetUsed(state, ds);
  const childUsed = descendants(state, ds.id).reduce((a, d) => a + d.usedBytes + snapshotsUsed(state, d.id), 0);
  const created = new Date(ds.createdAt);
  const internalUserProps = new Set(['org.freenas:description', 'org.freenas:quota_warning', 'org.freenas:quota_critical', 'org.freenas:refquota_warning', 'org.freenas:refquota_critical', 'org.truenas:managedby']);
  const entry: Obj = {
    id: ds.id,
    type: ds.type,
    name: ds.id,
    pool: ds.pool,
    encrypted: false,
    encryption_root: null,
    key_loaded: false,
    children: opts.children === false ? [] : childDatasets(state, ds.id).map((c) => renderDataset(state, c, opts)),
    user_properties: Object.fromEntries(
      Object.entries(ds.user_properties)
        .filter(([k]) => !internalUserProps.has(k))
        .map(([k, v]) => [k, zprop(v, v, v, 'LOCAL')]),
    ),
    locked: false,
    comments: ds.comments ? zprop(ds.comments, ds.comments, ds.comments, 'LOCAL') : zprop('', '', '', 'DEFAULT'),
    quota_warning: userPropDefault(ds, 'org.freenas:quota_warning', '80'),
    quota_critical: userPropDefault(ds, 'org.freenas:quota_critical', '95'),
    refquota_warning: userPropDefault(ds, 'org.freenas:refquota_warning', '80'),
    refquota_critical: userPropDefault(ds, 'org.freenas:refquota_critical', '95'),
    managedby: zprop(null, null, null, 'DEFAULT'),
    deduplication: renderProp(state, ds, 'deduplication'),
    aclmode: renderProp(state, ds, 'aclmode'),
    acltype: renderProp(state, ds, 'acltype'),
    xattr: renderProp(state, ds, 'xattr'),
    atime: renderProp(state, ds, 'atime'),
    casesensitivity: renderProp(state, ds, 'casesensitivity'),
    checksum: renderProp(state, ds, 'checksum'),
    exec: renderProp(state, ds, 'exec'),
    sync: renderProp(state, ds, 'sync'),
    compression: renderProp(state, ds, 'compression'),
    compressratio: zprop('1.00', '1.00', '1.00x', 'NONE'),
    origin: zprop('', '', '', 'NONE'),
    quota: quotaProp(ds.quota),
    refquota: quotaProp(ds.refquota),
    reservation: quotaProp(ds.reservation),
    refreservation: quotaProp(ds.refreservation),
    copies: renderProp(state, ds, 'copies'),
    snapdir: renderProp(state, ds, 'snapdir'),
    snapdev: renderProp(state, ds, 'snapdev'),
    readonly: renderProp(state, ds, 'readonly'),
    recordsize: renderProp(state, ds, 'recordsize'),
    special_small_block_size: renderProp(state, ds, 'special_small_block_size'),
    key_format: zprop('none', 'none', null, 'DEFAULT'),
    encryption_algorithm: zprop('off', 'off', null, 'DEFAULT'),
    pbkdf2iters: zprop('0', '0', '0', 'DEFAULT'),
    used: bytesProp(used),
    usedbychildren: bytesProp(childUsed),
    usedbydataset: bytesProp(ds.usedBytes),
    usedbyrefreservation: bytesProp(0),
    usedbysnapshots: bytesProp(snapshotsUsed(state, ds.id)),
    available: bytesProp(datasetAvailable(state, ds)),
    creation: zprop($date(ds.createdAt), String(Math.floor(ds.createdAt / 1000)), created.toUTCString(), 'NONE'),
    mountpoint: ds.type === 'FILESYSTEM' ? mountpoint(ds) : null,
  };
  if (ds.type === 'VOLUME') {
    entry.volsize = bytesProp(ds.volsize ?? 0);
    entry.volblocksize = zprop(16384, '16384', '16K', 'DEFAULT');
  }
  if (opts.snapshots) {
    entry.snapshots = state.snapshots.filter((s) => s.dataset === ds.id).map((s) => renderSnapshot(state, s));
  }
  return entry;
}

export function renderSnapshot(state: MockState, s: SnapshotStateLike): Obj {
  const ds = getDataset(state, s.dataset);
  return {
    id: s.id,
    name: s.id,
    pool: ds?.pool ?? s.dataset.split('/')[0],
    type: 'SNAPSHOT',
    snapshot_name: s.name,
    dataset: s.dataset,
    createtxg: String(s.createtxg),
    properties: {
      creation: zprop($date(s.createdAt), String(Math.floor(s.createdAt / 1000)), new Date(s.createdAt).toUTCString(), 'NONE'),
      used: bytesProp(s.usedBytes),
      referenced: bytesProp(s.referenced),
      userrefs: zprop(0, '0', '0', 'NONE'),
      defer_destroy: zprop(false, 'off', 'off', 'NONE'),
      createtxg: zprop(s.createtxg, String(s.createtxg), String(s.createtxg), 'NONE'),
    },
    holds: {},
    retention: null,
  };
}

type SnapshotStateLike = MockState['snapshots'][number];

export interface DatasetSpec {
  id: string;
  type?: 'FILESYSTEM' | 'VOLUME';
  share_type?: DatasetShareType;
  quota?: number | null;
  refquota?: number | null;
  comments?: string;
  user_properties?: Record<string, string>;
  props?: Record<string, string>;
  usedBytes?: number;
  volsize?: number | null;
  createdAt?: number;
}

const SHARE_PRESETS: Record<DatasetShareType, Record<string, string>> = {
  GENERIC: {},
  SMB: { casesensitivity: 'INSENSITIVE', acltype: 'NFSV4', aclmode: 'RESTRICTED' },
  APPS: { casesensitivity: 'SENSITIVE', atime: 'OFF', acltype: 'NFSV4', aclmode: 'PASSTHROUGH' },
  MULTIPROTOCOL: { casesensitivity: 'SENSITIVE', atime: 'OFF', acltype: 'NFSV4', aclmode: 'PASSTHROUGH' },
  NFS: { casesensitivity: 'SENSITIVE', atime: 'OFF', acltype: 'NFSV4', aclmode: 'PASSTHROUGH' },
};

/** Inserts a dataset (no validation) and emits `pool.dataset.query` added. */
export function addDataset(mock: Mock, spec: DatasetSpec, emit = true): DatasetState {
  const share = spec.share_type ?? 'GENERIC';
  const ds: DatasetState = {
    id: spec.id,
    pool: spec.id.split('/')[0]!,
    type: spec.type ?? 'FILESYSTEM',
    usedBytes: spec.usedBytes ?? (spec.type === 'VOLUME' ? (spec.volsize ?? 0) : 96 * 1024),
    quota: spec.quota || null,
    refquota: spec.refquota || null,
    reservation: null,
    refreservation: null,
    volsize: spec.volsize ?? null,
    props: { ...SHARE_PRESETS[share], ...(spec.props ?? {}) },
    comments: spec.comments ?? '',
    share_type: share,
    user_properties: { ...(spec.user_properties ?? {}) },
    createdAt: spec.createdAt ?? Date.now(),
    createtxg: mock.nextTxg(),
  };
  mock.state.datasets.push(ds);
  if (emit) mock.emit('pool.dataset.query', 'added', ds.id, renderDataset(mock.state, ds));
  return ds;
}

/** Removes a dataset tree with its snapshots, files, ACLs and SMB shares; emits removals. */
export function removeDatasetTree(mock: Mock, id: string): void {
  const { state } = mock;
  const root = getDataset(state, id);
  if (!root) return;
  const doomed = [root, ...descendants(state, id)];
  const ids = new Set(doomed.map((d) => d.id));
  const mp = mountpoint(root);
  state.datasets = state.datasets.filter((d) => !ids.has(d.id));
  state.snapshots = state.snapshots.filter((s) => {
    if (!ids.has(s.dataset)) return true;
    mock.emit('pool.snapshot.query', 'removed', s.id);
    return false;
  });
  const under = (p: string) => p === mp || p.startsWith(`${mp}/`);
  state.fs.nodes = state.fs.nodes.filter((n) => !under(n.path));
  for (const p of Object.keys(state.fs.acls)) if (under(p)) delete state.fs.acls[p];
  for (const p of Object.keys(state.fs.owners)) if (under(p)) delete state.fs.owners[p];
  state.shares = state.shares.filter((s) => {
    if (!under(s.path)) return true;
    mock.emit('sharing.smb.query', 'removed', s.id);
    return false;
  });
  for (const d of sortDatasets(doomed).reverse()) mock.emit('pool.dataset.query', 'removed', d.id);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function normPath(p: string): string {
  if (!p.startsWith('/')) return p;
  const parts = p.split('/').filter((x) => x && x !== '.');
  return `/${parts.join('/')}`;
}

/** Deepest filesystem dataset whose mountpoint contains `path`. */
export function datasetContaining(state: MockState, path: string): DatasetState | undefined {
  let best: DatasetState | undefined;
  let bestLen = -1;
  for (const ds of state.datasets) {
    if (ds.type !== 'FILESYSTEM') continue;
    const mp = mountpoint(ds);
    if ((path === mp || path.startsWith(`${mp}/`)) && mp.length > bestLen) {
      best = ds;
      bestLen = mp.length;
    }
  }
  return best;
}

export function datasetAtPath(state: MockState, path: string): DatasetState | undefined {
  return state.datasets.find((d) => d.type === 'FILESYSTEM' && mountpoint(d) === path);
}

export type PathKind = 'DIRECTORY' | 'FILE';

export function pathKind(state: MockState, path: string): PathKind | null {
  if (path === '/' || path === '/mnt') return 'DIRECTORY';
  if (datasetAtPath(state, path)) return 'DIRECTORY';
  const node = state.fs.nodes.find((n) => n.path === path);
  if (node) return node.type;
  return null;
}

export function ownerOf(state: MockState, path: string): Owner {
  const own = state.fs.owners[path];
  if (own) return own;
  const ds = datasetContaining(state, path);
  const nfs = ds ? resolveProp(state, ds, 'acltype').value === 'NFSV4' : false;
  const node = state.fs.nodes.find((n) => n.path === path);
  if (node?.type === 'FILE') return { uid: 0, gid: 0, mode: nfs ? 0o770 : 0o644 };
  return { uid: 0, gid: 0, mode: nfs ? 0o770 : 0o755 };
}

function nfsAce(tag: string, id: number | null, basic: string, who: string | null = null): Obj {
  return { tag, id: id ?? -1, who, type: 'ALLOW', perms: { BASIC: basic }, flags: { BASIC: 'INHERIT' } };
}

export function defaultAcl(state: MockState, path: string): AclState {
  const ds = datasetContaining(state, path);
  const nfs = ds ? resolveProp(state, ds, 'acltype').value === 'NFSV4' : false;
  if (nfs && ds) {
    const acl = [
      nfsAce('owner@', null, 'FULL_CONTROL'),
      nfsAce('group@', null, 'MODIFY'),
      nfsAce('GROUP', 545, 'MODIFY', 'builtin_users'),
      nfsAce('GROUP', 544, 'FULL_CONTROL', 'builtin_administrators'),
    ];
    if (ds.share_type === 'APPS') acl.push(nfsAce('USER', 568, 'MODIFY', 'apps'));
    return { acltype: 'NFS4', acl, aclflags: { autoinherit: false, protected: false, defaulted: false }, trivial: false };
  }
  const posix = (tag: string, r: boolean, w: boolean, x: boolean) => ({
    tag,
    id: -1,
    perms: { READ: r, WRITE: w, EXECUTE: x },
    default: false,
  });
  return {
    acltype: 'POSIX1E',
    acl: [posix('USER_OBJ', true, true, true), posix('GROUP_OBJ', true, false, true), posix('OTHER', true, false, true)],
    aclflags: null,
    trivial: true,
  };
}

/** Stored ACL at the path or the nearest ancestor (inherited), else the dataset default. */
export function effectiveAcl(state: MockState, path: string): AclState {
  const def = defaultAcl(state, path);
  for (let p: string = path; p.length > '/mnt'.length; p = p.slice(0, p.lastIndexOf('/')) || '/') {
    const acl = state.fs.acls[p];
    if (acl && acl.acltype === def.acltype) return acl;
  }
  return def;
}

export function emitPool(mock: Mock, pool: PoolState): void {
  mock.emit('pool.query', 'changed', pool.id, renderPool(mock.state, pool));
}
