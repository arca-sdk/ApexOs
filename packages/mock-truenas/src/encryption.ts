/**
 * ZFS native encryption model shared by the dataset, sharing, filesystem and replication namespaces.
 *
 * Only encryption roots carry `DatasetState.encryption`; every dataset below a root is encrypted with the
 * root's key, so "encrypted", "encryption root" and "locked" are derived by walking up the dataset names.
 * TrueNAS's stored keys live in `MockState.encryptionKeys` (dataset name → hex key), keyed by name exactly
 * like the middleware's `storage_encrypteddataset` table: renames leave records behind.
 *
 * This module only depends on state types so `storage.ts` can use it without an import cycle.
 */
import type { DatasetEncryptionState, DatasetState, MockState } from './state.ts';
import type { Obj } from './util.ts';

/** Asking for one of these in `extra.properties` makes the middleware compute the crypto fields. */
export const CRYPTO_PROPERTIES = ['encryption', 'encryptionroot', 'keyformat', 'keylocation', 'keystatus'];
export const ALGORITHMS = ['AES-128-CCM', 'AES-192-CCM', 'AES-256-CCM', 'AES-128-GCM', 'AES-192-GCM', 'AES-256-GCM'];
export const DEFAULT_PBKDF2ITERS = 350000;

function parentName(id: string): string | null {
  const i = id.lastIndexOf('/');
  return i === -1 ? null : id.slice(0, i);
}

function find(state: MockState, id: string): DatasetState | undefined {
  return state.datasets.find((d) => d.id === id);
}

function depth(id: string): number {
  return id.split('/').length;
}

/** TrueNAS's key store, created on first use (older state files don't have it). */
export function storedKeys(state: MockState): Record<string, string> {
  state.encryptionKeys ??= {};
  return state.encryptionKeys;
}

/** The nearest dataset at or above `ds` that is an encryption root. */
export function encryptionRootOf(state: MockState, ds: DatasetState): DatasetState | undefined {
  for (let id: string | null = ds.id; id; id = parentName(id)) {
    const cur = id === ds.id ? ds : find(state, id);
    if (cur?.encryption) return cur;
  }
  return undefined;
}

export function isEncrypted(state: MockState, ds: DatasetState): boolean {
  return !!encryptionRootOf(state, ds);
}

/** `locked` as the middleware reports it: encrypted and the key is not loaded. */
export function isLocked(state: MockState, ds: DatasetState): boolean {
  const root = encryptionRootOf(state, ds);
  return !!root && !root.encryption!.keyLoaded;
}

/**
 * `pool.dataset.path_in_locked_datasets`: strips `/mnt/` and checks the path and each parent component as a
 * dataset name. True when one of them is locked.
 */
export function pathInLockedDataset(state: MockState, path: string): boolean {
  if (!path.startsWith('/mnt/')) return false;
  const rel = path.slice('/mnt/'.length).replace(/\/+$/, '');
  for (let id: string | null = rel; id; id = parentName(id)) {
    const ds = find(state, id);
    if (ds && isLocked(state, ds)) return true;
  }
  return false;
}

/**
 * True for paths *inside* a locked dataset's mountpoint. A locked dataset's mountpoint itself is still there
 * (an empty, immutable directory); everything below it, including child datasets, is not.
 */
export function hiddenByLock(state: MockState, path: string): boolean {
  if (!path.startsWith('/mnt/')) return false;
  const rel = path.slice('/mnt/'.length).replace(/\/+$/, '');
  for (let id = parentName(rel); id; id = parentName(id)) {
    const ds = find(state, id);
    if (ds && isLocked(state, ds)) return true;
  }
  return false;
}

/** Encryption roots at or below `id`, parents first. */
export function rootsUnder(state: MockState, id: string): DatasetState[] {
  return state.datasets
    .filter((d) => d.encryption && (d.id === id || d.id.startsWith(`${id}/`)))
    .sort((a, b) => depth(a.id) - depth(b.id));
}

function zprop(parsed: unknown, rawvalue: string | null, value: string | null, source: string): Obj {
  return { parsed, rawvalue, value, source, source_info: null };
}

/**
 * Crypto entries of a `pool.dataset.query` item. With a narrow `extra.properties` list, `encrypted`,
 * `encryption_root`, `key_loaded` and `locked` are only present when one of `CRYPTO_PROPERTIES` was asked
 * for, and `key_format` / `encryption_algorithm` / `pbkdf2iters` only when their own property was.
 */
export function renderCryptoFields(state: MockState, ds: DatasetState, properties?: unknown): Obj {
  const all = !Array.isArray(properties);
  const asked = (p: string) => all || (properties as unknown[]).some((x) => typeof x === 'string' && x.toLowerCase() === p);
  const root = encryptionRootOf(state, ds);
  const enc = root?.encryption;
  const out: Obj = {};
  if (all || CRYPTO_PROPERTIES.some(asked)) {
    out.encrypted = !!enc;
    out.encryption_root = root?.id ?? null;
    out.key_loaded = !!enc?.keyLoaded;
    out.locked = !!enc && !enc.keyLoaded;
  }
  if (asked('keyformat')) {
    out.key_format = enc ? zprop(enc.keyFormat.toLowerCase(), enc.keyFormat.toLowerCase(), enc.keyFormat, 'NONE') : zprop('none', 'none', null, 'DEFAULT');
  }
  if (asked('encryption')) {
    out.encryption_algorithm = enc ? zprop(enc.algorithm.toLowerCase(), enc.algorithm.toLowerCase(), enc.algorithm, 'NONE') : zprop('off', 'off', null, 'DEFAULT');
  }
  if (asked('pbkdf2iters')) {
    const iters = String(enc?.pbkdf2iters ?? 0);
    out.pbkdf2iters = zprop(iters, iters, iters, enc ? 'NONE' : 'DEFAULT');
  }
  return out;
}

export function newEncryption(keyFormat: DatasetEncryptionState['keyFormat'], secret: string, opts: { algorithm?: string; pbkdf2iters?: number; keylocation?: string } = {}): DatasetEncryptionState {
  return {
    keyFormat,
    algorithm: opts.algorithm ?? 'AES-256-GCM',
    pbkdf2iters: keyFormat === 'PASSPHRASE' ? (opts.pbkdf2iters ?? DEFAULT_PBKDF2ITERS) : 0,
    secret,
    keyLoaded: true,
    keylocation: opts.keylocation ?? 'prompt',
  };
}

/** `insert_or_update_encrypted_record`: HEX/RAW keys are stored by dataset name; passphrases never are. */
export function storeKey(state: MockState, name: string, keyFormat: DatasetEncryptionState['keyFormat'], key: string | null | undefined): void {
  if (!key || keyFormat === 'PASSPHRASE') return;
  storedKeys(state)[name] = key;
}

/** Records for `name` and everything below it are dropped (dataset destroyed, pool exported). */
export function forgetKeys(state: MockState, name: string): void {
  const keys = storedKeys(state);
  for (const k of Object.keys(keys)) if (k === name || k.startsWith(`${name}/`)) delete keys[k];
}

/**
 * `pool.dataset.sync_db_keys`: removes stored keys that no longer open an existing encryption root with that
 * name (e.g. left behind by a rename, or replaced by a passphrase). Pools that aren't imported are skipped.
 */
export function syncStoredKeys(state: MockState, name?: string): string[] {
  const keys = storedKeys(state);
  const imported = new Set(state.pools.map((p) => p.name));
  const removed: string[] = [];
  for (const [ds, key] of Object.entries(keys)) {
    if (name && ds !== name && !ds.startsWith(`${name}/`)) continue;
    if (!imported.has(ds.split('/')[0]!)) continue;
    const cur = find(state, ds);
    const valid = !!cur?.encryption && cur.encryption.keyFormat !== 'PASSPHRASE' && cur.encryption.secret === key;
    if (!valid) {
      delete keys[ds];
      removed.push(ds);
    }
  }
  return removed;
}

/**
 * What the middleware does at boot and on import (`unlock_on_boot_impl`): every encryption root of the
 * pool(s) starts locked, then key-encrypted roots are unlocked with the stored keys (parents first).
 * Passphrase roots, and roots whose key isn't stored under their current name, stay locked.
 * Returns the datasets whose lock state changed.
 */
export function unlockWithStoredKeys(state: MockState, pool?: string): DatasetState[] {
  const keys = storedKeys(state);
  const changed: DatasetState[] = [];
  const roots = state.datasets
    .filter((d) => d.encryption && (!pool || d.pool === pool))
    .sort((a, b) => depth(a.id) - depth(b.id));
  const before = new Map(roots.map((r) => [r.id, r.encryption!.keyLoaded]));
  for (const r of roots) r.encryption!.keyLoaded = false;
  for (const r of roots) {
    const enc = r.encryption!;
    const parent = parentName(r.id);
    const parentDs = parent ? find(state, parent) : undefined;
    const parentLocked = parentDs ? isLocked(state, parentDs) : false;
    enc.keyLoaded = !parentLocked && enc.keyFormat !== 'PASSPHRASE' && keys[r.id] === enc.secret;
  }
  for (const r of roots) {
    if (before.get(r.id) !== r.encryption!.keyLoaded) changed.push(r);
  }
  return changed;
}
