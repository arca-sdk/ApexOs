/**
 * Backups between the user's own servers (HexOS "Buddy Backups", own-server variant).
 *
 * This server (A) pushes folders to another TrueNAS server (B) the user owns. There is no relay or
 * mesh: the servers must reach each other directly, on the same network or through the user's own VPN.
 *
 * - Adding a destination: ApexOs signs in to B's TrueNAS API once (admin password → ApexOs's own API
 *   key there, or an API key the user gives; passwords are never stored) and sets B up: a restricted
 *   receiving account `apexosbk_<A>` (SSH key only, no password, sudo limited to /usr/sbin/zfs), SSH
 *   turned on, and `<pool>/apexos-backups/<A>` with a quota and a reservation for the granted space.
 *   On A it creates an SSH key pair and SSH credentials pinned to B's host key.
 * - Backing up a folder: a periodic snapshot task (schedule, lifetime = retention) plus a PUSH
 *   replication task over SSH (sudo, properties on so encrypted folders are sent raw, target read-only,
 *   target retention mirrors A, pending snapshots held, never restarted from scratch automatically).
 *   TrueNAS runs these on its own, so scheduled backups keep working while ApexOs is down.
 * - Restoring: a one-off PULL (`replication.run_onetime`) into a new folder, then shared like any folder.
 * - Removal: tasks and keys here, the copies, account and datasets on B; when B is offline the B side is
 *   queued and finished when it comes back.
 *
 * Status and notices come from `replication.query` on A and a periodic look at B (space, reachability).
 */
import { randomUUID } from 'node:crypto';
import type {
  AddDestinationRequest,
  Backup,
  BackupDestination,
  BackupOptions,
  BackupSchedule,
  BackupsResponse,
  BackupState,
  BackupStatus,
  DestinationCheck,
  DestinationCredentials,
  NewBackupRequest,
  RestoreInfo,
  RestoreRequest,
  UpdateBackupRequest,
} from '@apexos/api-types';
import { TrueNasError, type TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { createPeerApiKey, hostOf, openPeer, peerBaseUrl, PeerUnreachableError, resolvePeerApi, withPeer } from '../lib/remote.ts';
import type { BackupDestinationRecord, BackupRecord, PendingCleanupRecord } from '../lib/store.ts';
import type { Task } from '../lib/tasks.ts';
import { errorMessage } from '../lib/tasks.ts';
import { foldernameFormat } from '../lib/validators.ts';
import { dateToIso, formatBytes, GiB, propNumber } from '../truenas/helpers.ts';
import type { TnDataset, TnDate, TnPool } from '../truenas/types.ts';
import { createFolder, getFolder, listFolders } from './folders.ts';
import { addNotice } from './notifications.ts';
import { isSupportedVersion } from './system.ts';

/** Dataset on B that holds the copies of every server backing up there. */
export const BACKUP_CONTAINER = 'apexos-backups';
/** Receiving accounts on B; hidden from ApexOs user lists (see services/users.ts). */
export const RECEIVER_PREFIX = 'apexosbk_';
const SOURCE_PROPERTY = 'apexos:backup-source';
const SOURCE_NAME_PROPERTY = 'apexos:backup-source-name';
const ZFS_SUDO = '/usr/sbin/zfs';
const DAY_MS = 86400_000;
const NEARLY_FULL = 0.9;
/** A destination has to stay unreachable this long before a notice is sent (short blips happen). */
export const UNREACHABLE_NOTICE_AFTER_MS = 15 * 60_000;
const PROBE_CACHE_MS = 30_000;
const MONITOR_INTERVAL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// TrueNAS shapes used here
// ---------------------------------------------------------------------------

interface TnReplication {
  id: number;
  name: string;
  enabled: boolean;
  speed_limit: number | null;
  state: {
    state: string;
    datetime?: TnDate;
    error?: string;
    reason?: string;
    last_snapshot?: string | null;
    progress?: { bytes_sent?: number; bytes_total?: number; snapshots_sent?: number; snapshots_total?: number } | null;
  };
  job: { id: number; state: string; progress?: { percent?: number | null } } | null;
}

interface TnSnapshotTask {
  id: number;
  dataset: string;
  enabled: boolean;
}

interface TnSnapshot {
  id: string;
  name: string;
  snapshot_name: string;
  dataset: string;
  properties?: { creation?: { parsed?: TnDate | null }; used?: { parsed?: number } };
}

interface TnSshConfig {
  tcpport: number;
  host_ed25519_key_pub: string | null;
  host_ecdsa_key_pub: string | null;
  host_rsa_key_pub: string | null;
}

interface EncDataset extends TnDataset {
  encryption_root: string | null;
  key_format?: { value: string | null };
  readonly?: { parsed: boolean };
  user_properties?: Record<string, { value: string } | string>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function slug(name: string, max: number): string {
  const s = name
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return s || 'server';
}

/** Name of the receiving account on B for this server, e.g. `apexosbk_myserver`. */
export function receiverUsername(serverName: string): string {
  return `${RECEIVER_PREFIX}${slug(serverName.toLowerCase(), 32 - RECEIVER_PREFIX.length).replace(/-+$/, '')}`;
}

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function short(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

function notFound(what = 'Backup'): UserError {
  return new UserError(`${what} not found`, 404, 'NOT_FOUND');
}

function destinationOf(ctx: AppContext, id: string): BackupDestinationRecord {
  const d = ctx.store.get().backups.destinations.find((x) => x.id === id);
  if (!d) throw notFound('Backup destination');
  return d;
}

function backupOf(ctx: AppContext, id: string): BackupRecord {
  const b = ctx.store.get().backups.jobs.find((x) => x.id === id);
  if (!b) throw notFound();
  return b;
}

function peerTarget(d: Pick<BackupDestinationRecord, 'apiUrl' | 'apiKey' | 'name'>): { apiUrl: string; apiKey: string; name: string } {
  return { apiUrl: d.apiUrl, apiKey: d.apiKey, name: d.name };
}

async function thisServer(ctx: AppContext): Promise<{ name: string; bootId: string | null; timezone: string }> {
  const client = ctx.truenas.client();
  const [info, bootId] = await Promise.all([
    client.call<{ hostname: string; timezone: string }>('system.info'),
    client.call<string>('system.boot_id').catch(() => null),
  ]);
  return { name: ctx.store.get().server.name || info.hostname, bootId, timezone: info.timezone || 'UTC' };
}

/** Decodes an `ssh.config` host key (base64 of an OpenSSH .pub file) into `<type> <base64>`. */
function hostKeyLine(b64: string | null): string | null {
  if (!b64) return null;
  const text = Buffer.from(b64, 'base64').toString('utf8').trim();
  const [type, key] = text.split(/\s+/);
  return type && key ? `${type} ${key}` : null;
}

function keyIds(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2)
    .map((p) => `${p[0]} ${p[1]}`);
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateOptions(o: BackupOptions): void {
  if (!TIME_RE.test(o.schedule.time)) throw new UserError('Pick a time like 02:30.', 400, 'VALIDATION', { time: 'Use HH:MM' });
  if (!['hourly', 'daily', 'weekly'].includes(o.schedule.frequency)) throw new UserError('Pick how often to back up.', 400, 'VALIDATION', { frequency: 'Invalid' });
  if (!Number.isInteger(o.schedule.weekday) || o.schedule.weekday < 0 || o.schedule.weekday > 6) throw new UserError('Pick a day of the week.', 400, 'VALIDATION', { weekday: 'Invalid' });
  if (!Number.isInteger(o.keepDays) || o.keepDays < 1 || o.keepDays > 365) {
    throw new UserError('Keep restore points for 1 to 365 days.', 400, 'VALIDATION', { keepDays: 'Use 1 to 365 days' });
  }
  if (o.schedule.frequency === 'weekly' && o.keepDays < 7) {
    throw new UserError('Weekly backups need restore points kept for at least 7 days, or there would be nothing to restore between backups.', 400, 'VALIDATION', {
      keepDays: 'At least 7 days for weekly backups',
    });
  }
  if (o.speedLimitMbps !== null && (!Number.isFinite(o.speedLimitMbps) || o.speedLimitMbps < 1 || o.speedLimitMbps > 100_000)) {
    throw new UserError('Use a speed limit between 1 and 100000 Mbit/s, or none.', 400, 'VALIDATION', { speedLimitMbps: 'Invalid' });
  }
}

/** TrueNAS cron schedule (in the server's time zone); Sunday is 7, as in the TrueNAS examples. */
export function toCron(s: BackupSchedule): { minute: string; hour: string; dom: string; month: string; dow: string } {
  const [h, m] = s.time.split(':').map(Number) as [number, number];
  return {
    minute: String(m),
    hour: s.frequency === 'hourly' ? '*' : String(h),
    dom: '*',
    month: '*',
    dow: s.frequency === 'weekly' ? String(s.weekday === 0 ? 7 : s.weekday) : '*',
  };
}

function speedLimitBytes(mbps: number | null): number | null {
  return mbps === null ? null : Math.round(mbps * 125_000);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(ms: number, timeZone: string): { hour: number; minute: number; weekday: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    }
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: WEEKDAYS.indexOf(String(p.weekday)) };
}

/** Next time the schedule fires, evaluated in the TrueNAS server's time zone. */
export function nextRunAt(s: BackupSchedule, timeZone: string, now = Date.now()): string | null {
  const [h, m] = s.time.split(':').map(Number) as [number, number];
  let t = Math.floor(now / 60_000) * 60_000 + 60_000;
  const limit = now + 8 * DAY_MS + 3600_000;
  while (t < limit) {
    const w = wallClock(t, timeZone);
    if (w.minute !== m) {
      // Jump to the next minute that has the wanted wall-clock minute (time zones are whole quarter hours).
      t += (((m - w.minute + 60) % 60) || 60) * 60_000;
      continue;
    }
    if (s.frequency === 'hourly' || (w.hour === h && (s.frequency === 'daily' || w.weekday === s.weekday))) return new Date(t).toISOString();
    t += 3600_000;
  }
  return null;
}

function intervalMs(s: BackupSchedule): number {
  return s.frequency === 'hourly' ? 3600_000 : s.frequency === 'daily' ? DAY_MS : 7 * DAY_MS;
}

/** A backup is overdue when nothing succeeded for one schedule interval plus a day (at least 2 days). */
export function overdueAfterMs(s: BackupSchedule): number {
  return Math.max(2 * DAY_MS, intervalMs(s) + DAY_MS);
}

// ---------------------------------------------------------------------------
// Errors in plain language
// ---------------------------------------------------------------------------

export interface ExplainedError {
  message: string;
  /** The copy can't be continued: it has to be replaced ("Start a fresh copy"). */
  freshCopy: boolean;
  unreachable: boolean;
  space: boolean;
}

/** Turns zettarepl/ZFS/SSH errors into plain language with a next step. */
export function explainError(raw: string, dest: string): ExplainedError {
  const r = raw.toLowerCase();
  const out = (message: string, extra: Partial<ExplainedError> = {}): ExplainedError => ({ message, freshCopy: false, unreachable: false, space: false, ...extra });
  if (/connection refused|unable to connect|timed out|no route to host|network is unreachable|connection reset|could not resolve|name or service not known|couldn’t reach/.test(r)) {
    return out(`Couldn’t reach ${dest}. Check that it’s turned on and that both servers are on the same network or VPN. It will be tried again at the next scheduled time.`, {
      unreachable: true,
    });
  }
  if (/quota exceeded|out of space|no space left|disk quota/.test(r)) {
    return out(`There isn’t enough room on ${dest}. Set aside more space there, or keep restore points for fewer days.`, { space: true });
  }
  if (/host key/.test(r)) return out(`${dest} doesn’t look like the same server any more (its SSH identity changed). If it was reinstalled, remove it as a destination and add it again.`);
  if (/authentication failed|permission denied \(publickey/.test(r)) return out(`${dest} no longer accepts this server’s key. Remove it as a destination and add it again.`);
  if (/passwordless `sudo`|sudo/.test(r)) return out(`The backup account on ${dest} lost its permission to store copies. Remove it as a destination and add it again.`);
  if (/currently not available/.test(r)) return out(`The backup account on ${dest} can’t sign in any more (its shell was changed). Remove it as a destination and add it again.`);
  if (/must be encrypted \(as one of its ancestors is encrypted\)/.test(r)) {
    return out(`The backup area on ${dest} is encrypted, so this unencrypted folder can’t be stored there. Encrypt the folder first, or back it up to a pool that isn’t encrypted.`);
  }
  if (/unable to send encrypted dataset|unrelated dataset|no incremental base|does not have snapshots but has data|refusing to overwrite/.test(r)) {
    return out(
      `The copy on ${dest} no longer matches this folder, for example because the folder was encrypted after its backup started. Start a fresh copy to replace it.`,
      { freshCopy: true },
    );
  }
  if (/dataset '.*' does not exist|dataset .* does not exist/.test(r)) return out('This folder no longer exists on this server. You can restore it from the copy, or remove this backup.');
  return out(`The last backup failed: ${raw.replace(/^\[E[A-Z]+\]\s*/, '')}`);
}

// ---------------------------------------------------------------------------
// Looking at a destination (cached)
// ---------------------------------------------------------------------------

interface DestinationProbe {
  at: number;
  reachable: boolean;
  error: string | null;
  usedBytes: number | null;
  quotaBytes: number | null;
  encrypted: boolean;
  copies: Map<string, { usedBytes: number; restorePoints: number; encrypted: boolean }>;
}

const probes = new Map<string, DestinationProbe>();

/** Forgets cached looks at destinations (for tests and after changes). */
export function forgetProbes(): void {
  probes.clear();
}

async function probe(ctx: AppContext, d: BackupDestinationRecord, opts: { fresh?: boolean } = {}): Promise<DestinationProbe> {
  const cached = probes.get(d.id);
  // Failures are cached briefly so a server that just came back shows up quickly.
  if (cached && !opts.fresh && Date.now() - cached.at < (cached.reachable ? PROBE_CACHE_MS : PROBE_CACHE_MS / 3)) return cached;
  const result: DestinationProbe = { at: Date.now(), reachable: false, error: null, usedBytes: null, quotaBytes: null, encrypted: d.encryptedOnly, copies: new Map() };
  try {
    await withPeer(
      peerTarget(d),
      async (b) => {
        const [datasets, snapshots] = await Promise.all([
          b.call<EncDataset[]>('pool.dataset.query', [
            [['OR', [['id', '=', d.rootDataset], ['id', '^', `${d.rootDataset}/`]]]],
            { extra: { retrieve_children: false, properties: ['used', 'available', 'quota', 'encryption', 'keystatus'] } },
          ]),
          b.call<TnSnapshot[]>('pool.snapshot.query', [[['dataset', '^', `${d.rootDataset}/`]], { select: ['id', 'dataset', 'snapshot_name'] }]),
        ]);
        const root = datasets.find((x) => x.id === d.rootDataset);
        result.reachable = true;
        if (!root) {
          result.error = `The backup area on ${d.name} is missing (${d.rootDataset}).`;
          return;
        }
        result.usedBytes = propNumber(root.used);
        result.quotaBytes = propNumber(root.quota) || null;
        result.encrypted = root.encrypted;
        for (const ds of datasets) {
          if (ds.id === d.rootDataset) continue;
          result.copies.set(ds.id, { usedBytes: propNumber(ds.used), restorePoints: snapshots.filter((s) => s.dataset === ds.id).length, encrypted: ds.encrypted });
        }
      },
      { timeoutMs: 8_000 },
    );
  } catch (err) {
    result.reachable = false;
    result.error = err instanceof PeerUnreachableError ? err.message : `Couldn’t check ${d.name}: ${errorMessage(err)}`;
  }
  probes.set(d.id, result);
  return result;
}

function destinationHealth(d: BackupDestinationRecord, p: DestinationProbe): { health: BackupDestination['health']; problem: string | null } {
  if (!p.reachable) return { health: 'unreachable', problem: p.error };
  if (p.error) return { health: 'unreachable', problem: p.error };
  const quota = p.quotaBytes ?? d.grantedBytes;
  const used = p.usedBytes ?? 0;
  if (quota > 0 && used >= quota * 0.99) {
    return { health: 'full', problem: `The space set aside on ${d.name} is full (${formatBytes(used)} of ${formatBytes(quota)}). Set aside more space or keep fewer days.` };
  }
  if (quota > 0 && used >= quota * NEARLY_FULL) {
    return { health: 'nearly-full', problem: `The space set aside on ${d.name} is almost full (${formatBytes(used)} of ${formatBytes(quota)}).` };
  }
  return { health: 'online', problem: null };
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

function authOf(c: DestinationCredentials) {
  return c.method === 'password' ? ({ type: 'password', username: c.username, password: c.password } as const) : ({ type: 'apiKey', apiKey: c.apiKey } as const);
}

async function assertNotThisServer(ctx: AppContext, b: TrueNasClient, name: string): Promise<void> {
  const [mine, theirs] = await Promise.all([
    ctx.truenas.client().call<string>('system.boot_id').catch(() => null),
    b.call<string>('system.boot_id').catch(() => null),
  ]);
  if (mine && theirs && mine === theirs) {
    throw new UserError(`${name} is this server. Pick another server you own to keep the copies.`, 400, 'SAME_SERVER', { address: 'This is this server' });
  }
}

function assertNewAddress(ctx: AppContext, baseUrl: string): void {
  const existing = ctx.store.get().backups.destinations.find((d) => d.address === baseUrl);
  if (existing) throw new UserError(`${existing.name} is already a backup destination.`, 409, 'ALREADY_ADDED', { address: 'Already added' });
}

/** Signs in to the other server once to show its name and pools (nothing is created). */
export async function checkDestination(ctx: AppContext, creds: DestinationCredentials): Promise<DestinationCheck> {
  const baseUrl = peerBaseUrl(creds.address);
  assertNewAddress(ctx, baseUrl);
  const apiUrl = await resolvePeerApi(baseUrl);
  const b = await openPeer(apiUrl, authOf(creds), { name: hostOf(baseUrl) });
  try {
    const info = await b.call<{ hostname: string; version: string }>('system.info');
    await assertNotThisServer(ctx, b, info.hostname);
    const [pools, roots, ssh] = await Promise.all([
      b.call<TnPool[]>('pool.query'),
      b.call<EncDataset[]>('pool.dataset.query', [[['pool', '!=', 'boot-pool']], { extra: { retrieve_children: false, properties: ['used', 'available', 'encryption', 'keystatus'] } }]),
      b.call<{ enable: boolean; state: string }[]>('service.query', [[['service', '=', 'ssh']]]).catch(() => []),
    ]);
    const { folders } = await listFolders(ctx);
    return {
      name: info.hostname,
      version: info.version.replace(/^TrueNAS-/i, ''),
      address: baseUrl,
      sshEnabled: ssh[0]?.enable === true,
      foldersBytes: folders.reduce((a, f) => a + f.usedBytes, 0),
      pools: pools.map((p) => {
        const root = roots.find((r) => r.id === p.name);
        const free = root ? propNumber(root.available) : 0;
        const status = p.status ?? 'ONLINE';
        let note: string | null = null;
        let usable = true;
        if (!root || root.locked) {
          usable = false;
          note = 'This pool is locked.';
        } else if (status !== 'ONLINE') {
          usable = false;
          note = `This pool isn’t healthy (${status.toLowerCase()}).`;
        } else if (free < 2 * GiB) {
          usable = false;
          note = 'This pool is full.';
        } else if (root.encrypted) note = 'This pool is encrypted: only encrypted folders can be backed up here.';
        return { name: p.name, sizeBytes: p.size ?? 0, freeBytes: free, encrypted: !!root?.encrypted, usable, note };
      }),
    };
  } finally {
    await b.close().catch(() => undefined);
  }
}

export function validateAddRequest(ctx: AppContext, req: AddDestinationRequest): string {
  const baseUrl = peerBaseUrl(req.address);
  assertNewAddress(ctx, baseUrl);
  if (!Number.isFinite(req.spaceBytes) || req.spaceBytes < GiB) {
    throw new UserError('Set aside at least 1 GB on the other server.', 400, 'VALIDATION', { spaceBytes: 'At least 1 GB' });
  }
  return baseUrl;
}

type Step = <T>(name: string, fn: (report: (percent: number, message?: string) => void) => Promise<T>) => Promise<T>;

/** Sets up the other server and this one; undoes what it created if a step fails. */
export async function addDestination(ctx: AppContext, req: AddDestinationRequest, step: Step): Promise<BackupDestinationRecord> {
  const baseUrl = validateAddRequest(ctx, req);
  const a = ctx.truenas.client();
  const me = await thisServer(ctx);
  const serverId = ctx.store.get().backups.serverId;
  const undo: Array<() => Promise<unknown>> = [];
  const id = randomUUID();
  let b: TrueNasClient | undefined;
  try {
    const conn = await step('Connecting to the other server', async () => {
      const apiUrl = await resolvePeerApi(baseUrl);
      const name = hostOf(baseUrl);
      let apiKey: string;
      let apiKeyId: number | null = null;
      if (req.method === 'password') {
        const created = await createPeerApiKey(apiUrl, req.username, req.password, name);
        apiKey = created.key;
        apiKeyId = created.id;
      } else apiKey = req.apiKey;
      b = await openPeer(apiUrl, { type: 'apiKey', apiKey }, { name });
      const client = b;
      if (apiKeyId !== null) undo.push(() => client.call('api_key.delete', [apiKeyId]));
      const info = await client.call<{ hostname: string; version: string }>('system.info');
      await assertNotThisServer(ctx, client, info.hostname);
      if (!isSupportedVersion(info.version)) {
        throw new UserError(`${info.hostname} runs TrueNAS ${info.version}. Backups need TrueNAS SCALE 25.10 or newer on both servers.`, 400, 'UNSUPPORTED_VERSION');
      }
      const [pool] = await client.call<TnPool[]>('pool.query', [[['name', '=', req.pool]]]);
      if (!pool) throw new UserError(`${info.hostname} has no pool called ${req.pool}.`, 400, 'VALIDATION', { pool: 'Unknown pool' });
      if (pool.status && pool.status !== 'ONLINE') {
        throw new UserError(`The pool ${req.pool} on ${info.hostname} isn’t healthy. Pick another pool or fix it first.`, 400, 'POOL_UNHEALTHY');
      }
      return { apiUrl, apiKey, apiKeyId, name: info.hostname };
    });
    const client = b!;
    const aName = slug(me.name, 40);
    const container = `${req.pool}/${BACKUP_CONTAINER}`;
    const rootDataset = `${container}/${aName}`;
    const username = receiverUsername(me.name);

    const storage = await step(`Setting aside space on ${conn.name}`, async () => {
      const [poolRoot] = await client.call<EncDataset[]>('pool.dataset.query', [[['id', '=', req.pool]], { extra: { retrieve_children: false, properties: ['available', 'encryption', 'keystatus'] } }]);
      if (!poolRoot || poolRoot.locked) throw new UserError(`The pool ${req.pool} on ${conn.name} is locked.`, 400, 'POOL_LOCKED');
      const existing = await client.call<EncDataset[]>('pool.dataset.query', [
        [['id', 'in', [container, rootDataset]]],
        { extra: { retrieve_children: false, retrieve_user_props: true, properties: ['used', 'available', 'encryption', 'keystatus'] } },
      ]);
      const existingRoot = existing.find((x) => x.id === rootDataset);
      if (existingRoot) {
        const source = existingRoot.user_properties?.[SOURCE_PROPERTY];
        const sourceId = typeof source === 'string' ? source : source?.value;
        if (sourceId !== serverId) {
          throw new UserError(`${conn.name} already keeps backups from another server called ${me.name}. Rename this server, or remove those backups on ${conn.name} first.`, 409, 'NAME_TAKEN');
        }
      }
      const free = propNumber(poolRoot.available) + (existingRoot ? propNumber(existingRoot.used) : 0);
      if (req.spaceBytes > free) {
        throw new UserError(`The pool ${req.pool} on ${conn.name} has only ${formatBytes(free)} free. Set aside less space or pick another pool.`, 400, 'NOT_ENOUGH_SPACE', {
          spaceBytes: `At most ${formatBytes(free)}`,
        });
      }
      const containerCreated = !existing.some((x) => x.id === container);
      if (containerCreated) {
        await client.call('pool.dataset.create', [{ name: container, type: 'FILESYSTEM', share_type: 'GENERIC', comments: 'Backups kept for other servers (ApexOs)' }]);
        undo.push(() => client.call('pool.dataset.delete', [container, { recursive: false }]));
      }
      await excludeFromSnapshotTasks(client, container);
      if (existingRoot) {
        await client.call('pool.dataset.update', [rootDataset, { quota: req.spaceBytes, reservation: req.spaceBytes }]);
      } else {
        await client.call('pool.dataset.create', [
          {
            name: rootDataset,
            type: 'FILESYSTEM',
            share_type: 'GENERIC',
            quota: req.spaceBytes,
            reservation: req.spaceBytes,
            comments: `Backups from ${me.name} (ApexOs)`,
            user_properties: [
              { key: SOURCE_PROPERTY, value: serverId },
              { key: SOURCE_NAME_PROPERTY, value: me.name },
            ],
          },
        ]);
        undo.push(() => client.call('pool.dataset.delete', [rootDataset, { recursive: true }]));
      }
      const [root] = await client.call<EncDataset[]>('pool.dataset.query', [[['id', '=', rootDataset]], { extra: { retrieve_children: false, properties: ['encryption', 'keystatus', 'mountpoint'] } }]);
      return { container, containerCreated, encryptedOnly: !!root?.encrypted, home: root?.mountpoint ?? `/mnt/${rootDataset}` };
    });

    const keys = await step('Creating a key for this server', async () => {
      const pair = await a.call<{ private_key: string; public_key: string }>('keychaincredential.generate_ssh_key_pair');
      const kp = await a.call<{ id: number; attributes: { public_key: string } }>('keychaincredential.create', [
        { name: `apexos-backup-${slug(conn.name, 30)}-${short(id)}-key`, type: 'SSH_KEY_PAIR', attributes: { private_key: pair.private_key } },
      ]);
      undo.push(() => a.call('keychaincredential.delete', [kp.id, { cascade: true }]));
      return { keypairId: kp.id, publicKey: (kp.attributes.public_key || pair.public_key).trim() };
    });

    await step(`Creating the backup account on ${conn.name}`, async () => {
      const [user] = await client.call<{ id: number }[]>('user.query', [[['username', '=', username]]]);
      const account = {
        full_name: `ApexOs backups from ${me.name}`,
        password_disabled: true,
        smb: false,
        shell: '/usr/bin/bash',
        sshpubkey: `${keys.publicKey.split(/\s+/).slice(0, 2).join(' ')} apexos-${slug(me.name, 40)}`,
        sudo_commands: [],
        sudo_commands_nopasswd: [ZFS_SUDO],
      };
      if (user) {
        await client.call('user.update', [user.id, account]);
        return;
      }
      const [group] = await client.call<{ id: number; users: number[] }[]>('group.query', [[['name', '=', username]]]);
      const created = await client.call<{ id: number }>('user.create', [
        {
          username,
          ...account,
          ...(group && !group.users.length ? { group: group.id } : { group_create: true }),
          home: storage.home,
          home_create: true,
          home_mode: '700',
        },
      ]);
      undo.push(() => client.call('user.delete', [created.id, { delete_group: true }]));
    });

    const ssh = await step(`Turning on SSH on ${conn.name}`, async () => {
      const config = await client.call<TnSshConfig>('ssh.config');
      const [svc] = await client.call<{ enable: boolean; state: string }[]>('service.query', [[['service', '=', 'ssh']]]);
      let enabledByUs = false;
      if (svc && !svc.enable) {
        await client.call('service.update', ['ssh', { enable: true }]);
        enabledByUs = true;
        undo.push(() => client.call('service.update', ['ssh', { enable: false }]));
      }
      if (!svc || svc.state !== 'RUNNING') {
        await client.job('service.control', ['START', 'ssh', { silent: false }]);
        if (enabledByUs) undo.push(() => client.job('service.control', ['STOP', 'ssh', {}]));
      }
      const offered = [config.host_ed25519_key_pub, config.host_ecdsa_key_pub, config.host_rsa_key_pub].map(hostKeyLine).filter((k): k is string => !!k);
      return { port: config.tcpport, hostKeys: offered, enabledByUs };
    });

    const credentialId = await step('Connecting the two servers securely', async () => {
      const sshHost = hostOf(baseUrl);
      let scanned: string;
      try {
        scanned = await a.call<string>('keychaincredential.remote_ssh_host_key_scan', [{ host: sshHost, port: ssh.port, connect_timeout: 10 }]);
      } catch (err) {
        throw new PeerUnreachableError(
          `This server can’t reach ${conn.name} over SSH (${sshHost}, port ${ssh.port}). Both servers must be on the same network or connected through your own VPN, such as Tailscale. (${errorMessage(err)})`,
        );
      }
      // The key this server sees must be the one the other server reports, or something is in between.
      const matching = keyIds(scanned).filter((k) => ssh.hostKeys.includes(k));
      if (ssh.hostKeys.length && !matching.length) {
        throw new UserError(`The server answering at ${sshHost}:${ssh.port} isn’t ${conn.name} (its SSH identity doesn’t match). Check the address.`, 400, 'HOST_KEY_MISMATCH');
      }
      const cred = await a.call<{ id: number }>('keychaincredential.create', [
        {
          name: `apexos-backup-${slug(conn.name, 30)}-${short(id)}`,
          type: 'SSH_CREDENTIALS',
          attributes: {
            host: sshHost,
            port: ssh.port,
            username,
            private_key: keys.keypairId,
            remote_host_key: (matching.length ? matching : keyIds(scanned)).join('\n'),
            connect_timeout: 10,
          },
        },
      ]);
      return cred.id;
    });

    const record: BackupDestinationRecord = {
      id,
      name: conn.name,
      address: baseUrl,
      apiUrl: conn.apiUrl,
      apiKey: conn.apiKey,
      apiKeyId: conn.apiKeyId,
      pool: req.pool,
      container: storage.container,
      containerCreated: storage.containerCreated,
      rootDataset,
      username,
      sshHost: hostOf(baseUrl),
      sshPort: ssh.port,
      sshEnabledByApexOs: ssh.enabledByUs,
      keypairId: keys.keypairId,
      credentialId,
      grantedBytes: req.spaceBytes,
      encryptedOnly: storage.encryptedOnly,
      createdAt: new Date().toISOString(),
      alert: 'ok',
      unreachableSince: null,
    };
    await ctx.store.update((s) => {
      s.backups.destinations.push(record);
    });
    probes.delete(id);
    ctx.bus.changed('backups');
    return record;
  } catch (err) {
    for (const fn of undo.reverse()) await fn().catch(() => undefined);
    throw err;
  } finally {
    await (b as TrueNasClient | undefined)?.close().catch(() => undefined);
  }
}

/** Keeps the other server's own recursive snapshot tasks away from the copies (extra snapshots break them). */
async function excludeFromSnapshotTasks(b: TrueNasClient, container: string): Promise<void> {
  const tasks = await b.call<{ id: number; dataset: string; recursive: boolean; exclude: string[] }[]>('pool.snapshottask.query').catch(() => []);
  for (const t of tasks) {
    if (!t.recursive || !container.startsWith(`${t.dataset}/`) || t.exclude.includes(container)) continue;
    await b.call('pool.snapshottask.update', [t.id, { exclude: [...t.exclude, container] }]).catch(() => undefined);
  }
}

export async function updateDestinationSpace(ctx: AppContext, id: string, spaceBytes: number): Promise<void> {
  const d = destinationOf(ctx, id);
  if (!Number.isFinite(spaceBytes) || spaceBytes < GiB) throw new UserError('Set aside at least 1 GB.', 400, 'VALIDATION', { spaceBytes: 'At least 1 GB' });
  await withPeer(peerTarget(d), async (b) => {
    const [root] = await b.call<EncDataset[]>('pool.dataset.query', [[['id', '=', d.rootDataset]], { extra: { retrieve_children: false, properties: ['used', 'available', 'quota'] } }]);
    const [poolRoot] = await b.call<EncDataset[]>('pool.dataset.query', [[['id', '=', d.pool]], { extra: { retrieve_children: false, properties: ['available'] } }]);
    if (!root || !poolRoot) throw new UserError(`The backup area on ${d.name} is missing.`, 409, 'MISSING');
    const used = propNumber(root.used);
    if (spaceBytes < used) {
      throw new UserError(`The copies already use ${formatBytes(used)} on ${d.name}. Set aside at least that much.`, 400, 'VALIDATION', { spaceBytes: `At least ${formatBytes(used)}` });
    }
    const max = propNumber(poolRoot.available) + Math.max(propNumber(root.quota), d.grantedBytes);
    if (spaceBytes > max) {
      throw new UserError(`${d.name} doesn’t have that much free space (at most ${formatBytes(max)}).`, 400, 'NOT_ENOUGH_SPACE', { spaceBytes: `At most ${formatBytes(max)}` });
    }
    await b.call('pool.dataset.update', [d.rootDataset, { quota: spaceBytes, reservation: spaceBytes }]);
  });
  await ctx.store.update((s) => {
    const rec = s.backups.destinations.find((x) => x.id === id);
    if (rec) rec.grantedBytes = spaceBytes;
  });
  probes.delete(id);
  ctx.bus.changed('backups');
}

/** Removes everything ApexOs set up on the other server for this one. */
async function cleanUpDestinationOnPeer(b: TrueNasClient, c: Pick<PendingCleanupRecord, 'dataset' | 'username' | 'container' | 'containerCreated' | 'sshEnabledByApexOs' | 'apiKeyId'>): Promise<void> {
  await deleteDataset(b, c.dataset);
  if (c.username) {
    const [user] = await b.call<{ id: number }[]>('user.query', [[['username', '=', c.username]]]);
    if (user) await b.call('user.delete', [user.id, { delete_group: true }]);
  }
  if (c.container && c.containerCreated) {
    const children = await b.call<{ id: string }[]>('pool.dataset.query', [[['id', '^', `${c.container}/`]], { extra: { retrieve_children: false, properties: [] } }]);
    if (!children.length) await deleteDataset(b, c.container);
  }
  if (c.sshEnabledByApexOs) {
    // Only switch SSH off again if nobody else signs in with it now.
    const users = await b.call<{ username: string; builtin: boolean; sshpubkey: string | null; ssh_password_enabled: boolean }[]>('user.query', [[['builtin', '=', false]]]);
    const others = users.filter((u) => u.sshpubkey || u.ssh_password_enabled);
    if (!others.length) {
      await b.call('service.update', ['ssh', { enable: false }]);
      await b.job('service.control', ['STOP', 'ssh', {}]).catch(() => undefined);
    }
  }
  if (c.apiKeyId !== null && c.apiKeyId !== undefined) await b.call('api_key.delete', [c.apiKeyId]).catch(() => undefined);
}

async function deleteDataset(b: TrueNasClient, dataset: string): Promise<void> {
  try {
    await b.call('pool.dataset.delete', [dataset, { recursive: true, force: true }]);
  } catch (err) {
    if (err instanceof TrueNasError && (err.errname === 'ENOENT' || /does not exist/.test(err.reason ?? err.message))) return;
    throw err;
  }
}

function queueCleanup(ctx: AppContext, c: Omit<PendingCleanupRecord, 'id' | 'since' | 'attempts' | 'lastError'>, error: string): Promise<void> {
  return ctx.store.update((s) => {
    s.backups.cleanups.push({ ...c, id: randomUUID(), since: new Date().toISOString(), attempts: 1, lastError: error });
  });
}

export async function removeDestination(ctx: AppContext, id: string, step: Step): Promise<void> {
  const d = destinationOf(ctx, id);
  const a = ctx.truenas.client();
  const jobs = ctx.store.get().backups.jobs.filter((j) => j.destinationId === id);
  await step('Removing the backup tasks on this server', async () => {
    for (const j of jobs) await removeLocalTasks(ctx, j);
  });
  await step(`Removing the copies and the backup account on ${d.name}`, async (report) => {
    const cleanup = {
      kind: 'destination' as const,
      destinationName: d.name,
      apiUrl: d.apiUrl,
      apiKey: d.apiKey,
      apiKeyId: d.apiKeyId,
      dataset: d.rootDataset,
      username: d.username,
      container: d.container,
      containerCreated: d.containerCreated,
      sshEnabledByApexOs: d.sshEnabledByApexOs,
    };
    try {
      await withPeer(peerTarget(d), (b) => cleanUpDestinationOnPeer(b, cleanup), { timeoutMs: 10_000 });
    } catch (err) {
      if (!(err instanceof PeerUnreachableError)) throw err;
      await queueCleanup(ctx, cleanup, err.message);
      report(100, `${d.name} is offline. ApexOs will finish removing the copies when it’s back.`);
    }
  });
  await step('Removing the keys on this server', async () => {
    await a.call('keychaincredential.delete', [d.credentialId, { cascade: true }]).catch(ignoreMissing);
    await a.call('keychaincredential.delete', [d.keypairId, { cascade: true }]).catch(ignoreMissing);
  });
  await ctx.store.update((s) => {
    s.backups.destinations = s.backups.destinations.filter((x) => x.id !== id);
    s.backups.jobs = s.backups.jobs.filter((j) => j.destinationId !== id);
  });
  probes.delete(id);
  ctx.bus.changed('backups');
}

function ignoreMissing(err: unknown): void {
  if (err instanceof TrueNasError && (err.errname === 'ENOENT' || /does not exist|not found/i.test(err.reason ?? err.message))) return;
  throw err;
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

interface FolderInfo {
  name: string;
  dataset: string;
  usedBytes: number;
  encrypted: boolean;
}

async function folderDatasets(ctx: AppContext): Promise<Map<string, EncDataset>> {
  const list = await ctx.truenas
    .client()
    .call<EncDataset[]>('pool.dataset.query', [[['type', '=', 'FILESYSTEM']], { extra: { retrieve_children: false, properties: ['used', 'encryption', 'keystatus', 'mountpoint'] } }]);
  return new Map(list.map((d) => [d.id, d]));
}

export interface BackupPlan {
  destination: BackupDestinationRecord;
  folders: FolderInfo[];
  options: BackupOptions;
}

/** Checks a new backup against the destination: reachable, not a duplicate, fits, encryption allowed. */
export async function prepareBackups(ctx: AppContext, req: NewBackupRequest): Promise<BackupPlan> {
  validateOptions(req);
  const d = destinationOf(ctx, req.destinationId);
  const names = [...new Set(req.folders.map((f) => f.trim()).filter(Boolean))];
  if (!names.length) throw new UserError('Pick at least one folder to back up.', 400, 'VALIDATION', { folders: 'Pick a folder' });
  const { folders } = await listFolders(ctx);
  const datasets = await folderDatasets(ctx);
  const jobs = ctx.store.get().backups.jobs;
  const picked: FolderInfo[] = names.map((name) => {
    const f = folders.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!f) throw new UserError(`There’s no folder called ${name}.`, 400, 'VALIDATION', { folders: `Unknown folder ${name}` });
    if (jobs.some((j) => j.destinationId === d.id && j.dataset === f.dataset)) {
      throw new UserError(`${f.name} is already backed up to ${d.name}.`, 409, 'ALREADY_BACKED_UP', { folders: `${f.name} is already backed up there` });
    }
    const ds = datasets.get(f.dataset);
    return { name: f.name, dataset: f.dataset, usedBytes: f.usedBytes, encrypted: !!ds?.encrypted };
  });
  if (d.encryptedOnly) {
    const plain = picked.filter((f) => !f.encrypted);
    if (plain.length) {
      throw new UserError(
        `The backup area on ${d.name} is inside an encrypted pool, so only encrypted folders can be stored there. ${plain.map((f) => f.name).join(', ')} ${plain.length === 1 ? 'isn’t' : 'aren’t'} encrypted: ${d.name} would have to re-encrypt ${plain.length === 1 ? 'it' : 'them'} with its own key, and restoring would then need ${d.name}’s key. Encrypt the folder first, or use a destination pool that isn’t encrypted.`,
        400,
        'ENCRYPTED_DESTINATION',
        { folders: 'Only encrypted folders can go to this destination' },
      );
    }
  }
  const p = await probe(ctx, d, { fresh: true });
  if (!p.reachable) throw new PeerUnreachableError(p.error ?? `Couldn’t reach ${d.name}.`);
  const free = Math.max(0, (p.quotaBytes ?? d.grantedBytes) - (p.usedBytes ?? 0));
  const needed = picked.reduce((a, f) => a + f.usedBytes, 0);
  if (needed > free) {
    throw new UserError(
      `The selected folders use ${formatBytes(needed)}, but only ${formatBytes(free)} of the ${formatBytes(p.quotaBytes ?? d.grantedBytes)} set aside on ${d.name} is free. Set aside more space on ${d.name}, or pick fewer folders.`,
      400,
      'NOT_ENOUGH_SPACE',
      { folders: 'Not enough space on the destination' },
    );
  }
  for (const f of picked) {
    const target = `${d.rootDataset}/${slug(f.name, 80)}`;
    if (p.copies.has(target)) {
      throw new UserError(`${d.name} still has an older copy of ${f.name}. Wait until it has been removed, or remove it on ${d.name}.`, 409, 'COPY_EXISTS');
    }
  }
  return { destination: d, folders: picked, options: { schedule: req.schedule, keepDays: req.keepDays, speedLimitMbps: req.speedLimitMbps } };
}

/** Creates the snapshot and replication tasks for each folder (the first backups start afterwards). */
export async function createBackups(ctx: AppContext, plan: BackupPlan, step: Step): Promise<BackupRecord[]> {
  const a = ctx.truenas.client();
  const d = plan.destination;
  const created: BackupRecord[] = [];
  for (const f of plan.folders) {
    await step(`Setting up ${f.name}`, async () => {
      const id = randomUUID();
      const namingSchema = `apexosbk-${short(id)}-%Y%m%d-%H%M%S`;
      const task = await a.call<{ id: number }>('pool.snapshottask.create', [
        {
          dataset: f.dataset,
          recursive: true,
          naming_schema: namingSchema,
          lifetime_value: plan.options.keepDays,
          lifetime_unit: 'DAY',
          allow_empty: false,
          enabled: true,
          schedule: toCron(plan.options.schedule),
        },
      ]);
      const remoteDataset = `${d.rootDataset}/${slug(f.name, 80)}`;
      let repl: { id: number };
      try {
        repl = await a.call<{ id: number }>('replication.create', [
          {
            name: `ApexOs backup of ${f.name} to ${d.name} (${short(id)})`,
            direction: 'PUSH',
            transport: 'SSH',
            ssh_credentials: d.credentialId,
            sudo: true,
            source_datasets: [f.dataset],
            target_dataset: remoteDataset,
            recursive: true,
            periodic_snapshot_tasks: [task.id],
            auto: true,
            // Sending properties makes encrypted folders go raw: the copy stays encrypted and locked.
            properties: true,
            encryption: false,
            retention_policy: 'SOURCE',
            readonly: 'SET',
            allow_from_scratch: false,
            hold_pending_snapshots: true,
            compressed: true,
            large_block: true,
            compression: 'LZ4',
            speed_limit: speedLimitBytes(plan.options.speedLimitMbps),
            retries: 5,
            enabled: true,
          },
        ]);
      } catch (err) {
        await a.call('pool.snapshottask.delete', [task.id]).catch(() => undefined);
        throw err;
      }
      const record: BackupRecord = {
        id,
        folder: f.name,
        dataset: f.dataset,
        destinationId: d.id,
        remoteDataset,
        namingSchema,
        snapshotTaskId: task.id,
        replicationId: repl.id,
        encrypted: f.encrypted,
        createdAt: new Date().toISOString(),
        lastSuccessAt: null,
        alert: 'ok',
        ...plan.options,
      };
      await ctx.store.update((s) => {
        s.backups.jobs.push(record);
      });
      created.push(record);
    });
  }
  ctx.bus.changed('backups');
  return created;
}

export async function updateBackup(ctx: AppContext, id: string, req: UpdateBackupRequest): Promise<Backup> {
  const rec = backupOf(ctx, id);
  const options: BackupOptions = {
    schedule: req.schedule ?? rec.schedule,
    keepDays: req.keepDays ?? rec.keepDays,
    speedLimitMbps: req.speedLimitMbps === undefined ? rec.speedLimitMbps : req.speedLimitMbps,
  };
  validateOptions(options);
  const a = ctx.truenas.client();
  await a.call('pool.snapshottask.update', [rec.snapshotTaskId, { schedule: toCron(options.schedule), lifetime_value: options.keepDays, lifetime_unit: 'DAY' }]);
  const repl: Record<string, unknown> = { speed_limit: speedLimitBytes(options.speedLimitMbps) };
  if (req.paused !== undefined) repl.enabled = !req.paused;
  await a.call('replication.update', [rec.replicationId, repl]);
  await ctx.store.update((s) => {
    const r = s.backups.jobs.find((x) => x.id === id);
    if (r) Object.assign(r, options);
  });
  ctx.bus.changed('backups');
  const { backups } = await listBackups(ctx);
  const updated = backups.find((b) => b.id === id);
  if (!updated) throw notFound();
  return updated;
}

/** Waits for a replication job and reports its progress. */
async function runReplication(ctx: AppContext, rec: BackupRecord, dest: BackupDestinationRecord, report: (percent: number, message?: string) => void): Promise<void> {
  const a = ctx.truenas.client();
  try {
    await a.job('replication.run', [rec.replicationId], (job) => {
      const percent = job.progress?.percent ?? 0;
      report(percent, job.progress?.description || undefined);
    });
  } catch (err) {
    const raw = errorMessage(err);
    if (/already running/i.test(raw)) throw new UserError(`A backup of ${rec.folder} is already running.`, 409, 'BUSY');
    throw new UserError(explainError(raw, dest.name).message, 502, 'BACKUP_FAILED');
  }
  await ctx.store.update((s) => {
    const r = s.backups.jobs.find((x) => x.id === rec.id);
    if (r) r.lastSuccessAt = new Date().toISOString();
  });
  probes.delete(dest.id);
}

/** Takes a snapshot now and sends it ("Back up now"). */
export async function prepareRun(ctx: AppContext, id: string): Promise<{ rec: BackupRecord; dest: BackupDestinationRecord }> {
  const rec = backupOf(ctx, id);
  const dest = destinationOf(ctx, rec.destinationId);
  const [repl] = await ctx.truenas.client().call<TnReplication[]>('replication.query', [[['id', '=', rec.replicationId]]]);
  if (!repl) throw new UserError(`The backup task for ${rec.folder} is missing on this server. Remove this backup and set it up again.`, 409, 'TASK_MISSING');
  if (!repl.enabled) throw new UserError('This backup is paused. Resume it first.', 409, 'PAUSED');
  if (repl.state.state === 'RUNNING' || ctx.tasks.findRunning('backup-run', id) || ctx.tasks.findRunning('backup-fresh-copy', id)) {
    throw new UserError(`A backup of ${rec.folder} is already running.`, 409, 'BUSY');
  }
  const datasets = await folderDatasets(ctx);
  if (!datasets.has(rec.dataset)) throw new UserError(`${rec.folder} no longer exists on this server.`, 409, 'FOLDER_MISSING');
  const p = await probe(ctx, dest, { fresh: true });
  if (!p.reachable) throw new PeerUnreachableError(p.error ?? `Couldn’t reach ${dest.name}.`);
  return { rec, dest };
}

export function startRun(ctx: AppContext, rec: BackupRecord, dest: BackupDestinationRecord): Task {
  return ctx.tasks.start(
    { type: 'backup-run', title: `Backing up ${rec.folder} to ${dest.name}`, ref: rec.id, steps: ['Taking a snapshot', `Copying changes to ${dest.name}`] },
    async (t) => {
      await t.step('Taking a snapshot', () => takeSnapshot(ctx, rec));
      await t.step(`Copying changes to ${dest.name}`, (report) => runReplication(ctx, rec, dest, report));
      ctx.bus.changed('backups');
    },
  );
}

async function takeSnapshot(ctx: AppContext, rec: BackupRecord): Promise<void> {
  try {
    await ctx.truenas.client().call('pool.snapshot.create', [{ dataset: rec.dataset, naming_schema: rec.namingSchema, recursive: true }]);
  } catch (err) {
    // Two runs within the same second share the snapshot.
    if (!/already exists/i.test(errorMessage(err))) throw err;
  }
}

/** Replaces the copy on the destination with a fresh full copy (needed after the folder was encrypted). */
export function startFreshCopy(ctx: AppContext, rec: BackupRecord, dest: BackupDestinationRecord): Task {
  return ctx.tasks.start(
    {
      type: 'backup-fresh-copy',
      title: `Starting a fresh copy of ${rec.folder} on ${dest.name}`,
      ref: rec.id,
      steps: [`Deleting the old copy on ${dest.name}`, 'Taking a snapshot', `Copying everything to ${dest.name}`],
    },
    async (t) => {
      await t.step(`Deleting the old copy on ${dest.name}`, () => withPeer(peerTarget(dest), (b) => deleteDataset(b, rec.remoteDataset)));
      const datasets = await folderDatasets(ctx);
      await ctx.store.update((s) => {
        const r = s.backups.jobs.find((x) => x.id === rec.id);
        if (r) r.encrypted = !!datasets.get(rec.dataset)?.encrypted;
      });
      await t.step('Taking a snapshot', () => takeSnapshot(ctx, rec));
      await t.step(`Copying everything to ${dest.name}`, (report) => runReplication(ctx, rec, dest, report));
      ctx.bus.changed('backups');
    },
  );
}

/** Deletes the replication task, the snapshot task and this backup's snapshots here. */
async function removeLocalTasks(ctx: AppContext, rec: BackupRecord): Promise<void> {
  const a = ctx.truenas.client();
  // The replication task goes first: TrueNAS refuses to delete the last snapshot task bound to an enabled one.
  await a.call('replication.delete', [rec.replicationId]).catch(ignoreMissing);
  await a.call('pool.snapshottask.delete', [rec.snapshotTaskId]).catch(ignoreMissing);
  const prefix = rec.namingSchema.split('%')[0]!;
  const snaps = await a.call<TnSnapshot[]>('pool.snapshot.query', [[['dataset', '=', rec.dataset], ['snapshot_name', '^', prefix]], { select: ['id', 'snapshot_name', 'dataset'] }]);
  for (const s of snaps) await a.call('pool.snapshot.delete', [s.id, { recursive: true }]).catch(ignoreMissing);
}

export function startRemoveBackup(ctx: AppContext, rec: BackupRecord, dest: BackupDestinationRecord): Task {
  return ctx.tasks.start(
    { type: 'backup-remove', title: `Removing the backup of ${rec.folder} from ${dest.name}`, ref: rec.id, steps: ['Removing the backup tasks', `Deleting the copy on ${dest.name}`] },
    async (t) => {
      await t.step('Removing the backup tasks', () => removeLocalTasks(ctx, rec));
      await t.step(`Deleting the copy on ${dest.name}`, async (report) => {
        try {
          await withPeer(peerTarget(dest), (b) => deleteDataset(b, rec.remoteDataset), { timeoutMs: 10_000 });
        } catch (err) {
          if (!(err instanceof PeerUnreachableError)) throw err;
          await queueCleanup(
            ctx,
            { kind: 'copy', destinationName: dest.name, apiUrl: dest.apiUrl, apiKey: dest.apiKey, apiKeyId: null, dataset: rec.remoteDataset },
            err.message,
          );
          report(100, `${dest.name} is offline. ApexOs will delete the copy when it’s back.`);
        }
      });
      await ctx.store.update((s) => {
        s.backups.jobs = s.backups.jobs.filter((j) => j.id !== rec.id);
      });
      probes.delete(dest.id);
      ctx.bus.changed('backups');
    },
  );
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function restoreName(folder: string, taken: Set<string>): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const base = `${folder}-restored-${date}`.slice(0, 80);
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = `${base.slice(0, 76)}-${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

async function remoteCopy(d: BackupDestinationRecord, rec: BackupRecord): Promise<{ copy: EncDataset; points: { name: string; createdAt: string }[] }> {
  return withPeer(peerTarget(d), async (b) => {
    const [copy] = await b.call<EncDataset[]>('pool.dataset.query', [
      [['id', '=', rec.remoteDataset]],
      { extra: { retrieve_children: false, properties: ['used', 'encryption', 'keystatus', 'keyformat'] } },
    ]);
    if (!copy) throw new UserError(`There’s no copy of ${rec.folder} on ${d.name} yet.`, 409, 'NO_COPY');
    const snaps = await b.call<TnSnapshot[]>('pool.snapshot.query', [[['dataset', '=', rec.remoteDataset]]]);
    const points = snaps
      .map((s) => ({ name: s.snapshot_name, createdAt: dateToIso(s.properties?.creation?.parsed ?? null) ?? new Date(0).toISOString() }))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt) || y.name.localeCompare(x.name));
    return { copy, points };
  });
}

export async function getRestoreInfo(ctx: AppContext, id: string): Promise<RestoreInfo> {
  const rec = backupOf(ctx, id);
  const d = destinationOf(ctx, rec.destinationId);
  const { copy, points } = await remoteCopy(d, rec);
  if (!points.length) throw new UserError(`The copy on ${d.name} has no restore points yet.`, 409, 'NO_RESTORE_POINTS');
  const a = ctx.truenas.client();
  const [{ folders }, datasets, pools] = await Promise.all([
    listFolders(ctx),
    a.call<EncDataset[]>('pool.dataset.query', [[], { extra: { retrieve_children: false, properties: ['available'] } }]),
    a.call<TnPool[]>('pool.query', [[], { select: ['id', 'name'] }]),
  ]);
  const taken = new Set([...datasets.map((x) => x.id.split('/')[1]?.toLowerCase() ?? ''), ...folders.map((f) => f.name.toLowerCase())]);
  const keyFormat = copy.encrypted ? (copy.key_format?.value === 'PASSPHRASE' ? 'passphrase' : 'key') : null;
  const poolNames = ctx.store.get().poolNames;
  return {
    restorePoints: points,
    suggestedName: restoreName(rec.folder, taken),
    sizeBytes: propNumber(copy.used),
    encrypted: copy.encrypted,
    keyFormat,
    pools: pools.map((p) => ({ name: p.name, displayName: poolNames[p.name] ?? p.name, freeBytes: propNumber(datasets.find((x) => x.id === p.name)?.available) })),
    defaultPool: rec.dataset.split('/')[0]!,
    originalExists: folders.some((f) => f.dataset === rec.dataset),
  };
}

export async function prepareRestore(ctx: AppContext, id: string, req: RestoreRequest): Promise<{ rec: BackupRecord; dest: BackupDestinationRecord; point: string; info: RestoreInfo; name: string }> {
  const rec = backupOf(ctx, id);
  const dest = destinationOf(ctx, rec.destinationId);
  const name = req.name.trim();
  if (!foldernameFormat(name) || name.length > 80) {
    throw new UserError('Folder names use letters, numbers, spaces, dashes or underscores (up to 80).', 400, 'VALIDATION', { name: 'Invalid folder name' });
  }
  const info = await getRestoreInfo(ctx, id);
  const pool = info.pools.find((p) => p.name === req.pool);
  if (!pool) throw new UserError('Pick a pool for the restored folder.', 400, 'VALIDATION', { pool: 'Unknown pool' });
  const { folders } = await listFolders(ctx);
  const datasets = await folderDatasets(ctx);
  if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase()) || datasets.has(`${pool.name}/${name}`)) {
    throw new UserError(`There’s already a folder called ${name}. A restore never replaces a folder: pick another name.`, 409, 'VALIDATION', { name: 'Already exists' });
  }
  if (info.sizeBytes > pool.freeBytes) {
    throw new UserError(`The copy needs ${formatBytes(info.sizeBytes)}, but ${pool.displayName} has only ${formatBytes(pool.freeBytes)} free.`, 400, 'NOT_ENOUGH_SPACE', {
      pool: 'Not enough space',
    });
  }
  const point = req.restorePoint ?? info.restorePoints[0]!.name;
  if (!info.restorePoints.some((p) => p.name === point)) throw new UserError('That restore point no longer exists.', 409, 'VALIDATION', { restorePoint: 'Not found' });
  return { rec, dest, point, info, name };
}

export function startRestore(
  ctx: AppContext,
  prepared: Awaited<ReturnType<typeof prepareRestore>>,
  req: RestoreRequest,
): Task {
  const { rec, dest, point, info, name } = prepared;
  const target = `${req.pool}/${name}`;
  return ctx.tasks.start(
    { type: 'backup-restore', title: `Restoring ${rec.folder} as ${name}`, ref: rec.id, steps: [`Copying from ${dest.name}`, 'Finishing the folder', 'Sharing on your network'] },
    async (t) => {
      const a = ctx.truenas.client();
      await t.step(`Copying from ${dest.name}`, async (report) => {
        try {
          await a.job(
            'replication.run_onetime',
            [
              {
                direction: 'PULL',
                transport: 'SSH',
                ssh_credentials: dest.credentialId,
                sudo: true,
                source_datasets: [rec.remoteDataset],
                target_dataset: target,
                recursive: true,
                properties: true,
                properties_exclude: ['readonly'],
                name_regex: regexEscape(point),
                retention_policy: 'NONE',
                readonly: 'IGNORE',
                allow_from_scratch: false,
                only_from_scratch: true,
              },
            ],
            (job) => report(job.progress?.percent ?? 0),
          );
        } catch (err) {
          // Never leave a half-received copy behind (the target didn't exist before).
          await a.call('pool.dataset.delete', [target, { recursive: true, force: true }]).catch(() => undefined);
          throw new UserError(explainError(errorMessage(err), dest.name).message, 502, 'RESTORE_FAILED');
        }
      });
      const locked = await t.step('Finishing the folder', async () => {
        const [ds] = await a.call<EncDataset[]>('pool.dataset.query', [[['id', '=', target]], { extra: { retrieve_children: false, properties: ['readonly', 'encryption', 'keystatus'] } }]);
        if (ds?.readonly?.parsed) await a.call('pool.dataset.update', [target, { readonly: 'OFF' }]);
        // The restore point travelled with the data; the restored folder starts without it.
        await a.call('pool.snapshot.delete', [`${target}@${point}`, { recursive: true }]).catch(() => undefined);
        if (!ds?.encrypted) return false;
        if (!req.secret) return true;
        const entry = info.keyFormat === 'passphrase' ? { name: target, passphrase: req.secret } : { name: target, key: req.secret };
        const result = await a.job<{ unlocked: string[]; failed: Record<string, { error: string }> }>('pool.dataset.unlock', [target, { datasets: [entry] }]).catch(() => null);
        return !result?.unlocked.includes(target);
      });
      await t.step('Sharing on your network', async (report) => {
        if (locked) {
          report(100, 'The folder is encrypted and still locked. Unlock it, then share it from Folders.');
          return;
        }
        const original = info.originalExists ? await getFolder(ctx, rec.folder).catch(() => null) : null;
        await createFolder(ctx, {
          name,
          pool: req.pool,
          access: original?.access ?? 'private',
          users: original?.access === 'private' ? original.users : [],
          quotaBytes: null,
          timeMachine: false,
        });
      });
      await addNotice(ctx, {
        level: 'info',
        title: `${rec.folder} was restored as ${name}`,
        message: locked
          ? `The copy from ${dest.name} is in ${name}. It’s encrypted and still locked: unlock it with the folder’s ${info.keyFormat ?? 'key'}, then share it.`
          : `The copy from ${dest.name} is in the new folder ${name}.`,
        link: `/folders?folder=${encodeURIComponent(name)}`,
      });
      ctx.bus.changed('folders');
    },
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const LABELS: Record<BackupState, string> = {
  waiting: 'Waiting for the first backup',
  running: 'Backing up',
  ok: 'Up to date',
  failed: 'Last backup failed',
  overdue: 'Overdue',
  paused: 'Paused',
  'needs-fresh-copy': 'Needs a fresh copy',
};

interface Snapshot {
  replications: Map<number, TnReplication>;
  tasks: Map<number, TnSnapshotTask>;
  datasets: Map<string, EncDataset>;
  timezone: string;
  serverName: string;
}

async function localSnapshot(ctx: AppContext): Promise<Snapshot> {
  const a = ctx.truenas.client();
  const [repls, tasks, datasets, me] = await Promise.all([
    a.call<TnReplication[]>('replication.query'),
    a.call<TnSnapshotTask[]>('pool.snapshottask.query'),
    folderDatasets(ctx),
    thisServer(ctx),
  ]);
  return { replications: new Map(repls.map((r) => [r.id, r])), tasks: new Map(tasks.map((t) => [t.id, t])), datasets, timezone: me.timezone, serverName: me.name };
}

function computeStatus(ctx: AppContext, rec: BackupRecord, dest: BackupDestinationRecord, snap: Snapshot, p: DestinationProbe | undefined, now: number): BackupStatus {
  const repl = snap.replications.get(rec.replicationId);
  const running = ctx.tasks.findRunning('backup-run', rec.id) ?? ctx.tasks.findRunning('backup-fresh-copy', rec.id);
  const finishedAt = repl?.state.state === 'FINISHED' ? dateToIso(repl.state.datetime) : null;
  const lastSuccessAt = [rec.lastSuccessAt, finishedAt].filter((x): x is string => !!x).sort().at(-1) ?? null;
  const lastAttemptAt = dateToIso(repl?.state.datetime) ?? lastSuccessAt;
  const base = { lastSuccessAt, lastAttemptAt, nextRunAt: repl?.enabled === false ? null : nextRunAt(rec.schedule, snap.timezone, now), progress: null };
  const status = (state: BackupState, detail: string | null = null, extra: Partial<BackupStatus> = {}): BackupStatus => ({ state, label: LABELS[state], detail, ...base, ...extra });

  const folder = snap.datasets.get(rec.dataset);
  if (!repl) return status('failed', `The backup task for ${rec.folder} was removed from this server. Remove this backup and set it up again.`);
  if (repl.state.state === 'RUNNING' || running) {
    const pr = repl.state.progress;
    const bytesTotal = pr?.bytes_total ?? 0;
    const bytesSent = pr?.bytes_sent ?? 0;
    const percent = bytesTotal ? Math.round((bytesSent / bytesTotal) * 100) : (repl.job?.progress?.percent ?? running?.progress ?? 0);
    return status('running', null, { progress: { percent: Math.min(100, Math.max(0, percent)), bytesSent, bytesTotal } });
  }
  if (!folder) return status('failed', `${rec.folder} no longer exists on this server. Its copy on ${dest.name} is kept: restore it, or remove this backup to delete the copy.`);
  if (!!folder.encrypted !== rec.encrypted) {
    return status(
      'needs-fresh-copy',
      folder.encrypted
        ? `${rec.folder} was encrypted after its backup started, so the copy on ${dest.name} can’t be continued. Start a fresh copy to replace it.`
        : `${rec.folder} is no longer encrypted, so the copy on ${dest.name} can’t be continued. Start a fresh copy to replace it.`,
    );
  }
  if (!repl.enabled) return status('paused', `Scheduled backups to ${dest.name} are paused. Snapshots are still taken here.`);
  if (repl.state.state === 'ERROR') {
    const explained = explainError(repl.state.error ?? 'Unknown error', dest.name);
    return status(explained.freshCopy ? 'needs-fresh-copy' : 'failed', explained.message);
  }
  if (repl.state.state === 'HOLD') return status('failed', `TrueNAS is holding this backup: ${repl.state.reason ?? 'unknown reason'}.`);
  const since = lastSuccessAt ?? rec.createdAt;
  if (now - Date.parse(since) > overdueAfterMs(rec.schedule)) {
    const unreachable = p && !p.reachable ? ` ${dest.name} can’t be reached right now.` : '';
    return status('overdue', `No backup has finished since ${new Date(since).toLocaleString('en-US', { timeZone: snap.timezone, dateStyle: 'medium', timeStyle: 'short' })}.${unreachable}`);
  }
  if (!lastSuccessAt) return status('waiting');
  return status('ok');
}

function toBackup(rec: BackupRecord, dest: BackupDestinationRecord, snap: Snapshot, p: DestinationProbe | undefined, status: BackupStatus): Backup {
  const copy = p?.copies.get(rec.remoteDataset);
  const repl = snap.replications.get(rec.replicationId);
  return {
    id: rec.id,
    folder: rec.folder,
    pool: rec.dataset.split('/')[0]!,
    dataset: rec.dataset,
    folderExists: snap.datasets.has(rec.dataset),
    encrypted: rec.encrypted,
    destinationId: dest.id,
    destinationName: dest.name,
    remoteDataset: rec.remoteDataset,
    remoteUsedBytes: p?.reachable ? (copy?.usedBytes ?? 0) : null,
    restorePoints: p?.reachable ? (copy?.restorePoints ?? 0) : null,
    paused: repl?.enabled === false,
    schedule: rec.schedule,
    keepDays: rec.keepDays,
    speedLimitMbps: rec.speedLimitMbps,
    status,
    createdAt: rec.createdAt,
  };
}

function toDestination(d: BackupDestinationRecord, p: DestinationProbe | undefined, count: number): BackupDestination {
  const { health, problem } = p ? destinationHealth(d, p) : { health: 'online' as const, problem: null };
  return {
    id: d.id,
    name: d.name,
    address: d.address,
    pool: d.pool,
    dataset: d.rootDataset,
    grantedBytes: p?.quotaBytes ?? d.grantedBytes,
    usedBytes: p?.reachable ? p.usedBytes : null,
    health,
    problem,
    checkedAt: p ? new Date(p.at).toISOString() : null,
    encryptedOnly: p?.reachable ? p.encrypted : d.encryptedOnly,
    ssh: { host: d.sshHost, port: d.sshPort },
    backupCount: count,
    createdAt: d.createdAt,
  };
}

export async function listBackups(ctx: AppContext, opts: { fresh?: boolean; now?: number } = {}): Promise<BackupsResponse> {
  const state = ctx.store.get().backups;
  const now = opts.now ?? Date.now();
  const [snap, probed] = await Promise.all([localSnapshot(ctx), Promise.all(state.destinations.map((d) => probe(ctx, d, { fresh: opts.fresh })))]);
  const probeOf = new Map(state.destinations.map((d, i) => [d.id, probed[i]!]));
  const destinations = state.destinations.map((d) => toDestination(d, probeOf.get(d.id), state.jobs.filter((j) => j.destinationId === d.id).length));
  const backups: Backup[] = [];
  for (const rec of state.jobs) {
    const dest = state.destinations.find((d) => d.id === rec.destinationId);
    if (!dest) continue;
    const p = probeOf.get(dest.id);
    backups.push(toBackup(rec, dest, snap, p, computeStatus(ctx, rec, dest, snap, p, now)));
  }
  backups.sort((x, y) => x.folder.localeCompare(y.folder) || x.destinationName.localeCompare(y.destinationName));
  return {
    serverName: snap.serverName,
    timezone: snap.timezone,
    destinations,
    backups,
    pendingCleanups: state.cleanups.map((c) => ({
      id: c.id,
      destinationName: c.destinationName,
      description: c.kind === 'copy' ? `Delete the copy ${c.dataset}` : `Remove the copies, the backup account and the space set aside (${c.dataset})`,
      since: c.since,
      lastError: c.lastError,
    })),
  };
}

export async function forgetCleanup(ctx: AppContext, id: string): Promise<void> {
  if (!ctx.store.get().backups.cleanups.some((c) => c.id === id)) throw notFound('Cleanup');
  await ctx.store.update((s) => {
    s.backups.cleanups = s.backups.cleanups.filter((c) => c.id !== id);
  });
  ctx.bus.changed('backups');
}

// ---------------------------------------------------------------------------
// Monitor: notices on state changes, deferred cleanups
// ---------------------------------------------------------------------------

async function runCleanups(ctx: AppContext): Promise<void> {
  for (const c of ctx.store.get().backups.cleanups) {
    try {
      await withPeer(
        { apiUrl: c.apiUrl, apiKey: c.apiKey, name: c.destinationName },
        (b) => (c.kind === 'copy' ? deleteDataset(b, c.dataset) : cleanUpDestinationOnPeer(b, c)),
        { timeoutMs: 8_000 },
      );
      await ctx.store.update((s) => {
        s.backups.cleanups = s.backups.cleanups.filter((x) => x.id !== c.id);
      });
      await addNotice(ctx, {
        level: 'info',
        title: `Finished cleaning up on ${c.destinationName}`,
        message: c.kind === 'copy' ? `${c.destinationName} is back, and the removed copy was deleted there.` : `${c.destinationName} is back, and the backups that were removed have been deleted there.`,
        link: '/backups',
      });
    } catch (err) {
      await ctx.store.update((s) => {
        const x = s.backups.cleanups.find((y) => y.id === c.id);
        if (x) {
          x.attempts += 1;
          x.lastError = errorMessage(err);
        }
      });
    }
  }
}

/**
 * Looks at every backup and destination, sends one notice per change of state (failing, overdue,
 * fresh copy needed, destination unreachable / nearly full / full, and back to normal) and finishes
 * removals that waited for an offline destination.
 */
export async function checkBackups(ctx: AppContext, opts: { now?: number } = {}): Promise<void> {
  if (!ctx.truenas.connected) return;
  const state = ctx.store.get().backups;
  if (state.cleanups.length) await runCleanups(ctx);
  if (!state.jobs.length && !state.destinations.length) return;
  const now = opts.now ?? Date.now();
  const list = await listBackups(ctx, { fresh: true, now });
  const notices: Array<Parameters<typeof addNotice>[1]> = [];
  const nextJobs = new Map<string, BackupRecord['alert']>();
  const nextDest = new Map<string, Pick<BackupDestinationRecord, 'alert' | 'unreachableSince'>>();

  for (const d of list.destinations) {
    const rec = state.destinations.find((x) => x.id === d.id)!;
    let unreachableSince = rec.unreachableSince;
    let alert: BackupDestinationRecord['alert'] = rec.alert;
    if (d.health === 'unreachable') {
      unreachableSince ??= new Date(now).toISOString();
      if (now - Date.parse(unreachableSince) >= UNREACHABLE_NOTICE_AFTER_MS) alert = 'unreachable';
    } else {
      unreachableSince = null;
      alert = d.health === 'online' ? 'ok' : d.health;
    }
    if (alert !== rec.alert) {
      if (alert === 'unreachable') {
        notices.push({ level: 'warning', title: `Can’t reach ${d.name}`, message: `${d.problem ?? ''} Backups to it will wait until it’s back.`.trim(), link: '/backups' });
      } else if (alert === 'nearly-full' || alert === 'full') {
        notices.push({
          level: alert === 'full' ? 'error' : 'warning',
          title: alert === 'full' ? `No room left for backups on ${d.name}` : `Backup space on ${d.name} is almost full`,
          message: `${d.problem ?? ''} Set aside more space, or keep restore points for fewer days.`.trim(),
          link: '/backups',
        });
      } else if (rec.alert === 'unreachable') {
        notices.push({ level: 'info', title: `${d.name} is reachable again`, message: 'Backups to it continue as scheduled.', link: '/backups' });
      }
    }
    nextDest.set(d.id, { alert, unreachableSince });
  }

  for (const b of list.backups) {
    const rec = state.jobs.find((x) => x.id === b.id)!;
    const s = b.status.state;
    const alert: BackupRecord['alert'] = s === 'failed' || s === 'overdue' || s === 'needs-fresh-copy' ? s : s === 'ok' ? 'ok' : rec.alert;
    if (alert !== rec.alert) {
      if (alert === 'ok') {
        notices.push({ level: 'info', title: `Backups of ${b.folder} to ${b.destinationName} are working again`, message: 'The last backup finished.', link: '/backups' });
      } else {
        const title =
          alert === 'overdue'
            ? `Backups of ${b.folder} to ${b.destinationName} may have stopped`
            : alert === 'needs-fresh-copy'
              ? `The backup of ${b.folder} needs a fresh copy`
              : `Backing up ${b.folder} to ${b.destinationName} failed`;
        notices.push({ level: alert === 'overdue' ? 'warning' : 'error', title, message: b.status.detail ?? '', link: '/backups' });
      }
    }
    nextJobs.set(b.id, alert);
  }

  await ctx.store.update((st) => {
    for (const j of st.backups.jobs) {
      const alert = nextJobs.get(j.id);
      if (alert) j.alert = alert;
      const b = list.backups.find((x) => x.id === j.id);
      if (b?.status.lastSuccessAt && (!j.lastSuccessAt || b.status.lastSuccessAt > j.lastSuccessAt)) j.lastSuccessAt = b.status.lastSuccessAt;
    }
    for (const d of st.backups.destinations) {
      const next = nextDest.get(d.id);
      if (next) Object.assign(d, next);
    }
  });
  for (const n of notices) await addNotice(ctx, n);
  if (notices.length) ctx.bus.changed('backups');
}

/** Starts the background monitor; returns a function that stops it. */
export function startBackupMonitor(ctx: AppContext): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void checkBackups(ctx)
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  // Follow replication state changes on this server (TrueNAS sends one event per change).
  const subscribed = new WeakSet<object>();
  let debounce: NodeJS.Timeout | undefined;
  const onStatus = (connected: boolean) => {
    if (!connected) return;
    try {
      const client = ctx.truenas.client();
      if (!subscribed.has(client)) {
        subscribed.add(client);
        void client.subscribe('replication.query', () => undefined).catch(() => undefined);
      }
    } catch {
      // not configured yet
    }
    run();
  };
  const onUpdate = (u: { collection: string }) => {
    if (u.collection !== 'replication.query') return;
    ctx.bus.changed('backups');
    clearTimeout(debounce);
    debounce = setTimeout(run, 2_000);
    debounce.unref();
  };
  ctx.truenas.on('status', onStatus);
  ctx.truenas.on('update', onUpdate);
  if (ctx.truenas.connected) onStatus(true);
  const timer = setInterval(run, MONITOR_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(debounce);
    ctx.truenas.off('status', onStatus);
    ctx.truenas.off('update', onUpdate);
  };
}
