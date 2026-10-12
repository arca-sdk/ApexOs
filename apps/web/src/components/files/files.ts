/** Helpers shared by the file browser components: names, paths, kinds, icons and view preferences. */
import { reactive, watch, type Component } from 'vue';
import { File, FileArchive, FileCode, FileHeadphone, FileImage, FilePlay, FileSpreadsheet, FileSymlink, FileText, Folder, FolderLock } from 'lucide-vue-next';
import type { FileEntry, FileSortKey, FileSortOrder } from '@apexos/api-types';

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** "photo.jpg" → ["photo", ".jpg"]; dotfiles and names without a dot have no extension. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot)];
}

type Kind = 'image' | 'video' | 'audio' | 'archive' | 'pdf' | 'text' | 'document' | 'sheet' | 'slides' | 'code' | 'disk';

const KINDS: Record<Kind, { label: string; icon: Component; ext: string[] }> = {
  image: { label: 'Image', icon: FileImage, ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg', 'avif', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng'] },
  video: { label: 'Video', icon: FilePlay, ext: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'm4v', 'webm', 'mpg', 'mpeg', 'ts', 'm2ts', 'flv'] },
  audio: { label: 'Audio', icon: FileHeadphone, ext: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'm4b', 'ogg', 'opus', 'wma', 'aiff', 'alac'] },
  archive: { label: 'Archive', icon: FileArchive, ext: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'] },
  disk: { label: 'Disk image', icon: FileArchive, ext: ['iso', 'img', 'dmg', 'vhd', 'vhdx', 'qcow2'] },
  pdf: { label: 'PDF document', icon: FileText, ext: ['pdf'] },
  text: { label: 'Text', icon: FileText, ext: ['txt', 'md', 'log', 'srt', 'vtt', 'nfo', 'rtf'] },
  document: { label: 'Document', icon: FileText, ext: ['doc', 'docx', 'odt', 'pages', 'epub'] },
  sheet: { label: 'Spreadsheet', icon: FileSpreadsheet, ext: ['xls', 'xlsx', 'ods', 'csv', 'numbers'] },
  slides: { label: 'Presentation', icon: FileText, ext: ['ppt', 'pptx', 'odp', 'key'] },
  code: { label: 'Code', icon: FileCode, ext: ['js', 'ts', 'json', 'yml', 'yaml', 'py', 'sh', 'html', 'css', 'xml', 'toml', 'ini', 'conf', 'env'] },
};

const KIND_BY_EXT = new Map<string, Kind>();
for (const [kind, def] of Object.entries(KINDS) as Array<[Kind, (typeof KINDS)[Kind]]>) for (const e of def.ext) KIND_BY_EXT.set(e, kind);

function kindOf(entry: FileEntry): Kind | null {
  const ext = splitExtension(entry.name)[1].slice(1).toLowerCase();
  return KIND_BY_EXT.get(ext) ?? null;
}

export function entryIcon(entry: FileEntry): Component {
  if (entry.type === 'folder') return entry.separate ? FolderLock : Folder;
  if (entry.type === 'link') return FileSymlink;
  const kind = kindOf(entry);
  return kind ? KINDS[kind].icon : File;
}

/** Plain-language type, e.g. "Folder", "Video", "PDF document", "XYZ file". */
export function kindLabel(entry: FileEntry): string {
  if (entry.type === 'folder') return entry.separate ? 'Folder (stored separately)' : 'Folder';
  if (entry.type === 'link') return 'Link';
  if (entry.type === 'other') return 'Special file';
  const kind = kindOf(entry);
  if (kind) return KINDS[kind].label;
  const ext = splitExtension(entry.name)[1].slice(1);
  return ext ? `${ext.toUpperCase()} file` : 'File';
}

export function displayName(entry: FileEntry, showExtensions: boolean): string {
  if (showExtensions || entry.type !== 'file') return entry.name;
  return splitExtension(entry.name)[0];
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function formatDate(iso: string | null): string {
  return iso ? dateFormat.format(new Date(iso)) : '—';
}

export function downloadUrl(folder: string, path: string): string {
  return `/api/files/download?${new URLSearchParams({ folder, path })}`;
}

/** Starts browser downloads one after another (browsers drop rapid bursts). */
export async function downloadAll(folder: string, paths: string[]): Promise<void> {
  for (const [i, path] of paths.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 400));
    const a = document.createElement('a');
    a.href = downloadUrl(folder, path);
    a.download = baseName(path);
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  }
}

export function itemsLabel(n: number): string {
  return n === 1 ? '1 item' : `${n.toLocaleString()} items`;
}

// ---- view preferences (remembered in this browser) ----

export interface ViewPrefs {
  sort: FileSortKey;
  order: FileSortOrder;
  showHidden: boolean;
  showExtensions: boolean;
}

const PREFS_KEY = 'apexos.files.view';

function loadPrefs(): ViewPrefs {
  const defaults: ViewPrefs = { sort: 'name', order: 'asc', showHidden: false, showExtensions: true };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<ViewPrefs>;
    return {
      sort: ['name', 'size', 'type', 'modified'].includes(saved.sort as string) ? (saved.sort as FileSortKey) : defaults.sort,
      order: saved.order === 'desc' ? 'desc' : 'asc',
      showHidden: saved.showHidden === true,
      showExtensions: saved.showExtensions !== false,
    };
  } catch {
    return defaults;
  }
}

export const viewPrefs = reactive<ViewPrefs>(loadPrefs());
watch(viewPrefs, (p) => localStorage.setItem(PREFS_KEY, JSON.stringify(p)), { deep: true });

export const SORT_LABELS: Record<FileSortKey, string> = { name: 'Name', size: 'Size', type: 'Type', modified: 'Date modified' };
