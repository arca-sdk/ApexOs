/**
 * `pool.dataset.*` encryption methods, following middleware 25.10 (`plugins/pool_/dataset_encryption_*.py`):
 * lock / unlock / encryption_summary / change_key / export_key / export_keys, plus the encryption part of
 * `pool.dataset.create` validation and what happens to keys on reboot.
 */
import { randomBytes } from 'node:crypto';
import type { Mock } from '../context.ts';
import { registerDownloadableJob } from '../download.ts';
import {
  ALGORITHMS,
  DEFAULT_PBKDF2ITERS,
  encryptionRootOf,
  isLocked,
  newEncryption,
  rootsUnder,
  storedKeys,
  storeKey,
  syncStoredKeys,
  unlockWithStoredKeys,
} from '../encryption.ts';
import { callError, validationErrors } from '../rpc.ts';
import type { DatasetEncryptionState, DatasetState } from '../state.ts';
import { descendants, getDataset, parentId, renderDataset } from '../storage.ts';
import { argObj, isObj, type Obj } from '../util.ts';
import { renderApp, visibleApps } from './apps.ts';
import { hostPaths } from './datasets.ts';
import { renderShare } from './smb.ts';

const HEX64 = /^[0-9a-fA-F]{64}$/;

function requireDataset(mock: Mock, id: unknown): DatasetState {
  const ds = typeof id === 'string' ? getDataset(mock.state, id) : undefined;
  if (!ds) throw callError('ENOENT', `${String(id)} dataset does not exist`);
  return ds;
}

/** Python `json.dumps` formatting (", " and ": " separators), as the middleware writes key files. */
function pyJson(obj: Record<string, string>): string {
  return `{${Object.entries(obj)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(', ')}}`;
}

/** Emits `changed` for a dataset tree and the shares inside it (their `locked` flag follows the datasets). */
function emitTree(mock: Mock, id: string): void {
  const { state } = mock;
  const root = getDataset(state, id);
  if (!root) return;
  for (const d of [root, ...descendants(state, id)]) mock.emit('pool.dataset.query', 'changed', d.id, renderDataset(state, d));
  const mp = `/mnt/${id}`;
  for (const s of state.shares) {
    if (s.path === mp || s.path.startsWith(`${mp}/`)) mock.emit('sharing.smb.query', 'changed', s.id, renderShare(s, state));
  }
}

/** Ancestors of a dataset name, closest first (`get_dataset_parents`). */
function parentsOf(id: string): string[] {
  const out: string[] = [];
  for (let p = parentId(id); p; p = parentId(p)) out.push(p);
  return out;
}

// ---------------------------------------------------------------------------
// pool.dataset.create
// ---------------------------------------------------------------------------

/**
 * Validates the encryption fields of `pool.dataset.create` (errors are added to `errors`) and returns the
 * encryption the new dataset gets as its own root, or undefined when it is unencrypted or inherits.
 */
export function createEncryption(mock: Mock, data: Obj, id: string, attr: string, errors: Array<[string, string]>): DatasetEncryptionState | undefined {
  const { state } = mock;
  const parent = parentId(id);
  const parentDs = parent ? getDataset(state, parent) : undefined;
  if (parentDs && isLocked(state, parentDs)) errors.push([`${attr}.name`, `${parent} must be unlocked to create ${id}.`]);

  if (data.encryption !== undefined && typeof data.encryption !== 'boolean') errors.push([`${attr}.encryption`, 'Input should be a valid boolean']);
  if (data.inherit_encryption !== undefined && typeof data.inherit_encryption !== 'boolean') {
    errors.push([`${attr}.inherit_encryption`, 'Input should be a valid boolean']);
  }
  const encryption = data.encryption === true;
  const inherit = data.inherit_encryption !== false;

  let unencryptedParent: string | null = null;
  for (const p of parentsOf(id)) {
    const ds = getDataset(state, p);
    if (!ds) continue;
    if (encryptionRootOf(state, ds)) {
      if (unencryptedParent) {
        errors.push([
          `${attr}.name`,
          `Creating an encrypted dataset within an unencrypted dataset is not allowed. In this case, '${unencryptedParent}' must be moved to an unencrypted dataset.`,
        ]);
        break;
      } else if (!encryption && !inherit) {
        errors.push([`${attr}.encryption`, `Cannot create an unencrypted dataset within an encrypted dataset (${p}).`]);
        break;
      }
    } else {
      unencryptedParent = p;
    }
  }

  const opts = data.encryption_options === undefined ? {} : data.encryption_options;
  if (!isObj(opts)) {
    errors.push([`${attr}.encryption_options`, 'Input should be a valid dictionary']);
    return undefined;
  }
  const oattr = `${attr}.encryption_options`;
  const passphrase = opts.passphrase ?? null;
  const key = opts.key ?? null;
  const algorithm = opts.algorithm ?? 'AES-256-GCM';
  const pbkdf2iters = opts.pbkdf2iters ?? DEFAULT_PBKDF2ITERS;
  if (passphrase !== null && (typeof passphrase !== 'string' || passphrase.length < 8)) errors.push([`${oattr}.passphrase`, 'String should have at least 8 characters']);
  if (key !== null && (typeof key !== 'string' || key.length !== 64)) errors.push([`${oattr}.key`, 'String should have exactly 64 characters']);
  if (typeof algorithm !== 'string' || !ALGORITHMS.includes(algorithm)) errors.push([`${oattr}.algorithm`, `Input should be ${ALGORITHMS.map((a) => `'${a}'`).join(', ')}`]);
  if (typeof pbkdf2iters !== 'number' || !Number.isInteger(pbkdf2iters) || pbkdf2iters < 100000) errors.push([`${oattr}.pbkdf2iters`, 'Input should be greater than or equal to 100000']);
  if (!encryption) return undefined;

  if (inherit) errors.push([`${attr}.inherit_encryption`, 'Must be disabled when encryption is enabled.']);
  if (!passphrase && parentDs) {
    const parentRoot = encryptionRootOf(state, parentDs);
    if (parentRoot?.encryption?.keyFormat === 'PASSPHRASE') {
      errors.push([`${attr}.encryption`, 'Passphrase encrypted datasets cannot have children encrypted with a key.']);
    }
  }
  if (passphrase) {
    for (const f of ['key', 'generate_key'] as const) {
      if (opts[f]) errors.push([`${oattr}.${f}`, 'Must be disabled when dataset is to be encrypted with passphrase.']);
    }
  } else {
    const provided = (['key', 'generate_key'] as const).filter((k) => opts[k]);
    if (!provided.length) {
      errors.push([`${oattr}.key`, 'Please provide a key or select generate_key to automatically generate a key when passphrase is not provided.']);
    } else if (provided.length > 1) {
      for (const k of provided) errors.push([`${oattr}.${k}`, `Only one of ${provided.join(', ')} must be provided.`]);
    }
  }
  if (typeof key === 'string' && key.length === 64 && !HEX64.test(key)) errors.push([`${oattr}.key`, 'Please specify a valid key']);
  if (errors.length) return undefined;
  if (passphrase) return newEncryption('PASSPHRASE', passphrase as string, { algorithm: algorithm as string, pbkdf2iters: pbkdf2iters as number });
  const hex = opts.generate_key ? randomBytes(32).toString('hex') : (key as string).toLowerCase();
  return newEncryption('HEX', hex, { algorithm: algorithm as string });
}

/** After `pool.dataset.create`: HEX keys go to the key store (passphrases never do). */
export function afterCreateEncryption(mock: Mock, ds: DatasetState): void {
  if (ds.encryption) storeKey(mock.state, ds.id, ds.encryption.keyFormat, ds.encryption.secret);
}

// ---------------------------------------------------------------------------
// Reboot / import
// ---------------------------------------------------------------------------

/**
 * Boot-time unlock of every imported pool (or one pool after import): key-encrypted roots unlock with the
 * keys TrueNAS stored under their *current* name; passphrase roots stay locked.
 */
export function unlockAfterBoot(mock: Mock, pool?: string): void {
  for (const r of unlockWithStoredKeys(mock.state, pool)) emitTree(mock, r.id);
}

/** Pool export: TrueNAS forgets the pool's stored keys and the datasets' keys are unloaded. */
export function lockForExport(datasets: DatasetState[]): void {
  for (const d of datasets) if (d.encryption) d.encryption.keyLoaded = false;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/** Running apps with a host path at or below `path` (the apps attachment delegate). */
function appsUsing(mock: Mock, path: string): string[] {
  const inside = (p: string) => p === path || p.startsWith(`${path}/`);
  return visibleApps(mock).filter((a) => a.state !== 'STOPPED' && hostPaths(a.config).some(inside)).map((a) => a.name);
}

interface UnlockRequest {
  name: string;
  key: string | null;
  recursive: boolean;
}

/** `options.datasets` of unlock / encryption_summary (the summary doesn't require a key per entry). */
function unlockDatasets(raw: unknown, errors: Array<[string, string]>, requireSecret = true): UnlockRequest[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(['unlock_options.datasets', 'Input should be a valid list']);
    return [];
  }
  const out: UnlockRequest[] = [];
  raw.forEach((d: unknown, i) => {
    const a = `unlock_options.datasets.${i}`;
    if (!isObj(d) || typeof d.name !== 'string' || !d.name) return void errors.push([`${a}.name`, 'Field required']);
    const key = typeof d.key === 'string' && d.key ? d.key : null;
    const passphrase = typeof d.passphrase === 'string' && d.passphrase ? d.passphrase : null;
    if (key && key.length !== 64) errors.push([`${a}.key`, 'String should have exactly 64 characters']);
    if (key && passphrase) errors.push([`${a}.dataset.key`, `Must not be specified when passphrase for ${d.name} is supplied`]);
    else if (!key && !passphrase && requireSecret) errors.push([`${a}.dataset`, `Passphrase or key must be specified for ${d.name}`]);
    out.push({ name: d.name, key: key ? key.toLowerCase() : passphrase, recursive: d.recursive === true });
  });
  return out;
}

export function registerEncryption(mock: Mock): void {
  const { server } = mock;

  server.job('pool.dataset.lock', async (p, job) => {
    const id = String(p[0]);
    const opts = argObj(p[1], 'options');
    const ds = requireDataset(mock, id);
    const root = encryptionRootOf(mock.state, ds);
    if (!root) throw callError('EFAULT', `${id} is not encrypted`);
    if (isLocked(mock.state, ds)) throw callError('EFAULT', `Dataset ${id} is already locked`);
    if (root.encryption!.keyFormat !== 'PASSPHRASE') throw callError('EFAULT', 'Only datasets which are encrypted with passphrase can be locked');
    if (root.id !== id) throw callError('EFAULT', `Please lock ${root.id}. Only encryption roots can be locked.`);
    void opts.force_umount;

    // Attachment delegates stop first: SMB shares go away (smb.conf `available = no`), apps are stopped.
    job.progress(20, 'Stopping services that use the dataset');
    for (const name of appsUsing(mock, `/mnt/${id}`)) {
      const app = visibleApps(mock).find((a) => a.name === name)!;
      app.state = 'STOPPED';
      mock.emit('app.query', 'changed', app.name, renderApp(mock, app));
    }
    await job.sleep();
    job.progress(70, 'Unloading key');
    for (const r of rootsUnder(mock.state, id)) r.encryption!.keyLoaded = false;
    emitTree(mock, id);
    return true;
  });

  server.job('pool.dataset.unlock', async (p, job) => {
    const id = String(p[0]);
    const opts = argObj(p[1], 'options');
    const ds = requireDataset(mock, id);
    if (opts.key_file === true) throw callError('EINVAL', 'Unlocking with an uploaded key file is not simulated; pass the keys in options.datasets');
    const errors: Array<[string, string]> = [];
    const requests = unlockDatasets(opts.datasets, errors);
    const supplied = new Map(requests.filter((r) => r.key).map((r) => [r.name, r.key!]));
    const recursive = opts.recursive === true;
    const keys = storedKeys(mock.state);
    if (id.includes('/') || !recursive) {
      if (!isLocked(mock.state, ds)) errors.push(['id', `${id} dataset is not locked`]);
      else if (encryptionRootOf(mock.state, ds)?.id !== id) errors.push(['id', 'Only encryption roots can be unlocked']);
      else if (!keys[id] && !supplied.has(id)) errors.push(['unlock_options.datasets', `Please specify key for ${id}`]);
    }
    if (errors.length) throw validationErrors(errors);

    const lockedParents = mock.state.datasets.filter((d) => d.encryption && !d.encryption.keyLoaded && id.startsWith(`${d.id}/`)).map((d) => d.id);
    if (lockedParents.length) throw callError('EFAULT', `${id} has locked parents ${lockedParents.join(',')} which must be unlocked first`);

    // Keys given with `recursive: true` also apply to encryption roots below that dataset.
    const roots = rootsUnder(mock.state, id).filter((r) => !r.encryption!.keyLoaded);
    for (const r of roots) {
      if (supplied.has(r.id)) continue;
      const parentReq = requests.find((q) => q.recursive && q.key && r.id.startsWith(`${q.name}/`));
      if (parentReq) supplied.set(r.id, parentReq.key!);
    }
    const names = (recursive ? roots : roots.filter((r) => r.id === id)).map((r) => r.id);
    const failed: Record<string, { error: string | null; skipped: string[] }> = {};
    const unlocked: string[] = [];
    for (const [i, name] of names.entries()) {
      const blocked = Object.keys(failed).find((f) => name.startsWith(`${f}/`));
      if (blocked) {
        failed[blocked]!.skipped.push(name);
        continue;
      }
      const root = getDataset(mock.state, name)!;
      const enc = root.encryption!;
      const key = supplied.get(name) ?? (enc.keyFormat !== 'PASSPHRASE' ? keys[name] : undefined);
      if (!key) {
        failed[name] = { error: 'Missing key', skipped: [] };
        continue;
      }
      job.progress(Math.round((i / names.length) * 90), `Unlocking '${name}'`);
      await job.sleep();
      if (key !== enc.secret) {
        failed[name] = { error: 'Invalid Key', skipped: [] };
        continue;
      }
      enc.keyLoaded = true;
      unlocked.push(name);
    }
    if (unlocked.length) {
      // toggle_attachments restarts shares (they read `locked` live); apps are *not* started again.
      job.progress(91, 'Handling attachments');
      job.progress(92, 'Updating database');
      for (const name of unlocked) {
        if (supplied.has(name)) storeKey(mock.state, name, getDataset(mock.state, name)!.encryption!.keyFormat, supplied.get(name));
      }
      job.progress(94, 'Running post-unlock tasks');
      emitTree(mock, id);
    }
    return { unlocked, failed };
  });

  server.job('pool.dataset.encryption_summary', async (p) => {
    const id = String(p[0]);
    const opts = argObj(p[1], 'options');
    requireDataset(mock, id);
    if (opts.key_file === true) throw callError('EINVAL', 'Checking an uploaded key file is not simulated; pass the keys in options.datasets');
    const errors: Array<[string, string]> = [];
    const requests = unlockDatasets(opts.datasets, errors, false).filter((r) => r.key);
    if (errors.length) throw validationErrors(errors);
    const supplied = new Map(requests.map((r) => [r.name, r.key!]));
    const keys = storedKeys(mock.state);
    const results = rootsUnder(mock.state, id).map((r) => {
      const enc = r.encryption!;
      const dbKey = enc.keyFormat !== 'PASSPHRASE' ? keys[r.id] : undefined;
      const key = supplied.get(r.id) ?? dbKey;
      return {
        name: r.id,
        key_format: enc.keyFormat,
        key_present_in_database: !!dbKey,
        valid_key: !!key && key === enc.secret,
        locked: !enc.keyLoaded,
        unlock_error: null as string | null,
        unlock_successful: false,
      };
    });
    const failed = new Set<string>();
    for (const r of results) {
      for (const anc of parentsOf(r.name)) {
        if (failed.has(anc)) {
          failed.add(r.name);
          r.unlock_error = `Child cannot be unlocked when parent "${anc}" is locked`;
        }
      }
      if (r.valid_key) r.unlock_successful = !r.unlock_error;
      else if (!r.locked) r.unlock_successful = true;
      else {
        const provided = supplied.has(r.name) || r.key_present_in_database;
        if (provided) r.unlock_error = r.unlock_error ? `${r.unlock_error} and provided key is invalid` : 'Provided key is invalid';
        else if (!r.unlock_error) r.unlock_error = 'Key not provided';
        failed.add(r.name);
      }
    }
    return results;
  });

  server.job('pool.dataset.change_key', async (p, job) => {
    const id = String(p[0]);
    const opts = argObj(p[1], 'change_key_options');
    const ds = requireDataset(mock, id);
    const errors: Array<[string, string]> = [];
    const root = encryptionRootOf(mock.state, ds);
    if (!root) errors.push(['id', 'Dataset is not encrypted']);
    else if (isLocked(mock.state, ds)) errors.push(['id', 'Dataset must be unlocked before key can be changed']);
    if (opts.key_file === true) throw callError('EINVAL', 'Reading a key file is not simulated; pass key, passphrase or generate_key');
    const passphrase = typeof opts.passphrase === 'string' && opts.passphrase ? opts.passphrase : null;
    const key = typeof opts.key === 'string' && opts.key ? opts.key : null;
    const generate = opts.generate_key === true;
    const pbkdf2iters = opts.pbkdf2iters ?? DEFAULT_PBKDF2ITERS;
    if (typeof pbkdf2iters !== 'number' || pbkdf2iters < 100000) errors.push(['change_key_options.pbkdf2iters', 'Input should be greater than or equal to 100000']);
    if (key && !HEX64.test(key)) errors.push(['change_key_options.key', 'String should have exactly 64 hexadecimal characters']);
    if (!errors.length) {
      if (passphrase) {
        if (generate || key) errors.push(['change_key_options.key', `Must not be specified when passphrase for ${id} is supplied.`]);
        else if (rootsUnder(mock.state, id).some((r) => r.id !== id && r.encryption!.keyFormat !== 'PASSPHRASE')) {
          errors.push([
            'change_key_options.passphrase',
            `${id} has children which are encrypted with a key. It is not allowed to have encrypted roots which are encrypted with a key as children for passphrase encrypted datasets.`,
          ]);
        }
      } else if (!generate && !key) {
        for (const k of ['key', 'passphrase', 'generate_key']) errors.push([`change_key_options.${k}`, 'Either Key or passphrase must be provided.']);
      } else if (parentsOf(id).some((a) => getDataset(mock.state, a)?.encryption?.keyFormat === 'PASSPHRASE')) {
        errors.push([
          'change_key_options.key',
          `${id} has parent(s) which are encrypted with a passphrase. It is not allowed to have encrypted roots which are encrypted with a key as children for passphrase encrypted datasets.`,
        ]);
      }
    }
    if (errors.length) throw validationErrors(errors);
    if (passphrase && passphrase.length < 8) throw callError('EFAULT', 'Failed to change key: Passphrase too short (min 8).');

    job.progress(50, 'Changing key');
    await job.sleep();
    // `zfs change-key` on the dataset: it becomes (or stays) its own encryption root; data isn't re-encrypted.
    const old = ds.encryption ?? { ...root!.encryption! };
    const enc: DatasetEncryptionState = passphrase
      ? { ...old, keyFormat: 'PASSPHRASE', secret: passphrase, pbkdf2iters: pbkdf2iters as number, keylocation: 'prompt', keyLoaded: true }
      : { ...old, keyFormat: 'HEX', secret: generate ? randomBytes(32).toString('hex') : key!.toLowerCase(), pbkdf2iters: 0, keylocation: 'prompt', keyLoaded: true };
    ds.encryption = enc;
    storeKey(mock.state, id, enc.keyFormat, enc.secret);
    if (passphrase && old.keyFormat !== 'PASSPHRASE') syncStoredKeys(mock.state, id);
    emitTree(mock, id);
    return null;
  });

  registerDownloadableJob(
    mock,
    'pool.dataset.export_key',
    async (p, _job, output) => {
      const id = String(p[0]);
      const download = p[1] === true;
      if (download && !output) throw new Error("Pipe 'output' is not open");
      requireDataset(mock, id);
      const key = storedKeys(mock.state)[id];
      if (!key) throw callError('EINVAL', "Specified dataset does not have it's own encryption key.");
      if (download) {
        output!.write(pyJson({ [id]: key }));
        return null;
      }
      return key;
    },
    { checkPipes: false },
  );

  registerDownloadableJob(
    mock,
    'pool.dataset.export_keys',
    async (p, job, output) => {
      const id = String(p[0]);
      requireDataset(mock, id);
      job.progress(30, 'Syncing stored keys');
      syncStoredKeys(mock.state, id);
      const keys = storedKeys(mock.state);
      const picked = Object.fromEntries(Object.entries(keys).filter(([k]) => k === id || k.startsWith(`${id}/`)));
      output!.write(pyJson(picked));
      return null;
    },
    { checkPipes: true },
  );
}
