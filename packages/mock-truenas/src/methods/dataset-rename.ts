/**
 * `pool.dataset.rename` (middleware `plugins/pool_/dataset.py`): a bare `zfs rename` behind a `force` flag.
 * Like the real thing it does not touch anything that refers to the dataset by name or path: SMB shares,
 * stored encryption keys (`storage_encrypteddataset` is keyed by name), snapshot/replication tasks and apps.
 */
import type { Mock } from '../context.ts';
import { encryptionRootOf, isEncrypted } from '../encryption.ts';
import { callError, validationError } from '../rpc.ts';
import { descendants, getDataset, mountpoint, parentId, renderDataset, renderSnapshot, sortDatasets } from '../storage.ts';
import { argObj } from '../util.ts';
import { datasetNameError } from './datasets.ts';

/** Renames a dataset tree with its snapshots and files; emits removed/added events. No validation. */
export function renameDatasetInternal(mock: Mock, from: string, to: string): void {
  const { state } = mock;
  const root = getDataset(state, from);
  if (!root) return;
  const tree = sortDatasets([root, ...descendants(state, from)]);
  const oldMp = mountpoint(root);
  const newMp = mountpoint({ id: to, pool: root.pool });
  const remapId = (id: string) => (id === from || id.startsWith(`${from}/`) ? `${to}${id.slice(from.length)}` : id);
  const remapPath = (p: string) => (p === oldMp || p.startsWith(`${oldMp}/`) ? `${newMp}${p.slice(oldMp.length)}` : p);

  for (const d of [...tree].reverse()) mock.emit('pool.dataset.query', 'removed', d.id);
  const oldSnaps = state.snapshots.filter((s) => s.dataset === from || s.dataset.startsWith(`${from}/`));
  for (const s of oldSnaps) mock.emit('pool.snapshot.query', 'removed', s.id);

  for (const d of tree) d.id = remapId(d.id);
  for (const s of oldSnaps) {
    s.dataset = remapId(s.dataset);
    s.id = `${s.dataset}@${s.name}`;
  }
  for (const n of state.fs.nodes) n.path = remapPath(n.path);
  for (const map of [state.fs.acls, state.fs.owners] as Array<Record<string, unknown>>) {
    for (const p of Object.keys(map)) {
      const np = remapPath(p);
      if (np !== p) {
        map[np] = map[p];
        delete map[p];
      }
    }
  }

  for (const d of tree) mock.emit('pool.dataset.query', 'added', d.id, renderDataset(state, d));
  for (const s of oldSnaps) mock.emit('pool.snapshot.query', 'added', s.id, renderSnapshot(state, s));
}

export function registerDatasetRename(mock: Mock): void {
  mock.server.method('pool.dataset.rename', (p) => {
    const { state } = mock;
    const id = String(p[0]);
    const opts = argObj(p[1], 'options');
    const newName = opts.new_name;
    const nameErr = datasetNameError(newName);
    if (nameErr) throw validationError('options.new_name', nameErr === 'Field required' ? nameErr : 'Please provide a valid dataset name according to ZFS standards');
    if (opts.force !== true) {
      throw validationError(
        'pool.dataset.rename.force',
        'No safety checks are performed when renaming ZFS resources; this may break existing usages. If you understand the risks, please set force and proceed.',
      );
    }
    const to = newName as string;
    const ds = getDataset(state, id);
    if (!ds) throw callError('ENOENT', `Failed to rename dataset: cannot open '${id}': dataset does not exist`);
    const fail = (msg: string) => callError('EFAULT', `Failed to rename dataset: ${msg}`);
    if (!parentId(id)) throw fail(`cannot rename '${id}': cannot rename the root dataset of a pool`);
    if (to.split('/')[0] !== ds.pool) throw fail(`cannot rename to '${to}': datasets must be within same pool`);
    if (to === id || to.startsWith(`${id}/`)) throw fail(`cannot rename to '${to}': New dataset name cannot be a descendant of current dataset name`);
    if (getDataset(state, to)) throw fail(`cannot rename to '${to}': dataset already exists`);
    const newParent = getDataset(state, parentId(to)!);
    if (!newParent) throw fail(`cannot rename to '${to}': parent does not exist`);
    const root = encryptionRootOf(state, ds);
    if (root && root !== ds && encryptionRootOf(state, newParent) !== root) {
      throw fail(`cannot rename '${id}': cannot move encrypted child outside of its encryption root`);
    }
    if (!isEncrypted(state, ds) && isEncrypted(state, newParent)) {
      throw fail(`cannot rename '${id}': cannot move unencrypted dataset into encrypted dataset`);
    }
    renameDatasetInternal(mock, id, to);
    return null;
  });
}
