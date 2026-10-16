import type { FolderUse, LocationGroup, LocationInfo, LocationPreferenceId, Pool } from '@apexos/api-types';
import { LocationPreferenceId as L } from '@apexos/shared/eshtek/preferences';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import type { TnDataset } from '../truenas/types.ts';
import { assertFolderNotMoving } from './folder-move.ts';
import { createFolder, FOLDER_PROPERTY } from './folders.ts';
import { getStorage } from './storage.ts';

export interface LocationDef {
  id: LocationPreferenceId;
  name: string;
  group: LocationGroup;
  description: string;
  /** Folder (dataset) name created for the location. */
  folder: string;
  /** Created inside this location's folder instead of at the pool root. */
  parent?: LocationPreferenceId;
  /** Which kind of pool suits it best. */
  prefers: 'performance' | 'capacity';
  /** Share the location's folder on the network. */
  shared: boolean;
}

export const LOCATION_DEFS: LocationDef[] = [
  {
    id: L.APPLICATIONS_PERFORMANCE,
    name: 'Apps (fast storage)',
    group: 'applications',
    description: 'App settings and databases. Best on SSDs.',
    folder: 'Applications',
    prefers: 'performance',
    shared: false,
  },
  {
    id: L.APPLICATIONS_CAPACITY,
    name: 'Apps (large storage)',
    group: 'applications',
    description: 'Large app data such as caches and logs. Best on hard drives.',
    folder: 'Applications',
    prefers: 'capacity',
    shared: false,
  },
  { id: L.MEDIA, name: 'Media', group: 'content', description: 'Movies, shows, music and videos.', folder: 'Media', prefers: 'capacity', shared: true },
  { id: L.MOVIES, name: 'Movies', group: 'content', description: 'Inside Media.', folder: 'Movies', parent: L.MEDIA, prefers: 'capacity', shared: false },
  { id: L.SHOWS, name: 'Shows', group: 'content', description: 'Inside Media.', folder: 'Shows', parent: L.MEDIA, prefers: 'capacity', shared: false },
  { id: L.MUSIC, name: 'Music', group: 'content', description: 'Inside Media.', folder: 'Music', parent: L.MEDIA, prefers: 'capacity', shared: false },
  { id: L.VIDEOS, name: 'Videos', group: 'content', description: 'Inside Media.', folder: 'Videos', parent: L.MEDIA, prefers: 'capacity', shared: false },
  { id: L.PHOTOS, name: 'Photos', group: 'content', description: 'Photo libraries.', folder: 'Photos', prefers: 'capacity', shared: true },
  { id: L.DOCUMENTS, name: 'Documents', group: 'content', description: 'Documents and files you sync.', folder: 'Documents', prefers: 'capacity', shared: true },
  { id: L.DOWNLOADS, name: 'Downloads', group: 'content', description: 'Where download apps save files.', folder: 'Downloads', prefers: 'capacity', shared: true },
];

export function locationDef(id: string): LocationDef {
  const def = LOCATION_DEFS.find((d) => d.id === id);
  if (!def) throw new UserError(`Unknown location ${id}`, 400, 'UNKNOWN_LOCATION');
  return def;
}

function datasetIdFromPath(path: string): string {
  return path.replace(/^\/mnt\//, '');
}

function pickPool(pools: Pool[], prefers: 'performance' | 'capacity'): Pool | undefined {
  const usable = pools.filter((p) => p.health !== 'offline');
  const largest = [...usable].sort((a, b) => b.freeBytes - a.freeBytes);
  if (prefers === 'performance') {
    return usable.find((p) => p.kind === 'performance') ?? usable.find((p) => p.isAppsPool) ?? largest[0];
  }
  return largest.find((p) => p.kind === 'capacity') ?? largest[0];
}

function suggestedPath(def: LocationDef, pools: Pool[], stored: Partial<Record<LocationPreferenceId, string>>): string | null {
  if (def.parent) {
    const parentDef = locationDef(def.parent);
    const parentPath = stored[def.parent] ?? suggestedPath(parentDef, pools, stored);
    return parentPath ? `${parentPath}/${def.folder}` : null;
  }
  const pool = pickPool(pools, def.prefers);
  return pool ? `${pool.path}/${def.folder}` : null;
}

function appUses(ctx: AppContext, id: LocationPreferenceId): FolderUse[] {
  return Object.entries(ctx.store.get().apps)
    .filter(([, app]) => app.locations.includes(id))
    .map(([name]) => ({ type: 'app' as const, id: name, name }));
}

export async function listLocations(ctx: AppContext): Promise<LocationInfo[]> {
  const client = ctx.truenas.client();
  const [storage, datasets] = await Promise.all([
    getStorage(ctx),
    client.call<TnDataset[]>('pool.dataset.query', [[['type', '=', 'FILESYSTEM']], { extra: { retrieve_children: false, properties: ['mountpoint'] } }]),
  ]);
  const ids = new Set(datasets.map((d) => d.id));
  const stored = ctx.store.get().preferences.locations;
  return LOCATION_DEFS.map((def) => {
    const path = stored[def.id] ?? null;
    const datasetId = path ? datasetIdFromPath(path) : null;
    // A child location (e.g. Movies) also usedBy apps of its own; the parent lists its children's apps.
    const usedBy = [...appUses(ctx, def.id), ...LOCATION_DEFS.filter((d) => d.parent === def.id && stored[d.id]).flatMap((d) => appUses(ctx, d.id))];
    return {
      id: def.id,
      name: def.name,
      group: def.group,
      description: def.description,
      path,
      folder: datasetId ? (datasetId.split('/')[1] ?? null) : null,
      pool: datasetId ? (datasetId.split('/')[0] ?? null) : null,
      created: datasetId ? ids.has(datasetId) : false,
      usedBy: dedupeUses(usedBy),
      suggestedPath: suggestedPath(def, storage.pools, stored),
    };
  });
}

function dedupeUses(uses: FolderUse[]): FolderUse[] {
  const seen = new Set<string>();
  return uses.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
}

/** Points a location at an existing folder. Only new files go there; nothing is moved. */
export async function setLocation(ctx: AppContext, id: string, path: string): Promise<LocationInfo> {
  const def = locationDef(id);
  const current = (await listLocations(ctx)).find((l) => l.id === def.id)!;
  if (current.path) assertFolderNotMoving(ctx, current.path.replace(/^\/mnt\//, ''));
  if (current.usedBy.length) {
    throw new UserError(
      `This location is used by ${current.usedBy.map((u) => u.name).join(', ')}. To take it to another pool with its files, use Move instead.`,
      409,
      'IN_USE',
    );
  }
  const normalized = path.replace(/\/+$/, '');
  const datasetId = datasetIdFromPath(normalized);
  if (!normalized.startsWith('/mnt/') || datasetId.split('/').length < 2) {
    throw new UserError('A location must be a folder inside a pool, not a whole pool.', 400, 'VALIDATION', { path: 'Pick a folder' });
  }
  const [ds] = await ctx.truenas.client().call<TnDataset[]>('pool.dataset.query', [[['id', '=', datasetId]], { extra: { retrieve_children: false } }]);
  if (!ds) throw new UserError('That folder does not exist.', 404, 'NOT_FOUND', { path: 'Folder not found' });
  await ctx.store.update((s) => {
    s.preferences.locations[def.id] = normalized;
  });
  ctx.bus.changed('locations');
  return (await listLocations(ctx)).find((l) => l.id === def.id)!;
}

/**
 * Makes sure a location's folder exists, creating it (and its parent) on the most suitable pool.
 * Returns the absolute path.
 */
export async function ensureLocation(ctx: AppContext, id: LocationPreferenceId): Promise<string> {
  const def = locationDef(id);
  const client = ctx.truenas.client();
  const stored = ctx.store.get().preferences.locations;
  let path = stored[def.id];
  if (path) {
    const [ds] = await client.call<TnDataset[]>('pool.dataset.query', [[['id', '=', datasetIdFromPath(path)]], { extra: { retrieve_children: false } }]);
    if (ds) return path;
  }

  if (def.parent) {
    const parentPath = await ensureLocation(ctx, def.parent);
    path = path ?? `${parentPath}/${def.folder}`;
    const datasetId = datasetIdFromPath(path);
    const [existing] = await client.call<TnDataset[]>('pool.dataset.query', [[['id', '=', datasetId]], { extra: { retrieve_children: false } }]);
    if (!existing) {
      await client.call('pool.dataset.create', [
        { name: datasetId, type: 'FILESYSTEM', share_type: 'SMB', create_ancestors: true, user_properties: [{ key: FOLDER_PROPERTY, value: 'system' }] },
      ]);
    }
  } else {
    const storage = await getStorage(ctx);
    const pool = path ? storage.pools.find((p) => path!.startsWith(`${p.path}/`)) : pickPool(storage.pools, def.prefers);
    if (!pool) throw new UserError(`No pool is available for ${def.name}. Create a storage pool first.`, 409, 'NO_POOL');
    path = path ?? `${pool.path}/${def.folder}`;
    const name = path.slice(pool.path.length + 1);
    await createFolder(
      ctx,
      { name, pool: pool.name, access: 'private', users: [], quotaBytes: null, timeMachine: false },
      { system: true, noShare: !def.shared, shareType: def.group === 'applications' ? 'APPS' : 'SMB' },
    );
  }

  await ctx.store.update((s) => {
    s.preferences.locations[def.id] = path!;
  });
  ctx.bus.changed('locations');
  return path;
}
