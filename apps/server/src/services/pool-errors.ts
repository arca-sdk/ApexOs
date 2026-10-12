/**
 * Pool data errors: the files ZFS lists as permanently damaged (`zpool status -v`, "errors:" section),
 * what they mean for the user, and the actions built on that list:
 *
 * - **Repair** deletes damaged files that belong to TrueNAS's own downloaded copy of the app catalog,
 *   runs a full check (scrub) and refreshes the catalog. It never touches anything else.
 * - **Reset error count** (`zpool clear`) clears the drives' error counters, and only after the last
 *   check ApexOs itself ran finished clean.
 *
 * TrueNAS has no API for the damaged-file list or for clearing counters, so both go through the host
 * helper (`lib/host.ts`). User files are never deleted: the user restores or deletes them over the share.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type {
  DataErrorEntry,
  DataErrorKind,
  Pool,
  PoolActionAvailability,
  PoolDataErrors,
  PoolDataErrorSummary,
  StorageOverview,
  Task,
} from '@apexos/api-types';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { errorMessage, type TaskContext } from '../lib/tasks.ts';
import type { TnPool } from '../truenas/types.ts';
import { addNotice } from './notifications.ts';
import { lastCheckOutcome } from './pool-checks.ts';
import { findPool, getStorage, startScrub } from './storage.ts';

/** Repair refuses more damaged system files than this: that much damage needs a human. */
export const MAX_REPAIR_FILES = 20;

const CACHE_MS = 30_000;
const FAILED_CACHE_MS = 10_000;
const CATALOG_CACHE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Parsing and classification (pure)
// ---------------------------------------------------------------------------

/** Control characters, including C1 and Unicode line/paragraph separators. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const OBJECT_REF = /^<(0x[0-9a-f]+|metadata)>:<0x[0-9a-f]+>$/i;
/** `dataset:/path`, `dataset@snap:/path`, `dataset:<0x..>` (dataset names may contain ':' and '@'). */
const QUALIFIED = /^(.+?):(\/.*|<0x[0-9a-f]+>)$/i;

/** Absolute, already normalized, no empty/`.`/`..` segments, no control characters. */
export function isCleanAbsolutePath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4095 || CONTROL_CHARS.test(path)) return false;
  if (path.includes('//') || (path.length > 1 && path.endsWith('/'))) return false;
  if (path.slice(1).split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return posix.normalize(path) === path;
}

/** The catalog directory TrueNAS reports must itself look sane before anything is judged against it. */
export function isUsableCatalogDir(dir: unknown): dir is string {
  if (typeof dir !== 'string' || !isCleanAbsolutePath(dir)) return false;
  const parts = dir.split('/').filter(Boolean);
  return parts[0] === 'mnt' && parts.length >= 3;
}

/** True only for a clean absolute path strictly inside the catalog directory. */
export function isSafeCatalogPath(path: string, catalogDir: string): boolean {
  return isUsableCatalogDir(catalogDir) && isCleanAbsolutePath(path) && path.startsWith(`${catalogDir}/`) && path.length > catalogDir.length + 1;
}

/** Extracts the permanent-error entries from `zpool status -v <pool>`. Throws when the list can't be read. */
export function parseErrorList(output: string, poolName: string): string[] {
  const lines = output.replace(/\r/g, '').split('\n');
  const poolLine = lines.find((l) => /^\s*pool:\s/.test(l));
  if (!poolLine || poolLine.trim().slice('pool:'.length).trim() !== poolName) {
    throw new Error('the output of zpool status was not about this pool');
  }
  const at = lines.findIndex((l) => l.startsWith('errors:'));
  if (at < 0) throw new Error('zpool status did not include an errors section');
  const head = lines[at]!.slice('errors:'.length).trim();
  if (/^No known data errors/i.test(head)) return [];
  if (!/^Permanent errors have been detected/i.test(head)) throw new Error(head || 'the errors section was empty');
  const entries: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) {
      if (entries.length) break;
      continue;
    }
    if (!/^\s/.test(line)) break;
    entries.push(line.replace(/^[ \t]+/, ''));
  }
  if (!entries.length) throw new Error('ZFS reported damaged files but listed none');
  return entries;
}

export function classifyEntry(raw: string, catalogDir: string): DataErrorEntry {
  const entry = (kind: DataErrorKind, path: string | null, snapshot: string | null = null): DataErrorEntry => ({ raw, kind, path, snapshot });
  if (OBJECT_REF.test(raw)) return entry('unreadable', null);
  // Anything that merely looks like a catalog path but isn't clean counts as the user's: never deleted.
  if (raw.startsWith('/')) return entry(isSafeCatalogPath(raw, catalogDir) ? 'catalog' : 'user', raw);
  const qualified = QUALIFIED.exec(raw);
  if (qualified) {
    const [, dataset, rest] = qualified as unknown as [string, string, string];
    if (dataset.includes('@')) return entry('snapshot', rest.startsWith('/') ? rest : null, dataset);
    if (rest.startsWith('<')) return entry('unreadable', null);
  }
  // A file in an unmounted dataset, or a format ApexOs doesn't know: treat it as the user's.
  return entry('user', null);
}

export function summarize(entries: DataErrorEntry[], readError: string | null): PoolDataErrorSummary {
  const count = (...kinds: DataErrorKind[]) => entries.filter((e) => kinds.includes(e.kind)).length;
  const base = { userFiles: count('user', 'snapshot'), catalogFiles: count('catalog'), unreadable: count('unreadable'), readError };
  if (readError) return { ...base, state: 'data-errors', label: 'Data errors' };
  if (base.userFiles) {
    return { ...base, state: 'user-files', label: `${base.userFiles} ${base.userFiles === 1 ? "file can't" : "files can't"} be read` };
  }
  if (base.catalogFiles > MAX_REPAIR_FILES) return { ...base, state: 'data-errors', label: 'Data errors' };
  if (base.catalogFiles) return { ...base, state: 'quick-repair', label: 'Needs a quick repair' };
  if (base.unreadable) return { ...base, state: 'data-errors', label: 'Data errors' };
  return { ...base, state: 'none', label: null };
}

export function fingerprintOf(poolName: string, entries: string[]): string {
  return createHash('sha256')
    .update(`${poolName}\n${[...entries].sort().join('\n')}`)
    .digest('hex')
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Reading the list (cached briefly)
// ---------------------------------------------------------------------------

interface ErrorRead {
  entries: DataErrorEntry[];
  readError: string | null;
  fingerprint: string;
  checkedAt: string;
  catalogLocation: string | null;
}

interface CacheEntry {
  at: number;
  signature: string;
  value: Promise<ErrorRead>;
  failed?: boolean;
}

const cache = new Map<string, CacheEntry>();
let catalogCache: { at: number; dir: string } | null = null;
/** Pools with a repair in progress (by ZFS name). */
const repairing = new Set<string>();
/** Last data-error state a notice was raised for, per pool. */
const notified = new Map<string, string>();

const POOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,254}$/;

/** Pool names reach `zpool` as arguments; refuse anything that could be read as an option. */
function assertPoolName(name: string): void {
  if (!POOL_NAME_RE.test(name)) throw new UserError('This pool’s name can’t be used with the repair tools.', 400, 'INVALID_POOL_NAME');
}

/** Changes whenever the pool's damage picture may have changed (a check finished, counters moved). */
function poolSignature(pool: Pool): string {
  const s = pool.scan;
  return [pool.health, pool.zfsStatus, s?.kind, s?.state, s?.finishedAt, s?.errors, pool.errors.read, pool.errors.write, pool.errors.checksum].join('|');
}

async function catalogDir(ctx: AppContext): Promise<string> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_CACHE_MS) return catalogCache.dir;
  const config = await ctx.truenas.client().call<{ location?: unknown }>('catalog.config');
  if (!isUsableCatalogDir(config?.location)) {
    throw new Error('TrueNAS did not report a usable app catalog location, so system files can’t be told apart from yours');
  }
  catalogCache = { at: Date.now(), dir: config.location };
  return config.location;
}

async function readFromHost(ctx: AppContext, poolName: string): Promise<ErrorRead> {
  const checkedAt = new Date().toISOString();
  try {
    assertPoolName(poolName);
    const dir = await catalogDir(ctx);
    const output = await ctx.host.runChecked('zpool', ['status', '-v', poolName], { timeoutMs: 60_000 });
    const raw = parseErrorList(output, poolName);
    return { entries: raw.map((r) => classifyEntry(r, dir)), readError: null, fingerprint: fingerprintOf(poolName, raw), checkedAt, catalogLocation: dir };
  } catch (err) {
    // A failed read is never "no errors".
    return { entries: [], readError: errorMessage(err), fingerprint: '', checkedAt, catalogLocation: catalogCache?.dir ?? null };
  }
}

async function readErrors(ctx: AppContext, pool: Pool, opts: { fresh?: boolean } = {}): Promise<ErrorRead> {
  const signature = poolSignature(pool);
  const hit = cache.get(pool.name);
  const maxAge = hit?.failed ? FAILED_CACHE_MS : CACHE_MS;
  if (!opts.fresh && hit && hit.signature === signature && Date.now() - hit.at < maxAge) return hit.value;
  const entry: CacheEntry = { at: Date.now(), signature, value: readFromHost(ctx, pool.name) };
  cache.set(pool.name, entry);
  const value = await entry.value;
  entry.failed = Boolean(value.readError);
  await recordDetection(ctx, pool, value).catch(() => undefined);
  return value;
}

function invalidate(poolName: string): void {
  cache.delete(poolName);
}

/** For tests. */
export function forgetPoolErrorState(): void {
  cache.clear();
  catalogCache = null;
  repairing.clear();
  notified.clear();
}

/** Raises one notice per new damage state (shown in the notifications panel / Activity). */
async function recordDetection(ctx: AppContext, pool: Pool, read: ErrorRead): Promise<void> {
  if (read.readError || repairing.has(pool.name)) return;
  const summary = summarize(read.entries, null);
  // Entries for files that were already deleted are expected right after a fix; the panel shows them.
  if (summary.state === 'none' || (summary.state === 'data-errors' && !summary.catalogFiles)) {
    notified.delete(pool.name);
    return;
  }
  const key = `${summary.state}:${summary.userFiles}:${summary.catalogFiles}`;
  if (notified.get(pool.name) === key) return;
  const firstSinceStart = !notified.has(pool.name);
  notified.set(pool.name, key);
  const name = pool.displayName;
  const notice =
    summary.state === 'quick-repair'
      ? {
          level: 'warning' as const,
          title: `${name} needs a quick repair`,
          message: 'Some of TrueNAS’s own app catalog files are damaged. Your files are fine. Open Storage and choose Repair.',
        }
      : summary.state === 'user-files'
        ? {
            level: 'error' as const,
            title: `Some data on ${name} can’t be read`,
            message: `${summary.label}. Restore ${summary.userFiles === 1 ? 'it' : 'them'} from a backup made before the damage, or delete ${summary.userFiles === 1 ? 'it' : 'them'}, then run Check pool.${pool.layout.faultTolerance === 0 ? ' This pool keeps only one copy of your data, so there is nothing to repair from.' : ''}`,
          }
        : {
            level: 'error' as const,
            title: `${name} has data errors`,
            message: `More than ${MAX_REPAIR_FILES} system files are damaged. Get help before changing anything on this pool.`,
          };
  // After an ApexOs restart, don't repeat a notice the user hasn't dismissed yet.
  if (firstSinceStart && ctx.store.get().notices.some((n) => n.title === notice.title && !n.dismissed)) return;
  await addNotice(ctx, { ...notice, link: '/storage' });
}

// ---------------------------------------------------------------------------
// Availability of Repair and Reset error count
// ---------------------------------------------------------------------------

const allowed: PoolActionAvailability = { allowed: true, code: null, reason: null };
const refuse = (code: string, reason: string): PoolActionAvailability => ({ allowed: false, code, reason });

function scanBusy(pool: Pool): boolean {
  return pool.scan?.state === 'running' || pool.scan?.state === 'paused';
}

function repairAvailability(pool: Pool, read: ErrorRead, summary: PoolDataErrorSummary, opts: { self?: boolean } = {}): PoolActionAvailability {
  if (pool.health === 'offline') return refuse('POOL_UNAVAILABLE', 'The pool is unavailable. Reconnect its drives first.');
  if (read.readError) return refuse('LIST_UNREADABLE', `ApexOs couldn’t read the list of damaged files: ${read.readError}.`);
  if (summary.userFiles) {
    return refuse(
      'USER_FILES',
      'Some of your own files are damaged. ApexOs never deletes your files, so Repair becomes available once you have restored or deleted them and run Check pool.',
    );
  }
  if (!summary.catalogFiles) return refuse('NOTHING_TO_REPAIR', 'There are no damaged system files to repair.');
  if (summary.catalogFiles > MAX_REPAIR_FILES) {
    return refuse(
      'TOO_MANY_FILES',
      `${summary.catalogFiles} system files are damaged. Above ${MAX_REPAIR_FILES}, that points to a bigger problem, so ApexOs won’t repair it automatically. Get help before changing anything.`,
    );
  }
  if (!opts.self && repairing.has(pool.name)) return refuse('BUSY', 'A repair is already running on this pool.');
  if (scanBusy(pool)) return refuse('BUSY', 'Wait for the current check or rebuild to finish.');
  return allowed;
}

async function resetAvailability(ctx: AppContext, pool: Pool): Promise<{ availability: PoolActionAvailability; outcome: PoolDataErrors['lastCheck'] }> {
  const outcome = await lastCheckOutcome(ctx, pool);
  const result = (availability: PoolActionAvailability) => ({ availability, outcome });
  if (pool.health === 'offline') return result(refuse('POOL_UNAVAILABLE', 'The pool is unavailable. Reconnect its drives first.'));
  if (repairing.has(pool.name)) return result(refuse('BUSY', 'Wait for the repair to finish.'));
  const { read, write, checksum } = pool.errors;
  if (read + write + checksum === 0) return result(refuse('NOTHING_TO_RESET', 'The drives in this pool have no errors to reset.'));
  if (pool.drives.some((d) => d.missing || d.status !== 'ONLINE')) {
    return result(refuse('DRIVE_MISSING', 'A drive is missing or offline. Resetting the count would hide a real problem, so check the drives first.'));
  }
  if (scanBusy(pool) || outcome === 'running') return result(refuse('CHECK_RUNNING', 'Wait for the check to finish.'));
  switch (outcome) {
    case 'clean':
      return result(allowed);
    case 'errors':
      return result(refuse('CHECK_FOUND_ERRORS', 'The last check found problems. Deal with them first, then run Check pool again.'));
    case 'stale':
      return result(refuse('RESTARTED', 'TrueNAS restarted since the last check, so its result no longer counts. Run Check pool again.'));
    default:
      return result(
        refuse(
          'NO_CLEAN_CHECK',
          'Run Check pool first. The count can only be reset after a check started from ApexOs finishes without finding problems (checks from before ApexOs last restarted don’t count).',
        ),
      );
  }
}

/** Every data drive is present, ONLINE and has no read or write errors. */
function drivesLookHealthy(pool: Pool): boolean {
  return pool.drives.length > 0 && pool.drives.every((d) => !d.missing && d.status === 'ONLINE' && d.errors.read === 0 && d.errors.write === 0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getPoolDataErrors(ctx: AppContext, pool: Pool, opts: { fresh?: boolean } = {}): Promise<PoolDataErrors> {
  const read = await readErrors(ctx, pool, opts);
  const summary = summarize(read.entries, read.readError);
  const { availability: resetErrors, outcome } = await resetAvailability(ctx, pool);
  return {
    ...summary,
    poolId: pool.id,
    entries: read.entries,
    fingerprint: read.fingerprint,
    checkedAt: read.checkedAt,
    catalogLocation: read.catalogLocation,
    maxRepairFiles: MAX_REPAIR_FILES,
    singleCopy: pool.layout.faultTolerance === 0,
    drivesLookHealthy: drivesLookHealthy(pool),
    lastCheck: outcome,
    repair: repairAvailability(pool, read, summary),
    resetErrors,
  };
}

function suggestsDamage(pool: Pool, statusCode: string | null | undefined): boolean {
  return (
    statusCode === 'CORRUPT_DATA' ||
    pool.errors.checksum > 0 ||
    (pool.scan?.kind === 'scrub' && pool.scan.state === 'finished' && pool.scan.errors > 0)
  );
}

/** Adds `dataErrors` summaries to the pools that look damaged. Never throws. */
export async function withDataErrors(ctx: AppContext, overview: StorageOverview): Promise<StorageOverview> {
  try {
    const codes = await ctx.truenas
      .client()
      .call<Pick<TnPool, 'name' | 'status_code'>[]>('pool.query', [[], { select: ['name', 'status_code'] }])
      .catch(() => [] as Pick<TnPool, 'name' | 'status_code'>[]);
    for (const pool of overview.pools) {
      if (!suggestsDamage(pool, codes.find((c) => c.name === pool.name)?.status_code)) continue;
      const read = await readErrors(ctx, pool);
      pool.dataErrors = summarize(read.entries, read.readError);
    }
  } catch {
    // Pool cards still render without the summary.
  }
  return overview;
}

const STEP_READ = 'Re-reading the list of damaged files';
const STEP_DELETE = 'Removing the damaged app catalog files';
const STEP_CHECK = 'Checking the whole pool';
const STEP_CATALOG = 'Refreshing the app catalog';

/** Starts Repair: deletes only damaged app-catalog files, checks the pool, refreshes the catalog. */
export async function startRepair(ctx: AppContext, pool: Pool, fingerprint: string): Promise<Task> {
  assertPoolName(pool.name);
  const read = await readErrors(ctx, pool);
  const availability = repairAvailability(pool, read, summarize(read.entries, read.readError));
  if (!availability.allowed) throw new UserError(availability.reason!, 409, availability.code!);
  if (read.fingerprint !== fingerprint) {
    throw new UserError('The list of damaged files changed since you looked at it. Review the new list and try again.', 409, 'FINGERPRINT_CHANGED');
  }
  repairing.add(pool.name);
  return ctx.tasks.start(
    { type: 'pool-repair', title: `Repairing ${pool.displayName}`, ref: pool.displayName, steps: [STEP_READ, STEP_DELETE, STEP_CHECK, STEP_CATALOG] },
    async (t) => {
      try {
        await runRepair(ctx, t, pool, fingerprint);
      } finally {
        repairing.delete(pool.name);
        invalidate(pool.name);
        ctx.bus.changed('storage');
      }
    },
  );
}

/** Runs a task step; on failure the step and the task both say which step failed and why. */
function namedStep<T>(t: TaskContext, name: string, fn: (report: (percent: number, message?: string) => void) => Promise<T>): Promise<T> {
  return t.step(name, async (report) => {
    try {
      return await fn(report);
    } catch (err) {
      throw new Error(`${name} failed: ${errorMessage(err)}`);
    }
  });
}

async function runRepair(ctx: AppContext, t: TaskContext, pool: Pool, fingerprint: string): Promise<void> {
  const paths = await namedStep(t, STEP_READ, async () => {
    // Always straight from ZFS, immediately before deleting anything.
    const current = findPool(await getStorage(ctx), pool.id);
    if (current.name !== pool.name) throw new Error('The pool changed. Nothing was deleted.');
    const read = await readErrors(ctx, current, { fresh: true });
    if (read.readError) throw new Error(`ApexOs couldn’t read the list: ${read.readError}. Nothing was deleted.`);
    if (read.fingerprint !== fingerprint) {
      throw new Error('The list of damaged files changed since you clicked Repair. Nothing was deleted; review the new list and try again.');
    }
    const availability = repairAvailability(current, read, summarize(read.entries, null), { self: true });
    if (!availability.allowed) throw new Error(`${availability.reason} Nothing was deleted.`);
    const dir = read.catalogLocation;
    const catalog = read.entries.filter((e) => e.kind === 'catalog');
    // Validate every path before deleting any of them.
    const bad = catalog.find((e) => !dir || !e.path || !isSafeCatalogPath(e.path, dir));
    if (bad) throw new Error(`“${bad.raw}” is not safely inside the app catalog folder. Nothing was deleted.`);
    return catalog.map((e) => e.path!);
  });

  await namedStep(t, STEP_DELETE, async (report) => {
    report(10, `${paths.length} ${paths.length === 1 ? 'file' : 'files'}`);
    await ctx.host.runChecked('rm', ['-f', '--', ...paths]);
  });

  await namedStep(t, STEP_CHECK, async (report) => {
    const current = findPool(await getStorage(ctx), pool.id);
    const before = await scanStart(ctx, pool.id);
    await startScrub(ctx, current);
    const result = await waitForCheck(ctx, pool.id, before, report);
    if (result.state === 'canceled') throw new Error('The check was stopped before it finished. Run Check pool to finish the repair.');
    if (result.errors > 0) {
      invalidate(pool.name);
      const after = await getPoolDataErrors(ctx, findPool(await getStorage(ctx), pool.id), { fresh: true }).catch(() => null);
      const detail =
        after && !after.readError && after.userFiles
          ? ` ${after.userFiles} of them ${after.userFiles === 1 ? 'is one of your files' : 'are your files'}, which ApexOs never deletes.`
          : '';
      throw new Error(
        `The check found ${result.errors} more damaged ${result.errors === 1 ? 'file' : 'files'}.${detail} Open the pool’s damaged-file list to see what to do next.`,
      );
    }
  });

  await namedStep(t, STEP_CATALOG, async (report) => {
    await ctx.truenas.client().job('catalog.sync', [], (job) => report(job.progress.percent ?? 0, job.progress.description ?? undefined));
  });
}

async function scanStart(ctx: AppContext, poolId: number): Promise<number | null> {
  const [p] = await ctx.truenas.client().call<TnPool[]>('pool.query', [[['id', '=', poolId]]]);
  return p?.scan?.start_time?.$date ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the check started after `previousStart` to finish, following the pool's scan state (a long
 * check can take a day, so this polls instead of holding a job open). Independent of clock differences.
 */
async function waitForCheck(
  ctx: AppContext,
  poolId: number,
  previousStart: number | null,
  report: (percent: number, message?: string) => void,
): Promise<{ state: 'finished' | 'canceled'; errors: number }> {
  const startedWaiting = Date.now();
  let delay = 200;
  let failures = 0;
  for (;;) {
    await sleep(delay);
    delay = Math.min(delay * 2, 5_000);
    let p: TnPool | undefined;
    try {
      [p] = await ctx.truenas.client().call<TnPool[]>('pool.query', [[['id', '=', poolId]]]);
      failures = 0;
    } catch (err) {
      if (++failures >= 12) throw new Error(`Lost contact with TrueNAS while waiting for the check (${errorMessage(err)})`);
      continue;
    }
    if (!p) throw new Error('The pool disappeared during the check.');
    const scan = p.scan;
    const ours = scan?.function === 'SCRUB' && (scan.start_time?.$date ?? null) !== previousStart;
    if (!ours) {
      if (Date.now() - startedWaiting > 120_000) throw new Error('The check did not start.');
      continue;
    }
    if (scan.state === 'SCANNING') {
      report(scan.percentage ?? 0, scan.pause ? 'Paused' : undefined);
      continue;
    }
    if (scan.state === 'CANCELED') return { state: 'canceled', errors: scan.errors ?? 0 };
    return { state: 'finished', errors: scan.errors ?? 0 };
  }
}

/** Reset error count: clears the drives' error counters (`zpool clear`), nothing else. */
export async function resetErrorCounts(ctx: AppContext, pool: Pool): Promise<void> {
  assertPoolName(pool.name);
  const { availability } = await resetAvailability(ctx, pool);
  if (!availability.allowed) throw new UserError(availability.reason!, 409, availability.code!);
  await ctx.host.runChecked('zpool', ['clear', pool.name]);
  invalidate(pool.name);
  ctx.bus.changed('storage');
}
