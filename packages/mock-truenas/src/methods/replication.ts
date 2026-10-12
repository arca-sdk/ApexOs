/**
 * Periodic snapshot tasks (`pool.snapshottask.*`) and replication (`replication.*`), modelled on
 * zettarepl's behaviour in TrueNAS 25.10:
 *
 * - Snapshot tasks take (recursive) snapshots on their cron schedule in the box's time zone, skip empty
 *   snapshots when `allow_empty` is false, prune snapshots older than their lifetime (keeping snapshots a
 *   bound `hold_pending_snapshots` replication still needs) and then start their bound `auto` replications.
 * - Replication over `SSH` connects to another simulator in the same process (see peers.ts) with an
 *   `SSH_CREDENTIALS` keychain entry and checks what a real connection would (reachability, pinned host key,
 *   key login, passwordless sudo for zfs). Replication tasks (`replication.run`, scheduled runs) and one-off
 *   runs (`runOnetimeSsh`, registered together with the LOCAL transport by `registerLocalReplication` in replication-local.ts, which dispatches on `transport`) share
 *   the transfer engine. Other transports (LOCAL) are not handled in this module.
 * - The transfer engine applies zettarepl's rules: incremental from the newest common snapshot, refusing
 *   unrelated targets unless `allow_from_scratch`, raw sends for encrypted sources when `properties` is
 *   on (the copy arrives encrypted and locked), refusing plain data under an encrypted target ancestor,
 *   space and quota limits on the receiving side, `readonly` SET/REQUIRE/IGNORE and target retention.
 *   Sizes are simulated from the snapshots' `referenced` bytes.
 */
import type { Mock } from '../context.ts';
import { encryptionRootOf, isEncrypted, newEncryption } from '../encryption.ts';
import { openSsh } from '../peers.ts';
import { CallError, callError, queryFilter, validationError, validationErrors, type JobControl } from '../rpc.ts';
import type { DatasetEncryptionState, DatasetState, MockState, ReplicationTaskState, SnapshotState, SnapshotTaskState } from '../state.ts';
import {
  addDataset,
  datasetAvailable,
  datasetContaining,
  descendants,
  getDataset,
  mountpoint,
  parentId,
  poolAllocated,
  poolSize,
  renderDataset,
  renderSnapshot,
  resolveProp,
  sortDatasets,
} from '../storage.ts';
import { $date, argObj, isObj, MiB, type Obj } from '../util.ts';
import { renderCredential } from './keychain.ts';

const LIFETIME_UNITS = ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'] as const;
const UNIT_MS: Record<string, number> = { HOUR: 3600_000, DAY: 86400_000, WEEK: 7 * 86400_000, MONTH: 30 * 86400_000, YEAR: 365 * 86400_000 };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const SCHEDULER_TICK_MS = 15_000;

/** Fills in the backup-related state for state files saved before these namespaces existed. */
export function ensureReplicationState(state: MockState, defaults: Pick<MockState, 'ssh'>): void {
  state.keychain ??= [];
  state.snapshotTasks ??= [];
  state.replications ??= [];
  state.ssh ??= defaults.ssh;
  state.nextIds.keychain ??= Math.max(0, ...state.keychain.map((k) => k.id)) + 1;
  state.nextIds.snapshotTask ??= Math.max(0, ...state.snapshotTasks.map((t) => t.id)) + 1;
  state.nextIds.replication ??= Math.max(0, ...state.replications.map((r) => r.id)) + 1;
  // A run that was in progress when the state was saved died with the process.
  for (const r of state.replications) {
    if (r.state.state === 'RUNNING') r.state = { ...r.state, state: 'ERROR', error: 'The replication was interrupted (the system restarted).' };
    r.jobId = null;
  }
}

// ---------------------------------------------------------------------------
// Runtime data (per simulator, not persisted)
// ---------------------------------------------------------------------------

interface Runtime {
  /** Replication task id → live progress while it runs. */
  running: Map<number, { progress: Obj | null; started: number }>;
  /** Snapshot task ids currently running. */
  snapshotting: Set<number>;
  /** `<task kind>:<id>` → minute key of the last scheduled start. */
  fired: Map<string, string>;
  timer?: NodeJS.Timeout;
}

const runtimes = new WeakMap<Mock, Runtime>();
function runtime(mock: Mock): Runtime {
  let rt = runtimes.get(mock);
  if (!rt) {
    rt = { running: new Map(), snapshotting: new Set(), fired: new Map() };
    runtimes.set(mock, rt);
  }
  return rt;
}

// ---------------------------------------------------------------------------
// Time, cron and naming schemas
// ---------------------------------------------------------------------------

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' };
    try {
      f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock time of the simulated box (its configured time zone), like zettarepl's scheduler uses. */
export function localTime(ms: number, timeZone: string): LocalTime {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(String(parts.weekday)),
  };
}

function cronValue(v: string, dow: boolean): number {
  const lower = v.toLowerCase();
  if (dow && lower in DOW_NAMES) return DOW_NAMES[lower]!;
  return Number(v);
}

/** Standard cron field matching: `*`, `a`, `a-b`, `a,b`, `*\/n`, `a-b/n`; for weekdays 0 and 7 are Sunday. */
export function cronFieldMatches(field: string, value: number, min: number, max: number, dow = false): boolean {
  return String(field)
    .split(',')
    .some((part) => {
      const [range = '*', stepRaw] = part.trim().split('/');
      const step = stepRaw ? Math.max(1, Number(stepRaw)) : 1;
      let lo = min;
      let hi = max;
      if (range !== '*') {
        const [a, b] = range.split('-');
        lo = cronValue(a ?? '', dow);
        hi = b !== undefined ? cronValue(b, dow) : stepRaw ? max : lo;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      for (let v = lo; v <= hi; v += step) if (v === value || (dow && v === 7 && value === 0)) return true;
      return false;
    });
}

function hhmm(t: LocalTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

export function scheduleMatches(s: { minute: string; hour: string; dom: string; month: string; dow: string; begin?: string; end?: string }, t: LocalTime): boolean {
  if (!cronFieldMatches(s.minute, t.minute, 0, 59)) return false;
  if (!cronFieldMatches(s.hour, t.hour, 0, 23)) return false;
  if (!cronFieldMatches(s.dom, t.day, 1, 31)) return false;
  if (!cronFieldMatches(s.month, t.month, 1, 12)) return false;
  if (!cronFieldMatches(s.dow, t.weekday, 0, 7, true)) return false;
  const now = hhmm(t);
  if (s.begin && s.end && (now < s.begin || now > s.end)) return false;
  return true;
}

function strftime(schema: string, t: LocalTime): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const map: Record<string, string> = {
    Y: String(t.year),
    y: pad(t.year % 100),
    m: pad(t.month),
    d: pad(t.day),
    H: pad(t.hour),
    M: pad(t.minute),
    S: pad(t.second),
    '%': '%',
  };
  return schema.replace(/%([YymdHMS%])/g, (_, k: string) => map[k] ?? '');
}

/** Regex matching snapshot names produced by a naming schema. */
export function schemaRegex(schema: string): RegExp {
  const map: Record<string, string> = { Y: '\\d{4}', y: '\\d{2}', m: '\\d{2}', d: '\\d{2}', H: '\\d{2}', M: '\\d{2}', S: '\\d{2}', s: '\\d+', z: '[+-]\\d{4}', '%': '%' };
  let out = '';
  for (let i = 0; i < schema.length; i++) {
    const c = schema[i]!;
    if (c === '%' && i + 1 < schema.length) {
      out += map[schema[++i]!] ?? '';
    } else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function namingSchemaError(schema: unknown): string | null {
  if (typeof schema !== 'string' || !schema) return 'Field required';
  if (['%Y', '%m', '%d', '%H', '%M'].some((x) => !schema.includes(x))) return 'Naming schema must contain %Y, %m, %d, %H and %M';
  if (!/^[A-Za-z0-9_.:%-]+$/.test(schema.replace(/%[YymdHMSsz%]/g, ''))) return 'Naming schema may only contain letters, numbers, "_", "-", ".", ":" and strftime codes';
  return null;
}

function cronSchedule(raw: unknown, defaults: Record<string, string>, attr: string, errors: Array<[string, string]>): Record<string, string> {
  const out = { ...defaults };
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) {
    errors.push([attr, 'Input should be a valid dictionary']);
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in defaults)) errors.push([`${attr}.${k}`, 'Extra inputs are not permitted']);
    else if (typeof v !== 'string') errors.push([`${attr}.${k}`, 'Input should be a valid string']);
    else out[k] = v;
  }
  for (const k of ['begin', 'end']) if (k in out && !/^\d{2}:\d{2}$/.test(out[k]!)) errors.push([`${attr}.${k}`, 'Time should be HH:MM']);
  return out;
}

// ---------------------------------------------------------------------------
// Datasets, snapshots and encryption helpers
// ---------------------------------------------------------------------------

function snapshotsOf(state: MockState, dataset: string): SnapshotState[] {
  return state.snapshots.filter((s) => s.dataset === dataset).sort((a, b) => a.createtxg - b.createtxg);
}

function isUnder(id: string, root: string): boolean {
  return id === root || id.startsWith(`${root}/`);
}

function nearestExisting(state: MockState, id: string): DatasetState | undefined {
  for (let cur: string | null = id; cur; cur = parentId(cur)) {
    const ds = getDataset(state, cur);
    if (ds) return ds;
  }
  return undefined;
}

/** True when a dataset holds files or noticeable data of its own (zettarepl refuses to overwrite it). */
function hasData(state: MockState, ds: DatasetState): string | null {
  const mp = mountpoint(ds);
  const node = state.fs.nodes.find((n) => n.path.startsWith(`${mp}/`) && datasetContaining(state, n.path)?.id === ds.id);
  if (node) return node.path.slice(mp.length + 1).split('/')[0]!;
  return ds.usedBytes > 1 * MiB ? '<data>' : null;
}

function emitDataset(mock: Mock, ds: DatasetState, msg: 'added' | 'changed' = 'changed'): void {
  mock.emit('pool.dataset.query', msg, ds.id, renderDataset(mock.state, ds));
}

function deleteSnapshots(mock: Mock, doomed: SnapshotState[]): void {
  if (!doomed.length) return;
  const ids = new Set(doomed.map((s) => s.id));
  mock.state.snapshots = mock.state.snapshots.filter((s) => !ids.has(s.id));
  for (const s of doomed) mock.emit('pool.snapshot.query', 'removed', s.id);
}

/** Datasets a recursive operation covers, parents first, minus excluded subtrees. */
function treeOf(state: MockState, root: DatasetState, recursive: boolean, exclude: string[]): DatasetState[] {
  const all = recursive ? sortDatasets([root, ...descendants(state, root.id)]) : [root];
  return all.filter((d) => !exclude.some((e) => isUnder(d.id, e)) && d.type === 'FILESYSTEM');
}

// ---------------------------------------------------------------------------
// Transfer engine (shared by all transports)
// ---------------------------------------------------------------------------

export interface TransferPlan {
  src: Mock;
  dst: Mock;
  sources: string[];
  target: string;
  recursive: boolean;
  exclude: string[];
  /** Which snapshot names take part (naming schemas or name regex). */
  eligible: (name: string) => boolean;
  properties: boolean;
  propertiesExclude: string[];
  propertiesOverride: Record<string, string>;
  readonly: 'SET' | 'REQUIRE' | 'IGNORE';
  retention: 'SOURCE' | 'CUSTOM' | 'NONE';
  lifetimeMs: number | null;
  allowFromScratch: boolean;
  onlyFromScratch: boolean;
  encryption: { enabled: boolean; inherit: boolean; keyFormat: 'HEX' | 'PASSPHRASE' | null; key: string | null };
  /** The sending side may run `zfs send` (root or passwordless sudo). */
  canRead: boolean;
  /** The receiving side may create and receive datasets. */
  canWrite: boolean;
  /** Throws when the connection dropped (checked between snapshots). */
  alive: () => void;
  job: JobControl;
  report: (progress: Obj) => void;
}

interface DatasetWork {
  src: DatasetState;
  target: string;
  send: SnapshotState[];
  full: boolean;
  raw: boolean;
  destroy: SnapshotState[];
  /** Newest snapshot both sides hold (incremental base). */
  base?: SnapshotState;
  bytes: number;
}

function streamBytes(send: SnapshotState[], full: boolean, base: SnapshotState | undefined): number {
  let total = 0;
  let prev = full ? undefined : base;
  for (const s of send) {
    total += prev ? Math.abs(s.referenced - prev.referenced) + 64 * 1024 : s.referenced;
    prev = s;
  }
  return total;
}

function planDataset(plan: TransferPlan, src: DatasetState, target: string): DatasetWork {
  const { dst } = plan;
  const srcSnaps = snapshotsOf(plan.src.state, src.id).filter((s) => plan.eligible(s.name));
  // zettarepl sends raw (`zfs send -w`) exactly when properties are sent and the source is encrypted.
  const raw = plan.properties && isEncrypted(plan.src.state, src);
  const existing = getDataset(dst.state, target);
  const work: DatasetWork = { src, target, send: [], full: false, raw, destroy: [], bytes: 0 };
  if (!srcSnaps.length) return work;
  if (!plan.canRead) throw new CallError('EACCES', `cannot send '${src.id}@${srcSnaps.at(-1)!.name}': permission denied`);
  if (existing) {
    if (plan.onlyFromScratch) throw new CallError('EEXIST', `Target dataset '${target}' already exists`);
    if (raw && !isEncrypted(dst.state, existing)) throw new CallError('EFAULT', `Unable to send encrypted dataset '${src.id}' to existing unencrypted or unrelated dataset '${target}'`);
    if (plan.readonly === 'REQUIRE' && resolveProp(dst.state, existing, 'readonly').value !== 'ON') {
      throw new CallError('EFAULT', `Target dataset '${target}' exists and does not have readonly=on property, but replication task is set up to require this property. Refusing to replicate.`);
    }
    const dstSnaps = snapshotsOf(dst.state, target);
    const names = new Set(dstSnaps.map((s) => s.name));
    let common = -1;
    srcSnaps.forEach((s, i) => {
      if (names.has(s.name)) common = i;
    });
    if (common >= 0) {
      work.base = srcSnaps[common];
      work.send = srcSnaps.slice(common + 1);
      work.bytes = streamBytes(work.send, false, work.base);
    } else {
      const data = hasData(dst.state, existing);
      if (dstSnaps.length || data) {
        if (!plan.allowFromScratch) {
          throw new CallError(
            'EFAULT',
            dstSnaps.length
              ? `No incremental base on dataset '${src.id}' and replication from scratch is not allowed`
              : `Target dataset '${target}' does not have snapshots but has data (e.g. '${data}') and replication from scratch is not allowed. Refusing to overwrite existing data.`,
          );
        }
        work.destroy = dstSnaps;
      }
      work.send = srcSnaps;
      work.full = true;
      work.bytes = streamBytes(work.send, true, undefined);
    }
  } else {
    const ancestor = nearestExisting(dst.state, target);
    if (!raw && !plan.encryption.enabled && ancestor && isEncrypted(dst.state, ancestor)) {
      throw new CallError(
        'EFAULT',
        `Destination dataset '${target}' must be encrypted (as one of its ancestors is encrypted). Refusing to transfer unencrypted data to it.`,
      );
    }
    work.send = srcSnaps;
    work.full = true;
    work.bytes = streamBytes(work.send, true, undefined);
  }
  if (work.send.length && !plan.canWrite) {
    throw new CallError('EACCES', existing ? `cannot receive incremental stream: permission denied` : `cannot create '${target}': permission denied`);
  }
  return work;
}

function checkSpace(plan: TransferPlan, w: DatasetWork): void {
  const { state } = plan.dst;
  const anchor = getDataset(state, w.target) ?? nearestExisting(state, w.target);
  if (!anchor) throw new CallError('ENOENT', `cannot open '${w.target.split('/')[0]}': dataset does not exist`);
  if (w.bytes <= datasetAvailable(state, anchor)) return;
  const pool = state.pools.find((p) => p.name === anchor.pool);
  const poolFree = pool ? Math.floor(poolSize(state, pool) * 0.968) - poolAllocated(state, pool) : 0;
  const stream = w.full ? 'new filesystem' : 'incremental';
  if (w.bytes > poolFree) throw new CallError('ENOSPC', `cannot receive ${stream} stream: out of space`, null, 28);
  throw new CallError('EDQUOT', `cannot receive ${stream} stream: destination ${w.target} space quota exceeded.`, null, 122);
}

/** Properties a received dataset gets: the sender's local properties (when `properties`), minus excludes, plus overrides. */
function receivedProps(plan: TransferPlan, src: DatasetState): { props: Record<string, string>; user: Record<string, string>; quota: number | null; refquota: number | null } {
  const props: Record<string, string> = {};
  const user: Record<string, string> = {};
  let quota: number | null = null;
  let refquota: number | null = null;
  if (plan.properties) {
    Object.assign(props, src.props);
    Object.assign(user, src.user_properties);
    quota = src.quota;
    refquota = src.refquota;
  }
  for (const key of [...plan.propertiesExclude, 'mountpoint', 'sharenfs', 'sharesmb']) {
    delete props[key];
    delete user[key];
    if (key === 'quota') quota = null;
    if (key === 'refquota') refquota = null;
  }
  for (const [key, value] of Object.entries(plan.propertiesOverride)) {
    if (key === 'quota' || key === 'refquota') {
      const n = value === 'none' ? null : Number(value) || null;
      if (key === 'quota') quota = n;
      else refquota = n;
    } else if (key.includes(':')) user[key] = value;
    else props[key] = value.toUpperCase();
  }
  return { props, user, quota, refquota };
}

function receiveSnapshot(plan: TransferPlan, w: DatasetWork, snap: SnapshotState, first: boolean): void {
  const { dst, src } = plan;
  const { state } = dst;
  let ds = getDataset(state, w.target);
  if (first && w.destroy.length) deleteSnapshots(dst, w.destroy);
  if (!ds) {
    // `zfs create -p` for missing parents (they inherit any encryption), then a full receive creates the dataset.
    const parts = w.target.split('/');
    for (let i = 2; i < parts.length; i++) {
      const anc = parts.slice(0, i).join('/');
      if (!getDataset(state, anc)) addDataset(dst, { id: anc });
    }
    const { props, user, quota, refquota } = receivedProps(plan, w.src);
    const srcRoot = encryptionRootOf(src.state, w.src);
    let encryption: DatasetEncryptionState | undefined;
    if (w.raw && srcRoot?.encryption) {
      // Raw send: same ciphertext and wrapped key, nothing loaded on the receiving side. The copy is an
      // encryption root itself unless its source's root came along in this transfer (then it inherits).
      const rootSent = srcRoot.id !== w.src.id && plan.sources.some((s) => isUnder(srcRoot.id, s));
      if (!rootSent) encryption = { ...srcRoot.encryption, keyLoaded: false, keylocation: 'prompt' };
    } else if (plan.encryption.enabled && !plan.encryption.inherit) {
      encryption = newEncryption(plan.encryption.keyFormat ?? 'HEX', plan.encryption.key ?? '');
    }
    // (encryption with `encryption_inherit` needs nothing here: the dataset inherits its parent's encryption.)
    ds = addDataset(dst, { id: w.target, share_type: w.src.share_type, props, user_properties: user, quota, refquota, usedBytes: 0, encryption }, false);
    emitDataset(dst, ds, 'added');
  }
  const previous = snapshotsOf(state, ds.id).at(-1);
  if (previous) previous.usedBytes = Math.abs(snap.referenced - previous.referenced);
  const received: SnapshotState = {
    id: `${ds.id}@${snap.name}`,
    dataset: ds.id,
    name: snap.name,
    createtxg: dst.nextTxg(),
    createdAt: snap.createdAt,
    referenced: snap.referenced,
    usedBytes: 0,
  };
  state.snapshots.push(received);
  ds.usedBytes = snap.referenced;
  dst.emit('pool.snapshot.query', 'added', received.id, renderSnapshot(state, received));
  emitDataset(dst, ds);
}

/** Files travel inside the stream: the copy shows the sender's files (unencrypted copies only). */
function copyFiles(plan: TransferPlan, w: DatasetWork): void {
  if (w.raw) return;
  const { src, dst } = plan;
  const srcDs = w.src;
  const dstDs = getDataset(dst.state, w.target);
  if (!dstDs) return;
  const from = mountpoint(srcDs);
  const to = mountpoint(dstDs);
  const own = (state: MockState, path: string, id: string) => datasetContaining(state, path)?.id === id;
  dst.state.fs.nodes = dst.state.fs.nodes.filter((n) => !(n.path.startsWith(`${to}/`) && own(dst.state, n.path, dstDs.id)));
  for (const n of src.state.fs.nodes) {
    if (!n.path.startsWith(`${from}/`) || !own(src.state, n.path, srcDs.id)) continue;
    dst.state.fs.nodes.push({ ...n, path: `${to}${n.path.slice(from.length)}` });
  }
  for (const [path, acl] of Object.entries(src.state.fs.acls)) {
    if (path === from || path.startsWith(`${from}/`)) dst.state.fs.acls[`${to}${path.slice(from.length)}`] = structuredClone(acl);
  }
  for (const [path, owner] of Object.entries(src.state.fs.owners)) {
    if (path === from || path.startsWith(`${from}/`)) dst.state.fs.owners[`${to}${path.slice(from.length)}`] = { ...owner };
  }
}

function mapTarget(plan: TransferPlan, srcId: string): string {
  if (plan.sources.length === 1) return `${plan.target}${srcId.slice(plan.sources[0]!.length)}`;
  const root = plan.sources.find((s) => isUnder(srcId, s))!;
  return `${plan.target}/${root.split('/').at(-1)}${srcId.slice(root.length)}`;
}

function applyRetention(plan: TransferPlan, w: DatasetWork): void {
  if (plan.retention === 'NONE') return;
  const { dst } = plan;
  const dstSnaps = snapshotsOf(dst.state, w.target).filter((s) => plan.eligible(s.name));
  if (!dstSnaps.length) return;
  const newest = dstSnaps.at(-1)!;
  let doomed: SnapshotState[] = [];
  if (plan.retention === 'SOURCE') {
    const present = new Set(snapshotsOf(plan.src.state, w.src.id).map((s) => s.name));
    doomed = dstSnaps.filter((s) => !present.has(s.name) && s !== newest);
  } else if (plan.lifetimeMs) {
    const cutoff = Date.now() - plan.lifetimeMs;
    doomed = dstSnaps.filter((s) => s.createdAt < cutoff && s !== newest);
  }
  deleteSnapshots(dst, doomed);
}

/** Runs a transfer and returns the newest snapshot the receiving side holds for the first source. */
export async function transfer(plan: TransferPlan): Promise<string | null> {
  const { src, dst, job } = plan;
  const work: DatasetWork[] = [];
  for (const sourceId of plan.sources) {
    const root = getDataset(src.state, sourceId);
    if (!root) throw new CallError('ENOENT', `Dataset '${sourceId}' does not exist`);
    for (const ds of treeOf(src.state, root, plan.recursive, plan.exclude)) work.push(planDataset(plan, ds, mapTarget(plan, ds.id)));
  }
  const rootWork = work[0];
  if (rootWork && !snapshotsOf(src.state, rootWork.src.id).some((s) => plan.eligible(s.name))) {
    throw new CallError('EFAULT', `No snapshots matching the replication task were found on dataset '${rootWork.src.id}'`);
  }
  const total = work.reduce((a, w) => a + w.send.length, 0);
  const bytesTotal = work.reduce((a, w) => a + w.bytes, 0);
  let sent = 0;
  let bytesSent = 0;
  job.log(`[${new Date().toISOString()}] INFO [replication_task] For replication of ${plan.sources.join(', ')} to ${plan.target}: ${total} snapshot(s) to send\n`);
  for (const w of work) {
    if (!w.send.length) continue;
    checkSpace(plan, w);
    let previous = w.base;
    for (const [i, snap] of w.send.entries()) {
      const bytes = previous ? Math.abs(snap.referenced - previous.referenced) + 64 * 1024 : snap.referenced;
      // A full stream takes a while; report it in chunks so progress is visible (e.g. in demo mode).
      const chunks = i === 0 && w.full ? 8 : 2;
      for (let c = 0; c < chunks; c++) {
        plan.alive();
        const done = bytesSent + Math.round((bytes * c) / chunks);
        plan.report({
          dataset: w.src.id,
          snapshot: snap.name,
          snapshots_sent: sent,
          snapshots_total: total,
          bytes_sent: done,
          bytes_total: bytesTotal,
          root_dataset: plan.sources[0],
          src_size: bytesTotal,
          dst_size: done,
        });
        job.progress(Math.min(99, Math.round((done / Math.max(bytesTotal, 1)) * 100)), `Sending ${w.src.id}@${snap.name} (${sent + 1}/${total})`);
        await job.sleep(1);
      }
      plan.alive();
      receiveSnapshot(plan, w, snap, i === 0);
      job.log(`[${new Date().toISOString()}] INFO [replication_task] Received ${w.target}@${snap.name}\n`);
      sent += 1;
      bytesSent += bytes;
      previous = snap;
    }
    copyFiles(plan, w);
  }
  for (const w of work) {
    const ds = getDataset(dst.state, w.target);
    if (!ds) continue;
    if (plan.readonly === 'SET' && ds.props.readonly !== 'ON') {
      ds.props.readonly = 'ON';
      emitDataset(dst, ds);
    }
    applyRetention(plan, w);
  }
  plan.report({ dataset: plan.sources[0], snapshots_sent: total, snapshots_total: total, bytes_sent: bytesTotal, bytes_total: bytesTotal });
  const target = rootWork ? rootWork.target : plan.target;
  const newest = rootWork ? snapshotsOf(dst.state, target).filter((s) => plan.eligible(s.name)).at(-1) : undefined;
  return newest ? newest.id : null;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** Runs one replication (task fields as stored or `run_onetime` arguments) and returns `last_snapshot`. */
type ReplicationTransport = (mock: Mock, fields: Obj, job: JobControl, report: (progress: Obj) => void) => Promise<string | null>;

function eligibleMatcher(mock: Mock, f: Obj): (name: string) => boolean {
  if (typeof f.name_regex === 'string' && f.name_regex) {
    const re = new RegExp(`^(?:${f.name_regex})$`);
    return (name) => re.test(name);
  }
  const schemas: string[] = [];
  if (f.direction === 'PUSH') {
    for (const id of (f.periodic_snapshot_tasks as number[] | undefined) ?? []) {
      const t = mock.state.snapshotTasks.find((x) => x.id === id);
      if (t) schemas.push(t.naming_schema);
    }
    schemas.push(...(((f.also_include_naming_schema as string[] | undefined) ?? []) as string[]));
  } else schemas.push(...(((f.naming_schema as string[] | undefined) ?? []) as string[]));
  const res = schemas.map(schemaRegex);
  return (name) => res.some((re) => re.test(name));
}

function lifetimeMs(f: Obj): number | null {
  if (f.retention_policy !== 'CUSTOM' || typeof f.lifetime_value !== 'number' || typeof f.lifetime_unit !== 'string') return null;
  return f.lifetime_value * (UNIT_MS[f.lifetime_unit] ?? UNIT_MS.DAY!);
}

const runSsh: ReplicationTransport = async (mock, f, job, report) => {
  const cred = mock.state.keychain.find((k) => k.id === f.ssh_credentials && k.type === 'SSH_CREDENTIALS');
  if (!cred) throw new CallError('EFAULT', 'SSH credentials for this replication task do not exist');
  const session = openSsh(mock, cred, { sudo: f.sudo === true });
  const push = f.direction === 'PUSH';
  const peer = session.peer;
  const host = String(cred.attributes.host);
  const port = Number(cred.attributes.port);
  return transfer({
    src: push ? mock : peer,
    dst: push ? peer : mock,
    sources: (f.source_datasets as string[]) ?? [],
    target: String(f.target_dataset),
    recursive: f.recursive === true,
    exclude: (f.exclude as string[] | undefined) ?? [],
    eligible: eligibleMatcher(mock, f),
    properties: f.properties !== false,
    propertiesExclude: (f.properties_exclude as string[] | undefined) ?? [],
    propertiesOverride: (isObj(f.properties_override) ? f.properties_override : {}) as Record<string, string>,
    readonly: (f.readonly as TransferPlan['readonly']) ?? 'SET',
    retention: (f.retention_policy as TransferPlan['retention']) ?? 'NONE',
    lifetimeMs: lifetimeMs(f),
    allowFromScratch: f.allow_from_scratch === true,
    onlyFromScratch: f.only_from_scratch === true,
    encryption: {
      enabled: f.encryption === true,
      inherit: f.encryption_inherit === true,
      keyFormat: (f.encryption_key_format as 'HEX' | 'PASSPHRASE' | null) ?? null,
      key: (f.encryption_key as string | null) ?? null,
    },
    canRead: push ? true : session.privileged,
    canWrite: push ? session.privileged : true,
    alive: () => {
      if (peer.closed || peer.state.services.find((s) => s.service === 'ssh')?.state !== 'RUNNING') {
        throw new CallError('EFAULT', `[Errno 104] Connection reset by peer (connection to ${host}:${port} was lost)`, null, 104);
      }
    },
    job,
    report,
  });
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function snapshotTaskState(mock: Mock, t: SnapshotTaskState): Obj {
  if (runtime(mock).snapshotting.has(t.id)) return { state: 'RUNNING', datetime: $date(Date.now()) };
  if (!t.lastRun) return { state: 'PENDING' };
  return { state: t.lastRun.state, datetime: $date(t.lastRun.datetime), ...(t.lastRun.error ? { error: t.lastRun.error } : {}) };
}

function renderSnapshotTask(mock: Mock, t: SnapshotTaskState, dbEntry = false): Obj {
  const { lastRun: _lastRun, ...fields } = t;
  const out: Obj = { ...structuredClone(fields), state: dbEntry ? snapshotTaskState(mock, t).state : snapshotTaskState(mock, t) };
  if (!dbEntry) out.vmware_sync = false;
  return out;
}

function renderJob(mock: Mock, jobId: number | null): Obj | null {
  const job = jobId === null ? undefined : mock.server.getJob(jobId);
  if (!job) return null;
  const { id, method, arguments: args, logs_path, logs_excerpt, progress, result, error, exception, exc_info, state, time_started, time_finished } = job;
  return structuredClone({ id, method, arguments: args, logs_path, logs_excerpt, progress, result, error, exception, exc_info, state, time_started, time_finished });
}

function renderReplication(mock: Mock, r: ReplicationTaskState): Obj {
  const f = r.fields;
  const cred = mock.state.keychain.find((k) => k.id === f.ssh_credentials);
  const live = runtime(mock).running.get(r.id);
  const state: Obj = live
    ? { state: 'RUNNING', datetime: $date(live.started), ...(r.state.last_snapshot ? { last_snapshot: r.state.last_snapshot } : {}), ...(live.progress ? { progress: live.progress } : {}) }
    : structuredClone(r.state);
  return {
    id: r.id,
    ...structuredClone(f),
    ssh_credentials: cred ? renderCredential(cred) : null,
    periodic_snapshot_tasks: ((f.periodic_snapshot_tasks as number[] | undefined) ?? [])
      .map((id) => mock.state.snapshotTasks.find((t) => t.id === id))
      .filter((t): t is SnapshotTaskState => !!t)
      .map((t) => renderSnapshotTask(mock, t, true)),
    state,
    job: renderJob(mock, r.jobId),
    has_encrypted_dataset_keys: false,
  };
}

function emitReplication(mock: Mock, r: ReplicationTaskState, msg: 'added' | 'changed' = 'changed'): void {
  mock.emit('replication.query', msg, r.id, renderReplication(mock, r));
}

function emitSnapshotTask(mock: Mock, t: SnapshotTaskState, msg: 'added' | 'changed' = 'changed'): void {
  mock.emit('pool.snapshottask.query', msg, t.id, renderSnapshotTask(mock, t));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const REPLICATION_DEFAULTS: Obj = {
  ssh_credentials: null,
  netcat_active_side: null,
  netcat_active_side_listen_address: null,
  netcat_active_side_port_min: null,
  netcat_active_side_port_max: null,
  netcat_passive_side_connect_address: null,
  sudo: false,
  exclude: [],
  properties: true,
  properties_exclude: [],
  properties_override: {},
  replicate: false,
  encryption: false,
  encryption_inherit: null,
  encryption_key: null,
  encryption_key_format: null,
  encryption_key_location: null,
  periodic_snapshot_tasks: [],
  naming_schema: [],
  also_include_naming_schema: [],
  name_regex: null,
  schedule: null,
  restrict_schedule: null,
  only_matching_schedule: false,
  allow_from_scratch: false,
  readonly: 'SET',
  hold_pending_snapshots: false,
  lifetime_value: null,
  lifetime_unit: null,
  lifetimes: [],
  compression: null,
  speed_limit: null,
  large_block: true,
  embed: false,
  compressed: true,
  retries: 5,
  logging_level: null,
  enabled: true,
};

const ENUM_FIELDS: Record<string, unknown[]> = {
  direction: ['PUSH', 'PULL'],
  transport: ['SSH', 'SSH+NETCAT', 'LOCAL'],
  readonly: ['SET', 'REQUIRE', 'IGNORE'],
  retention_policy: ['SOURCE', 'CUSTOM', 'NONE'],
  compression: [null, 'LZ4', 'PIGZ', 'PLZIP'],
  encryption_key_format: [null, 'HEX', 'PASSPHRASE'],
  lifetime_unit: [null, ...LIFETIME_UNITS],
};

/** `replication.create/update/run_onetime` validation (the subset of plugins/replication.py ApexOs relies on). */
function validateReplication(mock: Mock, data: Obj, attr: string, opts: { onetime: boolean; id?: number }): void {
  const errors: Array<[string, string]> = [];
  const add = (field: string, msg: string) => errors.push([`${attr}.${field}`, msg]);
  const required = opts.onetime
    ? ['direction', 'transport', 'source_datasets', 'target_dataset', 'recursive', 'retention_policy']
    : ['name', 'direction', 'transport', 'source_datasets', 'target_dataset', 'recursive', 'auto', 'retention_policy'];
  for (const key of required) if (data[key] === undefined || data[key] === null) add(key, 'Field required');
  if (errors.length) throw validationErrors(errors);
  for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
    if (key in data && !allowed.includes(data[key])) add(key, `Input should be ${allowed.filter((a) => a !== null).map((a) => `'${String(a)}'`).join(', ')}`);
  }
  if (!opts.onetime) {
    if (typeof data.name !== 'string' || !data.name.trim()) add('name', 'Field required');
    else if (mock.state.replications.some((r) => r.fields.name === data.name && r.id !== opts.id)) add('name', 'This name already exists');
  }
  if (!Array.isArray(data.source_datasets) || !data.source_datasets.length) add('source_datasets', 'List should have at least 1 item after validation');
  if (typeof data.target_dataset !== 'string' || !data.target_dataset) add('target_dataset', 'Field required');
  if (typeof data.speed_limit === 'number' && data.speed_limit < 1) add('speed_limit', 'Input should be greater than or equal to 1');

  const periodic = (data.periodic_snapshot_tasks as unknown[]) ?? [];
  const tasks: SnapshotTaskState[] = [];
  periodic.forEach((id, i) => {
    const t = mock.state.snapshotTasks.find((x) => x.id === id);
    if (!t) add(`periodic_snapshot_tasks.${i}`, 'This snapshot task does not exist');
    else tasks.push(t);
  });
  const naming = (data.naming_schema as string[]) ?? [];
  const alsoInclude = (data.also_include_naming_schema as string[]) ?? [];
  if (data.direction === 'PUSH') {
    if (naming.length) add('naming_schema', 'This field has no sense for push replication');
    if (!tasks.length && !alsoInclude.length && !data.name_regex) {
      add('periodic_snapshot_tasks', 'You must at least either bind a periodic snapshot task or provide "Also Include Naming Schema" or "Name Regex" for push replication task');
    }
    if (!opts.onetime && data.schedule === null && data.auto === true && !periodic.length) {
      add('auto', 'Push replication that runs automatically must be either bound to a periodic snapshot task or have a schedule');
    }
  } else if (data.direction === 'PULL') {
    if (!opts.onetime && data.schedule === null && data.auto === true) add('auto', 'Pull replication that runs automatically must have a schedule');
    if (periodic.length) add('periodic_snapshot_tasks', "Pull replication can't be bound to a periodic snapshot task");
    if (!naming.length && !data.name_regex) add('naming_schema', 'Naming schema or Name regex are required for pull replication');
    if (alsoInclude.length) add('also_include_naming_schema', 'This field has no sense for pull replication');
    if (data.hold_pending_snapshots === true) add('hold_pending_snapshots', "Pull replication tasks can't hold pending snapshots because they don't do source retention");
  }
  if (data.transport === 'LOCAL') {
    if (data.ssh_credentials !== null && data.ssh_credentials !== undefined) add('ssh_credentials', 'Remote credentials have no sense for local replication');
    if (data.compression !== null && data.compression !== undefined) add('compression', 'Compression has no sense for local replication');
    if (data.speed_limit !== null && data.speed_limit !== undefined) add('speed_limit', 'Speed limit has no sense for local replication');
  } else if (data.ssh_credentials === null || data.ssh_credentials === undefined) {
    add('ssh_credentials', 'SSH Credentials are required for non-local replication');
  } else {
    const c = mock.state.keychain.find((k) => k.id === data.ssh_credentials);
    if (!c) add('ssh_credentials', 'Credential does not exist');
    else if (c.type !== 'SSH_CREDENTIALS') add('ssh_credentials', 'Credential is not of type SSH_CREDENTIALS');
  }
  if (data.transport === 'SSH+NETCAT') {
    if (data.compression) add('compression', 'Compression is not supported for SSH+netcat replication');
    if (data.speed_limit) add('speed_limit', 'Speed limit is not supported for SSH+netcat replication');
  }
  const exclude = (data.exclude as string[]) ?? [];
  if (!data.recursive && exclude.length) add('exclude', 'Excluding child datasets is only supported for recursive replication');
  if (data.encryption === true && data.encryption_inherit !== true) {
    for (const k of ['encryption_key', 'encryption_key_format', 'encryption_key_location']) {
      if (data[k] === null || data[k] === undefined) add(k, 'This property is required when remote dataset encryption is enabled');
    }
  }
  if (data.name_regex) {
    try {
      new RegExp(`(${String(data.name_regex)})$`);
    } catch (e) {
      add('name_regex', `Invalid regex: ${(e as Error).message}`);
    }
    if (tasks.length) add('name_regex', "Naming regex can't be used with periodic snapshot tasks");
    if (naming.length || alsoInclude.length) add('name_regex', "Naming regex can't be used with Naming schema");
    if (!['SOURCE', 'NONE'].includes(String(data.retention_policy))) add('retention_policy', 'Only `Same as Source` and `None` retention policies can be used with Naming regex');
  }
  if (data.retention_policy === 'CUSTOM') {
    if (data.lifetime_value === null || data.lifetime_value === undefined) add('lifetime_value', 'This field is required for custom retention policy');
    if (data.lifetime_unit === null || data.lifetime_unit === undefined) add('lifetime_value', 'This field is required for custom retention policy');
  } else {
    if (data.lifetime_value !== null && data.lifetime_value !== undefined) add('lifetime_value', 'This field has no sense for specified retention policy');
    if (data.lifetime_unit !== null && data.lifetime_unit !== undefined) add('lifetime_unit', 'This field has no sense for specified retention policy');
  }
  if (!opts.onetime && data.schedule && data.auto !== true) add('schedule', "You can't have schedule for replication that does not run automatically");
  if (data.enabled !== false) {
    tasks.forEach((t, i) => {
      if (!t.enabled) add(`periodic_snapshot_tasks.${i}`, "You can't bind disabled periodic snapshot task to enabled replication task");
    });
  }
  if (errors.length) throw validationErrors(errors);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function transportFor(fields: Obj): ReplicationTransport {
  if (fields.transport === 'SSH') return runSsh;
  throw new CallError('ENOTSUP', `Replication tasks with the ${String(fields.transport)} transport are not simulated`, null, 95);
}

async function runReplicationTask(mock: Mock, r: ReplicationTaskState, job: JobControl): Promise<null> {
  const rt = runtime(mock);
  const live = { progress: null as Obj | null, started: Date.now() };
  rt.running.set(r.id, live);
  r.jobId = job.id;
  emitReplication(mock, r);
  job.log(`[${new Date().toISOString()}] INFO [replication_task] Starting replication task ${String(r.fields.name)}\n`);
  try {
    const last = await transportFor(r.fields)(mock, r.fields, job, (progress) => {
      live.progress = progress;
      emitReplication(mock, r);
    });
    r.state = { state: 'FINISHED', datetime: $date(Date.now()), warnings: [], last_snapshot: last ?? r.state.last_snapshot ?? null };
    job.progress(100, 'Replication finished');
    return null;
  } catch (err) {
    const message = err instanceof CallError ? err.reason : (err as Error).message;
    r.state = { state: 'ERROR', datetime: $date(Date.now()), error: message, last_snapshot: r.state.last_snapshot ?? null };
    job.log(`[${new Date().toISOString()}] ERROR [replication_task] ${message}\n`);
    throw err;
  } finally {
    rt.running.delete(r.id);
    if (!mock.closed) emitReplication(mock, r);
  }
}

/** Starts a replication task in the background (as `auto` runs do); returns the job id, or null when it can't run now. */
function startReplicationJob(mock: Mock, r: ReplicationTaskState): number | null {
  if (mock.closed || runtime(mock).running.has(r.id) || r.fields.enabled === false) return null;
  return mock.server.startJob('replication.run', [r.id, true], (_p, job) => runReplicationTask(mock, r, job));
}

/** Takes the task's snapshot (unless empty and `allow_empty` is off); returns its name or null. */
function takeSnapshot(mock: Mock, t: SnapshotTaskState, now: number): string | null {
  const { state } = mock;
  const root = getDataset(state, t.dataset);
  if (!root) throw new CallError('ENOENT', `Dataset ${t.dataset} does not exist`);
  const name = strftime(t.naming_schema, localTime(now, state.system.timezone));
  const tree = treeOf(state, root, t.recursive, t.exclude);
  if (tree.some((d) => state.snapshots.some((s) => s.id === `${d.id}@${name}`))) return null;
  if (!t.allow_empty) {
    const re = schemaRegex(t.naming_schema);
    const unchanged = tree.every((d) => {
      const last = snapshotsOf(state, d.id).filter((s) => re.test(s.name)).at(-1);
      return last && last.referenced === d.usedBytes;
    });
    if (unchanged) return null;
  }
  for (const d of tree) {
    const snap: SnapshotState = { id: `${d.id}@${name}`, dataset: d.id, name, createtxg: mock.nextTxg(), createdAt: now, referenced: d.usedBytes, usedBytes: 0 };
    state.snapshots.push(snap);
    mock.emit('pool.snapshot.query', 'added', snap.id, renderSnapshot(state, snap));
  }
  return name;
}

/** Deletes the task's snapshots older than its lifetime, except ones a holding replication still has to send. */
function pruneSnapshots(mock: Mock, t: SnapshotTaskState, now: number): void {
  const { state } = mock;
  const root = getDataset(state, t.dataset);
  if (!root) return;
  const re = schemaRegex(t.naming_schema);
  const cutoff = now - t.lifetime_value * (UNIT_MS[t.lifetime_unit] ?? UNIT_MS.WEEK!);
  const holders = state.replications.filter(
    (r) => r.fields.enabled !== false && r.fields.hold_pending_snapshots === true && ((r.fields.periodic_snapshot_tasks as number[]) ?? []).includes(t.id),
  );
  const doomed: SnapshotState[] = [];
  for (const d of treeOf(state, root, t.recursive, t.exclude)) {
    const snaps = snapshotsOf(state, d.id).filter((s) => re.test(s.name));
    let keepFrom = Infinity;
    for (const r of holders) {
      const last = typeof r.state.last_snapshot === 'string' ? r.state.last_snapshot.split('@')[1] : undefined;
      const idx = last ? snaps.findIndex((s) => s.name === last) : 0;
      keepFrom = Math.min(keepFrom, idx < 0 ? 0 : snaps[idx]!.createtxg);
    }
    doomed.push(...snaps.filter((s) => s.createdAt < cutoff && s.createtxg < keepFrom));
  }
  deleteSnapshots(mock, doomed);
}

async function runSnapshotTask(mock: Mock, t: SnapshotTaskState, now = Date.now()): Promise<void> {
  const rt = runtime(mock);
  if (rt.snapshotting.has(t.id) || mock.closed) return;
  rt.snapshotting.add(t.id);
  emitSnapshotTask(mock, t);
  try {
    takeSnapshot(mock, t, now);
    pruneSnapshots(mock, t, now);
    t.lastRun = { state: 'FINISHED', datetime: now };
  } catch (err) {
    t.lastRun = { state: 'ERROR', datetime: now, error: err instanceof CallError ? err.reason : (err as Error).message };
  } finally {
    rt.snapshotting.delete(t.id);
    emitSnapshotTask(mock, t);
  }
  if (t.lastRun?.state !== 'FINISHED') return;
  for (const r of mock.state.replications) {
    if (r.fields.direction === 'PUSH' && r.fields.auto === true && ((r.fields.periodic_snapshot_tasks as number[]) ?? []).includes(t.id)) {
      const restrict = r.fields.restrict_schedule as Obj | null;
      if (restrict && !scheduleMatches(restrict as never, localTime(now, mock.state.system.timezone))) continue;
      startReplicationJob(mock, r);
    }
  }
}

/** Starts scheduled snapshot tasks and scheduled replications at their cron times (checked every 15 s). */
function startScheduler(mock: Mock): void {
  const rt = runtime(mock);
  const tick = () => {
    if (mock.closed) {
      clearInterval(rt.timer);
      return;
    }
    const now = Date.now();
    const t = localTime(now, mock.state.system.timezone);
    const key = `${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}`;
    for (const task of mock.state.snapshotTasks) {
      if (!task.enabled || rt.fired.get(`s${task.id}`) === key || !scheduleMatches(task.schedule, t)) continue;
      rt.fired.set(`s${task.id}`, key);
      void runSnapshotTask(mock, task, now);
    }
    for (const r of mock.state.replications) {
      const schedule = r.fields.schedule as Obj | null;
      if (!schedule || r.fields.auto !== true || ((r.fields.periodic_snapshot_tasks as number[]) ?? []).length) continue;
      if (rt.fired.get(`r${r.id}`) === key || !scheduleMatches(schedule as never, t)) continue;
      rt.fired.set(`r${r.id}`, key);
      startReplicationJob(mock, r);
    }
  };
  rt.timer = setInterval(tick, SCHEDULER_TICK_MS);
  rt.timer.unref();
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

function parseSnapshotTask(mock: Mock, data: Obj, attr: string, current?: SnapshotTaskState): SnapshotTaskState {
  const errors: Array<[string, string]> = [];
  const merged: Obj = { ...(current ?? {}), ...data };
  const dataset = merged.dataset;
  if (typeof dataset !== 'string' || !getDataset(mock.state, dataset)) errors.push([`${attr}.dataset`, 'Dataset not found']);
  const recursive = merged.recursive === true;
  const exclude = Array.isArray(merged.exclude) ? (merged.exclude as unknown[]).map(String) : [];
  if (!recursive && exclude.length) errors.push([`${attr}.exclude`, 'Excluding datasets is not necessary for non-recursive periodic snapshot tasks']);
  exclude.forEach((e, i) => {
    if (typeof dataset === 'string' && !e.startsWith(`${dataset}/`)) errors.push([`${attr}.exclude.${i}`, 'Excluded dataset should be a child or other descendant of the selected dataset']);
  });
  const schema = merged.naming_schema ?? 'auto-%Y-%m-%d_%H-%M';
  const schemaErr = namingSchemaError(schema);
  if (schemaErr) errors.push([`${attr}.naming_schema`, schemaErr]);
  const lifetimeValue = merged.lifetime_value ?? 2;
  if (typeof lifetimeValue !== 'number' || !Number.isInteger(lifetimeValue)) errors.push([`${attr}.lifetime_value`, 'Input should be a valid integer']);
  const unit = merged.lifetime_unit ?? 'WEEK';
  if (!LIFETIME_UNITS.includes(unit as never)) errors.push([`${attr}.lifetime_unit`, `Input should be ${LIFETIME_UNITS.map((u) => `'${u}'`).join(', ')}`]);
  const schedule = cronSchedule(data.schedule, current?.schedule ?? { minute: '00', hour: '*', dom: '*', month: '*', dow: '*', begin: '00:00', end: '23:59' }, `${attr}.schedule`, errors);
  if (errors.length) throw validationErrors(errors);
  return {
    id: current?.id ?? 0,
    dataset: dataset as string,
    recursive,
    lifetime_value: lifetimeValue as number,
    lifetime_unit: unit as SnapshotTaskState['lifetime_unit'],
    enabled: merged.enabled !== false,
    exclude,
    naming_schema: schema as string,
    allow_empty: merged.allow_empty !== false,
    schedule: schedule as SnapshotTaskState['schedule'],
    lastRun: current?.lastRun ?? null,
  };
}

function storedFields(data: Obj, current: Obj | undefined, onetime: boolean): Obj {
  const out: Obj = { ...REPLICATION_DEFAULTS, ...(current ?? {}), ...data };
  if (onetime) {
    out.exclude_mountpoint_property = data.exclude_mountpoint_property !== false;
    out.only_from_scratch = data.only_from_scratch === true;
    out.mount = data.mount !== false;
  }
  for (const key of ['schedule', 'restrict_schedule'] as const) {
    if (isObj(out[key])) out[key] = { minute: '00', hour: '*', dom: '*', month: '*', dow: '*', begin: '00:00', end: '23:59', ...(out[key] as Obj) };
  }
  return out;
}

/**
 * Minimal `pool.dataset.unlock` for raw copies restored from a backup. Registered only when the box has no
 * fuller implementation (the encryption namespace provides one, including TrueNAS's key store).
 */
function registerUnlock(mock: Mock): void {
  const { server } = mock;
  if (server.listMethods().some((m) => m.name === 'pool.dataset.unlock')) return;
  server.job('pool.dataset.unlock', async (p, job) => {
    const { state } = mock;
    const id = String(p[0]);
    const opts = argObj(p[1], 'options');
    const entries = (Array.isArray(opts.datasets) ? opts.datasets : []) as Obj[];
    const unlocked: string[] = [];
    const failed: Record<string, Obj> = {};
    job.progress(20, 'Unlocking datasets');
    await job.sleep();
    for (const entry of entries) {
      const name = String(entry.name ?? id);
      const ds = getDataset(state, name);
      const enc = ds?.encryption;
      if (!ds || !enc) {
        failed[name] = { error: ds ? `${name} is not an encryption root` : `${name} not found`, skipped: [] };
        continue;
      }
      const secret = (entry.key ?? entry.passphrase) as string | undefined;
      if (!secret || secret !== enc.secret) {
        failed[name] = { error: enc.keyFormat === 'PASSPHRASE' ? 'Invalid passphrase' : 'Invalid Key', skipped: [] };
        continue;
      }
      enc.keyLoaded = true;
      for (const d of [ds, ...descendants(state, ds.id)]) {
        if (encryptionRootOf(state, d) !== ds) continue;
        unlocked.push(d.id);
        emitDataset(mock, d);
      }
    }
    return { unlocked, failed };
  });
}

export function registerReplication(mock: Mock): void {
  const { server } = mock;

  // Periodic snapshot tasks
  const snapshotTasks = () => mock.state.snapshotTasks.map((t) => renderSnapshotTask(mock, t));
  const getTask = (id: unknown) => {
    const t = mock.state.snapshotTasks.find((x) => x.id === id);
    if (!t) throw callError('ENOENT', `PeriodicSnapshotTask ${String(id)} does not exist`);
    return t;
  };
  server.method('pool.snapshottask.query', (p) => queryFilter(snapshotTasks(), p[0], p[1]));
  server.method('pool.snapshottask.get_instance', (p) => queryFilter(snapshotTasks(), [['id', '=', p[0]]], { get: true }));
  server.method('pool.snapshottask.max_count', () => 512);
  server.method('pool.snapshottask.max_total_count', () => 10000);
  server.method('pool.snapshottask.create', (p) => {
    const t = parseSnapshotTask(mock, argObj(p[0], 'periodic_snapshot_create'), 'periodic_snapshot_create');
    t.id = mock.state.nextIds.snapshotTask++;
    mock.state.snapshotTasks.push(t);
    emitSnapshotTask(mock, t, 'added');
    return renderSnapshotTask(mock, t);
  });
  server.method('pool.snapshottask.update', (p) => {
    const current = getTask(p[0]);
    const data = argObj(p[1], 'periodic_snapshot_update');
    const { fixate_removal_date: _fixate, ...rest } = data;
    const next = parseSnapshotTask(mock, rest, 'periodic_snapshot_update', current);
    Object.assign(current, next);
    emitSnapshotTask(mock, current);
    return renderSnapshotTask(mock, current);
  });
  server.method('pool.snapshottask.delete', (p) => {
    const t = getTask(p[0]);
    for (const r of mock.state.replications) {
      const bound = (r.fields.periodic_snapshot_tasks as number[]) ?? [];
      if (r.fields.direction === 'PUSH' && !((r.fields.also_include_naming_schema as string[]) ?? []).length && r.fields.enabled !== false && bound.length === 1 && bound[0] === t.id) {
        throw callError(
          'EFAULT',
          `You are deleting the last periodic snapshot task bound to enabled replication task '${String(r.fields.name)}' which will break it. Please, disable that replication task first.`,
        );
      }
    }
    for (const r of mock.state.replications) {
      const bound = (r.fields.periodic_snapshot_tasks as number[]) ?? [];
      if (bound.includes(t.id)) r.fields.periodic_snapshot_tasks = bound.filter((x) => x !== t.id);
    }
    mock.state.snapshotTasks = mock.state.snapshotTasks.filter((x) => x.id !== t.id);
    mock.emit('pool.snapshottask.query', 'removed', t.id);
    return true;
  });
  server.method('pool.snapshottask.run', (p) => {
    const t = getTask(p[0]);
    if (!t.enabled) throw callError('EFAULT', 'Task is not enabled');
    setImmediate(() => void runSnapshotTask(mock, t));
    return null;
  });

  // Replication tasks
  const replications = () => mock.state.replications.map((r) => renderReplication(mock, r));
  const getRepl = (id: unknown) => {
    const r = mock.state.replications.find((x) => x.id === id);
    if (!r) throw callError('ENOENT', `ReplicationTask ${String(id)} does not exist`);
    return r;
  };
  server.method('replication.query', (p) => queryFilter(replications(), p[0], p[1]));
  server.method('replication.get_instance', (p) => queryFilter(replications(), [['id', '=', p[0]]], { get: true }));
  server.method('replication.create', (p) => {
    const data = argObj(p[0], 'replication_create');
    for (const key of ['id', 'state', 'job', 'has_encrypted_dataset_keys']) if (key in data) throw validationError(`replication_create.${key}`, 'Extra inputs are not permitted');
    const fields = storedFields(data, undefined, false);
    validateReplication(mock, fields, 'replication_create', { onetime: false });
    const r: ReplicationTaskState = { id: mock.state.nextIds.replication++, fields, state: { state: 'PENDING' }, jobId: null };
    mock.state.replications.push(r);
    emitReplication(mock, r, 'added');
    return renderReplication(mock, r);
  });
  server.method('replication.update', (p) => {
    const r = getRepl(p[0]);
    const data = argObj(p[1], 'replication_update');
    const fields = storedFields(data, r.fields, false);
    validateReplication(mock, fields, 'replication_update', { onetime: false, id: r.id });
    r.fields = fields;
    emitReplication(mock, r);
    return renderReplication(mock, r);
  });
  server.method('replication.delete', (p) => {
    const r = getRepl(p[0]);
    mock.state.replications = mock.state.replications.filter((x) => x.id !== r.id);
    mock.emit('replication.query', 'removed', r.id);
    return true;
  });
  server.job('replication.run', async (p, job) => {
    const r = getRepl(p[0]);
    if (p[1] !== false) {
      if (r.fields.enabled === false) throw callError('EFAULT', 'Task is not enabled');
      if (runtime(mock).running.has(r.id)) throw callError('EFAULT', 'Task is already running');
    }
    return runReplicationTask(mock, r, job);
  });
  server.method('replication.list_naming_schemas', () => [...new Set(mock.state.snapshotTasks.map((t) => t.naming_schema))].sort());
  server.method('replication.config.config', () => ({ id: 1, max_parallel_replication_tasks: replicationConfig.get(mock) ?? 5 }));
  server.method('replication.config.update', (p) => {
    const data = argObj(p[0], 'replication_config_update');
    if (data.max_parallel_replication_tasks !== undefined && data.max_parallel_replication_tasks !== null) {
      if (typeof data.max_parallel_replication_tasks !== 'number' || data.max_parallel_replication_tasks < 1) {
        throw validationError('replication_config_update.max_parallel_replication_tasks', 'Input should be greater than or equal to 1');
      }
      replicationConfig.set(mock, data.max_parallel_replication_tasks);
    }
    return { id: 1, max_parallel_replication_tasks: replicationConfig.get(mock) ?? 5 };
  });

  registerUnlock(mock);
  startScheduler(mock);
}

const replicationConfig = new WeakMap<Mock, number>();

/**
 * `replication.run_onetime` with `transport: "SSH"`: a one-off PUSH or PULL with another simulator, as used to
 * restore a backed-up folder (PULL with `name_regex`, `readonly: IGNORE`, `only_from_scratch`).
 * Validation follows `replication._validate` like `replication.create`.
 */
export async function runOnetimeSsh(mock: Mock, data: Obj, job: JobControl): Promise<null> {
  for (const key of ['name', 'auto', 'schedule', 'only_matching_schedule', 'enabled']) {
    if (key in data) throw validationError(`replication_run_onetime.${key}`, 'Extra inputs are not permitted');
  }
  const fields = storedFields(data, undefined, true);
  validateReplication(mock, fields, 'replication_run_onetime', { onetime: true });
  job.log(`[${new Date().toISOString()}] INFO [replication_task] Temporary replication task for job ${job.id}\n`);
  await runSsh(mock, fields, job, () => undefined);
  job.progress(100, 'Replication finished');
  return null;
}

/**
 * Registers `replication.run_onetime`, dispatching on `transport`. Only SSH is handled in this module; a
 * LOCAL implementation (encrypting folders) plugs in as another branch here.
 */
/** For tests: runs a periodic snapshot task as if its schedule fired at `now`. */
export function runSnapshotTaskNow(mock: Mock, id: number, now = Date.now()): Promise<void> {
  const t = mock.state.snapshotTasks.find((x) => x.id === id);
  if (!t) throw new Error(`No snapshot task ${id}`);
  return runSnapshotTask(mock, t, now);
}
