import type { Mock } from '../context.ts';
import { callError, queryFilter, validationError, validationErrors } from '../rpc.ts';
import type { DatasetShareType, DatasetState, SnapshotState } from '../state.ts';
import {
  addDataset,
  datasetUsed,
  descendants,
  getDataset,
  INHERITABLE_PROPS,
  mountpoint,
  parentId,
  removeDatasetTree,
  renderDataset,
  renderSnapshot,
  sortDatasets,
} from '../storage.ts';
import { argObj, GiB, isObj, type Obj } from '../util.ts';
import { afterCreateEncryption, createEncryption } from './encryption.ts';

const COMPONENT_RE = /^[A-Za-z0-9_.: -]+$/;
const SHARE_TYPES: DatasetShareType[] = ['GENERIC', 'SMB', 'APPS', 'MULTIPROTOCOL', 'NFS'];
const ENUMS: Record<string, string[]> = {
  compression: ['ON', 'OFF', 'LZ4', 'GZIP', 'GZIP-1', 'GZIP-9', 'ZSTD', 'ZSTD-FAST', 'ZLE', 'LZJB', ...Array.from({ length: 19 }, (_, i) => `ZSTD-${i + 1}`)],
  atime: ['ON', 'OFF'],
  exec: ['ON', 'OFF'],
  readonly: ['ON', 'OFF'],
  sync: ['STANDARD', 'ALWAYS', 'DISABLED'],
  snapdir: ['VISIBLE', 'HIDDEN', 'DISABLED'],
  snapdev: ['HIDDEN', 'VISIBLE'],
  deduplication: ['ON', 'VERIFY', 'OFF'],
  checksum: ['ON', 'OFF', 'FLETCHER2', 'FLETCHER4', 'SHA256', 'SHA512', 'SKEIN', 'EDONR', 'BLAKE3'],
  aclmode: ['PASSTHROUGH', 'RESTRICTED', 'DISCARD'],
  acltype: ['OFF', 'NFSV4', 'POSIX'],
  casesensitivity: ['SENSITIVE', 'INSENSITIVE'],
  xattr: ['ON', 'SA'],
  recordsize: ['512', '512B', '1K', '2K', '4K', '8K', '16K', '32K', '64K', '128K', '256K', '512K', '1M', '2M', '4M', '8M', '16M'],
  copies: ['1', '2', '3'],
};

export function datasetNameError(name: unknown): string | null {
  if (typeof name !== 'string' || !name) return 'Field required';
  if (name.length > 200) return 'Dataset name is too long (maximum 200 characters).';
  const parts = name.split('/');
  if (parts.length < 2) return 'Please specify a dataset name in the form "pool/dataset".';
  if (parts.some((p) => !p || !COMPONENT_RE.test(p))) {
    return 'Dataset names may only contain letters, numbers, spaces and the characters "_", "-", ".", ":".';
  }
  return null;
}

function emitDataset(mock: Mock, ds: DatasetState): void {
  mock.emit('pool.dataset.query', 'changed', ds.id, renderDataset(mock.state, ds));
}

/** Validates and applies ZFS property fields shared by create and update. */
function collectProps(data: Obj, attr: string, errors: Array<[string, string]>, allowInherit: boolean): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of INHERITABLE_PROPS) {
    if (!(key in data)) continue;
    let v = data[key];
    if (typeof v === 'number') v = String(v);
    if (typeof v !== 'string') {
      errors.push([`${attr}.${key}`, 'Input should be a valid string']);
      continue;
    }
    const upper = v.toUpperCase();
    if (upper === 'INHERIT') {
      if (!allowInherit && key === 'casesensitivity') errors.push([`${attr}.${key}`, 'Input should be a valid value']);
      out[key] = null;
      continue;
    }
    const allowed = ENUMS[key];
    if (key === 'special_small_block_size') {
      out[key] = upper;
      continue;
    }
    if (allowed && !allowed.includes(upper)) {
      errors.push([`${attr}.${key}`, `Input should be ${allowed.map((a) => `'${a}'`).join(', ')}`]);
      continue;
    }
    out[key] = upper;
  }
  return out;
}

function quotaError(v: unknown): string | null {
  if (v === null || v === undefined || v === 0) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return 'Input should be a valid integer';
  if (v < GiB) return 'Quota must be at least 1 GiB (1073741824 bytes); use 0 or null to remove it.';
  return null;
}

export function registerDatasets(mock: Mock): void {
  const { server } = mock;

  const list = (options: unknown) => {
    const extra = (isObj(options) && isObj(options.extra) ? options.extra : {}) as Obj;
    const flat = extra.flat !== false;
    const opts = { children: extra.retrieve_children !== false, snapshots: extra.snapshots === true, properties: extra.properties };
    const all = sortDatasets(mock.state.datasets);
    const roots = flat ? all : all.filter((d) => !parentId(d.id) || !getDataset(mock.state, parentId(d.id)!));
    return roots.map((d) => renderDataset(mock.state, d, opts));
  };
  server.method('pool.dataset.query', (p) => queryFilter(list(p[1]), p[0], p[1]));
  server.method('pool.dataset.get_instance', (p) => queryFilter(list(p[1]), [['id', '=', p[0]]], { get: true }));

  server.method('pool.dataset.create', (p) => {
    const { state } = mock;
    const data = argObj(p[0], 'pool_dataset_create');
    const attr = 'pool_dataset_create';
    const errors: Array<[string, string]> = [];
    const name = data.name;
    const nameErr = datasetNameError(name);
    if (nameErr) throw validationError(`${attr}.name`, nameErr);
    const id = name as string;
    const poolName = id.split('/')[0]!;
    const type = data.type ?? 'FILESYSTEM';
    if (type !== 'FILESYSTEM' && type !== 'VOLUME') errors.push([`${attr}.type`, "Input should be 'FILESYSTEM' or 'VOLUME'"]);
    const shareType = (data.share_type ?? 'GENERIC') as DatasetShareType;
    if (!SHARE_TYPES.includes(shareType)) errors.push([`${attr}.share_type`, `Input should be ${SHARE_TYPES.map((s) => `'${s}'`).join(', ')}`]);
    if (!state.pools.some((x) => x.name === poolName)) errors.push([`${attr}.name`, 'Please specify a pool which exists for the dataset/volume']);
    else if (getDataset(state, id)) errors.push([`${attr}.name`, `Path ${id} already exists`]);
    else {
      const parent = getDataset(state, parentId(id)!);
      if (!parent && data.create_ancestors !== true) errors.push([`${attr}.name`, `Parent dataset ${parentId(id)} does not exist. Set create_ancestors to create it.`]);
      if (parent?.type === 'VOLUME') errors.push([`${attr}.name`, 'Parent dataset is a volume; datasets cannot be created under a volume.']);
    }
    if (id.startsWith(`${poolName}/ix-apps/`) || id === `${poolName}/ix-apps`) {
      errors.push([`${attr}.name`, 'Datasets cannot be created inside the ix-apps dataset, it is managed by the apps service.']);
    }
    for (const key of ['quota', 'refquota'] as const) {
      const err = quotaError(data[key]);
      if (err) errors.push([`${attr}.${key}`, err]);
    }
    if (data.reservation !== undefined && data.reservation !== null && (typeof data.reservation !== 'number' || !Number.isInteger(data.reservation) || data.reservation < 0)) {
      errors.push([`${attr}.reservation`, 'Input should be a valid integer']);
    }
    if (type === 'VOLUME' && (typeof data.volsize !== 'number' || data.volsize <= 0)) errors.push([`${attr}.volsize`, 'Field required for volumes']);
    const userProps: Record<string, string> = {};
    if (data.user_properties !== undefined) {
      if (!Array.isArray(data.user_properties)) errors.push([`${attr}.user_properties`, 'Input should be a valid list']);
      else {
        data.user_properties.forEach((up: unknown, i) => {
          if (!isObj(up) || typeof up.key !== 'string' || typeof up.value !== 'string') {
            errors.push([`${attr}.user_properties.${i}`, 'Each user property needs a string "key" and "value"']);
          } else if (!/^[a-z0-9_.-]+:[a-z0-9_.:-]+$/i.test(up.key)) {
            errors.push([`${attr}.user_properties.${i}.key`, 'User property names must contain a colon, e.g. "org.example:prop".']);
          } else userProps[up.key] = up.value;
        });
      }
    }
    if (data.comments !== undefined && typeof data.comments !== 'string') errors.push([`${attr}.comments`, 'Input should be a valid string']);
    const props = collectProps(data, attr, errors, false);
    const encryption = createEncryption(mock, data, id, attr, errors);
    if (errors.length) throw validationErrors(errors);

    // Missing ancestors
    const parts = id.split('/');
    for (let i = 2; i < parts.length; i++) {
      const anc = parts.slice(0, i).join('/');
      if (!getDataset(state, anc)) addDataset(mock, { id: anc });
    }
    const localProps = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== null)) as Record<string, string>;
    const ds = addDataset(mock, {
      id,
      type: type as 'FILESYSTEM' | 'VOLUME',
      share_type: shareType,
      quota: (data.quota as number | null) ?? null,
      refquota: (data.refquota as number | null) ?? null,
      comments: (data.comments as string | undefined) ?? '',
      user_properties: userProps,
      props: localProps,
      volsize: type === 'VOLUME' ? (data.volsize as number) : null,
      usedBytes: type === 'VOLUME' ? (data.sparse === true ? 64 * 1024 : (data.volsize as number)) : undefined,
      encryption,
    });
    if (typeof data.reservation === 'number' && data.reservation > 0) ds.reservation = data.reservation;
    afterCreateEncryption(mock, ds);
    return renderDataset(state, ds);
  });

  server.method('pool.dataset.update', (p) => {
    const { state } = mock;
    const ds = getDataset(state, String(p[0]));
    if (!ds) throw callError('ENOENT', `${String(p[0])} dataset does not exist`);
    const data = argObj(p[1], 'pool_dataset_update');
    const attr = 'pool_dataset_update';
    const errors: Array<[string, string]> = [];
    for (const key of ['name', 'type', 'casesensitivity', 'share_type', 'sparse', 'volblocksize', 'encryption', 'encryption_options', 'inherit_encryption']) {
      if (key in data) errors.push([`${attr}.${key}`, 'Extra inputs are not permitted']);
    }
    for (const key of ['quota', 'refquota'] as const) {
      if (!(key in data)) continue;
      const err = quotaError(data[key]);
      if (err) errors.push([`${attr}.${key}`, err]);
      else if (key === 'quota' && typeof data.quota === 'number' && data.quota > 0 && data.quota < datasetUsed(state, ds)) {
        errors.push([`${attr}.quota`, 'Quota cannot be smaller than the space already used by the dataset.']);
      }
    }
    const props = collectProps(data, attr, errors, true);
    const updates: Array<{ key: string; value?: string; remove?: boolean }> = [];
    if (data.user_properties_update !== undefined) {
      if (!Array.isArray(data.user_properties_update)) errors.push([`${attr}.user_properties_update`, 'Input should be a valid list']);
      else {
        data.user_properties_update.forEach((u: unknown, i) => {
          if (!isObj(u) || typeof u.key !== 'string' || !u.key.includes(':')) {
            errors.push([`${attr}.user_properties_update.${i}.key`, 'User property names must contain a colon, e.g. "org.example:prop".']);
          } else if (u.remove !== true && typeof u.value !== 'string') {
            errors.push([`${attr}.user_properties_update.${i}.value`, 'Field required unless remove is set']);
          } else updates.push({ key: u.key, value: u.value as string | undefined, remove: u.remove === true });
        });
      }
    }
    if (errors.length) throw validationErrors(errors);

    if ('quota' in data) ds.quota = (data.quota as number | null) || null;
    if ('refquota' in data) ds.refquota = (data.refquota as number | null) || null;
    if ('reservation' in data) ds.reservation = (data.reservation as number | null) || null;
    if ('refreservation' in data) ds.refreservation = (data.refreservation as number | null) || null;
    if (typeof data.comments === 'string') ds.comments = data.comments === 'INHERIT' ? '' : data.comments;
    if (typeof data.volsize === 'number' && ds.type === 'VOLUME') ds.volsize = data.volsize;
    for (const [k, v] of Object.entries(props)) {
      if (v === null) delete ds.props[k];
      else ds.props[k] = v;
    }
    for (const u of updates) {
      if (u.remove) delete ds.user_properties[u.key];
      else ds.user_properties[u.key] = u.value!;
    }
    for (const key of ['quota_warning', 'quota_critical', 'refquota_warning', 'refquota_critical'] as const) {
      if (typeof data[key] === 'number') ds.user_properties[`org.freenas:${key}`] = String(data[key]);
      else if (data[key] === 'INHERIT') delete ds.user_properties[`org.freenas:${key}`];
    }
    emitDataset(mock, ds);
    if (Object.keys(props).length) for (const d of descendants(state, ds.id)) emitDataset(mock, d);
    return renderDataset(state, ds);
  });

  server.method('pool.dataset.delete', (p) => {
    const { state } = mock;
    const id = String(p[0]);
    const ds = getDataset(state, id);
    if (!ds) throw callError('ENOENT', `${id} dataset does not exist`);
    const opts = argObj(p[1], 'options');
    if (!parentId(id)) throw callError('EINVAL', `${id} is the root dataset of a pool; export the pool to remove it.`);
    if (state.docker.pool === ds.pool && (id === `${ds.pool}/ix-apps` || id.startsWith(`${ds.pool}/ix-apps/`))) {
      throw callError('EBUSY', `${id} is in use by the apps service. Unset the apps pool before deleting it.`);
    }
    const kids = descendants(state, id);
    const snaps = state.snapshots.filter((s) => s.dataset === id || kids.some((k) => k.id === s.dataset));
    if ((kids.length || snaps.length) && opts.recursive !== true) {
      const list = [...kids.map((k) => k.id), ...snaps.map((s) => s.id)].join('\n');
      throw callError('EFAULT', `Failed to delete dataset: cannot destroy '${id}': filesystem has children\nuse '-r' to destroy the following datasets:\n${list}`);
    }
    removeDatasetTree(mock, id);
    return true;
  });

  server.method('pool.dataset.attachments', (p) => {
    const { state } = mock;
    const ds = getDataset(state, String(p[0]));
    if (!ds) throw callError('ENOENT', `${String(p[0])} dataset does not exist`);
    const mp = mountpoint(ds);
    const under = (path: string) => path === mp || path.startsWith(`${mp}/`) || mp.startsWith(`${path}/`);
    const out: Obj[] = [];
    const shares = state.shares.filter((s) => under(s.path)).map((s) => s.name);
    if (shares.length) out.push({ type: 'SMB Share', service: 'cifs', attachments: shares });
    const apps = state.apps
      .filter((a) => a.pool === state.docker.pool)
      .filter((a) => (ds.id === `${ds.pool}/ix-apps` || ds.id === ds.pool ? a.pool === ds.pool : hostPaths(a.config).some(under)))
      .map((a) => a.name);
    if (apps.length) out.push({ type: 'Applications', service: 'docker', attachments: apps });
    return out;
  });

  server.method('pool.dataset.snapshot_count', (p) => mock.state.snapshots.filter((s) => s.dataset === p[0]).length);
  server.method('pool.dataset.compression_choices', () => Object.fromEntries(ENUMS.compression!.map((c) => [c, c])));
  server.method('pool.dataset.checksum_choices', () => Object.fromEntries(ENUMS.checksum!.map((c) => [c, c])));
  server.method('pool.dataset.recordsize_choices', () => ENUMS.recordsize!.slice(1));
  server.method('pool.dataset.recommended_zvol_blocksize', () => '16K');
  server.method('pool.dataset.get_quota', () => []);
  server.method('pool.dataset.set_quota', () => null);
  server.method('pool.dataset.processes', () => []);

  // Snapshots
  const snaps = () => mock.state.snapshots.map((s) => renderSnapshot(mock.state, s));
  server.method('pool.snapshot.query', (p) => queryFilter(snaps(), p[0], p[1]));
  server.method('pool.snapshot.get_instance', (p) => queryFilter(snaps(), [['id', '=', p[0]]], { get: true }));
  server.method('pool.snapshot.create', (p) => {
    const { state } = mock;
    const data = argObj(p[0], 'snapshot_create');
    const ds = typeof data.dataset === 'string' ? getDataset(state, data.dataset) : undefined;
    if (!ds) throw validationError('snapshot_create.dataset', 'Dataset not found');
    let name: string;
    if (typeof data.name === 'string' && data.name) name = data.name;
    else if (typeof data.naming_schema === 'string' && data.naming_schema) name = strftime(data.naming_schema, new Date());
    else throw validationError('snapshot_create.naming_schema', 'You must specify either name or naming_schema');
    if (!/^[A-Za-z0-9_.:-]+$/.test(name)) throw validationError('snapshot_create.name', 'Invalid snapshot name');
    const targets = data.recursive === true ? [ds, ...descendants(state, ds.id)] : [ds];
    const exclude = Array.isArray(data.exclude) ? (data.exclude as string[]) : [];
    if (state.snapshots.some((s) => s.id === `${ds.id}@${name}`)) throw validationError('snapshot_create.name', `Snapshot ${ds.id}@${name} already exists`);
    let first: SnapshotState | undefined;
    for (const t of targets) {
      if (exclude.includes(t.id) || state.snapshots.some((s) => s.id === `${t.id}@${name}`)) continue;
      const snap: SnapshotState = {
        id: `${t.id}@${name}`,
        dataset: t.id,
        name,
        createtxg: mock.nextTxg(),
        createdAt: Date.now(),
        referenced: t.usedBytes,
        usedBytes: 0,
      };
      state.snapshots.push(snap);
      first ??= snap;
      mock.emit('pool.snapshot.query', 'added', snap.id, renderSnapshot(state, snap));
    }
    return renderSnapshot(state, first!);
  });
  server.method('pool.snapshot.delete', (p) => {
    const { state } = mock;
    const id = String(p[0]);
    const snap = state.snapshots.find((s) => s.id === id);
    if (!snap) throw callError('ENOENT', `Snapshot ${id} not found`);
    const opts = argObj(p[1], 'options');
    const doomed = new Set([id]);
    if (opts.recursive === true) for (const d of descendants(state, snap.dataset)) doomed.add(`${d.id}@${snap.name}`);
    state.snapshots = state.snapshots.filter((s) => {
      if (!doomed.has(s.id)) return true;
      mock.emit('pool.snapshot.query', 'removed', s.id);
      return false;
    });
    return true;
  });
  server.method('pool.snapshot.rollback', (p) => {
    const { state } = mock;
    const id = String(p[0]);
    const snap = state.snapshots.find((s) => s.id === id);
    if (!snap) throw callError('ENOENT', `Snapshot ${id} not found`);
    const newer = state.snapshots.filter((s) => s.dataset === snap.dataset && s.createtxg > snap.createtxg);
    if (newer.length && argObj(p[1], 'options').recursive !== true) {
      throw callError(
        'EFAULT',
        `cannot rollback to '${id}': more recent snapshots or bookmarks exist\nuse '-r' to force deletion of the following snapshots and bookmarks:\n${newer.map((s) => s.id).join('\n')}`,
      );
    }
    state.snapshots = state.snapshots.filter((s) => !newer.includes(s));
    for (const s of newer) mock.emit('pool.snapshot.query', 'removed', s.id);
    const ds = getDataset(state, snap.dataset);
    if (ds) {
      ds.usedBytes = snap.referenced;
      emitDataset(mock, ds);
    }
    return null;
  });
  server.method('pool.snapshot.clone', (p) => {
    const { state } = mock;
    const data = argObj(p[0], 'snapshot_clone');
    const snap = state.snapshots.find((s) => s.id === data.snapshot);
    if (!snap) throw validationError('snapshot_clone.snapshot', 'Snapshot not found');
    const dst = String(data.dataset_dst ?? '');
    const err = datasetNameError(dst);
    if (err) throw validationError('snapshot_clone.dataset_dst', err);
    if (getDataset(state, dst)) throw validationError('snapshot_clone.dataset_dst', `${dst} already exists`);
    if (!getDataset(state, parentId(dst) ?? '')) throw validationError('snapshot_clone.dataset_dst', 'Parent dataset does not exist');
    addDataset(mock, { id: dst, usedBytes: 64 * 1024 });
    return true;
  });
}

/** Host paths referenced by an app's values (storage.*.host_path_config.path and additional_storage). */
export function hostPaths(config: Obj): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      if (v.type === 'host_path' && isObj(v.host_path_config) && typeof v.host_path_config.path === 'string') out.push(v.host_path_config.path);
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(config.storage);
  return [...new Set(out)];
}

function strftime(schema: string, d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const map: Record<string, string> = {
    Y: String(d.getFullYear()),
    y: pad(d.getFullYear() % 100),
    m: pad(d.getMonth() + 1),
    d: pad(d.getDate()),
    H: pad(d.getHours()),
    M: pad(d.getMinutes()),
    S: pad(d.getSeconds()),
    '%': '%',
  };
  return schema.replace(/%([YymdHMS%])/g, (_, k: string) => map[k] ?? '');
}
