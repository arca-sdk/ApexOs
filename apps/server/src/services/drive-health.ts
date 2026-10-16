/**
 * Automatic drive-error handling ("drive diagnosis").
 *
 * A background monitor watches the ZFS read/write/checksum counters of every pool member. When a drive
 * reports new errors (an "episode"), ApexOs:
 *  1. notes them in the drive's history and reads the drive's SMART data;
 *  2. if the drive reports damaged areas, rates itself as failing, or stopped working and did not come
 *     back, tells the user to replace it right away (and never resets its counters);
 *  3. otherwise runs a pool check (scrub). When that check finishes clean, redundancy repaired the
 *     errors: ApexOs resets that drive's counters once (`zpool clear <pool> <vdev guid>` through the host
 *     helper) and watches the drive for a month. The user only gets an informational notice;
 *  4. if errors come back during that month, raises exactly one notice with the likely cause: a cable
 *     (one drive), the controller (several drives connected the same way), memory (several drives with
 *     checksum-only errors, or TrueNAS reports memory errors), or "unclear" (cable or port first, then
 *     replace).
 *
 * Safety rules: a drive that reports bad sectors is never reset, and no drive is reset twice within a
 * month. Unreadable data on a pool without redundancy is reported as soon as a check finds it.
 *
 * Passes are triggered by a periodic tick and (throttled) pool change events. All times come from an
 * injectable clock so tests can move a month ahead.
 */
import type { CollectionUpdate } from '@apexos/truenas-client';
import type {
  ChangeTopic,
  Drive,
  DriveDiagnosis,
  DriveErrorCounts,
  DriveHealth,
  DriveHealthDetail,
  DriveHealthEventKind,
  NoticeLevel,
  Pool,
  SmartSummary,
} from '@apexos/api-types';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { HostCommandError } from '../lib/host.ts';
import type { DriveHealthRecord, DriveHealthStore } from '../lib/store.ts';
import { errorMessage } from '../lib/tasks.ts';
import type { TnAlert, TnDisk, TnPool, TnVdev } from '../truenas/types.ts';
import { addNotice } from './notifications.ts';
import { lastCheckOutcome } from './pool-checks.ts';
import { buildOverview, getStorage, readStorage, startScrub, type StorageSnapshot } from './storage.ts';

const DAY_MS = 86_400_000;
/** How long a drive is watched after ApexOs reset its counters; also the minimum gap between two resets. */
export const WATCH_MS = 30 * DAY_MS;
export const DEFAULT_CHECK_INTERVAL_MS = 10 * 60_000;
const DEFAULT_DEBOUNCE_MS = 5_000;
/** Pool change events arrive every few seconds during a check; look at most this often. */
const DEFAULT_MIN_GAP_MS = 30_000;
const MAX_EVENTS = 60;
/** A check that was cancelled (or lost to a restart) is started again this many times in total. */
const MAX_CHECK_ATTEMPTS = 2;
/** New errors on an already diagnosed drive re-read SMART at most this often. */
const SMART_REFRESH_MS = DAY_MS;
/** Records of drives that left their pool are forgotten after this long without news. */
const FORGET_MS = 365 * DAY_MS;
const FAILED_STATES = new Set(['FAULTED', 'REMOVED', 'UNAVAIL']);
const KERNEL_NAME_RE = /^[a-z0-9]+$/;
const GUID_RE = /^\d{1,20}$/;
/** TrueNAS alert classes about faulty memory (e.g. `MemoryErrors`: uncorrected ECC errors). */
const MEMORY_ALERT_RE = /memory.*error|ecc/i;
const ZERO: DriveErrorCounts = { read: 0, write: 0, checksum: 0 };

/** The configured interval between full passes (`APEXOS_DRIVE_CHECK_INTERVAL_MS`, default 10 minutes). */
export function checkIntervalMs(): number {
  const n = Number(process.env.APEXOS_DRIVE_CHECK_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1_000 ? n : DEFAULT_CHECK_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// SMART
// ---------------------------------------------------------------------------

interface SmartctlJson {
  smartctl?: { exit_status?: number; messages?: { string?: string }[] };
  smart_status?: { passed?: boolean };
  ata_smart_attributes?: { table?: { id: number; raw?: { value?: number } }[] };
  nvme_smart_health_information_log?: { media_errors?: number };
  power_on_time?: { hours?: number };
  temperature?: { current?: number };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Parses `smartctl -j -H -A` output. smartctl's exit status is a bit mask: bits 0-1 mean the device could
 * not be read at all; higher bits (e.g. 8 = "disk failing") still come with complete JSON.
 */
export function parseSmart(output: string, exitCode: number, readAt: string): SmartSummary {
  let json: SmartctlJson;
  try {
    const start = output.indexOf('{');
    json = JSON.parse(start >= 0 ? output.slice(start) : output) as SmartctlJson;
  } catch {
    throw new HostCommandError('The drive did not return readable health data.');
  }
  if (exitCode & 0b11) {
    const detail = json.smartctl?.messages?.find((m) => m.string)?.string;
    throw new HostCommandError(detail ? `The drive's health data can't be read (${detail}).` : "The drive's health data can't be read.");
  }
  const table = json.ata_smart_attributes?.table ?? [];
  const attr = (id: number) => num(table.find((a) => a.id === id)?.raw?.value);
  const reallocatedSectors = attr(5);
  const pendingSectors = attr(197);
  const offlineUncorrectable = attr(198);
  const mediaErrors = num(json.nvme_smart_health_information_log?.media_errors);
  return {
    readAt,
    passed: typeof json.smart_status?.passed === 'boolean' ? json.smart_status.passed : null,
    reallocatedSectors,
    pendingSectors,
    offlineUncorrectable,
    mediaErrors,
    powerOnHours: num(json.power_on_time?.hours),
    temperatureC: num(json.temperature?.current),
    damaged: [reallocatedSectors, pendingSectors, offlineUncorrectable, mediaErrors].some((n) => (n ?? 0) > 0),
  };
}

/** Damaged areas, or the drive's own verdict is "failing": replace it, and never reset its counters. */
export function smartSaysReplace(smart: SmartSummary | null | undefined): boolean {
  return Boolean(smart && (smart.damaged || smart.passed === false));
}

/** Reads SMART through the host helper. `name` must be a kernel name the caller found in `disk.query`. */
export async function readSmart(ctx: AppContext, name: string, readAt: string): Promise<SmartSummary> {
  if (!KERNEL_NAME_RE.test(name)) throw new HostCommandError(`Unexpected device name ${JSON.stringify(name)}`);
  const result = await ctx.host.run('smartctl', ['-j', '-H', '-A', `/dev/${name}`], { timeoutMs: 90_000 });
  return parseSmart(result.output, result.code, readAt);
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

function total(e: DriveErrorCounts): number {
  return e.read + e.write + e.checksum;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describeCounts(e: DriveErrorCounts): string {
  const parts = [e.read && `${e.read} read`, e.write && `${e.write} write`, e.checksum && `${e.checksum} checksum`].filter(Boolean);
  return `${plural(total(e), 'new error')} (${parts.join(', ')})`;
}

function day(time: number | string): string {
  return new Date(time).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function label(rec: Pick<DriveHealthRecord, 'model' | 'serial'>): string {
  return `${rec.model || 'Drive'} (serial ${rec.serial})`;
}

function listText(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function describeSmart(s: SmartSummary): string {
  if (s.damaged) {
    const parts = [
      s.reallocatedSectors && plural(s.reallocatedSectors, 'replaced (reallocated) sector'),
      s.pendingSectors && plural(s.pendingSectors, 'unstable sector'),
      s.offlineUncorrectable && plural(s.offlineUncorrectable, 'unreadable sector'),
      s.mediaErrors && plural(s.mediaErrors, 'media error'),
    ].filter(Boolean) as string[];
    return `The drive reports damaged areas: ${listText(parts)}.`;
  }
  if (s.passed === false) return 'The drive rates its own health as failing.';
  return s.passed ? 'The drive passes its own health check and reports no damaged areas.' : 'The drive reports no damaged areas.';
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

type Identity = Pick<DriveHealthRecord, 'identifier' | 'name' | 'serial' | 'model'>;

function newRecord(id: Identity, pool: string | null): DriveHealthRecord {
  return {
    identifier: id.identifier,
    name: id.name,
    serial: id.serial,
    model: id.model,
    pool,
    baseline: { ...ZERO },
    failed: false,
    phase: 'ok',
    watchUntil: null,
    lastErrorAt: null,
    lastClearedAt: null,
    diagnosis: null,
    diagnosisNote: null,
    previousDiagnosis: null,
    notified: [],
    check: null,
    smart: null,
    events: [],
  };
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function addEvent(rec: DriveHealthRecord, time: number, kind: DriveHealthEventKind, message: string, errors: DriveErrorCounts | null = null): void {
  rec.events.unshift({ time: iso(time), kind, message, errors });
  if (rec.events.length > MAX_EVENTS) rec.events.length = MAX_EVENTS;
}

/** Like addEvent, but doesn't repeat the newest message (e.g. "waiting for the running check"). */
function addEventOnce(rec: DriveHealthRecord, time: number, kind: DriveHealthEventKind, message: string): void {
  if (rec.events[0]?.message !== message) addEvent(rec, time, kind, message);
}

function toHealth(rec: DriveHealthRecord): DriveHealth {
  return {
    state: rec.phase,
    watchUntil: rec.phase === 'watching' ? rec.watchUntil : null,
    lastErrorAt: rec.lastErrorAt,
    diagnosis: rec.phase === 'attention' ? rec.diagnosis : null,
  };
}

/** Adds `health` to pool members ApexOs has a record for (called while building the storage overview). */
export function attachDriveHealth(ctx: AppContext, drives: Drive[]): void {
  const records = ctx.store.get().driveHealth?.drives ?? {};
  for (const d of drives) {
    const rec = records[d.identifier];
    if (rec && d.pool && d.role !== 'boot') d.health = toHealth(rec);
  }
}

// ---------------------------------------------------------------------------
// Topology helpers
// ---------------------------------------------------------------------------

const SECTIONS = ['data', 'spare', 'cache', 'log', 'special', 'dedup'] as const;

function walkLeaves(pool: TnPool, visit: (leaf: TnVdev, parent: TnVdev | null) => void): void {
  const walk = (v: TnVdev, parent: TnVdev | null) => {
    if (v.type === 'DISK') visit(v, parent);
    for (const c of v.children ?? []) walk(c, v);
  };
  for (const key of SECTIONS) for (const v of pool.topology?.[key] ?? []) walk(v, null);
}

/** What matters for drive health in `pool.query`: counters, states and check results (not progress). */
function fingerprint(pools: TnPool[]): string {
  return JSON.stringify(
    pools.map((p) => {
      const leaves: unknown[] = [];
      walkLeaves(p, (l) => leaves.push([l.guid, l.status, l.stats?.read_errors, l.stats?.write_errors, l.stats?.checksum_errors]));
      const s = p.scan;
      return [p.name, p.status, s?.function, s?.state, s?.end_time?.$date ?? null, s?.errors ?? null, Boolean(s?.pause), leaves];
    }),
  );
}

interface Member {
  drive: Drive;
  pool: Pool;
  disk: TnDisk | undefined;
  /** ZFS leaf vdev guid, used for `zpool clear`. */
  guid: string | null;
  /** Approximation of "the same controller": drives on the same bus and subsystem. */
  controller: string;
  /** Part of a replacement in progress: the user is already dealing with it. */
  replacing: boolean;
}

function collectMembers(snap: StorageSnapshot, pools: Pool[]): Map<string, Member> {
  const out = new Map<string, Member>();
  for (const pool of pools) {
    const tn = snap.pools.find((p) => p.name === pool.name);
    const leaves = new Map<string, { guid: string; replacing: boolean }>();
    if (tn) {
      walkLeaves(tn, (leaf, parent) => {
        const info = { guid: leaf.guid, replacing: parent?.type === 'REPLACING' };
        if (leaf.disk) leaves.set(leaf.disk, info);
        if (leaf.unavail_disk?.identifier) leaves.set(leaf.unavail_disk.identifier, info);
        leaves.set(`missing:${leaf.guid}`, info);
      });
    }
    for (const drive of [...pool.drives, ...pool.spares]) {
      const disk = snap.disks.find((d) => d.identifier === drive.identifier);
      const leaf = (!drive.missing ? leaves.get(drive.name) : undefined) ?? leaves.get(drive.identifier);
      out.set(drive.identifier, {
        drive,
        pool,
        disk,
        guid: leaf?.guid ?? null,
        controller: disk ? `${disk.bus || '?'}/${disk.subsystem || '?'}`.toLowerCase() : `unknown:${drive.identifier}`,
        replacing: leaf?.replacing ?? false,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

interface NoticeDraft {
  level: NoticeLevel;
  title: string;
  message: string;
  link: string;
}

/** Errors that need a diagnosis: they came back while watched, or a check couldn't repair them. */
interface Episode {
  rec: DriveHealthRecord;
  member: Member;
  /** The errors behind this episode. */
  errors: DriveErrorCounts;
  reason: 'recurred' | 'unrepaired';
  /** Set the diagnosis without a notice (another notice already covers it). */
  quiet?: boolean;
}

interface Pass {
  now: number;
  store: DriveHealthStore;
  snap: StorageSnapshot;
  pools: Pool[];
  members: Map<string, Member>;
  notices: NoticeDraft[];
  /** Drives whose errors were repaired and counters reset in this pass (one info notice per pool). */
  repaired: DriveHealthRecord[];
}

export interface DriveHealthOptions {
  /** Full pass interval (default: APEXOS_DRIVE_CHECK_INTERVAL_MS or 10 minutes). */
  intervalMs?: number;
  /** Delay after a pool change before looking (default 5 s). */
  debounceMs?: number;
  /** Minimum time between two event-triggered looks (default 30 s). */
  minGapMs?: number;
  /** Clock (ms since epoch); tests replace it to move ahead in time. */
  now?: () => number;
  onError?: (err: unknown) => void;
}

const locks = new WeakMap<AppContext, Promise<unknown>>();

/** Serializes changes to the drive-health records (monitor passes and manual SMART reads). */
function withLock<T>(ctx: AppContext, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(ctx) ?? Promise.resolve()).then(fn, fn);
  locks.set(
    ctx,
    next.catch(() => undefined),
  );
  return next;
}

/** Forgets data-loss records (they are kept per pool name, which a new pool may reuse); drive history stays. */
export function forgetPoolDataLoss(ctx: AppContext): Promise<void> {
  return withLock(ctx, () =>
    ctx.store.update((s) => {
      s.driveHealth.dataLoss = {};
    }),
  );
}

const monitors = new WeakMap<AppContext, DriveHealthMonitor>();

export class DriveHealthMonitor {
  readonly intervalMs: number;
  readonly clock: () => number;
  private readonly debounceMs: number;
  private readonly minGapMs: number;
  private readonly onError: (err: unknown) => void;
  private tick?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private lastQuick = 0;
  private queued: { quick: boolean; promise: Promise<void> } | null = null;
  private lastFingerprint: string | null = null;
  private emitting = false;
  private stopped = false;
  private lastErrorText: string | null = null;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly ctx: AppContext,
    opts: DriveHealthOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? checkIntervalMs();
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
    this.clock = opts.now ?? Date.now;
    this.onError =
      opts.onError ??
      ((err) => {
        const text = errorMessage(err);
        if (text !== this.lastErrorText) console.warn(`Drive health check failed: ${text}`);
        this.lastErrorText = text;
      });
    monitors.set(ctx, this);
  }

  /** Starts the periodic tick and listens for pool changes. */
  start(): this {
    const { ctx } = this;
    const onUpdate = (u: CollectionUpdate) => {
      if (u.collection === 'pool.query' || u.collection === 'zfs.pool.scan') this.schedule();
    };
    const onChanged = (topic: ChangeTopic) => {
      if (topic === 'storage' && !this.emitting) this.schedule();
    };
    const onStatus = (connected: boolean) => {
      if (connected) this.schedule();
    };
    ctx.truenas.on('update', onUpdate);
    ctx.bus.on('changed', onChanged);
    ctx.truenas.on('status', onStatus);
    this.unsubscribe.push(
      () => ctx.truenas.off('update', onUpdate),
      () => ctx.bus.off('changed', onChanged),
      () => ctx.truenas.off('status', onStatus),
    );
    this.tick = setInterval(() => void this.check(), this.intervalMs);
    this.tick.unref();
    void this.check();
    return this;
  }

  /** Stops timers and listeners and waits for a running pass. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.tick);
    clearTimeout(this.debounce);
    for (const off of this.unsubscribe.splice(0)) off();
    if (monitors.get(this.ctx) === this) monitors.delete(this.ctx);
    await (locks.get(this.ctx) ?? Promise.resolve());
  }

  /** Throttled, debounced pass after a pool change. */
  private schedule(): void {
    if (this.debounce || this.stopped) return;
    const wait = Math.max(this.debounceMs, this.lastQuick + this.minGapMs - Date.now());
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.lastQuick = Date.now();
      void this.check({ quick: true });
    }, wait);
    this.debounce.unref();
  }

  /**
   * Runs one pass (after any running one). A quick pass first reads only `pool.query` and stops when
   * nothing relevant changed. Requests made while a pass is waiting to run share that pass.
   */
  check(opts: { quick?: boolean } = {}): Promise<void> {
    if (this.queued) {
      if (!opts.quick) this.queued.quick = false;
      return this.queued.promise;
    }
    const entry = { quick: opts.quick ?? false } as { quick: boolean; promise: Promise<void> };
    entry.promise = withLock(this.ctx, async () => {
      if (this.queued === entry) this.queued = null;
      if (this.stopped) return;
      try {
        await this.pass(entry.quick);
        this.lastErrorText = null;
      } catch (err) {
        this.onError(err);
      }
    });
    this.queued = entry;
    return entry.promise;
  }

  /**
   * Resets a drive's error counters, but only if that's safe: never for a drive that reports bad sectors
   * or should be replaced, and never twice within a month. Returns whether the counters were reset.
   */
  clearErrorsOnce(identifier: string): Promise<boolean> {
    return withLock(this.ctx, async () => {
      const p = await this.load();
      const member = p.members.get(identifier);
      const rec = p.store.drives[identifier] ?? (member ? newRecord(member.drive, member.pool.name) : undefined);
      if (!member || !rec) throw new UserError('That drive is not part of a pool.', 404, 'NOT_FOUND');
      p.store.drives[identifier] = rec;
      const result = await this.clearOnce(p, rec, member);
      await this.commit(p, JSON.stringify(this.ctx.store.get().driveHealth));
      return result === 'cleared';
    });
  }

  private async load(): Promise<Pass> {
    const snap = await readStorage(this.ctx.truenas.client());
    const overview = buildOverview(this.ctx, snap);
    this.lastFingerprint = fingerprint(snap.pools);
    return {
      now: this.clock(),
      store: structuredClone(this.ctx.store.get().driveHealth),
      snap,
      pools: overview.pools,
      members: collectMembers(snap, overview.pools),
      notices: [],
      repaired: [],
    };
  }

  private async commit(p: Pass, before: string): Promise<void> {
    const changed = JSON.stringify(p.store) !== before;
    if (changed) {
      await this.ctx.store.update((s) => {
        s.driveHealth = p.store;
      });
    }
    for (const n of p.notices) await addNotice(this.ctx, n);
    if (changed) {
      // Let the UI refresh its badges without triggering another pass of our own.
      this.emitting = true;
      try {
        this.ctx.bus.changed('storage');
      } finally {
        this.emitting = false;
      }
    }
  }

  private async pass(quick: boolean): Promise<void> {
    if (!this.ctx.truenas.connected) return;
    if (quick) {
      const pools = await this.ctx.truenas.client().call<TnPool[]>('pool.query');
      if (fingerprint(pools) === this.lastFingerprint) return;
    }
    const before = JSON.stringify(this.ctx.store.get().driveHealth);
    const p = await this.load();
    const fresh = this.observe(p);
    const episodes = await this.route(p, fresh);
    await this.followChecks(p, episodes);
    await this.diagnose(p, episodes);
    this.housekeeping(p);
    this.reportDataLoss(p);
    this.reportRepaired(p);
    await this.commit(p, before);
  }

  /** Step 1: compare counters and states with what was seen last time. */
  private observe(p: Pass): { rec: DriveHealthRecord; member: Member; delta: DriveErrorCounts }[] {
    const out: { rec: DriveHealthRecord; member: Member; delta: DriveErrorCounts }[] = [];
    for (const m of p.members.values()) {
      const { drive } = m;
      const status = (drive.status ?? '').toUpperCase();
      const failedNow = drive.missing || FAILED_STATES.has(status);
      const counts = drive.errors;
      let rec = p.store.drives[drive.identifier];
      if (!rec) {
        if (total(counts) === 0 && !failedNow) continue;
        rec = p.store.drives[drive.identifier] = newRecord(drive, m.pool.name);
      } else if (rec.pool !== m.pool.name) {
        // Records made by "Check health now" for a drive without history start without a pool.
        if (rec.pool !== null || rec.lastErrorAt) addEvent(rec, p.now, 'pool', `Joined ${m.pool.displayName}.`);
        Object.assign(rec, { pool: m.pool.name, phase: 'ok', check: null, watchUntil: null, diagnosis: null, diagnosisNote: null, notified: [] });
      }
      if (!drive.missing) Object.assign(rec, { name: drive.name, serial: drive.serial, model: drive.model });

      if (counts.read < rec.baseline.read || counts.write < rec.baseline.write || counts.checksum < rec.baseline.checksum) {
        // Someone reset the counters (TrueNAS, a replacement, or the drive coming back).
        rec.baseline = { ...ZERO };
        addEvent(rec, p.now, 'cleared', 'The error count was reset outside ApexOs.');
        if (rec.phase === 'attention' && rec.diagnosis !== 'replace-drive') {
          rec.previousDiagnosis = rec.diagnosis;
          this.startWatch(p, rec, 'ApexOs will watch whether the fix helped.');
        }
      }
      const delta: DriveErrorCounts = {
        read: Math.max(0, counts.read - rec.baseline.read),
        write: Math.max(0, counts.write - rec.baseline.write),
        checksum: Math.max(0, counts.checksum - rec.baseline.checksum),
      };
      rec.baseline = { ...counts };

      const newlyFailed = failedNow && !rec.failed;
      if (rec.failed && !failedNow) {
        addEvent(rec, p.now, 'recovered', 'The drive is working again.');
        if (rec.phase === 'attention' && rec.diagnosis === 'replace-drive' && !smartSaysReplace(rec.smart)) {
          this.startWatch(p, rec, 'It came back on its own, so it may not need replacing.');
        }
      }
      rec.failed = failedNow;
      if (m.replacing) continue; // being replaced already
      if (total(delta) === 0 && !newlyFailed) continue;
      rec.lastErrorAt = iso(p.now);
      if (total(delta) > 0) addEvent(rec, p.now, 'errors', `ZFS counted ${describeCounts(delta)}.`, delta);
      if (newlyFailed) {
        addEvent(rec, p.now, 'failed', drive.missing ? 'The drive disappeared from the server.' : `The drive stopped working (ZFS marked it ${status}).`);
      }
      out.push({ rec, member: m, delta });
    }
    return out;
  }

  /** Step 2: decide what each new error episode needs. Returns errors that came back while watched. */
  private async route(p: Pass, fresh: { rec: DriveHealthRecord; member: Member; delta: DriveErrorCounts }[]): Promise<Episode[]> {
    const episodes: Episode[] = [];
    for (const { rec, member, delta } of fresh) {
      // The check that is already running (or about to) covers these errors too.
      if (rec.phase === 'checking') continue;
      if (rec.phase === 'attention') {
        // Already diagnosed and the user was told: keep monitoring, but escalate if the drive is now failing.
        if (rec.diagnosis === 'replace-drive') continue;
        if (rec.failed) {
          this.replace(p, rec, member, 'failed');
          continue;
        }
        if (!rec.smart || p.now - Date.parse(rec.smart.readAt) > SMART_REFRESH_MS) await this.refreshSmart(p, rec, member);
        if (smartSaysReplace(rec.smart)) this.replace(p, rec, member, 'smart');
        continue;
      }
      if (rec.failed) {
        this.replace(p, rec, member, 'failed');
        continue;
      }
      const smart = await this.refreshSmart(p, rec, member);
      if (smartSaysReplace(smart)) {
        this.replace(p, rec, member, 'smart');
        continue;
      }
      if (rec.phase === 'watching' && rec.watchUntil && Date.parse(rec.watchUntil) > p.now) {
        episodes.push({ rec, member, errors: delta, reason: 'recurred' });
        continue;
      }
      // A new episode: check the pool, and reset the counters once if the check finds nothing it can't repair.
      Object.assign(rec, {
        phase: 'checking',
        check: { pool: member.pool.name, requestedAt: iso(p.now), startedAt: null, attempts: 0 },
        notified: [],
        diagnosis: null,
        diagnosisNote: null,
        watchUntil: null,
      });
    }
    return episodes;
  }

  /** Step 3: start pool checks for new episodes and act on the ones that finished. */
  private async followChecks(p: Pass, episodes: Episode[]): Promise<void> {
    for (const pool of p.pools) {
      const waiting = Object.values(p.store.drives).filter((r) => r.phase === 'checking' && r.check?.pool === pool.name);
      if (!waiting.length) continue;
      const scanBusy = pool.scan?.state === 'running' || pool.scan?.state === 'paused';
      const started = waiting.filter((r) => r.check?.startedAt);
      if (started.length) {
        const outcome = await lastCheckOutcome(this.ctx, pool);
        if (outcome === 'running') continue;
        if (outcome === 'clean') {
          for (const r of started) {
            const result = await this.afterCleanCheck(p, r, pool);
            if (result) episodes.push(result);
          }
        } else if (outcome === 'errors') {
          for (const r of started) {
            const member = p.members.get(r.identifier);
            r.check = null;
            addEvent(r, p.now, 'check', `The check of ${pool.displayName} found damaged data that couldn't be repaired.`);
            // On a pool without redundancy the "data can't be read" notice says it all.
            if (member) episodes.push({ rec: r, member, errors: { ...r.baseline }, reason: 'unrepaired', quiet: pool.layout.faultTolerance === 0 });
            else r.phase = 'ok';
          }
        } else if (!scanBusy) {
          // Cancelled, or ApexOs/TrueNAS restarted meanwhile (results aren't trusted across restarts).
          for (const r of started) {
            if (r.check!.attempts >= MAX_CHECK_ATTEMPTS) {
              Object.assign(r, { phase: 'ok', check: null });
              addEvent(r, p.now, 'check', "The pool check didn't finish, so ApexOs left the error count as it is. It will try again if new errors appear.");
            } else {
              r.check!.startedAt = null;
              addEvent(r, p.now, 'check', "The pool check didn't finish; ApexOs will run it again.");
            }
          }
        }
      }
      const pending = waiting.filter((r) => r.phase === 'checking' && r.check && !r.check.startedAt);
      if (!pending.length) continue;
      if (scanBusy) {
        for (const r of pending) addEventOnce(r, p.now, 'check', `Waiting for the check that is already running on ${pool.displayName} to finish.`);
        continue;
      }
      try {
        await startScrub(this.ctx, pool);
        for (const r of pending) {
          r.check!.startedAt = iso(p.now);
          r.check!.attempts += 1;
          addEvent(r, p.now, 'check', `ApexOs started a check of ${pool.displayName} to find and repair any damaged data.`);
        }
      } catch (err) {
        for (const r of pending) addEventOnce(r, p.now, 'check', `ApexOs couldn't start a check of ${pool.displayName} yet (${errorMessage(err)}). It will try again.`);
      }
    }
  }

  /** The check found nothing it couldn't repair: reset the counters once and watch the drive. */
  private async afterCleanCheck(p: Pass, rec: DriveHealthRecord, pool: Pool): Promise<Episode | null> {
    rec.check = null;
    addEvent(rec, p.now, 'check', `The check of ${pool.displayName} finished: everything that was damaged has been repaired.`);
    const member = p.members.get(rec.identifier);
    if (!member) {
      rec.phase = 'ok';
      return null;
    }
    // Never reset a drive that reports bad sectors: look again right before resetting.
    const smart = (await this.refreshSmart(p, rec, member)) ?? rec.smart;
    if (smartSaysReplace(smart)) {
      this.replace(p, rec, member, 'smart');
      return null;
    }
    const result = await this.clearOnce(p, rec, member);
    if (result === 'refused') {
      // Already reset within the last month: errors keep coming back, so this needs a diagnosis instead.
      return { rec, member, errors: { ...rec.baseline }, reason: 'recurred' };
    }
    this.startWatch(p, rec, result === 'cleared' ? 'The errors were repaired.' : "The errors were repaired, but the error count couldn't be reset.");
    p.repaired.push(rec);
    return null;
  }

  private async clearOnce(p: Pass, rec: DriveHealthRecord, member: Member): Promise<'cleared' | 'refused' | 'failed'> {
    if (rec.diagnosis === 'replace-drive' || smartSaysReplace(rec.smart)) {
      addEventOnce(rec, p.now, 'kept', 'The drive reports damaged areas, so ApexOs leaves its error count as it is.');
      return 'refused';
    }
    if (rec.lastClearedAt && p.now - Date.parse(rec.lastClearedAt) < WATCH_MS) {
      addEventOnce(rec, p.now, 'kept', `ApexOs already reset this drive's error count on ${day(rec.lastClearedAt)} and does that at most once a month.`);
      return 'refused';
    }
    const tn = p.snap.pools.find((x) => x.name === member.pool.name);
    const guids = new Set<string>();
    if (tn) walkLeaves(tn, (leaf) => guids.add(leaf.guid));
    const guid = member.guid;
    if (!tn || !guid || !GUID_RE.test(guid) || !guids.has(guid)) {
      addEvent(rec, p.now, 'kept', "ApexOs couldn't find the drive in the pool layout, so its error count stays as it is.");
      return 'failed';
    }
    try {
      await this.ctx.host.runChecked('zpool', ['clear', tn.name, guid]);
    } catch (err) {
      addEvent(rec, p.now, 'kept', `ApexOs couldn't reset the error count: ${errorMessage(err)}`);
      return 'failed';
    }
    rec.lastClearedAt = iso(p.now);
    rec.baseline = { ...ZERO };
    addEvent(rec, p.now, 'cleared', "ApexOs reset the drive's error count.");
    return 'cleared';
  }

  private startWatch(p: Pass, rec: DriveHealthRecord, why: string): void {
    const until = p.now + WATCH_MS;
    Object.assign(rec, { phase: 'watching', watchUntil: iso(until), check: null, diagnosis: null, diagnosisNote: null, notified: [] });
    addEvent(rec, p.now, 'watch', `${why} ApexOs is watching this drive until ${day(until)}.`);
  }

  private async refreshSmart(p: Pass, rec: DriveHealthRecord, member: Member): Promise<SmartSummary | null> {
    const name = member.disk?.name;
    if (member.drive.missing || !name || !KERNEL_NAME_RE.test(name)) {
      addEventOnce(rec, p.now, 'smart', "The drive's own health data (SMART) can't be read right now.");
      return null;
    }
    try {
      const smart = await readSmart(this.ctx, name, iso(p.now));
      rec.smart = smart;
      addEvent(rec, p.now, 'smart', describeSmart(smart));
      return smart;
    } catch (err) {
      addEventOnce(rec, p.now, 'smart', `ApexOs couldn't read the drive's own health data (SMART): ${errorMessage(err)}`);
      return null;
    }
  }

  private replace(p: Pass, rec: DriveHealthRecord, member: Member, reason: 'failed' | 'smart'): void {
    const note = reason === 'failed' ? 'The drive stopped working and has not come back.' : describeSmart(rec.smart!);
    Object.assign(rec, { phase: 'attention', diagnosis: 'replace-drive', diagnosisNote: note, check: null, watchUntil: null });
    const notify = !rec.notified.includes('replace-drive');
    addEvent(rec, p.now, 'diagnosis', `${note} ApexOs recommends replacing it and leaves its error count as it is.${notify ? ' You were notified.' : ''}`);
    if (!notify) return;
    rec.notified.push('replace-drive');
    const protectedPool = (member.pool.layout.faultTolerance ?? 0) > 0;
    const safety = protectedPool
      ? 'The other drives in the pool still protect your data, but replace this one soon.'
      : 'This pool keeps only one copy of your data, so copy anything important elsewhere now, then replace the drive.';
    p.notices.push({
      level: 'error',
      title: `Replace a drive in ${member.pool.displayName}`,
      message:
        reason === 'failed'
          ? `${label(rec)} stopped working and hasn't come back. ${safety}`
          : `${label(rec)} is wearing out. ${note} ${safety}`,
      link: '/storage',
    });
  }

  /** Step 4: one diagnosis notice per episode, grouping drives that had errors at the same time. */
  private async diagnose(p: Pass, episodes: Episode[]): Promise<void> {
    if (!episodes.length) return;
    const single: Episode[] = [];
    if (episodes.length >= 2) {
      const memoryAlert = await this.memoryAlert();
      const checksumOnly = episodes.every((e) => e.errors.read === 0 && e.errors.write === 0 && e.errors.checksum > 0);
      if (memoryAlert || checksumOnly) {
        const what = checksumOnly ? 'checksum errors' : 'errors';
        this.setDiagnosis(
          p,
          episodes,
          'check-memory',
          `${plural(episodes.length, 'drive')} reported ${what} at the same time${memoryAlert ? ', and TrueNAS reported memory errors' : ''}.`,
          memoryAlert,
        );
        return;
      }
      const byController = new Map<string, Episode[]>();
      for (const e of episodes) byController.set(e.member.controller, [...(byController.get(e.member.controller) ?? []), e]);
      for (const group of byController.values()) {
        if (group.length >= 2) {
          this.setDiagnosis(p, group, 'check-controller', `${plural(group.length, 'drive')} connected the same way reported errors at the same time.`);
        } else single.push(...group);
      }
    } else single.push(...episodes);

    for (const e of single) {
      const { rec } = e;
      // SMART must have been read for these errors, else the drive can't be ruled out.
      const smartKnown = Boolean(rec.smart && rec.lastErrorAt && Date.parse(rec.smart.readAt) >= Date.parse(rec.lastErrorAt));
      if (e.reason === 'unrepaired') {
        this.setDiagnosis(p, [e], 'unclear', 'A pool check found damaged data that could not be repaired.');
      } else if (rec.previousDiagnosis === 'check-cable') {
        this.setDiagnosis(p, [e], 'unclear', 'Errors came back even after the advice to check the cable.');
      } else if (!smartKnown) {
        this.setDiagnosis(p, [e], 'unclear', "Errors came back, and the drive's own health data couldn't be read.");
      } else {
        this.setDiagnosis(p, [e], 'check-cable', 'Errors came back within a month of being repaired, while the drive reports no damaged areas.');
      }
    }
  }

  private setDiagnosis(p: Pass, group: Episode[], diagnosis: DriveDiagnosis, note: string, memoryAlert = false): void {
    const unnotified = group.filter((e) => !e.rec.notified.includes(diagnosis));
    const notify = unnotified.some((e) => !e.quiet);
    for (const e of group) {
      Object.assign(e.rec, { phase: 'attention', diagnosis, diagnosisNote: note, check: null, watchUntil: null });
      const told = notify && unnotified.includes(e) ? ' You were notified.' : '';
      addEvent(e.rec, p.now, 'diagnosis', `${note} ${DIAGNOSIS_EVENT[diagnosis]}${told}`);
    }
    for (const e of unnotified) e.rec.notified.push(diagnosis);
    if (notify) p.notices.push(diagnosisNotice(diagnosis, group, memoryAlert));
  }

  private async memoryAlert(): Promise<boolean> {
    const alerts = await this.ctx.truenas
      .client()
      .call<TnAlert[]>('alert.list')
      .catch(() => [] as TnAlert[]);
    return alerts.some((a) => MEMORY_ALERT_RE.test(a.klass));
  }

  /** Step 5: end watch periods, lift old warnings, forget drives that left their pool. */
  private housekeeping(p: Pass): void {
    for (const rec of Object.values(p.store.drives)) {
      const member = p.members.get(rec.identifier);
      if (!member) {
        const pool = rec.pool ? p.pools.find((x) => x.name === rec.pool) : undefined;
        // A pool whose layout can't be read right now (e.g. offline) keeps its records.
        const layoutKnown = Boolean(pool && p.snap.pools.find((x) => x.name === pool.name)?.topology);
        if (rec.pool && (!pool || layoutKnown)) {
          addEvent(rec, p.now, 'pool', `No longer part of ${pool?.displayName ?? rec.pool}.`);
          Object.assign(rec, {
            pool: null,
            phase: 'ok',
            check: null,
            watchUntil: null,
            diagnosis: null,
            diagnosisNote: null,
            notified: [],
            failed: false,
            baseline: { ...ZERO },
          });
        }
        const latest = rec.events[0] ? Date.parse(rec.events[0].time) : 0;
        if (!rec.pool && p.now - latest > FORGET_MS) delete p.store.drives[rec.identifier];
        continue;
      }
      if (rec.phase === 'watching' && rec.watchUntil && Date.parse(rec.watchUntil) <= p.now) {
        Object.assign(rec, { phase: 'ok', watchUntil: null, previousDiagnosis: null });
        addEvent(rec, p.now, 'watch', 'A month passed without new errors. ApexOs stopped watching this drive closely.');
      }
      if (rec.phase === 'attention' && rec.diagnosis !== 'replace-drive' && rec.lastErrorAt && p.now - Date.parse(rec.lastErrorAt) >= WATCH_MS) {
        Object.assign(rec, { phase: 'ok', previousDiagnosis: rec.diagnosis, diagnosis: null, diagnosisNote: null, notified: [] });
        addEvent(rec, p.now, 'watch', 'No new errors for a month, so ApexOs lifted the warning.');
      }
      // A health reading (e.g. "Check health now") that shows damaged areas is acted on too.
      if (rec.phase !== 'checking' && rec.diagnosis !== 'replace-drive' && smartSaysReplace(rec.smart)) this.replace(p, rec, member, 'smart');
    }
  }

  /** Step 6: a check found unreadable data on a pool without redundancy. */
  private reportDataLoss(p: Pass): void {
    for (const pool of p.pools) {
      const scan = pool.scan;
      if (pool.layout.faultTolerance !== 0 || !scan || scan.kind !== 'scrub' || scan.state !== 'finished') continue;
      if (scan.errors <= 0 || !scan.finishedAt || p.store.dataLoss[pool.name] === scan.finishedAt) continue;
      p.store.dataLoss[pool.name] = scan.finishedAt;
      p.notices.push({
        level: 'critical',
        title: `Some data on ${pool.displayName} can't be read`,
        message: `A check of ${pool.displayName} found ${plural(scan.errors, 'damaged item')} that can't be repaired, because this pool keeps only one copy of your data. Restore the affected files from a backup if you have one, and check the pool's drive on the Storage page.`,
        link: '/storage',
      });
    }
  }

  /** Step 7: one informational notice per pool for errors that were repaired. */
  private reportRepaired(p: Pass): void {
    const byPool = new Map<string, DriveHealthRecord[]>();
    for (const rec of p.repaired) byPool.set(rec.pool ?? '', [...(byPool.get(rec.pool ?? '') ?? []), rec]);
    for (const [poolName, recs] of byPool) {
      const pool = p.pools.find((x) => x.name === poolName);
      const name = pool?.displayName ?? poolName;
      const repairedFrom = (pool?.layout.faultTolerance ?? 0) > 0 ? ' and repaired what was damaged from the other drives' : '';
      const until = recs[0]!.watchUntil ? day(recs[0]!.watchUntil) : 'next month';
      p.notices.push({
        level: 'info',
        title: `Drive errors in ${name} were fixed`,
        message: `${listText(recs.map(label))} reported a few errors. ApexOs checked ${name}${repairedFrom}, so your data is fine. ApexOs is watching ${recs.length === 1 ? 'this drive' : 'these drives'} until ${until} and will let you know if the errors come back.`,
        link: '/storage',
      });
    }
  }
}

const DIAGNOSIS_EVENT: Record<DriveDiagnosis, string> = {
  'check-cable': 'Likely cause: a loose or worn cable.',
  'check-controller': 'Likely cause: the controller, backplane or enclosure the drives share.',
  'check-memory': "Likely cause: the server's memory (RAM).",
  'replace-drive': 'ApexOs recommends replacing the drive.',
  unclear: 'The cause is not clear yet: check the cable and port first, then consider replacing the drive.',
};

function diagnosisNotice(diagnosis: DriveDiagnosis, group: Episode[], memoryAlert: boolean): NoticeDraft {
  const drives = listText(group.map((e) => label(e.rec)));
  const pools = listText([...new Set(group.map((e) => e.member.pool.displayName))]);
  const first = group[0]!;
  switch (diagnosis) {
    case 'check-cable':
      return {
        level: 'warning',
        title: `Check a drive cable in ${pools}`,
        message: `${drives} reported errors again, although the drive itself reports no damage. A loose or worn cable is the usual cause. When it suits you, shut the server down, reseat this drive's data and power cables firmly (or swap them for spares), then start it again. ApexOs keeps watching the drive.`,
        link: '/storage',
      };
    case 'check-controller':
      return {
        level: 'warning',
        title: `Check the drive controller in ${pools}`,
        message: `${drives} reported errors at the same time, while the drives themselves look healthy. The part they share (controller card, backplane, drive enclosure or its power supply) is the likely cause. Shut the server down, make sure that part is seated firmly, cooled and powered, and check its cables. ApexOs keeps watching the drives.`,
        link: '/storage',
      };
    case 'check-memory':
      return {
        level: 'warning',
        title: "Check the server's memory",
        message: `${drives} reported errors at the same time, while the drives themselves look healthy. ${memoryAlert ? 'TrueNAS also reported memory errors. ' : ''}This usually means data gets corrupted in the server's memory (RAM) before it reaches the drives. Run a memory test (for example MemTest86) and replace any faulty memory module. ApexOs keeps watching the drives.`,
        link: '/storage',
      };
    case 'replace-drive':
      return { level: 'error', title: `Replace a drive in ${pools}`, message: `${drives} should be replaced.`, link: '/storage' };
    case 'unclear':
      return {
        level: 'warning',
        title: first.reason === 'unrepaired' ? `A drive in ${pools} needs a look` : `Errors again on a drive in ${pools}`,
        message: `${drives} ${first.reason === 'unrepaired' ? 'had errors that a pool check could not repair' : 'reported errors again'}, and the cause isn't clear. First check its cable and try another port or bay. If errors still come back, replace the drive. ApexOs keeps watching it.`,
        link: '/storage',
      };
  }
}

// ---------------------------------------------------------------------------
// Entry points for the server and routes
// ---------------------------------------------------------------------------

/** Starts the background monitor (call after the TrueNAS connection is configured). */
export function startDriveHealthMonitor(ctx: AppContext, opts: DriveHealthOptions = {}): DriveHealthMonitor {
  return new DriveHealthMonitor(ctx, opts).start();
}

function allDrives(overview: { pools: Pool[]; unassigned: Drive[]; bootDrives: Drive[] }): Drive[] {
  return [...overview.pools.flatMap((p) => [...p.drives, ...p.spares]), ...overview.unassigned, ...overview.bootDrives];
}

export async function getDriveHealthDetail(ctx: AppContext, identifier: string): Promise<DriveHealthDetail> {
  const drive = allDrives(await getStorage(ctx)).find((d) => d.identifier === identifier);
  const rec = ctx.store.get().driveHealth.drives[identifier];
  if (!drive && !rec) throw new UserError('That drive is not connected.', 404, 'NOT_FOUND');
  const inPool = Boolean(drive?.pool && drive.role !== 'boot');
  return {
    identifier,
    name: drive?.name ?? rec!.name,
    serial: drive?.serial ?? rec!.serial,
    model: drive?.model ?? rec!.model,
    pool: inPool ? drive!.pool : null,
    errors: drive?.errors ?? { ...ZERO },
    health: rec && inPool ? toHealth(rec) : { state: 'ok', watchUntil: null, lastErrorAt: rec?.lastErrorAt ?? null, diagnosis: null },
    diagnosisNote: rec && inPool && rec.phase === 'attention' ? rec.diagnosisNote : null,
    smart: rec?.smart ?? null,
    events: rec?.events ?? [],
    checkIntervalMinutes: Math.max(1, Math.round((monitors.get(ctx)?.intervalMs ?? checkIntervalMs()) / 60_000)),
  };
}

/** Reads SMART now ("Check health now") and remembers it; damaged areas on a pool member are acted on. */
export async function readSmartNow(ctx: AppContext, identifier: string): Promise<SmartSummary> {
  const [disk] = await ctx.truenas.client().call<TnDisk[]>('disk.query', [[['identifier', '=', identifier]]]);
  if (!disk) throw new UserError('That drive is not connected.', 404, 'NOT_FOUND');
  if (!KERNEL_NAME_RE.test(disk.name)) throw new UserError("ApexOs can't read this drive's health data.", 409, 'SMART_UNAVAILABLE');
  const monitor = monitors.get(ctx);
  const now = monitor?.clock() ?? Date.now();
  let smart: SmartSummary;
  try {
    smart = await readSmart(ctx, disk.name, iso(now));
  } catch (err) {
    throw new UserError(errorMessage(err), 409, 'SMART_UNAVAILABLE');
  }
  await withLock(ctx, () =>
    ctx.store.update((s) => {
      const rec = (s.driveHealth.drives[identifier] ??= newRecord({ identifier, name: disk.name, serial: disk.serial, model: disk.model }, null));
      rec.smart = smart;
      addEvent(rec, now, 'smart', `Health check on request: ${describeSmart(smart)}`);
    }),
  );
  if (smartSaysReplace(smart)) void monitor?.check();
  return smart;
}
