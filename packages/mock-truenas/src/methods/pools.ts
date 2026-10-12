import { clearAlert, raiseAlert, syncAppAlerts, syncPoolAlerts } from '../alerts.ts';
import type { Mock } from '../context.ts';
import { forgetKeys, unlockWithStoredKeys } from '../encryption.ts';
import { callError, queryFilter, validationError, validationErrors, type JobControl } from '../rpc.ts';
import type { DiskState, ExportedPoolState, LeafState, PoolState, ScrubTaskState, VdevCategory, VdevState, VdevType } from '../state.ts';
import {
  addDataset,
  diskById,
  diskByName,
  diskInUse,
  emitPool,
  exportedPoolOf,
  type LeafRef,
  MIN_DISKS,
  mountpoint,
  newLeaf,
  newVdev,
  poolAllocated,
  poolHealth,
  poolLeaves,
  removeDatasetTree,
  renderDataset,
  renderDisk,
  renderPool,
  renderScan,
  sortDatasets,
} from '../storage.ts';
import { argObj, GiB, isObj, MiB, nameArg, randomGuid, type Obj } from '../util.ts';
import { lockForExport } from './encryption.ts';

const RESERVED_PREFIXES = ['mirror', 'raidz', 'draid', 'spare', 'log'];
const DATA_TYPES: VdevType[] = ['STRIPE', 'MIRROR', 'RAIDZ1', 'RAIDZ2', 'RAIDZ3'];
const AUX_TYPES: Record<Exclude<VdevCategory, 'data'>, VdevType[]> = {
  special: ['MIRROR', 'STRIPE'],
  dedup: ['MIRROR', 'STRIPE'],
  log: ['MIRROR', 'STRIPE'],
  cache: ['STRIPE'],
};

export function poolNameError(name: unknown): string | null {
  if (typeof name !== 'string' || !name) return 'Field required';
  if (/\s/.test(name)) return 'Pool name must not contain whitespace';
  if (name.length > 50) return 'String should have at most 50 characters';
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name)) {
    return 'Pool name must begin with a letter and contain only letters, numbers, "_", "-", ":" and ".".';
  }
  const lower = name.toLowerCase();
  if (lower === 'boot-pool' || RESERVED_PREFIXES.some((p) => lower.startsWith(p)) || /^c\d/.test(lower)) return 'Pool name is reserved.';
  return null;
}

// ---------------------------------------------------------------------------
// Topology input
// ---------------------------------------------------------------------------

interface RawVdev {
  type: VdevType;
  disks: string[];
}
interface RawTopology {
  data: RawVdev[];
  special: RawVdev[];
  dedup: RawVdev[];
  log: RawVdev[];
  cache: RawVdev[];
  spares: string[];
}

/** pydantic-level shape validation of a create/update topology. */
function parseTopology(raw: unknown, attr: string, requireData: boolean): RawTopology {
  const t = argObj(raw, `${attr}.topology`);
  const errors: Array<[string, string]> = [];
  const out: RawTopology = { data: [], special: [], dedup: [], log: [], cache: [], spares: [] };
  for (const cat of ['data', 'special', 'dedup', 'log', 'cache'] as const) {
    const list = t[cat] ?? [];
    if (!Array.isArray(list)) {
      errors.push([`${attr}.topology.${cat}`, 'Input should be a valid list']);
      continue;
    }
    const allowed = cat === 'data' ? DATA_TYPES : AUX_TYPES[cat];
    list.forEach((v: unknown, i) => {
      if (!isObj(v)) return void errors.push([`${attr}.topology.${cat}.${i}`, 'Input should be a valid dictionary']);
      if (typeof v.type === 'string' && v.type.startsWith('DRAID') && cat === 'data') {
        return void errors.push([`${attr}.topology.${cat}.${i}.type`, 'dRAID vdevs are not supported by this simulator']);
      }
      if (!allowed.includes(v.type as VdevType)) {
        return void errors.push([`${attr}.topology.${cat}.${i}.type`, `Input should be ${allowed.map((a) => `'${a}'`).join(', ')}`]);
      }
      if (!Array.isArray(v.disks) || v.disks.some((d) => typeof d !== 'string')) {
        return void errors.push([`${attr}.topology.${cat}.${i}.disks`, 'Input should be a valid list of disk names']);
      }
      out[cat].push({ type: v.type as VdevType, disks: v.disks as string[] });
    });
  }
  const spares = t.spares ?? [];
  if (!Array.isArray(spares) || spares.some((d) => typeof d !== 'string')) errors.push([`${attr}.topology.spares`, 'Input should be a valid list of disk names']);
  else out.spares = spares as string[];
  if (requireData && !out.data.length) errors.push([`${attr}.topology.data`, 'List should have at least 1 item after validation, not 0']);
  if (errors.length) throw validationErrors(errors);
  return out;
}

interface ResolvedTopology {
  data: Array<{ type: VdevType; disks: DiskState[] }>;
  special: Array<{ type: VdevType; disks: DiskState[] }>;
  dedup: Array<{ type: VdevType; disks: DiskState[] }>;
  log: Array<{ type: VdevType; disks: DiskState[] }>;
  cache: Array<{ type: VdevType; disks: DiskState[] }>;
  spares: DiskState[];
}

/** Semantic checks done inside the job by the middleware: vdev widths and disk availability. */
function resolveTopology(mock: Mock, t: RawTopology, attr: string): ResolvedTopology {
  const errors: Array<[string, string]> = [];
  for (const cat of ['data', 'special', 'dedup', 'log', 'cache'] as const) {
    t[cat].forEach((v, i) => {
      if (v.disks.length < MIN_DISKS[v.type]) errors.push([`${attr}.topology.${cat}.${i}.disks`, `You need at least ${MIN_DISKS[v.type]} disk(s) for this vdev type.`]);
    });
  }
  const all = [...t.data, ...t.special, ...t.dedup, ...t.log, ...t.cache].flatMap((v) => v.disks).concat(t.spares);
  const missing = all.filter((n) => !diskByName(mock.state, n));
  if (missing.length) errors.push([`${attr}.topology`, `The following disks were not found in system: ${[...new Set(missing)].join(',')}.`]);
  const dupes = all.filter((n, i) => all.indexOf(n) !== i);
  if (dupes.length) errors.push([`${attr}.topology`, `Disk ${dupes[0]} is used more than once.`]);
  const inUse = all.filter((n) => {
    const d = diskByName(mock.state, n);
    return d && diskInUse(mock.state, d);
  });
  if (inUse.length) errors.push([`${attr}.topology`, `The following disks are already in use: ${[...new Set(inUse)].join(',')}.`]);
  if (errors.length) throw validationErrors(errors);
  const res = (vs: RawVdev[]) => vs.map((v) => ({ type: v.type, disks: v.disks.map((n) => diskByName(mock.state, n)!) }));
  return {
    data: res(t.data),
    special: res(t.special),
    dedup: res(t.dedup),
    log: res(t.log),
    cache: res(t.cache),
    spares: t.spares.map((n) => diskByName(mock.state, n)!),
  };
}

/** Disks that carried an exported pool get wiped: that pool is no longer importable. */
function consumeDisks(mock: Mock, disks: DiskState[]): void {
  for (const d of disks) {
    const exported = exportedPoolOf(mock.state, d);
    if (exported) mock.state.exportedPools = mock.state.exportedPools.filter((e) => e !== exported);
    d.foreignPartitions = [];
  }
}

function buildVdevs(cat: VdevCategory, specs: Array<{ type: VdevType; disks: DiskState[] }>): VdevState[] {
  const out: VdevState[] = [];
  for (const s of specs) {
    if (s.type === 'STRIPE' || cat === 'cache') for (const d of s.disks) out.push(newVdev('STRIPE', [d]));
    else out.push(newVdev(s.type, s.disks));
  }
  return out;
}

function spareLeaf(d: DiskState): LeafState {
  return { ...newLeaf(d), status: 'AVAIL' };
}

export function defaultScrubTask(mock: Mock, pool: PoolState): ScrubTaskState {
  const task: ScrubTaskState = {
    id: mock.state.nextIds.scrubTask++,
    pool: pool.id,
    threshold: 35,
    description: '',
    schedule: { minute: '00', hour: '00', dom: '*', month: '*', dow: '7' },
    enabled: true,
  };
  mock.state.scrubTasks.push(task);
  return task;
}

/** Creates a pool and its root dataset from resolved disks (also used by scenario seeding). */
export function createPoolInternal(mock: Mock, name: string, topo: ResolvedTopology, emit = true): PoolState {
  const { state } = mock;
  consumeDisks(mock, [...topo.data, ...topo.special, ...topo.dedup, ...topo.log, ...topo.cache].flatMap((v) => v.disks).concat(topo.spares));
  const pool: PoolState = {
    id: state.nextIds.pool++,
    name,
    guid: randomGuid(),
    topology: {
      data: buildVdevs('data', topo.data),
      special: buildVdevs('special', topo.special),
      dedup: buildVdevs('dedup', topo.dedup),
      log: buildVdevs('log', topo.log),
      cache: buildVdevs('cache', topo.cache),
      spare: topo.spares.map(spareLeaf),
    },
    scan: null,
    expand: null,
    autotrim: false,
    createdAt: Date.now(),
  };
  state.pools.push(pool);
  addDataset(mock, { id: name, props: { compression: 'LZ4', acltype: 'POSIX', aclmode: 'DISCARD', xattr: 'SA' }, usedBytes: Math.round(1.4 * MiB) }, emit);
  defaultScrubTask(mock, pool);
  if (emit) {
    mock.emit('pool.query', 'added', pool.id, renderPool(state, pool));
    syncPoolAlerts(mock);
  }
  return pool;
}

export function resolvedFromNames(mock: Mock, spec: Partial<Record<VdevCategory, Array<{ type: VdevType; disks: string[] }>>> & { spares?: string[] }): ResolvedTopology {
  const raw: RawTopology = {
    data: spec.data ?? [],
    special: spec.special ?? [],
    dedup: spec.dedup ?? [],
    log: spec.log ?? [],
    cache: spec.cache ?? [],
    spares: spec.spares ?? [],
  };
  return resolveTopology(mock, raw, 'pool_create');
}

// ---------------------------------------------------------------------------
// Resilver / scrub / expansion simulations
// ---------------------------------------------------------------------------

function emitScan(mock: Mock, pool: PoolState): void {
  mock.emit('zfs.pool.scan', 'changed', pool.name, { name: pool.name, scan: renderScan(pool.scan) });
  emitPool(mock, pool);
}

function stillImported(mock: Mock, pool: PoolState): boolean {
  return mock.state.pools.includes(pool);
}

async function runResilver(mock: Mock, pool: PoolState, job: JobControl, steps: number, toProcess: number, label: string): Promise<void> {
  const start = Date.now();
  pool.scan = {
    function: 'RESILVER',
    state: 'SCANNING',
    start_time: start,
    end_time: null,
    percentage: 0,
    bytes_to_process: toProcess,
    bytes_processed: 0,
    bytes_issued: 0,
    pause: null,
    errors: 0,
    total_secs_left: steps * 90,
  };
  emitScan(mock, pool);
  for (let i = 1; i <= steps; i++) {
    await job.sleep();
    if (mock.closed || !stillImported(mock, pool) || !pool.scan) return;
    const pct = (i / steps) * 100;
    pool.scan.percentage = Math.round(pct * 100) / 100;
    pool.scan.bytes_processed = Math.round((toProcess * i) / steps);
    pool.scan.bytes_issued = pool.scan.bytes_processed;
    pool.scan.total_secs_left = i === steps ? null : (steps - i) * 90;
    job.progress(Math.min(95, Math.round(10 + pct * 0.85)), `${label}: resilvering ${pool.scan.percentage.toFixed(1)}%`);
    if (i < steps) emitScan(mock, pool);
  }
  pool.scan.state = 'FINISHED';
  pool.scan.percentage = 100;
  pool.scan.end_time = Date.now();
}

async function runScrub(mock: Mock, pool: PoolState, job: JobControl): Promise<null> {
  if (pool.scan?.state === 'SCANNING') {
    if (pool.scan.function === 'RESILVER') throw callError('EBUSY', `cannot scrub ${pool.name}: currently resilvering`);
    if (pool.scan.pause) {
      pool.scan.pause = null;
      emitScan(mock, pool);
      return null;
    }
    throw callError('EBUSY', `cannot scrub ${pool.name}: currently scrubbing`);
  }
  const allocated = poolAllocated(mock.state, pool);
  const steps = 5;
  pool.scan = {
    function: 'SCRUB',
    state: 'SCANNING',
    start_time: Date.now(),
    end_time: null,
    percentage: 0,
    bytes_to_process: allocated,
    bytes_processed: 0,
    bytes_issued: 0,
    pause: null,
    errors: 0,
    total_secs_left: Math.round(allocated / (450 * MiB)),
  };
  const control = { stop: false };
  mock.scrubControls.set(pool.id, control);
  raiseAlert(mock, 'ScrubStarted', [pool.name], ['ScrubStarted', pool.name]);
  job.progress(0, 'Scrub started');
  emitScan(mock, pool);
  let done = 0;
  try {
    while (done < steps) {
      await job.sleep();
      const scan = pool.scan;
      if (mock.closed || !stillImported(mock, pool) || !scan || scan.function !== 'SCRUB') return null;
      if (control.stop) {
        scan.state = 'CANCELED';
        scan.end_time = Date.now();
        scan.total_secs_left = null;
        emitScan(mock, pool);
        clearAlert(mock, 'ScrubStarted', ['ScrubStarted', pool.name]);
        return null;
      }
      if (scan.pause) {
        job.progress(Math.round(scan.percentage), 'Scrub paused');
        continue;
      }
      done++;
      scan.percentage = Math.round((done / steps) * 10000) / 100;
      scan.bytes_processed = Math.round((allocated * done) / steps);
      scan.bytes_issued = scan.bytes_processed;
      scan.total_secs_left = done === steps ? null : Math.round(((steps - done) / steps) * (allocated / (450 * MiB)));
      job.progress(Math.min(99, Math.round(scan.percentage)), `Scrubbing pool ${pool.name}`);
      if (done < steps) emitScan(mock, pool);
    }
    pool.scan.state = 'FINISHED';
    pool.scan.percentage = 100;
    pool.scan.end_time = Date.now();
    // A scrub reads every block, so it also finds damage nobody had noticed yet.
    if (pool.latentDataErrors?.length) {
      pool.dataErrors = [...new Set([...(pool.dataErrors ?? []), ...pool.latentDataErrors])];
      delete pool.latentDataErrors;
    }
    // Deleted damaged files linger as <0x..>:<0x..> object references until a scrub; files still
    // present stay listed and count as errors found by this scrub.
    if (pool.dataErrors?.length) {
      pool.dataErrors = pool.dataErrors.filter((e) => !/^<0x[0-9a-f]+>:<0x[0-9a-f]+>$/i.test(e));
      pool.scan.errors = pool.dataErrors.length;
      if (!pool.dataErrors.length) delete pool.dataErrors;
    }
    emitScan(mock, pool);
    clearAlert(mock, 'ScrubStarted', ['ScrubStarted', pool.name]);
    raiseAlert(mock, 'ScrubFinished', [pool.name], ['ScrubFinished', pool.name, pool.scan.end_time]);
    return null;
  } finally {
    if (mock.scrubControls.get(pool.id) === control) mock.scrubControls.delete(pool.id);
  }
}

function scrubAction(mock: Mock, pool: PoolState, action: string, job: JobControl): Promise<null> | null {
  if (action === 'START') return runScrub(mock, pool, job);
  const scan = pool.scan;
  if (!scan || scan.state !== 'SCANNING' || scan.function !== 'SCRUB') {
    throw callError('ENOENT', `cannot ${action === 'STOP' ? 'cancel' : 'pause'} scrubbing ${pool.name}: there is no active scrub`);
  }
  if (action === 'STOP') {
    const control = mock.scrubControls.get(pool.id);
    if (control) control.stop = true;
    else {
      scan.state = 'CANCELED';
      scan.end_time = Date.now();
      emitScan(mock, pool);
    }
  } else {
    scan.pause = Date.now();
    emitScan(mock, pool);
  }
  return null;
}

function validateScrubAction(action: unknown, attr: string): string {
  const a = action ?? 'START';
  if (!['START', 'STOP', 'PAUSE'].includes(String(a))) throw validationError(attr, "Input should be 'START', 'STOP' or 'PAUSE'");
  return String(a);
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

export function exportPoolInternal(mock: Mock, pool: PoolState, opts: { destroy: boolean; cascade: boolean }): void {
  const { state } = mock;
  const name = pool.name;
  const mp = `/mnt/${name}`;
  const under = (p: string) => p === mp || p.startsWith(`${mp}/`);

  // Apps live in <pool>/ix-apps: unset the apps pool and take the apps along.
  const apps = state.apps.filter((a) => a.pool === name);
  state.apps = state.apps.filter((a) => a.pool !== name);
  if (state.docker.pool === name) {
    for (const a of apps) mock.emit('app.query', 'removed', a.name);
    state.docker.pool = null;
    state.docker.status = 'UNCONFIGURED';
    state.docker.description = '';
    const svc = state.services.find((s) => s.service === 'docker');
    if (svc) {
      svc.enable = false;
      svc.state = 'STOPPED';
      mock.emit('service.query', 'changed', svc.id, { ...svc, pids: [] });
    }
    mock.emit('docker.state', 'changed', null, { status: 'UNCONFIGURED', description: '' });
  }
  state.scrubTasks = state.scrubTasks.filter((t) => t.pool !== pool.id);
  if (opts.cascade || opts.destroy) {
    state.shares = state.shares.filter((s) => {
      if (!under(s.path)) return true;
      mock.emit('sharing.smb.query', 'removed', s.id);
      return false;
    });
  }

  // TrueNAS forgets the pool's stored dataset keys on export (destroy or not).
  forgetKeys(state, name);
  if (opts.destroy) {
    removeDatasetTree(mock, name);
    for (const ref of poolLeaves(pool)) {
      const d = diskById(state, ref.leaf.disk);
      if (d) d.zfs_guid = null;
    }
  } else {
    const ids = new Set(state.datasets.filter((d) => d.pool === name).map((d) => d.id));
    const record: ExportedPoolState = {
      hostname: state.network.hostname,
      pool: structuredClone(pool),
      datasets: state.datasets.filter((d) => ids.has(d.id)),
      snapshots: state.snapshots.filter((s) => ids.has(s.dataset)),
      fsNodes: state.fs.nodes.filter((n) => under(n.path)),
      acls: Object.fromEntries(Object.entries(state.fs.acls).filter(([p]) => under(p))),
      owners: Object.fromEntries(Object.entries(state.fs.owners).filter(([p]) => under(p))),
      apps,
    };
    record.pool.scan = record.pool.scan?.state === 'SCANNING' ? { ...record.pool.scan, state: 'CANCELED', end_time: Date.now() } : record.pool.scan;
    record.pool.expand = null;
    lockForExport(record.datasets);
    state.datasets = state.datasets.filter((d) => !ids.has(d.id));
    state.snapshots = state.snapshots.filter((s) => !ids.has(s.dataset));
    state.fs.nodes = state.fs.nodes.filter((n) => !under(n.path));
    for (const p of Object.keys(record.acls)) delete state.fs.acls[p];
    for (const p of Object.keys(record.owners)) delete state.fs.owners[p];
    for (const d of sortDatasets(record.datasets).reverse()) mock.emit('pool.dataset.query', 'removed', d.id);
    state.exportedPools.push(record);
  }
  state.pools = state.pools.filter((p) => p !== pool);
  const scrub = mock.scrubControls.get(pool.id);
  if (scrub) scrub.stop = true;
  mock.emit('pool.query', 'removed', pool.id);
  syncPoolAlerts(mock);
  syncAppAlerts(mock);
}

function renamePath(p: string, from: string, to: string): string {
  return p === `/mnt/${from}` || p.startsWith(`/mnt/${from}/`) ? `/mnt/${to}${p.slice(`/mnt/${from}`.length)}` : p;
}

function renameId(id: string, from: string, to: string): string {
  return id === from || id.startsWith(`${from}/`) || id.startsWith(`${from}@`) ? `${to}${id.slice(from.length)}` : id;
}

export function importPoolInternal(mock: Mock, rec: ExportedPoolState, newName?: string | null, emit = true): PoolState {
  const { state } = mock;
  const from = rec.pool.name;
  const to = newName || from;
  const pool = rec.pool;
  pool.id = state.nextIds.pool++;
  pool.name = to;
  for (const d of rec.datasets) {
    d.id = renameId(d.id, from, to);
    d.pool = to;
  }
  for (const s of rec.snapshots) {
    s.id = renameId(s.id, from, to);
    s.dataset = renameId(s.dataset, from, to);
  }
  for (const n of rec.fsNodes) n.path = renamePath(n.path, from, to);
  state.exportedPools = state.exportedPools.filter((e) => e !== rec);
  state.pools.push(pool);
  state.datasets.push(...rec.datasets);
  state.snapshots.push(...rec.snapshots);
  state.fs.nodes.push(...rec.fsNodes);
  for (const [p, acl] of Object.entries(rec.acls)) state.fs.acls[renamePath(p, from, to)] = acl;
  for (const [p, o] of Object.entries(rec.owners)) state.fs.owners[renamePath(p, from, to)] = o;
  for (const a of rec.apps) {
    a.pool = to;
    state.apps.push(a);
  }
  defaultScrubTask(mock, pool);
  // Encrypted datasets unlock with stored keys only (none survive an export: use the key file).
  unlockWithStoredKeys(state, to);
  if (emit) {
    mock.emit('pool.query', 'added', pool.id, renderPool(state, pool));
    for (const d of sortDatasets(rec.datasets)) mock.emit('pool.dataset.query', 'added', d.id, renderDataset(state, d));
    syncPoolAlerts(mock);
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

function findLeaf(pool: PoolState, label: string, mock: Mock): LeafRef | undefined {
  for (const ref of poolLeaves(pool)) {
    const d = diskById(mock.state, ref.leaf.disk);
    if (
      ref.leaf.guid === label ||
      ref.leaf.partuuid === label ||
      (d && (d.name === label || `${d.name}1` === label || `${d.name}p1` === label))
    ) {
      return ref;
    }
  }
  return undefined;
}

export function registerPools(mock: Mock): void {
  const { server } = mock;
  const poolArg = (id: unknown): PoolState => {
    const pool = mock.state.pools.find((p) => p.id === id);
    if (!pool) throw callError('ENOENT', `Pool ${String(id)} not found`);
    return pool;
  };
  const pools = (extra: Obj = {}) => mock.state.pools.map((p) => renderPool(mock.state, p, extra));
  const extraOf = (o: unknown): Obj => (isObj(o) && isObj(o.extra) ? o.extra : {});

  server.method('pool.query', (p) => queryFilter(pools(extraOf(p[1])), p[0], p[1]));
  server.method('pool.get_instance', (p) => queryFilter(pools(extraOf(p[1])), [['id', '=', p[0]]], { get: true }));
  server.method('pool.get_instance_by_name', (p) => queryFilter(pools(extraOf(p[1])), [['name', '=', p[0]]], { get: true }));
  server.method('pool.validate_name', (p) => {
    const err = poolNameError(p[0]);
    if (err) throw validationError('pool_name', err);
    if (mock.state.pools.some((x) => x.name === p[0])) throw validationError('pool_name', 'A pool with this name already exists.');
    return true;
  });
  server.method('pool.get_disks', (p) => {
    const list = p[0] === undefined || p[0] === null ? mock.state.pools : [poolArg(p[0])];
    return list.flatMap((pool) =>
      [...poolLeaves(pool)].map((r) => diskById(mock.state, r.leaf.disk)).filter((d): d is DiskState => !!d && d.present).map((d) => d.name),
    );
  });
  server.method('pool.is_upgraded', (p) => (poolArg(p[0]), true));
  server.method('pool.upgrade', (p) => (poolArg(p[0]), true));
  server.method('pool.processes', (p) => (poolArg(p[0]), []));
  server.method('pool.filesystem_choices', (p) => {
    const types = Array.isArray(p[0]) ? (p[0] as string[]) : ['FILESYSTEM', 'VOLUME'];
    return sortDatasets(mock.state.datasets.filter((d) => types.includes(d.type))).map((d) => d.id);
  });
  server.method('pool.attachments', (p) => {
    const pool = poolArg(p[0]);
    const mp = `/mnt/${pool.name}`;
    const out: Obj[] = [];
    const shares = mock.state.shares.filter((s) => s.path === mp || s.path.startsWith(`${mp}/`)).map((s) => s.name);
    if (shares.length) out.push({ type: 'SMB Share', service: 'cifs', attachments: shares });
    if (mock.state.docker.pool === pool.name) out.push({ type: 'Applications', service: 'docker', attachments: mock.state.apps.filter((a) => a.pool === pool.name).map((a) => a.name) });
    return out;
  });
  server.method('pool.resilver.config', () => ({ id: 1, enabled: true, begin: '18:00', end: '09:00', weekday: [1, 2, 3, 4, 5, 6, 7] }));

  server.job(
    'pool.create',
    async (p, job) => {
      const data = argObj(p[0], 'pool_create');
      const name = String(data.name);
      job.progress(5, 'Validating pool configuration');
      const errors: Array<[string, string]> = [];
      if (mock.state.pools.some((x) => x.name === name)) errors.push(['pool_create.name', 'A pool with this name already exists.']);
      if (errors.length) throw validationErrors(errors);
      const topo = resolveTopology(mock, parseTopology(data.topology, 'pool_create', true), 'pool_create');
      job.progress(15, 'Wiping disks');
      await job.sleep();
      job.progress(35, 'Formatting disks');
      await job.sleep();
      job.progress(60, 'Creating ZFS pool');
      await job.sleep();
      if (mock.state.pools.some((x) => x.name === name)) throw validationError('pool_create.name', 'A pool with this name already exists.');
      job.progress(80, 'Creating root dataset');
      const pool = createPoolInternal(mock, name, topo);
      if (data.autotrim === 'ON') pool.autotrim = true;
      job.progress(95, 'Configuring pool');
      await job.sleep();
      return renderPool(mock.state, pool);
    },
    (p) => {
      const data = argObj(p[0], 'pool_create');
      const err = poolNameError(data.name);
      if (err) throw validationError('pool_create.name', err);
      if (data.encryption === true && !isObj(data.encryption_options)) throw validationError('pool_create.encryption_options', 'Field required');
      parseTopology(data.topology, 'pool_create', true);
    },
  );

  server.job('pool.update', async (p, job) => {
    const pool = poolArg(p[0]);
    const data = argObj(p[1], 'pool_update');
    if (data.autotrim !== undefined) {
      if (data.autotrim !== 'ON' && data.autotrim !== 'OFF') throw validationError('pool_update.autotrim', "Input should be 'ON' or 'OFF'");
      pool.autotrim = data.autotrim === 'ON';
    }
    if (data.topology !== undefined) {
      const raw = parseTopology(data.topology, 'pool_update', false);
      const topo = resolveTopology(mock, raw, 'pool_update');
      const existing = pool.topology.data[0]?.type;
      for (const v of topo.data) {
        if (existing && v.type !== existing) {
          throw callError('EINVAL', `invalid vdev specification: mismatched replication level: pool uses ${existing.toLowerCase()} and new vdev is ${v.type.toLowerCase()}`);
        }
      }
      job.progress(20, 'Formatting disks');
      await job.sleep();
      consumeDisks(mock, [...topo.data, ...topo.special, ...topo.dedup, ...topo.log, ...topo.cache].flatMap((v) => v.disks).concat(topo.spares));
      job.progress(60, 'Extending ZFS pool');
      for (const cat of ['data', 'special', 'dedup', 'log', 'cache'] as const) pool.topology[cat].push(...buildVdevs(cat, topo[cat]));
      pool.topology.spare.push(...topo.spares.map(spareLeaf));
      await job.sleep();
    }
    emitPool(mock, pool);
    syncPoolAlerts(mock);
    return renderPool(mock.state, pool);
  });

  server.job('pool.attach', async (p, job) => {
    const pool = poolArg(p[0]);
    const data = argObj(p[1], 'pool_attach');
    const target = String(data.target_vdev ?? '');
    let vdev: VdevState | undefined;
    for (const cat of ['data', 'special', 'dedup', 'log'] as const) {
      vdev ??= pool.topology[cat].find((v) => v.guid === target || (v.type === 'STRIPE' && v.children[0]?.guid === target));
    }
    if (!vdev) throw validationError('pool_attach.target_vdev', 'Unable to locate VDEV');
    const disk = diskByName(mock.state, String(data.new_disk ?? ''));
    if (!disk) throw validationError('pool_attach.new_disk', `${String(data.new_disk)} not found`);
    if (diskInUse(mock.state, disk)) throw validationError('pool_attach.new_disk', `${disk.name} is already in use`);
    const smallest = Math.min(...vdev.children.map((l) => diskById(mock.state, l.disk)?.size ?? 0));
    if (disk.size < smallest) throw validationError('pool_attach.new_disk', `${disk.name} is too small for this vdev (smallest member is ${smallest} bytes)`);
    consumeDisks(mock, [disk]);
    job.progress(10, 'Formatting disk');
    await job.sleep();
    if (vdev.type === 'STRIPE' || vdev.type === 'MIRROR') {
      vdev.type = 'MIRROR';
      vdev.children.push(newLeaf(disk));
      job.progress(20, 'Attaching disk');
      await runResilver(mock, pool, job, 4, Math.round(poolAllocated(mock.state, pool) / Math.max(1, pool.topology.data.length)), 'Extending mirror');
      emitPool(mock, pool);
      return null;
    }
    // RAIDZ expansion: the disk joins at once, capacity grows when the reflow finishes.
    const index = pool.topology.data.indexOf(vdev);
    vdev.children.push(newLeaf(disk));
    const toReflow = Math.max(GiB, poolAllocated(mock.state, pool));
    const steps = 5;
    pool.expand = {
      state: 'EXPANDING',
      expanding_vdev: Math.max(0, index),
      start_time: Date.now(),
      end_time: null,
      bytes_to_reflow: toReflow,
      bytes_reflowed: 0,
      waiting_for_resilver: 0,
      total_secs_left: steps * 600,
      percentage: 0,
    };
    emitPool(mock, pool);
    for (let i = 1; i <= steps; i++) {
      await job.sleep();
      if (mock.closed || !stillImported(mock, pool) || !pool.expand) return null;
      pool.expand.bytes_reflowed = Math.round((toReflow * i) / steps);
      pool.expand.percentage = (i / steps) * 100;
      pool.expand.total_secs_left = i === steps ? null : (steps - i) * 600;
      job.progress(Math.round(10 + pool.expand.percentage * 0.85), `Expanding ${vdev.type} vdev: ${pool.expand.percentage.toFixed(0)}%`);
      if (i < steps) emitPool(mock, pool);
    }
    pool.expand.state = 'FINISHED';
    pool.expand.end_time = Date.now();
    emitPool(mock, pool);
    return null;
  });

  server.job('pool.replace', async (p, job) => {
    const pool = poolArg(p[0]);
    const data = argObj(p[1], 'options');
    const ref = findLeaf(pool, String(data.label ?? ''), mock);
    if (!ref || ref.category === 'spare' || ref.replaces) throw validationError('options.label', `Label ${String(data.label)} not found on this pool.`);
    if (ref.leaf.replacing) throw callError('EBUSY', 'A replacement is already in progress for this device');
    const disk = diskByName(mock.state, String(data.disk ?? ''));
    if (!disk) throw validationError('options.disk', `Disk ${String(data.disk)} not found.`);
    if (diskInUse(mock.state, disk)) throw validationError('options.disk', 'Disk is already in use.');
    const exported = exportedPoolOf(mock.state, disk);
    if (exported && data.force !== true) {
      throw validationError('options.disk', `Disk ${disk.name} is part of exported pool "${exported.pool.name}". Use force to overwrite it.`);
    }
    const old = diskById(mock.state, ref.leaf.disk);
    if (old && disk.size < old.size) throw validationError('options.disk', 'Disk is too small to replace the existing device.');
    consumeDisks(mock, [disk]);
    job.progress(5, 'Formatting disk');
    await job.sleep();
    const leaf = ref.leaf;
    leaf.replacing = newLeaf(disk);
    emitPool(mock, pool);
    job.progress(10, 'Replacing disk');
    const vdevShare = ref.vdev ? Math.round(poolAllocated(mock.state, pool) / Math.max(1, pool.topology.data.length) / Math.max(1, ref.vdev.children.length - 1)) : 0;
    await runResilver(mock, pool, job, 6, Math.max(GiB, vdevShare), 'Replacing disk');
    if (!stillImported(mock, pool) || !leaf.replacing) return true;
    const fresh = leaf.replacing;
    if (ref.vdev) ref.vdev.children = ref.vdev.children.map((l) => (l === leaf ? fresh : l));
    if (old) {
      old.zfs_guid = null;
      if (!old.present) old.expiretime = Date.now();
      else mock.emit('disk.query', 'changed', old.identifier, renderDisk(mock.state, old, false));
    }
    emitPool(mock, pool);
    syncPoolAlerts(mock);
    return true;
  });

  server.method('pool.detach', (p) => {
    const pool = poolArg(p[0]);
    const data = argObj(p[1], 'options');
    const ref = findLeaf(pool, String(data.label ?? ''), mock);
    if (!ref?.vdev || ref.vdev.type !== 'MIRROR') throw callError('EINVAL', 'Only devices of a mirror can be detached');
    ref.vdev.children = ref.vdev.children.filter((l) => l !== ref.leaf);
    if (ref.vdev.children.length === 1) ref.vdev.type = 'STRIPE';
    const d = diskById(mock.state, ref.leaf.disk);
    if (d) d.zfs_guid = null;
    emitPool(mock, pool);
    syncPoolAlerts(mock);
    return true;
  });

  for (const action of ['offline', 'online'] as const) {
    server.method(`pool.${action}`, (p) => {
      const pool = poolArg(p[0]);
      const ref = findLeaf(pool, String(argObj(p[1], 'options').label ?? ''), mock);
      if (!ref || ref.category === 'spare') throw callError('ENOENT', 'Disk not found in pool');
      if (action === 'offline') {
        const after = structuredClone(pool);
        for (const r of poolLeaves(after)) if (r.leaf.guid === ref.leaf.guid) r.leaf.status = 'OFFLINE';
        if (poolHealth(after).status === 'UNAVAIL') throw callError('EINVAL', `cannot offline ${String(argObj(p[1], 'options').label)}: no valid replicas`);
      }
      ref.leaf.status = action === 'offline' ? 'OFFLINE' : 'ONLINE';
      emitPool(mock, pool);
      syncPoolAlerts(mock);
      return true;
    });
  }

  server.job('pool.remove', async (p, job) => {
    const pool = poolArg(p[0]);
    const label = String(argObj(p[1], 'options').label ?? '');
    const spare = pool.topology.spare.find((l) => l.guid === label || diskById(mock.state, l.disk)?.name === label);
    const clear = (l: LeafState) => {
      const d = diskById(mock.state, l.disk);
      if (d) d.zfs_guid = null;
    };
    job.progress(20, 'Removing device');
    if (spare) {
      pool.topology.spare = pool.topology.spare.filter((l) => l !== spare);
      clear(spare);
    } else {
      let removed = false;
      for (const cat of ['cache', 'log', 'special', 'dedup', 'data'] as const) {
        const v = pool.topology[cat].find((x) => x.guid === label || x.children.some((l) => l.guid === label || diskById(mock.state, l.disk)?.name === label));
        if (!v) continue;
        if (cat === 'data') {
          if (pool.topology.data.length < 2) throw callError('EINVAL', 'Cannot remove the only data vdev of a pool');
          if (pool.topology.data.some((x) => x.type.startsWith('RAIDZ'))) throw callError('EINVAL', 'Removal of top-level vdevs is not supported on pools with RAIDZ vdevs');
          job.progress(50, 'Evacuating data');
          await job.sleep(2);
        }
        pool.topology[cat] = pool.topology[cat].filter((x) => x !== v);
        v.children.forEach(clear);
        removed = true;
        break;
      }
      if (!removed) throw callError('ENOENT', `Label ${label} not found on this pool.`);
    }
    await job.sleep();
    emitPool(mock, pool);
    syncPoolAlerts(mock);
    return null;
  });

  server.job('pool.expand', async (p, job) => {
    const pool = poolArg(p[0]);
    job.progress(50, 'Expanding partitions');
    await job.sleep();
    emitPool(mock, pool);
    return null;
  });

  server.job('pool.export', async (p, job) => {
    const pool = poolArg(p[0]);
    const opts = argObj(p[1], 'options');
    const destroy = opts.destroy === true;
    job.progress(10, 'Stopping services that use the pool');
    await job.sleep();
    job.progress(40, destroy ? 'Destroying pool' : 'Exporting pool');
    await job.sleep();
    if (!stillImported(mock, pool)) throw callError('ENOENT', `Pool ${String(p[0])} not found`);
    exportPoolInternal(mock, pool, { destroy, cascade: opts.cascade === true });
    job.progress(90, 'Cleaning up');
    await job.sleep();
    return null;
  });

  server.job('pool.import_find', async (_p, job) => {
    job.progress(30, 'Scanning disks for pools');
    await job.sleep();
    job.progress(70, 'Reading pool labels');
    await job.sleep();
    return mock.state.exportedPools.map((e) => {
      const leaves = [...poolLeaves(e.pool)];
      const present = leaves.filter((r) => diskById(mock.state, r.leaf.disk)?.present).length;
      return {
        name: e.pool.name,
        guid: e.pool.guid,
        status: present === leaves.length ? 'ONLINE' : present ? 'DEGRADED' : 'UNAVAIL',
        hostname: e.hostname,
      };
    });
  });

  server.job(
    'pool.import_pool',
    async (p, job) => {
      const data = argObj(p[0], 'pool_import');
      const rec = mock.state.exportedPools.find((e) => e.pool.guid === String(data.guid));
      if (!rec) throw validationError('pool_import.guid', `Pool with guid "${String(data.guid)}" not found for import.`);
      const name = typeof data.name === 'string' && data.name ? data.name : rec.pool.name;
      const err = poolNameError(name);
      if (err) throw validationError('pool_import.name', err);
      if (mock.state.pools.some((x) => x.name === name)) throw validationError('pool_import.name', `Pool name ${name} already in use.`);
      job.progress(20, 'Importing pool');
      await job.sleep();
      job.progress(60, 'Mounting datasets');
      await job.sleep();
      importPoolInternal(mock, rec, name);
      job.progress(90, 'Restarting services');
      await job.sleep();
      return true;
    },
    (p) => {
      const data = argObj(p[0], 'pool_import');
      if (typeof data.guid !== 'string' || !data.guid) throw validationError('pool_import.guid', 'Field required');
    },
  );

  // Scrubs
  server.job(
    'pool.scrub',
    (p, job) => Promise.resolve(scrubAction(mock, poolArg(p[0]), validateScrubAction(p[1], 'pool_scrub.action'), job)),
    (p) => validateScrubAction(p[1], 'pool_scrub.action'),
  );
  const byName = (name: unknown) => {
    const pool = mock.state.pools.find((x) => x.name === name);
    if (!pool) throw callError('ENOENT', `Pool ${String(name)} not found`);
    return pool;
  };
  server.job(
    'pool.scrub.scrub',
    (p, job) => Promise.resolve(scrubAction(mock, byName(p[0]), validateScrubAction(p[1], 'pool_scrub_scrub.action'), job)),
    (p) => validateScrubAction(p[1], 'pool_scrub_scrub.action'),
  );
  server.method('pool.scrub.run', (p) => {
    const pool = byName(p[0]);
    const threshold = typeof p[1] === 'number' ? p[1] : 35;
    const last = pool.scan?.function === 'SCRUB' ? pool.scan.end_time : null;
    if (pool.scan?.state === 'SCANNING') return null;
    if (last && Date.now() - last < threshold * 86400_000) return null;
    server.startJob('pool.scrub.scrub', [pool.name, 'START'], (_args, job) => Promise.resolve(scrubAction(mock, pool, 'START', job)));
    return null;
  });

  const renderTask = (t: ScrubTaskState) => ({ ...t, pool_name: mock.state.pools.find((x) => x.id === t.pool)?.name ?? null });
  server.method('pool.scrub.query', (p) => queryFilter(mock.state.scrubTasks.map(renderTask), p[0], p[1]));
  server.method('pool.scrub.get_instance', (p) => queryFilter(mock.state.scrubTasks.map(renderTask), [['id', '=', p[0]]], { get: true }));
  const validateTask = (data: Obj, attr: string, current?: ScrubTaskState) => {
    const errors: Array<[string, string]> = [];
    const poolId = data.pool ?? current?.pool;
    if (!mock.state.pools.some((x) => x.id === poolId)) errors.push([`${attr}.pool`, 'The specified pool does not exist.']);
    else if (mock.state.scrubTasks.some((t) => t.pool === poolId && t !== current)) errors.push([`${attr}.pool`, 'A scrub with this pool already exists']);
    if (data.threshold !== undefined && (typeof data.threshold !== 'number' || data.threshold < 0)) errors.push([`${attr}.threshold`, 'Input should be greater than or equal to 0']);
    if (errors.length) throw validationErrors(errors);
  };
  server.method('pool.scrub.create', (p) => {
    const data = argObj(p[0], 'pool_scrub_create');
    validateTask(data, 'pool_scrub_create');
    const task: ScrubTaskState = {
      id: mock.state.nextIds.scrubTask++,
      pool: Number(data.pool),
      threshold: typeof data.threshold === 'number' ? data.threshold : 35,
      description: typeof data.description === 'string' ? data.description : '',
      schedule: { minute: '00', hour: '00', dom: '*', month: '*', dow: '7', ...(isObj(data.schedule) ? (data.schedule as Obj) : {}) } as ScrubTaskState['schedule'],
      enabled: data.enabled !== false,
    };
    mock.state.scrubTasks.push(task);
    return renderTask(task);
  });
  server.method('pool.scrub.update', (p) => {
    const task = mock.state.scrubTasks.find((t) => t.id === p[0]);
    if (!task) throw callError('ENOENT', `Scrub task ${String(p[0])} does not exist`);
    const data = argObj(p[1], 'pool_scrub_update');
    validateTask(data, 'pool_scrub_update', task);
    if (typeof data.pool === 'number') task.pool = data.pool;
    if (typeof data.threshold === 'number') task.threshold = data.threshold;
    if (typeof data.description === 'string') task.description = data.description;
    if (typeof data.enabled === 'boolean') task.enabled = data.enabled;
    if (isObj(data.schedule)) task.schedule = { ...task.schedule, ...(data.schedule as Partial<ScrubTaskState['schedule']>) };
    return renderTask(task);
  });
  server.method('pool.scrub.delete', (p) => {
    const before = mock.state.scrubTasks.length;
    mock.state.scrubTasks = mock.state.scrubTasks.filter((t) => t.id !== p[0]);
    if (before === mock.state.scrubTasks.length) throw callError('ENOENT', `Scrub task ${String(p[0])} does not exist`);
    return true;
  });

  server.method('pool.dataset.details', () =>
    sortDatasets(mock.state.datasets).map((ds) => {
      const mp = mountpoint(ds);
      const entry = renderDataset(mock.state, ds, { children: false });
      return {
        ...entry,
        smb_shares: mock.state.shares.filter((s) => s.path === mp || s.path.startsWith(`${mp}/`)).map((s) => ({ enabled: s.enabled, path: s.path, share_name: s.name })),
        nfs_shares: [],
        iscsi_shares: [],
        vms: [],
        apps: [],
        replication_tasks_count: 0,
        snapshot_tasks_count: 0,
        cloudsync_tasks_count: 0,
        rsync_tasks_count: 0,
        snapshot_count: mock.state.snapshots.filter((s) => s.dataset === ds.id).length,
        thick_provisioned: false,
      };
    }),
  );
}
