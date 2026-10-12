/**
 * File browser: browse, upload, download and organize the files inside the folders ApexOs lists.
 *
 * TrueNAS 25.10 offers `filesystem.listdir` / `stat` / `mkdir` / `chown`, uploads through `POST /_upload`
 * (`filesystem.put`) and downloads through `core.download('filesystem.get')`, but nothing to rename, move,
 * copy or delete files: those run `mv`, `cp` and `rm` through the host helper (`lib/host.ts`).
 *
 * Safety rules (enforced here; the browser is never trusted):
 * - A path is relative to a folder ApexOs lists (`/mnt/<pool>/<Folder>`) and every segment is a validated
 *   name, so `..`, absolute paths, empty segments and control characters never reach TrueNAS.
 * - Every component below the folder root is `stat`ed before use: symlinks are never followed or operated
 *   through, `.zfs` (snapshots) is refused, and unknown mounts are refused.
 * - The folder root and child datasets ("separately stored" folders) can't be renamed, moved or deleted,
 *   folders containing a child dataset can't be moved, copied or deleted as a whole, and nothing is moved
 *   or copied across a dataset boundary.
 * - TrueNAS overwrites uploads silently, so ApexOs checks first; moves and copies never replace anything
 *   (`mv -n`, `cp -n`) and are verified afterwards.
 * - Host commands get argv built only from validated absolute paths, with `--` before the paths.
 */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import type {
  FileCheckRequest,
  FileCheckResponse,
  FileDeleteRequest,
  FileEntry,
  FileEntryType,
  FileListing,
  FileMkdirRequest,
  FileRenameRequest,
  FileRoot,
  FileRootsResponse,
  FileSortKey,
  FileSortOrder,
  FileTransferRequest,
  FileUploadResponse,
  Task,
} from '@apexos/api-types';
import { TrueNasError, type Job, type TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import type { HostBinary, HostResult } from '../lib/host.ts';
import type { TaskContext } from '../lib/tasks.ts';
import type { TnDataset } from '../truenas/types.ts';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Directory entries read per listing; bigger directories show the first ones by name. */
export const SCAN_LIMIT = 10_000;
/** Sorting by date needs a `stat` per entry, so it is offered up to this many entries. */
export const DATE_SORT_LIMIT = 2_000;
export const DEFAULT_PAGE = 200;
export const MAX_PAGE = 1_000;
/** Items one move, copy or delete may act on (like an upload batch). */
export const MAX_ITEMS = 10_000;
export const MAX_NAME_BYTES = 255;
export const MAX_PATH_BYTES = 4_000;
const DEFAULT_UPLOAD_MAX_BYTES = 32 * 1024 ** 3;
/** Paths per host command (each command is a TrueNAS cron run, so batching matters). */
const BATCH_ITEMS = 50;
const BATCH_BYTES = 32 * 1024;
/** Long copies may take hours; the host helper waits this long for one command. */
const TRANSFER_TIMEOUT_MS = 24 * 3600_000;
const STAT_CONCURRENCY = 16;
/** Single files at least this big get live copy progress (destination size is polled). */
const POLL_COPY_BYTES = 64 * 1024 ** 2;
/** Progress weight of a folder or link in a move/copy (their size is unknown without walking them). */
const NODE_WEIGHT = 1024 ** 2;

/** Largest accepted upload: APEXOS_UPLOAD_MAX_BYTES (bytes), default 32 GiB. */
export function uploadLimit(): number {
  const v = Number(process.env.APEXOS_UPLOAD_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_UPLOAD_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// TrueNAS shapes
// ---------------------------------------------------------------------------

type TnFileType = 'DIRECTORY' | 'FILE' | 'SYMLINK' | 'OTHER';

interface TnDirEntry {
  name: string;
  type: TnFileType;
  size: number;
  is_mountpoint: boolean;
}

interface TnStat {
  realpath: string;
  type: TnFileType;
  size: number;
  mtime: number;
  uid: number;
  gid: number;
  inode: number;
  dev: number;
  is_mountpoint: boolean;
  is_ctldir: boolean;
}

const LIST_SELECT = ['name', 'type', 'size', 'is_mountpoint'];
const DATASET_PROPERTIES = ['mountpoint', 'encryption', 'keystatus'];

// ---------------------------------------------------------------------------
// Names and paths (pure)
// ---------------------------------------------------------------------------

/** C0/C1 control characters (including NUL and line breaks) and Unicode line/paragraph separators. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Why `name` can't be used as one path segment, or null. `typed` adds rules for names people type
 * (no leading or trailing spaces); names of uploaded files are taken as they are.
 */
export function nameProblem(name: unknown, typed = false): string | null {
  if (typeof name !== 'string' || !name.length) return 'Enter a name.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  if (name.includes('/')) return 'Names can’t contain “/”.';
  if (CONTROL_CHARS.test(name)) return 'Names can’t contain line breaks or other invisible control characters.';
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return 'That name is too long.';
  if (name.toLowerCase() === '.zfs') return 'That name is reserved for snapshots.';
  if (typed && name.trim() !== name) return 'Names can’t start or end with a space.';
  return null;
}

/** Splits a folder-relative path into validated segments ('' is the folder itself). */
export function splitPath(raw: unknown, field = 'path'): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string') throw new UserError('That path is not valid.', 400, 'INVALID_PATH', { [field]: 'Not a path' });
  if (raw.startsWith('/')) throw new UserError('Paths must stay inside the folder.', 400, 'OUTSIDE_FOLDER', { [field]: 'Outside the folder' });
  if (Buffer.byteLength(raw, 'utf8') > MAX_PATH_BYTES) throw new UserError('That path is too long.', 400, 'INVALID_PATH', { [field]: 'Too long' });
  const segments = raw.split('/');
  for (const seg of segments) {
    if (seg === '..') throw new UserError('Paths must stay inside the folder.', 400, 'OUTSIDE_FOLDER', { [field]: 'Outside the folder' });
    if (seg.toLowerCase() === '.zfs') {
      throw new UserError('Snapshots can’t be browsed or changed here.', 400, 'SNAPSHOTS', { [field]: 'Snapshot directory' });
    }
    const problem = seg === '' || seg === '.' ? 'Empty or “.” path segment.' : nameProblem(seg);
    if (problem) throw new UserError(`That path is not valid: ${problem}`, 400, 'INVALID_PATH', { [field]: problem });
  }
  return segments;
}

export function validateNewName(name: unknown, field = 'name'): string {
  const problem = nameProblem(name, true);
  if (problem) throw new UserError(problem, 400, 'INVALID_NAME', { [field]: problem });
  return name as string;
}

/** "photo.jpg" → "photo (1).jpg"; folders and dotfiles keep their whole name as the base. */
export function numberedName(name: string, n: number, isFolder = false): string {
  const dot = name.lastIndexOf('.');
  if (isFolder || dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/** An ASCII-only name for TrueNAS (it puts the name in a header without escaping). */
export function asciiName(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%;]/g, '_').trim();
  return safe || 'download';
}

/** RFC 6266 / 5987 Content-Disposition for a download. */
export function contentDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encoded}`;
}

function toType(t: TnFileType): FileEntryType {
  return t === 'DIRECTORY' ? 'folder' : t === 'FILE' ? 'file' : t === 'SYMLINK' ? 'link' : 'other';
}

function relPath(segments: string[]): string {
  return segments.join('/');
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// ---------------------------------------------------------------------------
// Folders and datasets
// ---------------------------------------------------------------------------

interface Area {
  dataset: string;
  path: string;
  locked: boolean;
}

interface FolderRoot {
  name: string;
  pool: string;
  dataset: string;
  path: string;
  locked: boolean;
  encrypted: boolean;
  /** The folder's dataset and every dataset inside it (mounted under the folder). */
  areas: Area[];
}

/** Same rule as `GET /api/folders` (services/folders.ts): top-level datasets that aren't TrueNAS or app internals. */
function isFolderDataset(ds: TnDataset): boolean {
  const parts = ds.id.split('/');
  if (parts.length !== 2) return false;
  const name = parts[1]!;
  return !name.startsWith('.') && !name.startsWith('ix-');
}

async function readDatasets(client: TrueNasClient): Promise<TnDataset[]> {
  return client.call<TnDataset[]>('pool.dataset.query', [
    [['type', '=', 'FILESYSTEM']],
    { extra: { retrieve_children: false, properties: DATASET_PROPERTIES } },
  ]);
}

export async function listRoots(ctx: AppContext): Promise<FileRootsResponse> {
  const datasets = await readDatasets(ctx.truenas.client());
  const names = ctx.store.get().poolNames;
  const folders: FileRoot[] = datasets.filter(isFolderDataset).map((ds) => {
    const pool = ds.pool ?? ds.id.split('/')[0]!;
    return { name: ds.id.split('/')[1]!, pool, poolDisplayName: names[pool] ?? pool, dataset: ds.id, locked: ds.locked === true, encrypted: ds.encrypted === true };
  });
  folders.sort((a, b) => a.name.localeCompare(b.name) || a.pool.localeCompare(b.pool));
  return { folders, uploadMaxBytes: uploadLimit(), maxItems: MAX_ITEMS };
}

async function loadFolder(client: TrueNasClient, ref: unknown): Promise<FolderRoot> {
  if (typeof ref !== 'string' || !ref) throw new UserError('Choose a folder.', 400, 'VALIDATION', { folder: 'Required' });
  const datasets = await readDatasets(client);
  const folders = datasets.filter(isFolderDataset);
  let ds = ref.includes('/') ? folders.find((d) => d.id === ref) : undefined;
  if (!ds) {
    const matches = folders.filter((d) => d.id.split('/')[1]!.toLowerCase() === ref.toLowerCase());
    ds = matches.find((d) => d.id.split('/')[1] === ref) ?? matches[0];
  }
  if (!ds) throw new UserError(`There’s no folder called “${ref}”.`, 404, 'NOT_FOUND');
  const root = `/mnt/${ds.id}`;
  if (ds.mountpoint !== root) {
    throw new UserError(`“${ds.id.split('/')[1]}” isn’t mounted where ApexOs expects it, so it can’t be browsed.`, 409, 'UNAVAILABLE');
  }
  const areas = datasets
    .filter((d) => d.id === ds.id || d.id.startsWith(`${ds.id}/`))
    .filter((d) => d.mountpoint === `/mnt/${d.id}`)
    .map((d) => ({ dataset: d.id, path: d.mountpoint!, locked: d.locked === true }));
  const folder: FolderRoot = {
    name: ds.id.split('/')[1]!,
    pool: ds.pool ?? ds.id.split('/')[0]!,
    dataset: ds.id,
    path: root,
    locked: ds.locked === true,
    encrypted: ds.encrypted === true,
    areas,
  };
  if (folder.locked) throw lockedError(folder.name);
  return folder;
}

function lockedError(what: string): UserError {
  return new UserError(`“${what}” is locked. Unlock it to see and change its files.`, 423, 'LOCKED');
}

/** The dataset that stores `abs` (the deepest area containing it). */
function areaOf(folder: FolderRoot, abs: string): Area {
  let best = folder.areas.find((a) => a.dataset === folder.dataset)!;
  for (const a of folder.areas) {
    if ((abs === a.path || abs.startsWith(`${a.path}/`)) && a.path.length > best.path.length) best = a;
  }
  return best;
}

function displayRel(folder: FolderRoot, abs: string): string {
  return abs === folder.path ? folder.name : abs.slice(folder.path.length + 1);
}

// ---------------------------------------------------------------------------
// Locating paths on the server
// ---------------------------------------------------------------------------

interface Located {
  folder: FolderRoot;
  segments: string[];
  rel: string;
  abs: string;
  area: Area;
  /** null when the last component doesn't exist (only with `mustExist: false`). */
  stat: TnStat | null;
  /** stat of the containing directory (null for the folder root). */
  parentStat: TnStat | null;
}

async function statOrNull(client: TrueNasClient, path: string): Promise<TnStat | null> {
  try {
    return await client.call<TnStat>('filesystem.stat', [path]);
  } catch (err) {
    if (err instanceof TrueNasError && (err.errname === 'ENOENT' || err.errname === 'ENOTDIR')) return null;
    throw err;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Checks one component of a path inside the folder: no snapshot directories, no symlinks (except a final
 * one when `allowLink`), only directories along the way, and mounts only where ApexOs knows a dataset.
 */
function checkComponent(folder: FolderRoot, abs: string, st: TnStat, opts: { last: boolean; allowLink?: boolean }): void {
  const label = displayRel(folder, abs);
  if (st.is_ctldir) throw new UserError('Snapshots can’t be browsed or changed here.', 400, 'SNAPSHOTS');
  if (st.type === 'SYMLINK') {
    if (opts.last && opts.allowLink) return;
    throw new UserError(`“${label}” is a link to another place, so ApexOs won’t open it or work through it.`, 400, 'SYMLINK');
  }
  // A non-symlink resolves to itself; anything else means the path isn't what it looks like.
  if (st.realpath !== abs) throw new UserError(`“${label}” leads somewhere else, so ApexOs won’t use it.`, 400, 'SYMLINK');
  if (!opts.last && st.type !== 'DIRECTORY') throw new UserError(`“${label}” is not a folder.`, 400, 'NOT_A_FOLDER');
  const known = folder.areas.find((a) => a.path === abs);
  if (st.is_mountpoint) {
    if (!known) throw new UserError(`Something else is mounted at “${label}”, so ApexOs leaves it alone.`, 400, 'FOREIGN_MOUNT');
    if (known.locked) throw lockedError(label);
  } else if (known) {
    // A dataset should be mounted here but isn't: this is just an empty directory of the parent dataset.
    throw new UserError(`“${label}” isn’t available right now.`, 409, 'UNAVAILABLE');
  }
}

/** Resolves a folder-relative path and checks every component from the folder root down. */
async function locate(
  client: TrueNasClient,
  folder: FolderRoot,
  segments: string[],
  opts: { mustExist?: boolean; allowLink?: boolean } = {},
): Promise<Located> {
  const mustExist = opts.mustExist ?? true;
  const prefixes = [folder.path, ...segments.map((_, i) => `${folder.path}/${segments.slice(0, i + 1).join('/')}`)];
  const abs = prefixes[prefixes.length - 1]!;
  const area = areaOf(folder, abs);
  if (area.locked) throw lockedError(displayRel(folder, area.path));
  // Stat every component at once, but only report an error for components the walk actually reaches
  // (below a file, TrueNAS may answer with errors other than "not found").
  const results = await Promise.all(prefixes.map((p) => statOrNull(client, p).then((st) => ({ st }), (error: unknown) => ({ st: null, error }))));
  const stats = results.map((r) => r.st);
  for (let i = 0; i < prefixes.length; i++) {
    const result = results[i]!;
    if ('error' in result) throw result.error;
    const st = stats[i];
    const last = i === prefixes.length - 1;
    if (!st) {
      if (last && !mustExist) break;
      throw new UserError(`“${displayRel(folder, prefixes[i]!)}” doesn’t exist (any more). Refresh and try again.`, 404, 'NOT_FOUND');
    }
    checkComponent(folder, prefixes[i]!, st, { last, allowLink: opts.allowLink });
  }
  const root = stats[0]!;
  if (root.type !== 'DIRECTORY' || !root.is_mountpoint) throw new UserError(`“${folder.name}” isn’t available right now.`, 409, 'UNAVAILABLE');
  return {
    folder,
    segments,
    rel: relPath(segments),
    abs,
    area,
    stat: stats[prefixes.length - 1] ?? null,
    parentStat: prefixes.length > 1 ? stats[prefixes.length - 2]! : null,
  };
}

async function locateDirectory(client: TrueNasClient, folder: FolderRoot, segments: string[]): Promise<Located & { stat: TnStat }> {
  const dir = await locate(client, folder, segments);
  if (dir.stat!.type !== 'DIRECTORY') throw new UserError(`“${displayRel(folder, dir.abs)}” is not a folder.`, 400, 'NOT_A_FOLDER');
  return dir as Located & { stat: TnStat };
}

/**
 * Locates many existing items: each distinct parent directory is checked once, then the items themselves.
 * Missing items mean the selection is stale (renamed or deleted meanwhile).
 */
async function locateItems(client: TrueNasClient, folder: FolderRoot, paths: unknown): Promise<Array<Located & { stat: TnStat }>> {
  if (!Array.isArray(paths) || !paths.length) throw new UserError('Select at least one item.', 400, 'VALIDATION', { paths: 'Required' });
  if (paths.length > MAX_ITEMS) throw new UserError(`Select at most ${MAX_ITEMS.toLocaleString('en-US')} items at a time.`, 400, 'TOO_MANY');
  const all = paths.map((p, i) => splitPath(p, `paths.${i}`));
  const seen = new Set<string>();
  for (const segs of all) {
    if (!segs.length) throw new UserError('The folder itself can’t be changed here.', 400, 'PROTECTED');
    const key = relPath(segs);
    if (seen.has(key)) throw new UserError('An item is selected twice.', 400, 'VALIDATION');
    seen.add(key);
  }
  const parents = new Map<string, Promise<Located>>();
  for (const segs of all) {
    const key = relPath(segs.slice(0, -1));
    if (!parents.has(key)) parents.set(key, locateDirectory(client, folder, segs.slice(0, -1)));
  }
  const missing: string[] = [];
  const located = await mapLimit(all, STAT_CONCURRENCY, async (segs) => {
    const parent = await parents.get(relPath(segs.slice(0, -1)))!;
    const abs = `${parent.abs}/${segs[segs.length - 1]}`;
    const st = await statOrNull(client, abs);
    if (!st) {
      missing.push(segs[segs.length - 1]!);
      return null;
    }
    checkComponent(folder, abs, st, { last: true, allowLink: true });
    const area = areaOf(folder, abs);
    if (area.locked) throw lockedError(displayRel(folder, area.path));
    return { folder, segments: segs, rel: relPath(segs), abs, area, stat: st, parentStat: parent.stat };
  });
  if (missing.length) {
    throw new UserError(
      `${missing.length === 1 ? `“${missing[0]}” has` : `${missing.length} selected items have`} changed or disappeared since you selected ${missing.length === 1 ? 'it' : 'them'}. Refresh and select again.`,
      409,
      'STALE',
    );
  }
  return located as Array<Located & { stat: TnStat }>;
}

/** Folder roots, child datasets and folders containing child datasets can't be renamed, moved, copied or deleted. */
function assertMovable(item: Located): void {
  const { folder, abs } = item;
  const name = item.segments[item.segments.length - 1] ?? folder.name;
  if (abs === folder.path) throw new UserError('The folder itself can’t be renamed, moved or deleted here.', 400, 'PROTECTED');
  if (folder.areas.some((a) => a.path === abs) || item.stat?.is_mountpoint) {
    throw new UserError(`“${name}” is stored separately (its own dataset), so it can’t be renamed, moved or deleted here.`, 400, 'PROTECTED');
  }
  const inner = folder.areas.find((a) => a.path.startsWith(`${abs}/`));
  if (inner) {
    throw new UserError(
      `“${name}” contains “${displayRel(folder, inner.path)}”, which is stored separately (its own dataset), so it can’t be moved, copied or deleted as a whole.`,
      400,
      'CONTAINS_DATASET',
    );
  }
}

function entryFrom(folder: FolderRoot, rel: string, name: string, st: TnStat): FileEntry {
  const abs = `${folder.path}/${rel}`;
  return {
    name,
    path: rel,
    type: toType(st.type),
    size: st.type === 'DIRECTORY' ? null : st.size,
    modified: Number.isFinite(st.mtime) ? new Date(st.mtime * 1000).toISOString() : null,
    separate: st.type === 'DIRECTORY' && (st.is_mountpoint || folder.areas.some((a) => a.path === abs)),
    hidden: name.startsWith('.'),
  };
}

/** Picks "name (n)" that doesn't exist in `dirAbs` (and isn't in `taken`). */
async function freeName(client: TrueNasClient, dirAbs: string, name: string, isFolder: boolean, taken = new Set<string>()): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const candidate = numberedName(name, n, isFolder);
    if (Buffer.byteLength(candidate, 'utf8') > MAX_NAME_BYTES) break;
    if (taken.has(candidate.toLowerCase())) continue;
    if (!(await statOrNull(client, `${dirAbs}/${candidate}`))) return candidate;
  }
  throw new UserError(`Couldn’t find a free name for “${name}”.`, 409, 'EXISTS');
}

/** New files and folders are created by root; give them the owner of the folder they were created in. */
async function matchOwner(client: TrueNasClient, abs: string, owner: Pick<TnStat, 'uid' | 'gid'>): Promise<void> {
  const st = await statOrNull(client, abs);
  if (!st || (st.uid === owner.uid && st.gid === owner.gid)) return;
  await client.job('filesystem.chown', [{ path: abs, uid: owner.uid, gid: owner.gid, options: { recursive: false, traverse: false } }]);
}

function hostFailure(what: string, result: HostResult | null): string {
  const detail = result?.output.trim().split('\n').filter(Boolean).slice(-2).join(' ') ?? '';
  return detail ? `${what}: ${detail}` : what;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ListQuery {
  folder: string;
  path?: string;
  sort?: FileSortKey;
  order?: FileSortOrder;
  offset?: number;
  limit?: number;
  hidden?: boolean;
  foldersOnly?: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function extension(e: FileEntry): string {
  if (e.type !== 'file') return '';
  const dot = e.name.lastIndexOf('.');
  return dot > 0 ? e.name.slice(dot + 1).toLowerCase() : '';
}

function compareEntries(sort: FileSortKey, order: FileSortOrder): (a: FileEntry, b: FileEntry) => number {
  const dir = order === 'desc' ? -1 : 1;
  return (a, b) => {
    // Folders always come first.
    const fa = a.type === 'folder' ? 0 : 1;
    const fb = b.type === 'folder' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    let c = 0;
    if (sort === 'size') c = (a.size ?? -1) - (b.size ?? -1);
    else if (sort === 'type') c = collator.compare(a.type === 'file' ? extension(a) : a.type, b.type === 'file' ? extension(b) : b.type);
    else if (sort === 'modified') c = (a.modified ? Date.parse(a.modified) : 0) - (b.modified ? Date.parse(b.modified) : 0);
    return dir * (c || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };
}

async function addDates(client: TrueNasClient, dirAbs: string, entries: FileEntry[]): Promise<void> {
  await mapLimit(entries, STAT_CONCURRENCY, async (e) => {
    if (e.modified) return;
    const st = await statOrNull(client, `${dirAbs}/${e.name}`).catch(() => null);
    e.modified = st && Number.isFinite(st.mtime) ? new Date(st.mtime * 1000).toISOString() : null;
  });
}

export async function listDirectory(ctx: AppContext, q: ListQuery): Promise<FileListing> {
  const client = ctx.truenas.client();
  const folder = await loadFolder(client, q.folder);
  const dir = await locateDirectory(client, folder, splitPath(q.path));
  const sort: FileSortKey = q.sort ?? 'name';
  const order: FileSortOrder = q.order ?? 'asc';
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? DEFAULT_PAGE)), MAX_PAGE);
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const filters: unknown[] = [];
  if (!q.hidden) filters.push(['name', '!^', '.']);
  if (q.foldersOnly) filters.push(['type', '=', 'DIRECTORY']);
  const raw = await client.call<TnDirEntry[]>('filesystem.listdir', [dir.abs, filters, { select: LIST_SELECT, order_by: ['name'], limit: SCAN_LIMIT + 1 }]);
  const truncated = raw.length > SCAN_LIMIT;
  const entries: FileEntry[] = raw
    .slice(0, SCAN_LIMIT)
    .filter((e) => e.name.toLowerCase() !== '.zfs')
    .map((e) => ({
      name: e.name,
      path: joinRel(dir.rel, e.name),
      type: toType(e.type),
      size: e.type === 'DIRECTORY' ? null : e.size,
      modified: null,
      separate: e.type === 'DIRECTORY' && (e.is_mountpoint || folder.areas.some((a) => a.path === `${dir.abs}/${e.name}`)),
      hidden: e.name.startsWith('.'),
    }));
  let sortFallback = false;
  let effectiveSort = sort;
  if (sort === 'modified') {
    if (entries.length <= DATE_SORT_LIMIT) await addDates(client, dir.abs, entries);
    else {
      sortFallback = true;
      effectiveSort = 'name';
    }
  }
  entries.sort(compareEntries(effectiveSort, order));
  const page = entries.slice(offset, offset + limit);
  await addDates(client, dir.abs, page);
  return {
    folder: folder.name,
    path: dir.rel,
    entries: page,
    total: entries.length,
    offset,
    limit,
    sort,
    order,
    truncated,
    scanLimit: SCAN_LIMIT,
    sortFallback,
    separate: dir.area.dataset !== folder.dataset,
  };
}

// ---------------------------------------------------------------------------
// Check, new folder, rename
// ---------------------------------------------------------------------------

export async function checkNames(ctx: AppContext, req: FileCheckRequest): Promise<FileCheckResponse> {
  if (!Array.isArray(req.names) || req.names.length > 1_000) throw new UserError('Check at most 1,000 names at a time.', 400, 'VALIDATION');
  const client = ctx.truenas.client();
  const folder = await loadFolder(client, req.folder);
  const dir = await locateDirectory(client, folder, splitPath(req.path));
  const invalid: FileCheckResponse['invalid'] = [];
  const valid: string[] = [];
  for (const name of new Set(req.names)) {
    const problem = nameProblem(name);
    if (problem) invalid.push({ name: String(name), reason: problem });
    else valid.push(name);
  }
  const found = await mapLimit(valid, STAT_CONCURRENCY, async (name) => {
    const st = await statOrNull(client, `${dir.abs}/${name}`);
    return st ? { name, type: toType(st.type) } : null;
  });
  return { existing: found.filter((f): f is { name: string; type: FileEntryType } => f !== null), invalid };
}

/** Makes sure `name` is a usable sub-folder of `parent` (creating it if missing); refuses links, files and other datasets. */
async function ensureChildFolder(
  client: TrueNasClient,
  folder: FolderRoot,
  parent: Located,
  name: string,
  conflict: 'ask' | 'keep-both' | 'skip',
): Promise<Located & { stat: TnStat; created: boolean }> {
  let finalName = name;
  let abs = `${parent.abs}/${name}`;
  let st = await statOrNull(client, abs);
  if (st) {
    if (conflict === 'ask') throw new UserError(`There’s already something called “${name}” here.`, 409, 'EXISTS', { name: 'Already exists' });
    if (conflict === 'keep-both') {
      finalName = await freeName(client, parent.abs, name, true);
      abs = `${parent.abs}/${finalName}`;
      st = null;
    } else {
      // Reuse an existing folder, but never a link, a file or another dataset.
      checkComponent(folder, abs, st, { last: false });
      if (st.type !== 'DIRECTORY') throw new UserError(`“${name}” is a file, not a folder.`, 409, 'EXISTS');
      if (st.is_mountpoint || areaOf(folder, abs) !== parent.area) {
        throw new UserError(`“${name}” is stored separately (its own dataset); ApexOs won’t put things into it from here.`, 400, 'CROSSES_DATASET');
      }
      return { ...parent, segments: [...parent.segments, name], rel: joinRel(parent.rel, name), abs, stat: st, parentStat: parent.stat, created: false };
    }
  }
  try {
    await client.call('filesystem.mkdir', [{ path: abs, options: { mode: '755', raise_chmod_error: false } }]);
  } catch (err) {
    if (err instanceof TrueNasError && err.errname === 'EEXIST') throw new UserError(`There’s already something called “${finalName}” here.`, 409, 'EXISTS');
    throw err;
  }
  if (parent.stat) await matchOwner(client, abs, parent.stat);
  const created = await statOrNull(client, abs);
  if (!created || created.type !== 'DIRECTORY') throw new UserError(`TrueNAS didn’t create “${finalName}”.`, 502, 'MKDIR_FAILED');
  return { ...parent, segments: [...parent.segments, finalName], rel: joinRel(parent.rel, finalName), abs, stat: created, parentStat: parent.stat, created: true };
}

export async function makeDirectory(ctx: AppContext, req: FileMkdirRequest): Promise<FileEntry> {
  const client = ctx.truenas.client();
  const folder = await loadFolder(client, req.folder);
  const names = req.parents ? splitPath(req.name, 'name') : [validateNewName(req.name)];
  if (!names.length) throw new UserError('Enter a name.', 400, 'INVALID_NAME', { name: 'Required' });
  if (req.parents) for (const n of names) validateNewName(n);
  let current: Located = await locateDirectory(client, folder, splitPath(req.path));
  for (let i = 0; i < names.length; i++) {
    const last = i === names.length - 1;
    current = await ensureChildFolder(client, folder, current, names[i]!, last ? (req.conflict ?? 'ask') : 'skip');
  }
  return entryFrom(folder, current.rel, current.segments[current.segments.length - 1]!, current.stat!);
}

export async function renameEntry(ctx: AppContext, req: FileRenameRequest): Promise<FileEntry> {
  const client = ctx.truenas.client();
  const folder = await loadFolder(client, req.folder);
  const newName = validateNewName(req.newName, 'newName');
  const [item] = await locateItems(client, folder, [req.path]);
  assertMovable(item!);
  const oldName = item!.segments[item!.segments.length - 1]!;
  const parentAbs = posix.dirname(item!.abs);
  const parentRel = relPath(item!.segments.slice(0, -1));
  if (newName === oldName) return entryFrom(folder, item!.rel, oldName, item!.stat);
  const dst = `${parentAbs}/${newName}`;
  const existing = await statOrNull(client, dst);
  // On case-insensitive datasets a different-case name finds the item itself.
  const sameItem = !!existing && existing.inode === item!.stat.inode && existing.dev === item!.stat.dev;
  if (existing && !sameItem) throw new UserError(`There’s already something called “${newName}” here.`, 409, 'EXISTS', { newName: 'Already exists' });
  const result = await ctx.host.run('mv', ['-n', '-T', '--', item!.abs, dst]);
  const [after, before] = await Promise.all([statOrNull(client, dst), sameItem ? Promise.resolve(null) : statOrNull(client, item!.abs)]);
  if (!after || before) throw new UserError(hostFailure(`Couldn’t rename “${oldName}”`, result), 409, 'RENAME_FAILED');
  return entryFrom(folder, joinRel(parentRel, newName), newName, after);
}

// ---------------------------------------------------------------------------
// Move, copy, delete (tasks)
// ---------------------------------------------------------------------------

interface TransferItem {
  src: Located & { stat: TnStat };
  name: string;
  /** Final name at the destination (differs from `name` with keep-both). */
  target: string;
  weight: number;
}

export interface TransferPlan {
  kind: 'move' | 'copy';
  folder: FolderRoot;
  destination: Located & { stat: TnStat };
  items: TransferItem[];
  skipped: string[];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function listNames(names: string[], max = 3): string {
  const shown = names.slice(0, max).map((n) => `“${n}”`);
  return names.length > max ? `${shown.join(', ')} and ${names.length - max} more` : shown.join(names.length === 2 ? ' and ' : ', ');
}

/** Validates a move or copy against the server's current state; throws a UserError when it would be unsafe. */
export async function prepareTransfer(ctx: AppContext, kind: 'move' | 'copy', req: FileTransferRequest): Promise<TransferPlan> {
  const client = ctx.truenas.client();
  const folder = await loadFolder(client, req.folder);
  const conflict = req.conflict ?? 'ask';
  if (!['ask', 'keep-both', 'skip'].includes(conflict)) throw new UserError('Unknown conflict choice.', 400, 'VALIDATION');
  const [destination, sources] = await Promise.all([
    locateDirectory(client, folder, splitPath(req.destination, 'destination')),
    locateItems(client, folder, req.paths),
  ]);
  const verb = kind === 'move' ? 'moved' : 'copied';
  const names = new Set<string>();
  for (const src of sources) {
    assertMovable(src);
    const name = src.segments[src.segments.length - 1]!;
    if (src.area !== destination.area) {
      throw new UserError(
        `“${name}” can’t be ${verb} to “${displayRel(folder, destination.abs)}” because one of them is stored separately (its own dataset). Use your network share to ${kind} it instead.`,
        400,
        'CROSSES_DATASET',
      );
    }
    if (src.stat.type === 'DIRECTORY' && (destination.abs === src.abs || destination.abs.startsWith(`${src.abs}/`))) {
      throw new UserError(`A folder can’t be ${verb} into itself (“${name}”).`, 400, 'INTO_ITSELF');
    }
    if (kind === 'move' && posix.dirname(src.abs) === destination.abs) {
      throw new UserError(`“${name}” is already in “${displayRel(folder, destination.abs)}”.`, 400, 'SAME_PLACE');
    }
    if (names.has(name.toLowerCase())) throw new UserError(`Two selected items are called “${name}”.`, 400, 'DUPLICATE_NAMES');
    names.add(name.toLowerCase());
  }
  const existing = await mapLimit(sources, STAT_CONCURRENCY, (src) => statOrNull(client, `${destination.abs}/${src.segments[src.segments.length - 1]}`));
  const conflicts = sources.filter((_, i) => existing[i]).map((s) => s.segments[s.segments.length - 1]!);
  if (conflicts.length && conflict === 'ask') {
    throw new UserError(
      `${listNames(conflicts)} already ${conflicts.length === 1 ? 'exists' : 'exist'} in “${displayRel(folder, destination.abs)}”.`,
      409,
      'CONFLICT',
      Object.fromEntries(conflicts.map((n) => [n, 'exists'])),
    );
  }
  const items: TransferItem[] = [];
  const skipped: string[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!;
    const name = src.segments[src.segments.length - 1]!;
    let target = name;
    if (existing[i]) {
      if (conflict === 'skip') {
        skipped.push(name);
        continue;
      }
      target = await freeName(client, destination.abs, name, src.stat.type === 'DIRECTORY', taken);
    }
    taken.add(target.toLowerCase());
    items.push({ src, name, target, weight: src.stat.type === 'FILE' ? Math.max(src.stat.size, 1) : NODE_WEIGHT });
  }
  return { kind, folder, destination, items, skipped };
}

/** Splits items into host commands: same-name items share one `-t <dir>` command, renamed ones go alone. */
function batches(items: TransferItem[]): TransferItem[][] {
  const out: TransferItem[][] = [];
  let current: TransferItem[] = [];
  let bytes = 0;
  for (const item of items) {
    if (item.target !== item.name) {
      out.push([item]);
      continue;
    }
    const size = Buffer.byteLength(item.src.abs) + 3;
    if (current.length && (current.length >= BATCH_ITEMS || bytes + size > BATCH_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

const COPY_FLAGS = ['-a', '-n', '--reflink=auto', '--one-file-system'];

function transferArgv(kind: 'move' | 'copy', destAbs: string, batch: TransferItem[]): { binary: HostBinary; args: string[] } {
  const flags = kind === 'move' ? ['-n'] : COPY_FLAGS;
  const binary: HostBinary = kind === 'move' ? 'mv' : 'cp';
  const only = batch[0]!;
  if (batch.length === 1 && only.target !== only.name) return { binary, args: [...flags, '-T', '--', only.src.abs, `${destAbs}/${only.target}`] };
  return { binary, args: [...flags, '-t', destAbs, '--', ...batch.map((b) => b.src.abs)] };
}

export async function runTransfer(ctx: AppContext, plan: TransferPlan, task: TaskContext): Promise<void> {
  const client = ctx.truenas.client();
  const { kind, destination, items } = plan;
  const total = items.reduce((s, i) => s + i.weight, 0) || 1;
  let done = 0;
  let count = 0;
  const failed: string[] = [];
  let lastOutput: HostResult | null = null;
  const verb = kind === 'move' ? 'Moved' : 'Copied';
  task.progress(0, `${kind === 'move' ? 'Moving' : 'Copying'} ${plural(items.length, 'item')}…`);
  for (const batch of batches(items)) {
    const { binary, args } = transferArgv(kind, destination.abs, batch);
    const weight = batch.reduce((s, i) => s + i.weight, 0);
    // Live progress for one big file copy: watch the destination grow.
    const big = kind === 'copy' && batch.length === 1 && batch[0]!.src.stat.type === 'FILE' && batch[0]!.weight >= POLL_COPY_BYTES ? batch[0]! : null;
    let poll: NodeJS.Timeout | undefined;
    if (big) {
      poll = setInterval(() => {
        void statOrNull(client, `${destination.abs}/${big.target}`)
          .then((st) => {
            if (st) task.progress(((done + Math.min(st.size, big.weight)) / total) * 100, `Copying “${big.name}”…`);
          })
          .catch(() => undefined);
      }, 1_000);
    }
    let result: HostResult | null = null;
    try {
      result = await ctx.host.run(binary, args, { timeoutMs: TRANSFER_TIMEOUT_MS });
    } catch (err) {
      result = { output: (err as Error).message, code: -1 };
    } finally {
      clearInterval(poll);
    }
    // Verify every item: exit codes alone can't tell a skipped `-n` from a success.
    const checks = await mapLimit(batch, STAT_CONCURRENCY, async (item) => {
      const [after, before] = await Promise.all([
        statOrNull(client, `${destination.abs}/${item.target}`),
        kind === 'move' ? statOrNull(client, item.src.abs) : Promise.resolve(null),
      ]);
      return !!after && !before;
    });
    batch.forEach((item, i) => {
      if (!checks[i]) failed.push(item.name);
    });
    if (checks.some((ok) => !ok)) lastOutput = result;
    done += weight;
    count += batch.length;
    task.progress((done / total) * 100, `${verb} ${count.toLocaleString('en-US')} of ${plural(items.length, 'item')}`);
  }
  ctx.bus.changed('folders');
  if (failed.length) {
    throw new Error(hostFailure(`${listNames(failed)} couldn’t be ${kind === 'move' ? 'moved' : 'copied'}`, lastOutput));
  }
}

export function transferTitle(plan: TransferPlan): string {
  const what = plan.items.length === 1 ? `“${plan.items[0]!.name}”` : plural(plan.items.length, 'item');
  return `${plan.kind === 'move' ? 'Moving' : 'Copying'} ${what} to ${displayRel(plan.folder, plan.destination.abs)}`;
}

export interface DeletePlan {
  folder: FolderRoot;
  items: Array<Located & { stat: TnStat }>;
}

export async function prepareDelete(ctx: AppContext, req: FileDeleteRequest): Promise<DeletePlan> {
  const client = ctx.truenas.client();
  const folder = await loadFolder(client, req.folder);
  const items = await locateItems(client, folder, req.paths);
  for (const item of items) assertMovable(item);
  return { folder, items };
}

export function deleteTitle(plan: DeletePlan): string {
  const what = plan.items.length === 1 ? `“${plan.items[0]!.segments.at(-1)}”` : plural(plan.items.length, 'item');
  return `Deleting ${what} from ${plan.folder.name}`;
}

export async function runDelete(ctx: AppContext, plan: DeletePlan, task: TaskContext): Promise<void> {
  const client = ctx.truenas.client();
  const asItems: TransferItem[] = plan.items.map((src) => ({ src, name: src.abs, target: src.abs, weight: 1 }));
  const failed: string[] = [];
  let lastOutput: HostResult | null = null;
  let count = 0;
  task.progress(0, `Deleting ${plural(plan.items.length, 'item')}…`);
  for (const batch of batches(asItems)) {
    let result: HostResult | null = null;
    try {
      result = await ctx.host.run('rm', ['-r', '--one-file-system', '--', ...batch.map((b) => b.src.abs)], { timeoutMs: TRANSFER_TIMEOUT_MS });
    } catch (err) {
      result = { output: (err as Error).message, code: -1 };
    }
    const gone = await mapLimit(batch, STAT_CONCURRENCY, async (b) => !(await statOrNull(client, b.src.abs)));
    batch.forEach((b, i) => {
      if (!gone[i]) failed.push(b.src.segments.at(-1)!);
    });
    if (gone.some((g) => !g)) lastOutput = result;
    count += batch.length;
    task.progress((count / asItems.length) * 100, `Deleted ${count.toLocaleString('en-US')} of ${plural(asItems.length, 'item')}`);
  }
  ctx.bus.changed('folders');
  if (failed.length) throw new Error(hostFailure(`${listNames(failed)} couldn’t be deleted`, lastOutput));
}

export function startTransfer(ctx: AppContext, plan: TransferPlan): Task {
  return ctx.tasks.start({ type: `files-${plan.kind}`, title: transferTitle(plan), ref: plan.folder.name }, (t) => runTransfer(ctx, plan, t));
}

export function startDelete(ctx: AppContext, plan: DeletePlan): Task {
  return ctx.tasks.start({ type: 'files-delete', title: deleteTitle(plan), ref: plan.folder.name }, (t) => runDelete(ctx, plan, t));
}

// ---------------------------------------------------------------------------
// Upload and download
// ---------------------------------------------------------------------------

export interface UploadQuery {
  folder: string;
  path?: string;
  name: string;
  conflict?: string;
}

/**
 * Streams one file into the folder. TrueNAS's `filesystem.put` replaces files silently and creates them
 * as root, so ApexOs checks the name first, creates missing sub-folders itself, writes replacements to a
 * hidden temporary file that is renamed over the old one only once complete, and gives new files the
 * owner of their folder.
 */
export async function uploadFile(ctx: AppContext, q: UploadQuery, body: AsyncIterable<Buffer>, declaredSize: number | null): Promise<FileUploadResponse> {
  const max = uploadLimit();
  if (declaredSize !== null && declaredSize > max) {
    throw new UserError(`That file is larger than the ${Math.floor(max / 1024 ** 3)} GiB upload limit.`, 413, 'TOO_LARGE');
  }
  const conflict = q.conflict ?? 'ask';
  if (!['ask', 'replace', 'keep-both', 'skip'].includes(conflict)) throw new UserError('Unknown conflict choice.', 400, 'VALIDATION');
  const client = ctx.truenas.client();
  const folder = await loadFolder(client, q.folder);
  const nameSegments = splitPath(q.name, 'name');
  if (!nameSegments.length) throw new UserError('The file needs a name.', 400, 'INVALID_NAME');
  let parent: Located = await locateDirectory(client, folder, splitPath(q.path));
  for (const seg of nameSegments.slice(0, -1)) parent = await ensureChildFolder(client, folder, parent, seg, 'skip');
  const fileName = nameSegments[nameSegments.length - 1]!;
  let finalName = fileName;
  let target = `${parent.abs}/${fileName}`;
  let writePath = target;
  let action: FileUploadResponse['action'] = 'created';
  const existing = await statOrNull(client, target);
  if (existing) {
    if (existing.type === 'SYMLINK') {
      throw new UserError(`“${fileName}” here is a link to another place; ApexOs won’t write through it.`, 400, 'SYMLINK');
    }
    if (conflict === 'ask') throw new UserError(`“${fileName}” already exists here.`, 409, 'CONFLICT', { [fileName]: 'exists' });
    if (conflict === 'skip') return { action: 'skipped', entry: entryFrom(folder, joinRel(parent.rel, fileName), fileName, existing) };
    if (conflict === 'keep-both') {
      finalName = await freeName(client, parent.abs, fileName, false);
      target = `${parent.abs}/${finalName}`;
      writePath = target;
      action = 'renamed';
    } else {
      if (existing.type !== 'FILE') throw new UserError(`A folder called “${fileName}” is already here, so it can’t be replaced by a file.`, 409, 'EXISTS');
      writePath = `${parent.abs}/.apexos-upload-${randomUUID()}.part`;
      action = 'replaced';
    }
  }

  let job: Job | null = null;
  try {
    const jobId = await client.uploadStream({ method: 'filesystem.put', params: [writePath, { append: false }], body, filename: asciiName(finalName) });
    job = await client.waitForJob(jobId);
    if (job.state !== 'SUCCESS') throw new UserError(`TrueNAS couldn’t save “${finalName}”: ${job.error ?? job.state}`, 502, 'UPLOAD_FAILED');
  } catch (err) {
    // An interrupted upload leaves a partial file behind (TrueNAS keeps what arrived): let the job
    // finish writing, then remove what this upload created.
    await settlePutJobs(client, writePath);
    await ctx.host.run('rm', ['-f', '--', writePath]).catch(() => undefined);
    if (err instanceof UserError) throw err;
    if (err instanceof TrueNasError) throw new UserError(`The upload of “${finalName}” failed: ${err.reason ?? err.message}`, 502, 'UPLOAD_FAILED');
    throw err;
  }

  if (action === 'replaced') {
    // Keep the replaced file's owner, then swap the complete file in.
    await matchOwner(client, writePath, existing!);
    const written = await statOrNull(client, writePath);
    const result = await ctx.host.run('mv', ['-f', '-T', '--', writePath, target]);
    const after = await statOrNull(client, target);
    if (!written || !after || after.inode !== written.inode) {
      await ctx.host.run('rm', ['-f', '--', writePath]).catch(() => undefined);
      throw new UserError(hostFailure(`Couldn’t replace “${fileName}”`, result), 409, 'UPLOAD_FAILED');
    }
  } else if (parent.stat) {
    await matchOwner(client, target, parent.stat);
  }
  const st = await statOrNull(client, target);
  if (!st) throw new UserError(`“${finalName}” was uploaded but can’t be found.`, 502, 'UPLOAD_FAILED');
  return { action, entry: entryFrom(folder, joinRel(parent.rel, finalName), finalName, st) };
}

/** Waits (briefly) for `filesystem.put` jobs still writing `path`. */
async function settlePutJobs(client: TrueNasClient, path: string): Promise<void> {
  try {
    const jobs = await client.call<Job[]>('core.get_jobs', [[['method', '=', 'filesystem.put'], ['state', 'in', ['WAITING', 'RUNNING']]]]);
    const writing = jobs.filter((j) => Array.isArray(j.arguments) && j.arguments[0] === path);
    await Promise.race([Promise.all(writing.map((j) => client.waitForJob(j.id))), new Promise((r) => setTimeout(r, 30_000).unref())]);
  } catch {
    // Best effort: the partial file is removed either way.
  }
}

export interface OpenedDownload {
  name: string;
  size: number;
  stream: Readable;
  /** Resolves with the TrueNAS job once it ends; a failed job means the bytes were not the file. */
  finished: Promise<Job>;
}

/** Starts `filesystem.get` and opens its download right away (the token is single-use and expires in 60 s). */
export async function openDownload(ctx: AppContext, q: { folder: string; path: string }): Promise<OpenedDownload> {
  const client = ctx.truenas.client();
  const folder = await loadFolder(client, q.folder);
  const segments = splitPath(q.path);
  if (!segments.length) throw new UserError('Pick a file to download.', 400, 'NOT_A_FILE');
  const item = await locate(client, folder, segments);
  const name = segments[segments.length - 1]!;
  if (item.stat!.type !== 'FILE') throw new UserError(`“${name}” is not a file. Folders can’t be downloaded; open them and pick files.`, 400, 'NOT_A_FILE');
  const [jobId, url] = await client.call<[number, string]>('core.download', ['filesystem.get', [item.abs], asciiName(name), false]);
  const stream = await client.downloadStream(url);
  return { name, size: item.stat!.size, stream, finished: client.waitForJob(jobId) };
}
