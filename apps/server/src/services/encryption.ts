/**
 * Folder encryption: key modes, lock/unlock, switching key mode, turning encryption on for an existing folder
 * (Copy strategy), and the server recovery file.
 *
 * Model (self-hosted, no cloud escrow):
 * - Every encrypted folder is its own ZFS encryption root, a child of the (unencrypted) pool root dataset.
 * - Automatic key ("key" mode): a random hex key that TrueNAS keeps in its key store on the boot pool, so the
 *   folder unlocks at boot. The recovery file (`pool.dataset.export_keys` of every pool) is the only copy
 *   outside the server; ApexOs tracks when it was downloaded and which keys changed since.
 * - Passphrase mode: TrueNAS never stores it and neither does ApexOs; the folder is locked after every restart.
 *
 * TrueNAS behaviour this relies on is described in the module docs of `@apexos/mock-truenas` and in
 * docs/architecture.md (renames don't move stored keys, unlock restarts shares but not apps, …).
 */
import { randomBytes } from 'node:crypto';
import type {
  ChangeKeyModeRequest,
  ConversionCheck,
  ConversionDuration,
  EncryptionConversion,
  EncryptionMode,
  Folder,
  FolderEncryption,
  NewFolderEncryption,
  RecoveryKeyStatus,
  StartConversionRequest,
  Task,
  UnlockFolderRequest,
} from '@apexos/api-types';
import type { Job, TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { errorMessage, type TaskContext } from '../lib/tasks.ts';
import { formatBytes, GiB, propNumber, userProp } from '../truenas/helpers.ts';
import type { TnApp, TnDataset, TnProperty, TnSmbShare } from '../truenas/types.ts';
import { FOLDER_PROPERTY, getFolder, listFolders } from './folders.ts';
import { addNotice } from './notifications.ts';

// ---------------------------------------------------------------------------
// Constants and stored state
// ---------------------------------------------------------------------------

/** Set on the unencrypted original after a conversion (value: the folder's dataset); hides it from the list. */
export const SAFETY_COPY_PROPERTY = 'apexos:safety-copy';
/** The encrypted copy is built here (a hidden dataset next to the folder) and renamed over it at the end. */
const TEMP_PREFIX = '.apexos-enc-';
const SNAPSHOT_PREFIX = 'apexos-enc-';
/** How long the unencrypted original is kept before ApexOs removes it on its own. */
export const SAFETY_COPY_DAYS = 7;
export const MIN_PASSPHRASE = 8;
const MAX_PASSPHRASE = 512;
const PBKDF2_ITERS = 350000;
const HOUR = 3600_000;
/** Assumed copy speed for the duration estimate. */
const COPY_BYTES_PER_SEC = 150e6;
/** Most entries the post-copy check compares file by file (the snapshot comparison always runs). */
const VERIFY_MAX_ENTRIES = 20_000;

/** What ApexOs keeps about one "turn on encryption" run. Survives restarts so Retry can resume it. */
export interface ConversionRecord {
  folder: string;
  dataset: string;
  pool: string;
  path: string;
  /** Hidden dataset the encrypted copy is received into. */
  temp: string;
  /** Name the unencrypted original gets at the switch-over. */
  original: string;
  mode: 'key' | 'passphrase';
  /**
   * The copy's automatic key, escrowed here until TrueNAS stores it under the folder's own name (a crash
   * between the rename and `change_key` would otherwise lose it). Cleared when the run finishes.
   */
  key: string | null;
  keepOriginal: boolean;
  status: 'running' | 'failed' | 'done';
  step: string | null;
  error: string | null;
  taskId: string | null;
  /** The original has been renamed away. */
  renamedOriginal: boolean;
  /** The encrypted copy carries the folder's name. */
  switched: boolean;
  share: { id: number; wasEnabled: boolean } | null;
  quota: number | null;
  refquota: number | null;
  passphrasePending: boolean;
  startedAt: string;
  removeAfter: string | null;
}

/** ApexOs's own encryption bookkeeping (in state.json). Never contains passphrases. */
export interface StoredEncryption {
  /** Last recovery-file download: when, and which dataset keys it contained. */
  recovery?: { downloadedAt: string; datasets: string[] };
  /** Automatic-key folders created or re-keyed since the last download (dataset names). */
  pendingRecovery?: string[];
  /** Apps that were running when ApexOs locked a folder; started again after unlocking it. */
  stoppedApps?: Record<string, string[]>;
  conversions?: Record<string, ConversionRecord>;
}

function stored(ctx: AppContext): StoredEncryption {
  return ctx.store.get().encryption ?? {};
}

async function updateStored(ctx: AppContext, mutate: (e: StoredEncryption) => void): Promise<void> {
  await ctx.store.update((s) => {
    s.encryption ??= {};
    mutate(s.encryption);
  });
}

async function markRecoveryPending(ctx: AppContext, dataset: string, pending: boolean): Promise<void> {
  await updateStored(ctx, (e) => {
    const list = new Set(e.pendingRecovery ?? []);
    if (pending) list.add(dataset);
    else list.delete(dataset);
    e.pendingRecovery = [...list];
  });
}

// ---------------------------------------------------------------------------
// Reading encryption state
// ---------------------------------------------------------------------------

/** `pool.dataset.query` entry with the crypto fields (requested through `CRYPTO_QUERY_PROPERTIES`). */
export interface TnCryptoDataset extends TnDataset {
  encryption_root?: string | null;
  key_loaded?: boolean;
  key_format?: TnProperty<string | null>;
  refquota?: TnProperty<number | null>;
  usedbysnapshots?: TnProperty<number>;
}

/** Properties that make TrueNAS fill `encrypted`, `encryption_root`, `locked` and `key_format`. */
export const CRYPTO_QUERY_PROPERTIES = ['encryption', 'encryptionroot', 'keyformat', 'keystatus'];

async function queryDatasets(client: TrueNasClient, filters: unknown[]): Promise<TnCryptoDataset[]> {
  return client.call<TnCryptoDataset[]>('pool.dataset.query', [
    filters,
    {
      extra: {
        retrieve_children: false,
        properties: ['used', 'available', 'quota', 'refquota', 'usedbysnapshots', 'mountpoint', ...CRYPTO_QUERY_PROPERTIES],
        retrieve_user_props: true,
      },
    },
  ]);
}

async function getDataset(client: TrueNasClient, id: string): Promise<TnCryptoDataset | null> {
  return (await queryDatasets(client, [['id', '=', id]]))[0] ?? null;
}

export function encryptionMode(ds: Pick<TnCryptoDataset, 'encrypted' | 'key_format'>): EncryptionMode {
  if (!ds.encrypted) return 'none';
  return ds.key_format?.value?.toUpperCase() === 'PASSPHRASE' ? 'passphrase' : 'key';
}

function inRecoveryFile(enc: StoredEncryption, dataset: string): boolean {
  return !!enc.recovery?.datasets.includes(dataset) && !enc.pendingRecovery?.includes(dataset);
}

function folderEncryption(ds: TnCryptoDataset, enc: StoredEncryption): FolderEncryption {
  const mode = encryptionMode(ds);
  const root = ds.encrypted ? (ds.encryption_root ?? ds.id) : null;
  const inherited = !!root && root !== ds.id;
  return {
    mode,
    locked: !!ds.encrypted && !!ds.locked,
    root,
    inherited,
    notInRecoveryFile: mode === 'key' && !inherited && !inRecoveryFile(enc, ds.id),
    appsAffected: [],
  };
}

function conversionView(ctx: AppContext, record: ConversionRecord, originalUsed: number | null): EncryptionConversion {
  const task = record.taskId ? ctx.tasks.get(record.taskId) : undefined;
  const running = record.status === 'running' && task?.status === 'running';
  return {
    state: record.status === 'running' ? (running ? 'running' : 'interrupted') : record.status,
    step: running ? (task?.message ?? record.step) : record.step,
    error: record.error,
    switched: record.switched,
    taskId: record.taskId,
    mode: record.mode,
    passphrasePending: record.passphrasePending,
    safetyCopy:
      record.status === 'done' && record.keepOriginal && originalUsed !== null
        ? { dataset: record.original, usedBytes: originalUsed, removeAfter: record.removeAfter ?? new Date().toISOString() }
        : null,
    startedAt: record.startedAt,
  };
}

/** True for datasets that must not show up as folders: conversion copies and kept originals. */
export function isEncryptionArtifact(ctx: AppContext, ds: TnDataset): boolean {
  if (userProp(ds, SAFETY_COPY_PROPERTY)) return true;
  const name = ds.id.split('/')[1] ?? '';
  if (name.startsWith(TEMP_PREFIX)) return true;
  return Object.values(stored(ctx).conversions ?? {}).some((r) => r.original === ds.id);
}

/**
 * Adds `encryption` and `conversion` to listed folders. For locked folders it also asks TrueNAS which apps
 * keep files there (they can't reach them until the folder is unlocked and they are started again).
 */
export async function decorateFolders(ctx: AppContext, folders: Folder[], datasets: TnDataset[]): Promise<Folder[]> {
  const enc = stored(ctx);
  const byId = new Map(datasets.map((d) => [d.id, d as TnCryptoDataset]));
  const client = ctx.truenas.client();
  await Promise.all(
    folders.map(async (f) => {
      const ds = byId.get(f.dataset);
      f.encryption = ds ? folderEncryption(ds, enc) : { mode: 'none', locked: false, root: null, inherited: false, notInRecoveryFile: false, appsAffected: [] };
      if (f.encryption.locked) {
        const fromTrueNas = await attachedApps(client, f.dataset).catch(() => []);
        const fromApexOs = f.usedBy.filter((u) => u.type === 'app').map((u) => u.name);
        f.encryption.appsAffected = [...new Set([...fromTrueNas, ...fromApexOs])].sort();
      }
      const record = enc.conversions?.[f.dataset];
      if (record) {
        const original = record.status === 'done' ? byId.get(record.original) : undefined;
        f.conversion = conversionView(ctx, record, original ? propNumber(original.used) : null);
      } else f.conversion = null;
    }),
  );
  return folders;
}

interface TnAttachment {
  type: string;
  service: string | null;
  attachments: string[];
}

async function attachments(client: TrueNasClient, dataset: string): Promise<TnAttachment[]> {
  return client.call<TnAttachment[]>('pool.dataset.attachments', [dataset]);
}

function isAppAttachment(a: TnAttachment): boolean {
  return a.service === 'docker' || /application|^apps?$/i.test(a.type);
}

async function attachedApps(client: TrueNasClient, dataset: string): Promise<string[]> {
  return (await attachments(client, dataset)).filter(isAppAttachment).flatMap((a) => a.attachments);
}

// ---------------------------------------------------------------------------
// New folders
// ---------------------------------------------------------------------------

export function validatePassphrase(passphrase: string | undefined, field = 'passphrase'): string {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE) {
    throw new UserError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`, 400, 'VALIDATION', { [field]: `At least ${MIN_PASSPHRASE} characters` });
  }
  if (passphrase.length > MAX_PASSPHRASE) {
    throw new UserError(`Use a passphrase of at most ${MAX_PASSPHRASE} characters.`, 400, 'VALIDATION', { [field]: `At most ${MAX_PASSPHRASE} characters` });
  }
  return passphrase;
}

/** Checks the encryption choice of a new folder against the pool it goes on. */
export async function validateNewFolderEncryption(ctx: AppContext, pool: string, enc: NewFolderEncryption | undefined): Promise<void> {
  const mode = enc?.mode ?? 'none';
  if (mode === 'passphrase') validatePassphrase(enc?.passphrase, 'encryption.passphrase');
  if (mode === 'none') return;
  const root = await getDataset(ctx.truenas.client(), pool);
  if (root?.encrypted && encryptionMode(root) === 'passphrase' && mode === 'key') {
    throw new UserError('This pool is protected by a passphrase, so its folders can only use a passphrase too.', 400, 'VALIDATION', {
      'encryption.mode': 'Use a passphrase on this pool',
    });
  }
  if (root?.locked) throw new UserError('This pool is locked. Unlock it in TrueNAS first.', 409, 'LOCKED');
}

/** `pool.dataset.create` fields for a new folder: its own encryption root, or nothing. */
export function datasetCreateEncryption(enc: NewFolderEncryption | undefined): Record<string, unknown> {
  switch (enc?.mode ?? 'none') {
    case 'key':
      return { encryption: true, inherit_encryption: false, encryption_options: { generate_key: true, algorithm: 'AES-256-GCM' } };
    case 'passphrase':
      return {
        encryption: true,
        inherit_encryption: false,
        encryption_options: { passphrase: enc!.passphrase, pbkdf2iters: PBKDF2_ITERS, algorithm: 'AES-256-GCM' },
      };
    default:
      return {};
  }
}

/** After a folder was created: a new automatic key isn't in the recovery file yet. */
export async function afterFolderCreated(ctx: AppContext, dataset: string, enc: NewFolderEncryption | undefined): Promise<void> {
  if (enc?.mode === 'key') await markRecoveryPending(ctx, dataset, true);
}

/** After a folder was deleted: forget bookkeeping and remove its kept unencrypted original, if any. */
export async function afterFolderDeleted(ctx: AppContext, dataset: string): Promise<void> {
  const record = stored(ctx).conversions?.[dataset];
  if (record?.status === 'done' && record.keepOriginal) {
    const client = ctx.truenas.client();
    const original = await getDataset(client, record.original);
    if (original && userProp(original, SAFETY_COPY_PROPERTY) === dataset) {
      await client.call('pool.dataset.delete', [record.original, { recursive: true }]);
    }
  }
  await updateStored(ctx, (e) => {
    if (e.conversions) delete e.conversions[dataset];
    if (e.stoppedApps) delete e.stoppedApps[dataset];
    e.pendingRecovery = (e.pendingRecovery ?? []).filter((d) => d !== dataset);
  });
}

// ---------------------------------------------------------------------------
// Guards used by the folder routes
// ---------------------------------------------------------------------------

function activeConversion(ctx: AppContext, dataset: string): ConversionRecord | undefined {
  const record = stored(ctx).conversions?.[dataset];
  return record && record.status !== 'done' ? record : undefined;
}

/** Edit/Delete/Lock aren't possible while encryption is being turned on (or needs a Retry). */
export function assertNotConverting(ctx: AppContext, folder: Folder): void {
  if (activeConversion(ctx, folder.dataset)) {
    throw new UserError('Encryption is being turned on for this folder. Wait until it finishes, or discard the attempt first.', 409, 'CONVERTING');
  }
}

/** Saving a folder touches its files' permissions, which isn't possible while it is locked. */
export function assertFolderEditable(ctx: AppContext, folder: Folder): void {
  assertNotConverting(ctx, folder);
  if (folder.encryption?.locked) throw new UserError('Unlock this folder before changing its settings.', 409, 'LOCKED');
}

// ---------------------------------------------------------------------------
// Lock / unlock
// ---------------------------------------------------------------------------

function requireOwnKey(folder: Folder): FolderEncryption {
  const enc = folder.encryption;
  if (!enc || enc.mode === 'none') throw new UserError('This folder isn’t encrypted.', 409, 'NOT_ENCRYPTED');
  if (enc.inherited) {
    throw new UserError(`This folder uses the key of ${enc.root}, so it is locked, unlocked and re-keyed together with it.`, 409, 'INHERITED');
  }
  return enc;
}

export async function prepareLock(ctx: AppContext, name: string): Promise<Folder> {
  const folder = await getFolder(ctx, name);
  assertNotConverting(ctx, folder);
  const enc = requireOwnKey(folder);
  if (enc.mode !== 'passphrase') {
    throw new UserError(
      'Folders with an automatic key can’t be locked: the server keeps their key and unlocks them by itself. Switch the folder to a passphrase if you want to lock it.',
      409,
      'NOT_LOCKABLE',
    );
  }
  if (enc.locked) throw new UserError('This folder is already locked.', 409, 'ALREADY_LOCKED');
  if (ctx.tasks.findRunning('folder-unlock', folder.name) || ctx.tasks.findRunning('folder-key-mode', folder.name)) {
    throw new UserError('Something else is changing this folder right now. Try again in a moment.', 409, 'BUSY');
  }
  return folder;
}

export async function lockFolder(ctx: AppContext, folder: Folder, t: TaskContext): Promise<void> {
  const client = ctx.truenas.client();
  const running = await t.step('Checking which apps use it', async () => {
    const names = await attachedApps(client, folder.dataset).catch(() => [] as string[]);
    if (!names.length) return [];
    const apps = await client.call<TnApp[]>('app.query', [[['name', 'in', names]], { select: ['name', 'state'] }]);
    return apps.filter((a) => a.state !== 'STOPPED').map((a) => a.name);
  });
  await updateStored(ctx, (e) => {
    e.stoppedApps ??= {};
    if (running.length) e.stoppedApps[folder.dataset] = running;
    else delete e.stoppedApps[folder.dataset];
  });
  await t.step('Locking the folder', (report) =>
    client.job('pool.dataset.lock', [folder.dataset, { force_umount: false }], (job) => report(job.progress.percent ?? 0)),
  );
  ctx.bus.changed('folders');
  if (running.length) ctx.bus.changed('apps');
}

function unlockSecret(enc: FolderEncryption, req: UnlockFolderRequest): { field: 'passphrase' | 'key'; value: string } {
  if (enc.mode === 'passphrase') {
    if (!req.passphrase) throw new UserError('Enter the folder’s passphrase.', 400, 'VALIDATION', { passphrase: 'Required' });
    return { field: 'passphrase', value: req.passphrase };
  }
  const key = req.key?.trim().toLowerCase() ?? '';
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new UserError('That isn’t a key for this folder. Choose the recovery file that was downloaded from this server.', 400, 'VALIDATION', {
      key: 'Not a valid key',
    });
  }
  return { field: 'key', value: key };
}

/** Checks the passphrase or key with a dry run (`pool.dataset.encryption_summary`) so mistakes come back as a 400. */
async function verifySecret(client: TrueNasClient, dataset: string, secret: { field: 'passphrase' | 'key'; value: string }): Promise<void> {
  const summary = await client.job<{ name: string; valid_key: boolean }[]>('pool.dataset.encryption_summary', [
    dataset,
    { datasets: [{ name: dataset, [secret.field]: secret.value }] },
  ]);
  const entry = summary.find((s) => s.name === dataset);
  if (!entry?.valid_key) {
    const message = secret.field === 'passphrase' ? 'That passphrase doesn’t unlock this folder.' : 'That key doesn’t unlock this folder.';
    throw new UserError(message, 400, 'WRONG_SECRET', { [secret.field]: message });
  }
}

export async function prepareUnlock(ctx: AppContext, name: string, req: UnlockFolderRequest): Promise<Folder> {
  const folder = await getFolder(ctx, name);
  assertNotConverting(ctx, folder);
  const enc = requireOwnKey(folder);
  if (!enc.locked) throw new UserError('This folder is already unlocked.', 409, 'NOT_LOCKED');
  if (ctx.tasks.findRunning('folder-unlock', folder.name)) throw new UserError('This folder is already being unlocked.', 409, 'BUSY');
  await verifySecret(ctx.truenas.client(), folder.dataset, unlockSecret(enc, req));
  return folder;
}

async function unlockDataset(client: TrueNasClient, dataset: string, secret: { field: 'passphrase' | 'key'; value: string }, report?: (p: number) => void): Promise<void> {
  const res = await client.job<{ unlocked: string[]; failed: Record<string, { error: string | null }> }>(
    'pool.dataset.unlock',
    [dataset, { datasets: [{ name: dataset, [secret.field]: secret.value, recursive: true }], recursive: true, toggle_attachments: true }],
    (job) => report?.(job.progress.percent ?? 0),
  );
  const failure = res.failed?.[dataset];
  if (failure || !res.unlocked.includes(dataset)) {
    const why = failure?.error ?? 'TrueNAS didn’t unlock it';
    throw new UserError(/invalid key/i.test(why) ? 'That passphrase or key doesn’t unlock this folder.' : `The folder couldn’t be unlocked: ${why}`, 400, 'UNLOCK_FAILED');
  }
}

/** Unlocking brings the share back by itself; apps ApexOs stopped when locking are started again here. */
async function restartStoppedApps(ctx: AppContext, dataset: string, t: TaskContext): Promise<void> {
  const names = stored(ctx).stoppedApps?.[dataset] ?? [];
  if (!names.length) return;
  const client = ctx.truenas.client();
  await t.step('Starting apps again', async () => {
    const existing = new Set((await client.call<TnApp[]>('app.query', [[['name', 'in', names]], { select: ['name'] }])).map((a) => a.name));
    const problems: string[] = [];
    for (const name of names.filter((n) => existing.has(n))) {
      await client.job(`app.start`, [name]).catch((err) => problems.push(`${name}: ${errorMessage(err)}`));
    }
    await updateStored(ctx, (e) => {
      if (e.stoppedApps) delete e.stoppedApps[dataset];
    });
    ctx.bus.changed('apps');
    if (problems.length) throw new UserError(`The folder is unlocked, but some apps didn’t start: ${problems.join('; ')}`, 502, 'APPS_NOT_STARTED');
  });
}

export async function unlockFolder(ctx: AppContext, folder: Folder, req: UnlockFolderRequest, t: TaskContext): Promise<void> {
  const secret = unlockSecret(folder.encryption!, req);
  await t.step('Unlocking the folder', (report) => unlockDataset(ctx.truenas.client(), folder.dataset, secret, report));
  ctx.bus.changed('folders');
  await restartStoppedApps(ctx, folder.dataset, t);
}

// ---------------------------------------------------------------------------
// Key mode
// ---------------------------------------------------------------------------

export async function prepareKeyModeChange(ctx: AppContext, name: string, req: ChangeKeyModeRequest): Promise<Folder> {
  const folder = await getFolder(ctx, name);
  assertNotConverting(ctx, folder);
  const enc = requireOwnKey(folder);
  if (enc.mode === req.mode) {
    throw new UserError(req.mode === 'key' ? 'This folder already uses an automatic key.' : 'This folder already uses a passphrase.', 409, 'NO_CHANGE');
  }
  if (req.mode === 'passphrase') validatePassphrase(req.passphrase);
  if (enc.locked) {
    if (enc.mode !== 'passphrase') {
      throw new UserError('Unlock this folder with its recovery file first, then change how it is unlocked.', 409, 'LOCKED');
    }
    if (!req.currentPassphrase) {
      throw new UserError('This folder is locked. Enter its current passphrase to change it.', 400, 'VALIDATION', { currentPassphrase: 'Required' });
    }
    await verifySecret(ctx.truenas.client(), folder.dataset, { field: 'passphrase', value: req.currentPassphrase });
  }
  if (ctx.tasks.findRunning('folder-key-mode', folder.name) || ctx.tasks.findRunning('folder-lock', folder.name)) {
    throw new UserError('Something else is changing this folder right now. Try again in a moment.', 409, 'BUSY');
  }
  return folder;
}

export async function changeKeyMode(ctx: AppContext, folder: Folder, req: ChangeKeyModeRequest, t: TaskContext): Promise<void> {
  const client = ctx.truenas.client();
  if (folder.encryption!.locked) {
    await t.step('Unlocking the folder', (report) => unlockDataset(client, folder.dataset, { field: 'passphrase', value: req.currentPassphrase! }, report));
    await restartStoppedApps(ctx, folder.dataset, t);
  }
  if (req.mode === 'passphrase') {
    await t.step('Setting the passphrase', () => client.job('pool.dataset.change_key', [folder.dataset, { passphrase: req.passphrase, pbkdf2iters: PBKDF2_ITERS }]));
    await markRecoveryPending(ctx, folder.dataset, false);
  } else {
    await t.step('Switching to an automatic key', () => client.job('pool.dataset.change_key', [folder.dataset, { key: randomBytes(32).toString('hex') }]));
    await markRecoveryPending(ctx, folder.dataset, true);
  }
  // A conversion that couldn't apply the chosen passphrase is settled once the user picks a mode here.
  const record = stored(ctx).conversions?.[folder.dataset];
  if (record?.passphrasePending) {
    await updateStored(ctx, (e) => {
      const r = e.conversions?.[folder.dataset];
      if (!r) return;
      r.passphrasePending = false;
      if (r.status === 'done' && !r.keepOriginal) delete e.conversions![folder.dataset];
    });
  }
  ctx.bus.changed('folders');
}

// ---------------------------------------------------------------------------
// Turning on encryption for an existing folder (Copy strategy)
// ---------------------------------------------------------------------------

interface TnReplicationTask {
  id: number;
  name: string;
  source_datasets: string[];
  target_dataset: string;
  direction: string;
}

function inside(id: string, root: string): boolean {
  return id === root || id.startsWith(`${root}/`);
}

function durationOf(bytes: number): ConversionDuration {
  const seconds = bytes / COPY_BYTES_PER_SEC;
  if (seconds < 15 * 60) return 'minutes';
  if (seconds < 3600) return 'up-to-an-hour';
  if (seconds < 6 * 3600) return 'a-few-hours';
  return 'a-day-or-more';
}

function dateStamp(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

interface ConversionPlan extends ConversionCheck {
  folder: Folder;
  temp: string;
  original: string;
}

/**
 * Everything that would stop "Turn on encryption", explained, plus the space and time it takes.
 * `ownRun` is set when the conversion task itself re-checks before copying (its own record, task and
 * partial copy don't count then).
 */
export async function checkConversion(ctx: AppContext, name: string, opts: { ownRun?: boolean } = {}): Promise<ConversionPlan> {
  const client = ctx.truenas.client();
  const folder = await getFolder(ctx, name);
  const blockers: ConversionCheck['blockers'] = [];
  const block = (code: string, message: string) => blockers.push({ code, message });
  const record = stored(ctx).conversions?.[folder.dataset];
  const temp = `${folder.pool}/${TEMP_PREFIX}${folder.name}`;

  if (folder.system) block('SYSTEM_FOLDER', 'ApexOs looks after this folder for apps or locations, so encryption can only be turned on for your own folders.');
  if (folder.encryption?.mode !== 'none') block('ALREADY_ENCRYPTED', 'This folder is already encrypted.');
  if (record && record.status !== 'done' && !opts.ownRun) block('BUSY', 'Encryption is already being turned on for this folder. Use Retry or Discard on the folder page.');
  const other = Object.values(stored(ctx).conversions ?? {}).find((r) => r.dataset !== folder.dataset && r.status !== 'done');
  const runningTask = ctx.tasks.findRunning('folder-encrypt');
  if (other || (runningTask && !(opts.ownRun && runningTask.ref === folder.name))) {
    block('BUSY', `Encryption is being turned on for ${other?.folder ?? 'another folder'}. One folder at a time, so wait until that finishes.`);
  }

  const [all, pool, snapshots, attached, replications, ownShares] = await Promise.all([
    queryDatasets(client, [['OR', [['id', '=', folder.dataset], ['id', '^', `${folder.dataset}/`], ['id', '=', folder.pool], ['id', '=', temp], ['id', '^', `${folder.pool}/${folder.name}-unencrypted-`]]]]),
    getDataset(client, folder.pool),
    client.call<number>('pool.snapshot.query', [[['OR', [['dataset', '=', folder.dataset], ['dataset', '^', `${folder.dataset}/`]]]], { count: true }]).catch(() => 0),
    attachments(client, folder.dataset).catch(() => [] as TnAttachment[]),
    client.call<TnReplicationTask[]>('replication.query').catch(() => [] as TnReplicationTask[]),
    client.call<TnSmbShare[]>('sharing.smb.query', [[['path', '=', folder.path]]]).catch(() => [] as TnSmbShare[]),
  ]);
  const ownShareNames = new Set(ownShares.map((s) => s.name.toLowerCase()));
  const self = all.find((d) => d.id === folder.dataset);
  const children = all.filter((d) => d.id.startsWith(`${folder.dataset}/`));

  for (const c of children.filter((d) => d.encrypted)) {
    block('CHILD_ENCRYPTED', `“${c.id.slice(folder.dataset.length + 1)}” inside this folder has its own encryption. An encrypted copy can’t include it, so it has to be moved out or removed first.`);
  }
  const apps = [...new Set([...attached.filter(isAppAttachment).flatMap((a) => a.attachments), ...folder.usedBy.filter((u) => u.type === 'app').map((u) => u.name)])];
  if (apps.length) {
    block(
      'APPS',
      `${list(apps)} ${apps.length === 1 ? 'keeps' : 'keep'} files in this folder. Turning on encryption swaps the folder for an encrypted copy, which would pull it out from under ${apps.length === 1 ? 'that app' : 'those apps'}. Remove ${apps.length === 1 ? 'it' : 'them'} or point ${apps.length === 1 ? 'it' : 'them'} at another folder first.`,
    );
  }
  for (const a of attached.filter((x) => !isAppAttachment(x))) {
    if (a.service === 'cifs' || /smb/i.test(a.type)) {
      const extra = a.attachments.filter((s) => !ownShareNames.has(s.toLowerCase()));
      if (extra.length) {
        block('CHILD_SHARED', `The network share${extra.length === 1 ? '' : 's'} ${list(extra.map((s) => `“${s}”`))} ${extra.length === 1 ? 'points' : 'point'} into this folder. Remove ${extra.length === 1 ? 'it' : 'them'} in TrueNAS first; ApexOs only moves the folder’s own share.`);
      }
    } else {
      block('IN_USE', `TrueNAS uses this folder for ${a.type} (${list(a.attachments)}). Remove that first.`);
    }
  }
  const backups = replications.filter((r) => r.source_datasets.some((s) => inside(s, folder.dataset) || inside(folder.dataset, s)) || inside(r.target_dataset, folder.dataset));
  if (backups.length) {
    block('REPLICATION', `The backup task ${list(backups.map((r) => `“${r.name}”`))} copies this folder. Remove the folder from that backup first: swapping in the encrypted copy breaks its chain of restore points.`);
  }
  const lockedRoot = pool?.locked;
  if (lockedRoot) block('LOCKED_PARENT', 'This pool is locked. Unlock it in TrueNAS first.');

  const used = self ? propNumber(self.used) : folder.usedBytes;
  // The copy is slightly larger (encryption overhead) and the pool must not end up completely full.
  const spaceNeededBytes = Math.ceil(used * 1.03) + GiB;
  const freeBytes = pool ? propNumber(pool.available) : 0;
  const copyStarted = opts.ownRun && all.some((d) => d.id === temp);
  if (freeBytes < spaceNeededBytes && !copyStarted) {
    block(
      'SPACE',
      `The encrypted copy needs about ${formatBytes(spaceNeededBytes)} of free space on ${folder.poolDisplayName}, but only ${formatBytes(freeBytes)} is free. Free up space or add drives, then try again.`,
    );
  }

  let original = `${folder.pool}/${folder.name}-unencrypted-${dateStamp()}`;
  for (let i = 2; all.some((d) => d.id === original); i++) original = `${folder.pool}/${folder.name}-unencrypted-${dateStamp()}-${i}`;
  if (all.some((d) => d.id === temp) && !record) {
    block('NAME_TAKEN', `A dataset called “${temp}” is in the way, probably left over from an earlier attempt. Remove it in TrueNAS first.`);
  }

  return {
    folder,
    temp,
    original,
    allowed: blockers.length === 0,
    blockers,
    spaceNeededBytes,
    freeBytes,
    duration: durationOf(used),
    childDatasets: children.map((c) => c.id.slice(folder.dataset.length + 1)),
    snapshots: typeof snapshots === 'number' ? snapshots : 0,
  };
}

const CONVERSION_STEPS = [
  'Checking space and usage',
  'Taking a snapshot',
  'Making an encrypted copy',
  'Pausing network sharing',
  'Copying the latest changes',
  'Checking the copy',
  'Switching over',
  'Saving the key',
  'Restoring settings',
  'Cleaning up',
];

function conversionTitle(folder: string): string {
  return `Encrypting folder ${folder}`;
}

export async function startConversion(ctx: AppContext, name: string, req: StartConversionRequest): Promise<Task> {
  if (req.mode === 'passphrase') validatePassphrase(req.passphrase);
  const plan = await checkConversion(ctx, name);
  if (!plan.allowed) throw new UserError(plan.blockers.map((b) => b.message).join(' '), 409, 'CANNOT_CONVERT');
  const { folder } = plan;
  const record: ConversionRecord = {
    folder: folder.name,
    dataset: folder.dataset,
    pool: folder.pool,
    path: folder.path,
    temp: plan.temp,
    original: plan.original,
    mode: req.mode,
    key: randomBytes(32).toString('hex'),
    keepOriginal: req.keepOriginal !== false,
    status: 'running',
    step: null,
    error: null,
    taskId: null,
    renamedOriginal: false,
    switched: false,
    share: null,
    quota: null,
    refquota: null,
    passphrasePending: false,
    startedAt: new Date().toISOString(),
    removeAfter: null,
  };
  // The key is escrowed before anything happens on the server.
  await updateStored(ctx, (e) => {
    e.conversions ??= {};
    e.conversions[folder.dataset] = record;
  });
  return launchConversion(ctx, folder.dataset, req.mode === 'passphrase' ? req.passphrase : undefined);
}

export async function retryConversion(ctx: AppContext, name: string, passphrase: string | undefined): Promise<Task> {
  const folder = await getFolder(ctx, name).catch(() => null);
  const record = Object.values(stored(ctx).conversions ?? {}).find((r) => r.folder.toLowerCase() === name.toLowerCase() || r.dataset === folder?.dataset);
  if (!record || record.status === 'done') throw new UserError('There is nothing to retry for this folder.', 409, 'NOTHING_TO_RETRY');
  if (record.taskId && ctx.tasks.get(record.taskId)?.status === 'running') throw new UserError('Encryption is still being turned on for this folder.', 409, 'BUSY');
  if (passphrase !== undefined && passphrase !== '') validatePassphrase(passphrase);
  await updateStored(ctx, (e) => {
    const r = e.conversions?.[record.dataset];
    if (r) Object.assign(r, { status: 'running', error: null });
  });
  return launchConversion(ctx, record.dataset, record.mode === 'passphrase' && passphrase ? passphrase : undefined);
}

function launchConversion(ctx: AppContext, dataset: string, passphrase: string | undefined): Task {
  const record = stored(ctx).conversions![dataset]!;
  const task = ctx.tasks.start({ type: 'folder-encrypt', title: conversionTitle(record.folder), ref: record.folder, steps: CONVERSION_STEPS }, (t) =>
    runConversion(ctx, dataset, passphrase, t),
  );
  void updateStored(ctx, (e) => {
    const r = e.conversions?.[dataset];
    if (r) r.taskId = task.id;
  });
  ctx.bus.changed('folders');
  return task;
}

async function patchRecord(ctx: AppContext, dataset: string, patch: Partial<ConversionRecord>): Promise<ConversionRecord> {
  await updateStored(ctx, (e) => {
    const r = e.conversions?.[dataset];
    if (r) Object.assign(r, patch);
  });
  return stored(ctx).conversions![dataset]!;
}

async function snapshotNames(client: TrueNasClient, dataset: string): Promise<string[]> {
  const snaps = await client.call<{ snapshot_name: string; createtxg: string }[]>('pool.snapshot.query', [[['dataset', '=', dataset]], { select: ['snapshot_name', 'createtxg'] }]);
  return snaps.sort((a, b) => Number(a.createtxg) - Number(b.createtxg)).map((s) => s.snapshot_name);
}

async function ensureSnapshot(client: TrueNasClient, dataset: string, name: string): Promise<void> {
  const exists = await client.call<unknown[]>('pool.snapshot.query', [[['id', '=', `${dataset}@${name}`]]]);
  if (!exists.length) await client.call('pool.snapshot.create', [{ dataset, name, recursive: true }]);
}

function replicationArgs(record: ConversionRecord, fromScratch: boolean): Record<string, unknown> {
  return {
    direction: 'PUSH',
    transport: 'LOCAL',
    source_datasets: [record.dataset],
    target_dataset: record.temp,
    recursive: true,
    properties: true,
    // Quotas are put back after the switch-over: the encrypted copy is a little larger than the original.
    properties_override: { quota: 'none', refquota: 'none' },
    // Every snapshot, so the folder keeps its restore points ("Previous versions").
    name_regex: '.*',
    retention_policy: 'NONE',
    // The default (SET) would leave the folder read-only.
    readonly: 'IGNORE',
    allow_from_scratch: false,
    only_from_scratch: fromScratch,
    mount: true,
    encryption: true,
    encryption_inherit: false,
    // Always an automatic key here; a chosen passphrase is applied with change_key at the end, so a
    // restart can't lose the only copy of the key in the middle of the run.
    encryption_key_format: 'HEX',
    encryption_key: record.key,
    encryption_key_location: '$TrueNAS',
  };
}

interface FsEntry {
  name: string;
  path: string;
  type: string;
  size: number;
  uid: number;
  gid: number;
  mode: number;
  is_mountpoint?: boolean;
}

/** Compares names, types, sizes, owners and modes of both trees (up to VERIFY_MAX_ENTRIES entries). */
async function compareTrees(client: TrueNasClient, from: string, to: string): Promise<string | null> {
  let seen = 0;
  const walk = async (rel: string): Promise<string | null> => {
    const [a, b] = await Promise.all([
      client.call<FsEntry[]>('filesystem.listdir', [`${from}${rel}`, [], { order_by: ['name'] }]),
      client.call<FsEntry[]>('filesystem.listdir', [`${to}${rel}`, [], { order_by: ['name'] }]),
    ]);
    if (a.length !== b.length) return `${rel || '/'} has ${a.length} items in the original and ${b.length} in the copy`;
    for (let i = 0; i < a.length; i++) {
      const x = a[i]!;
      const y = b[i]!;
      if (x.name !== y.name || x.type !== y.type || x.uid !== y.uid || x.gid !== y.gid || x.mode !== y.mode || (x.type === 'FILE' && x.size !== y.size)) {
        return `${rel}/${x.name}`;
      }
      if (++seen >= VERIFY_MAX_ENTRIES) return null;
      if (x.type === 'DIRECTORY') {
        const diff = await walk(`${rel}/${x.name}`);
        if (diff) return diff;
      }
    }
    return null;
  };
  return walk('');
}

async function runConversion(ctx: AppContext, dataset: string, passphrase: string | undefined, t: TaskContext): Promise<void> {
  const client = ctx.truenas.client();
  let record = stored(ctx).conversions![dataset]!;
  const step = async <T>(name: string, fn: (report: (percent: number, message?: string) => void) => Promise<T>): Promise<T> => {
    record = await patchRecord(ctx, dataset, { step: name });
    return t.step(name, fn);
  };
  const skip = (name: string, why: string) => t.skip(name, why);

  try {
    if (!record.switched) {
      await step('Checking space and usage', async () => {
        if (record.renamedOriginal) return;
        const plan = await checkConversion(ctx, record.folder, { ownRun: true }).catch((err) => {
          throw new UserError(`The folder couldn’t be checked: ${errorMessage(err)}`, 409, 'CHECK_FAILED');
        });
        if (!plan.allowed) throw new UserError(plan.blockers.map((b) => b.message).join(' '), 409, 'CANNOT_CONVERT');
      });

      await step('Taking a snapshot', () => ensureSnapshot(client, record.renamedOriginal ? record.original : dataset, `${SNAPSHOT_PREFIX}1`));

      await step('Making an encrypted copy', async (report) => {
        const copy = await getDataset(client, record.temp);
        if (copy) {
          if ((await snapshotNames(client, record.temp)).includes(`${SNAPSHOT_PREFIX}1`)) return;
          // A copy that never got its first snapshot is a half-received leftover: start it again.
          await client.call('pool.dataset.delete', [record.temp, { recursive: true }]);
        }
        await client.job('replication.run_onetime', [replicationArgs(record, true)], (job: Job) =>
          report(job.progress.percent ?? 0, job.progress.description ?? undefined),
        );
      });

      await step('Pausing network sharing', async () => {
        if (record.share) return;
        const [share] = await client.call<TnSmbShare[]>('sharing.smb.query', [[['path', '=', record.path]]]);
        record = await patchRecord(ctx, dataset, { share: share ? { id: share.id, wasEnabled: share.enabled } : null });
        if (share?.enabled) await client.call('sharing.smb.update', [share.id, { enabled: false }]);
      });

      await step('Copying the latest changes', async (report) => {
        if (record.renamedOriginal) return;
        await ensureSnapshot(client, dataset, `${SNAPSHOT_PREFIX}2`);
        const copied = await snapshotNames(client, record.temp);
        if (copied.includes(`${SNAPSHOT_PREFIX}2`)) return;
        await client.job('replication.run_onetime', [replicationArgs(record, false)], (job: Job) =>
          report(job.progress.percent ?? 0, job.progress.description ?? undefined),
        );
      });

      await step('Checking the copy', async () => {
        const source = record.renamedOriginal ? record.original : dataset;
        const [src, dst] = await Promise.all([
          queryDatasets(client, [['OR', [['id', '=', source], ['id', '^', `${source}/`]]]]),
          queryDatasets(client, [['OR', [['id', '=', record.temp], ['id', '^', `${record.temp}/`]]]]),
        ]);
        const rel = (ids: TnDataset[], root: string) => ids.map((d) => d.id.slice(root.length)).sort().join('|');
        if (rel(src, source) !== rel(dst, record.temp)) throw new UserError('The encrypted copy is missing part of the folder.', 500, 'COPY_MISMATCH');
        const copy = dst.find((d) => d.id === record.temp);
        if (!copy?.encrypted || copy.encryption_root !== record.temp) throw new UserError('The copy isn’t encrypted as expected.', 500, 'COPY_MISMATCH');
        for (const d of src) {
          const twin = `${record.temp}${d.id.slice(source.length)}`;
          const [a, b] = await Promise.all([snapshotNames(client, d.id), snapshotNames(client, twin)]);
          if (a.join('|') !== b.join('|')) throw new UserError(`The restore points of ${d.id} don’t match the copy.`, 500, 'COPY_MISMATCH');
        }
        const diff = await compareTrees(client, `/mnt/${source}`, `/mnt/${record.temp}`);
        if (diff) throw new UserError(`The encrypted copy doesn’t match the original at “${diff}”.`, 500, 'COPY_MISMATCH');
      });
    } else {
      for (const name of CONVERSION_STEPS.slice(0, 6)) skip(name, 'Done before');
    }

    await step('Switching over', async () => {
      const ds = await queryDatasets(client, [['id', 'in', [dataset, record.original, record.temp]]]);
      const find = (id: string) => ds.find((d) => d.id === id);
      const current = find(dataset);
      // A restart can land between a rename and ApexOs writing it down: look at what is actually there.
      const swapped = !find(record.temp) && !!find(record.original) && !!current?.encrypted && current.encryption_root === dataset;
      if (!swapped && !record.switched) {
        if (!record.renamedOriginal) {
          if (current && find(record.original)) {
            throw new UserError(`“${record.original}” already exists, so the original folder can’t be moved aside. Rename or remove that dataset in TrueNAS, then retry.`, 409, 'NAME_TAKEN');
          }
          if (current) await client.call('pool.dataset.rename', [dataset, { new_name: record.original, force: true }]);
          else if (!find(record.original)) throw new UserError('The original folder is missing, so ApexOs stopped before changing anything else.', 500, 'MISSING');
          record = await patchRecord(ctx, dataset, { renamedOriginal: true });
        }
        try {
          await client.call('pool.dataset.rename', [record.temp, { new_name: dataset, force: true }]);
        } catch (err) {
          // Put the original back under its name so the folder never stays missing.
          const restored = await client.call('pool.dataset.rename', [record.original, { new_name: dataset, force: true }]).then(
            () => true,
            () => false,
          );
          if (restored) record = await patchRecord(ctx, dataset, { renamedOriginal: false });
          throw err;
        }
      }
      record = await patchRecord(ctx, dataset, { renamedOriginal: true, switched: true });
      ctx.bus.changed('folders');
    });

    await step('Saving the key', async () => {
      // `pool.dataset.rename` doesn't move TrueNAS's stored key, so it is registered again under the folder's
      // name (this also resets keylocation). Without this the folder would stay locked after a restart.
      if (record.mode === 'passphrase' && passphrase) {
        await client.job('pool.dataset.change_key', [dataset, { passphrase, pbkdf2iters: PBKDF2_ITERS }]);
        record = await patchRecord(ctx, dataset, { passphrasePending: false });
      } else {
        if (record.key) await client.job('pool.dataset.change_key', [dataset, { key: record.key }]);
        const [entry] = await client.job<{ name: string; key_present_in_database: boolean; valid_key: boolean }[]>('pool.dataset.encryption_summary', [dataset]);
        if (!entry?.key_present_in_database || !entry.valid_key) {
          throw new UserError('TrueNAS didn’t confirm that it stored the folder’s key. Retry to save it again.', 502, 'KEY_NOT_STORED');
        }
        record = await patchRecord(ctx, dataset, { passphrasePending: record.mode === 'passphrase' });
      }
    });

    await step('Restoring settings', async () => {
      const [ds, original] = await Promise.all([getDataset(client, dataset), getDataset(client, record.original)]);
      if (!ds) throw new UserError('The encrypted folder is missing after the switch-over.', 500, 'MISSING');
      if (record.quota === null && record.refquota === null && original) {
        record = await patchRecord(ctx, dataset, {
          quota: propNumber(original.quota) || null,
          refquota: propNumber(original.refquota) || null,
        });
      }
      const used = propNumber(ds.used);
      const update: Record<string, unknown> = {};
      // The encrypted copy can be slightly larger; raise the limit just enough to fit it.
      if (record.quota) update.quota = Math.max(record.quota, used + GiB);
      if (record.refquota) update.refquota = Math.max(record.refquota, used + GiB);
      if (Object.keys(update).length) await client.call('pool.dataset.update', [dataset, update]);
      if (original && userProp(original, SAFETY_COPY_PROPERTY) !== dataset) {
        await client.call('pool.dataset.update', [
          record.original,
          { user_properties_update: [{ key: SAFETY_COPY_PROPERTY, value: dataset }, { key: FOLDER_PROPERTY, remove: true }] },
        ]);
      }
      if (record.share) {
        // The share's path string is unchanged and now leads to the encrypted folder.
        await client.call('sharing.smb.update', [record.share.id, { path: record.path, enabled: record.share.wasEnabled }]);
      }
    });

    await step('Cleaning up', async () => {
      for (const n of [1, 2]) {
        const snap = `${dataset}@${SNAPSHOT_PREFIX}${n}`;
        const exists = await client.call<unknown[]>('pool.snapshot.query', [[['id', '=', snap]]]);
        if (exists.length) await client.call('pool.snapshot.delete', [snap, { recursive: true }]);
      }
      if (!record.keepOriginal) {
        const original = await getDataset(client, record.original);
        if (original && userProp(original, SAFETY_COPY_PROPERTY) === dataset) await client.call('pool.dataset.delete', [record.original, { recursive: true }]);
      }
    });

    const removeAfter = new Date(Date.now() + SAFETY_COPY_DAYS * 24 * HOUR).toISOString();
    await updateStored(ctx, (e) => {
      const r = e.conversions?.[dataset];
      if (!r) return;
      Object.assign(r, { status: 'done', step: null, error: null, key: null, removeAfter });
      if (!r.keepOriginal && !r.passphrasePending) delete e.conversions![dataset];
      const pending = new Set(e.pendingRecovery ?? []);
      if (r.mode === 'key' || r.passphrasePending) pending.add(dataset);
      else pending.delete(dataset);
      e.pendingRecovery = [...pending];
    });
    await addNotice(ctx, {
      level: record.passphrasePending ? 'warning' : 'info',
      title: `Folder ${record.folder} is now encrypted`,
      message: record.passphrasePending
        ? 'ApexOs restarted before your passphrase could be set, so the folder uses an automatic key for now. Set a passphrase from the folder’s Encryption section.'
        : record.mode === 'key'
          ? 'Download a new recovery file in Settings → Recovery key so it includes this folder.'
          : 'Remember the passphrase: after a restart the folder stays locked until you type it.',
      link: '/folders',
    }).catch(() => undefined);
  } catch (err) {
    const message = errorMessage(err);
    if (!record.switched && record.share?.wasEnabled) {
      // Before the switch-over the original is untouched: share it again so nothing stays offline.
      await client.call('sharing.smb.update', [record.share.id, { enabled: true }]).catch(() => undefined);
    }
    await updateStored(ctx, (e) => {
      const r = e.conversions?.[dataset];
      if (r) Object.assign(r, { status: 'failed', error: message, ...(r.switched ? {} : { share: null }) });
    });
    await addNotice(ctx, {
      level: 'error',
      title: `Encrypting folder ${record.folder} didn’t finish`,
      message: `${message} ${record.switched ? 'Retry from the folder page to finish.' : 'Your folder is unchanged. Retry or discard the attempt from the folder page.'}`,
      link: '/folders',
    }).catch(() => undefined);
    throw err;
  } finally {
    ctx.bus.changed('folders');
  }
}

export async function discardConversion(ctx: AppContext, name: string): Promise<Task> {
  const record = Object.values(stored(ctx).conversions ?? {}).find((r) => r.folder.toLowerCase() === name.toLowerCase());
  if (!record || record.status === 'done') throw new UserError('There is no attempt to discard for this folder.', 409, 'NOTHING_TO_DISCARD');
  if (record.renamedOriginal || record.switched) {
    throw new UserError('The encrypted copy has already replaced the folder, so the attempt can only be finished. Use Retry.', 409, 'ALREADY_SWITCHED');
  }
  if (record.taskId && ctx.tasks.get(record.taskId)?.status === 'running') throw new UserError('Wait until the current step finishes.', 409, 'BUSY');
  return ctx.tasks.start({ type: 'folder-encrypt-discard', title: `Discarding encryption of ${record.folder}`, ref: record.folder }, async (t) => {
    const client = ctx.truenas.client();
    await t.step('Removing the partial copy', async () => {
      if (await getDataset(client, record.temp)) await client.call('pool.dataset.delete', [record.temp, { recursive: true }]);
    });
    await t.step('Removing temporary snapshots', async () => {
      for (const n of [1, 2]) {
        const snap = `${record.dataset}@${SNAPSHOT_PREFIX}${n}`;
        const exists = await client.call<unknown[]>('pool.snapshot.query', [[['id', '=', snap]]]);
        if (exists.length) await client.call('pool.snapshot.delete', [snap, { recursive: true }]);
      }
    });
    if (record.share?.wasEnabled) await t.step('Sharing the folder again', () => client.call('sharing.smb.update', [record.share!.id, { enabled: true }]));
    await updateStored(ctx, (e) => {
      if (e.conversions) delete e.conversions[record.dataset];
    });
    ctx.bus.changed('folders');
  });
}

export async function removeSafetyCopy(ctx: AppContext, name: string): Promise<Task> {
  const folder = await getFolder(ctx, name);
  const record = stored(ctx).conversions?.[folder.dataset];
  if (!record || record.status !== 'done' || !record.keepOriginal) throw new UserError('This folder has no unencrypted copy to remove.', 409, 'NO_SAFETY_COPY');
  return ctx.tasks.start({ type: 'folder-safety-copy', title: `Removing the unencrypted copy of ${folder.name}`, ref: folder.name }, (t) =>
    t.step('Removing the unencrypted copy', () => deleteSafetyCopy(ctx, record)),
  );
}

async function deleteSafetyCopy(ctx: AppContext, record: ConversionRecord): Promise<void> {
  const client = ctx.truenas.client();
  const original = await getDataset(client, record.original);
  // Only ever delete the dataset ApexOs marked as this folder's safety copy.
  if (original && userProp(original, SAFETY_COPY_PROPERTY) === record.dataset) {
    await client.call('pool.dataset.delete', [record.original, { recursive: true }]);
  }
  await updateStored(ctx, (e) => {
    const r = e.conversions?.[record.dataset];
    if (!r) return;
    if (r.passphrasePending) r.keepOriginal = false;
    else delete e.conversions![record.dataset];
  });
  ctx.bus.changed('folders');
}

/**
 * Periodic housekeeping: removes safety copies whose time is up. At start-up it also deals with runs that
 * were cut short by an ApexOs restart: runs past the first rename (the folder is mid-swap) and automatic-key
 * runs are resumed; a passphrase run that hasn't switched yet shares the untouched folder again and waits for
 * Retry, because the passphrase only ever lived in memory.
 */
export async function encryptionHousekeeping(ctx: AppContext, opts: { startup?: boolean } = {}): Promise<void> {
  if (!ctx.truenas.connected) return;
  const client = ctx.truenas.client();
  for (const record of Object.values(stored(ctx).conversions ?? {})) {
    const running = record.taskId ? ctx.tasks.get(record.taskId)?.status === 'running' : false;
    if (opts.startup && record.status === 'running' && !running) {
      if (record.renamedOriginal || record.mode === 'key') {
        try {
          launchConversion(ctx, record.dataset, undefined);
        } catch {
          // Shown as interrupted; the user can retry.
        }
      } else {
        if (record.share?.wasEnabled) await client.call('sharing.smb.update', [record.share.id, { enabled: true }]).catch(() => undefined);
        await patchRecord(ctx, record.dataset, {
          status: 'failed',
          share: null,
          error: 'ApexOs restarted while encrypting this folder. Nothing was switched yet and the folder is shared again. Retry to continue (you’ll be asked for the passphrase again).',
        });
        ctx.bus.changed('folders');
      }
      continue;
    }
    if (record.status === 'done' && record.keepOriginal && record.removeAfter && Date.parse(record.removeAfter) <= Date.now()) {
      await deleteSafetyCopy(ctx, record).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Recovery file
// ---------------------------------------------------------------------------

export async function recoveryStatus(ctx: AppContext): Promise<RecoveryKeyStatus> {
  const client = ctx.truenas.client();
  const { folders } = await listFolders(ctx);
  const enc = stored(ctx);
  const own = folders.filter((f) => f.encryption && !f.encryption.inherited);
  const keyFolders = own.filter((f) => f.encryption!.mode === 'key');
  const pools = [...new Set(keyFolders.map((f) => f.pool))];
  const present = new Map<string, boolean>();
  await Promise.all(
    pools.map(async (pool) => {
      const summary = await client
        .job<{ name: string; key_present_in_database: boolean }[]>('pool.dataset.encryption_summary', [pool])
        .catch(() => [] as { name: string; key_present_in_database: boolean }[]);
      for (const s of summary) present.set(s.name, s.key_present_in_database);
    }),
  );
  return {
    keyFolders: keyFolders.map((f) => ({
      name: f.name,
      pool: f.poolDisplayName,
      dataset: f.dataset,
      inFile: !f.encryption!.notInRecoveryFile,
      keyStored: present.get(f.dataset) ?? true,
    })),
    passphraseFolders: own.filter((f) => f.encryption!.mode === 'passphrase').map((f) => f.name),
    lastDownloadedAt: enc.recovery?.downloadedAt ?? null,
    addedSinceDownload: keyFolders.filter((f) => f.encryption!.notInRecoveryFile).length,
  };
}

/**
 * Builds the recovery file: `pool.dataset.export_keys` of every pool through `core.download`, fetched by
 * ApexOs (the download token only works for the connection that asked for it) and merged into one file in
 * TrueNAS's own key-file format, so TrueNAS can unlock folders with it directly.
 */
export async function buildRecoveryFile(ctx: AppContext): Promise<{ filename: string; body: string; count: number }> {
  const client = ctx.truenas.client();
  const pools = await client.call<{ name: string }[]>('pool.query', [[], { select: ['name'] }]);
  const keys: Record<string, string> = {};
  for (const pool of pools) {
    const [jobId, url] = await client.call<[number, string]>('core.download', ['pool.dataset.export_keys', [pool.name], `${pool.name}-keys.json`, true]);
    const text = await client.downloadText(url);
    const job = await client.waitForJob(jobId);
    if (job.state !== 'SUCCESS') throw new UserError(`TrueNAS couldn’t export the keys of ${pool.name}: ${job.error ?? job.state}`, 502, 'EXPORT_FAILED');
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new UserError(`TrueNAS returned an unreadable key file for ${pool.name}.`, 502, 'EXPORT_FAILED');
    }
    for (const [ds, key] of Object.entries(parsed as Record<string, unknown>)) if (typeof key === 'string') keys[ds] = key;
  }
  const now = new Date();
  await updateStored(ctx, (e) => {
    e.recovery = { downloadedAt: now.toISOString(), datasets: Object.keys(keys).sort() };
    e.pendingRecovery = [];
  });
  ctx.bus.changed('folders');
  const server = (ctx.store.get().server.name ?? 'server').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'server';
  const stamp = now.toISOString().slice(0, 10);
  return { filename: `apexos-recovery-${server}-${stamp}.json`, body: `${JSON.stringify(keys, null, 2)}\n`, count: Object.keys(keys).length };
}
