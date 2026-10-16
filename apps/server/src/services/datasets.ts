/**
 * Dataset helpers shared by operations that copy a folder with ZFS replication and swap it in
 * ("Turn on encryption", moving a folder to another pool).
 */
import type { ConversionDuration } from '@apexos/api-types';
import type { TrueNasClient } from '@apexos/truenas-client';
import type { TnDataset, TnProperty } from '../truenas/types.ts';

/** Assumed copy speed for duration estimates. */
const COPY_BYTES_PER_SEC = 150e6;
/** Most entries the post-copy check compares file by file (the snapshot comparison always runs). */
const VERIFY_MAX_ENTRIES = 20_000;

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

export async function queryDatasets(client: TrueNasClient, filters: unknown[]): Promise<TnCryptoDataset[]> {
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

export async function getDataset(client: TrueNasClient, id: string): Promise<TnCryptoDataset | null> {
  return (await queryDatasets(client, [['id', '=', id]]))[0] ?? null;
}

/** A dataset and everything below it. */
export function treeFilter(dataset: string): unknown[] {
  return ['OR', [['id', '=', dataset], ['id', '^', `${dataset}/`]]];
}

export interface TnAttachment {
  type: string;
  service: string | null;
  attachments: string[];
}

export async function attachments(client: TrueNasClient, dataset: string): Promise<TnAttachment[]> {
  return client.call<TnAttachment[]>('pool.dataset.attachments', [dataset]);
}

export function isAppAttachment(a: TnAttachment): boolean {
  return a.service === 'docker' || /application|^apps?$/i.test(a.type);
}

export function isSmbAttachment(a: TnAttachment): boolean {
  return a.service === 'cifs' || /smb/i.test(a.type);
}

export async function attachedApps(client: TrueNasClient, dataset: string): Promise<string[]> {
  return (await attachments(client, dataset)).filter(isAppAttachment).flatMap((a) => a.attachments);
}

export interface TnReplicationTask {
  id: number;
  name: string;
  source_datasets: string[];
  target_dataset: string;
  direction: string;
}

/** Replication tasks (backups) that read from or write into the dataset tree. */
export function replicationsTouching(tasks: TnReplicationTask[], dataset: string): TnReplicationTask[] {
  return tasks.filter((r) => r.source_datasets.some((s) => inside(s, dataset) || inside(dataset, s)) || inside(r.target_dataset, dataset));
}

export function inside(id: string, root: string): boolean {
  return id === root || id.startsWith(`${root}/`);
}

export function durationOf(bytes: number): ConversionDuration {
  const seconds = bytes / COPY_BYTES_PER_SEC;
  if (seconds < 15 * 60) return 'minutes';
  if (seconds < 3600) return 'up-to-an-hour';
  if (seconds < 6 * 3600) return 'a-few-hours';
  return 'a-day-or-more';
}

export function dateStamp(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** "A", "A and B", "A, B and C". */
export function joinList(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export async function snapshotNames(client: TrueNasClient, dataset: string): Promise<string[]> {
  const snaps = await client.call<{ snapshot_name: string; createtxg: string }[]>('pool.snapshot.query', [[['dataset', '=', dataset]], { select: ['snapshot_name', 'createtxg'] }]);
  return snaps.sort((a, b) => Number(a.createtxg) - Number(b.createtxg)).map((s) => s.snapshot_name);
}

/** A recursive snapshot, unless it exists already (so a retried run can continue). */
export async function ensureSnapshot(client: TrueNasClient, dataset: string, name: string): Promise<void> {
  const exists = await client.call<unknown[]>('pool.snapshot.query', [[['id', '=', `${dataset}@${name}`]]]);
  if (!exists.length) await client.call('pool.snapshot.create', [{ dataset, name, recursive: true }]);
}

/** Removes a recursive snapshot ApexOs took, if it is there. */
export async function dropSnapshot(client: TrueNasClient, dataset: string, name: string): Promise<void> {
  const snap = `${dataset}@${name}`;
  const exists = await client.call<unknown[]>('pool.snapshot.query', [[['id', '=', snap]]]);
  if (exists.length) await client.call('pool.snapshot.delete', [snap, { recursive: true }]);
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
export async function compareTrees(client: TrueNasClient, from: string, to: string): Promise<string | null> {
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

/**
 * Checks both trees have the same datasets, and that the copy has every snapshot the source had up to `upTo`
 * (the last snapshot copied). Scheduled snapshot tasks keep running on the source meanwhile, so snapshots taken
 * after `upTo`, and ones the source has pruned since they were copied, don't count. Throws a readable error.
 */
export async function compareDatasetTrees(client: TrueNasClient, source: string, copy: string, upTo: string): Promise<void> {
  const [src, dst] = await Promise.all([queryDatasets(client, [treeFilter(source)]), queryDatasets(client, [treeFilter(copy)])]);
  const rel = (ids: TnDataset[], root: string) => ids.map((d) => d.id.slice(root.length)).sort().join('|');
  if (rel(src, source) !== rel(dst, copy)) throw new Error('The copy is missing part of the folder.');
  for (const d of src) {
    const twin = `${copy}${d.id.slice(source.length)}`;
    const [a, b] = await Promise.all([snapshotNames(client, d.id), snapshotNames(client, twin)]);
    const end = a.indexOf(upTo);
    const copied = new Set(b);
    if (end < 0 || a.slice(0, end + 1).some((s) => !copied.has(s))) throw new Error(`The restore points of ${d.id} don’t match the copy.`);
  }
}
