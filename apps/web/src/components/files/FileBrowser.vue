<script setup lang="ts">
/**
 * Browses one folder: breadcrumbs, the file list, a details pane and every operation (new folder,
 * rename, move/copy, delete, upload, download). Moves, copies and deletes run as server tasks; their
 * progress shows here and in the task tray.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  ArrowUp,
  ChevronRight,
  Copy,
  Download,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-vue-next';
import type { FileEntry, FileListing, FileRoot, FileSortKey, Task, TaskStarted } from '@apexos/api-types';
import ConfirmDialog from '../ConfirmDialog.vue';
import { api, ApiError } from '../../lib/api.ts';
import { live } from '../../lib/events.ts';
import ContextMenu, { type ContextItem } from './ContextMenu.vue';
import DestinationDialog from './DestinationDialog.vue';
import FileDetails from './FileDetails.vue';
import FileList from './FileList.vue';
import NameDialog from './NameDialog.vue';
import { downloadAll, itemsLabel, joinPath, parentPath, SORT_LABELS, viewPrefs } from './files.ts';
import { filesFromDrop, filesFromInput, onUploaded, queueUpload, uploadErrorText } from './uploads.ts';

/** `linkFolder`: how the folder is named in /files links (the name, or `pool/Name` when two pools share it). */
const props = defineProps<{ root: FileRoot; path: string; linkFolder: string }>();
const emit = defineEmits<{ navigate: [path: string] }>();

const PAGE = 200;

const listing = ref<FileListing | null>(null);
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const loadError = ref<{ message: string; code: string } | null>(null);
const selected = ref<string[]>([]);
const status = ref('');
const opError = ref<string | null>(null);
const notice = ref<string | null>(null);
const menu = ref<{ x: number; y: number; items: ContextItem[]; label: string } | null>(null);
type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'transfer'; mode: 'move' | 'copy'; items: FileEntry[] }
  | { kind: 'delete'; items: FileEntry[] };
const dialog = ref<Dialog | null>(null);
const dialogBusy = ref(false);
const dialogError = ref<string | null>(null);
const startedTasks = ref<string[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const listRef = ref<InstanceType<typeof FileList> | null>(null);
const upButton = ref<HTMLButtonElement | null>(null);
const dragDepth = ref(0);
let requestToken = 0;

const selectedSet = computed(() => new Set(selected.value));
const selection = computed(() => entries.value.filter((e) => selectedSet.value.has(e.path)));
const crumbs = computed(() => {
  const segs = props.path ? props.path.split('/') : [];
  return [{ name: props.root.name, path: '' }, ...segs.map((s, i) => ({ name: s, path: segs.slice(0, i + 1).join('/') }))];
});
const here = computed(() => crumbs.value.map((c) => c.name).join(' › '));
const remaining = computed(() => (listing.value ? listing.value.total - entries.value.length : 0));
const anyProtected = computed(() => selection.value.some((e) => e.separate));
const onlyFiles = computed(() => selection.value.length > 0 && selection.value.every((e) => e.type === 'file'));

// ---- loading ----

async function load(opts: { more?: boolean; keepSelection?: boolean } = {}) {
  const token = ++requestToken;
  if (opts.more) loadingMore.value = true;
  else loading.value = true;
  try {
    const q = new URLSearchParams({
      folder: props.root.dataset,
      path: props.path,
      sort: viewPrefs.sort,
      order: viewPrefs.order,
      offset: String(opts.more ? entries.value.length : 0),
      limit: String(opts.more ? PAGE : Math.max(PAGE, entries.value.length)),
      hidden: viewPrefs.showHidden ? '1' : '0',
    });
    const res = await api.get<FileListing>(`/files/list?${q}`);
    if (token !== requestToken) return;
    listing.value = res;
    entries.value = opts.more ? [...entries.value, ...res.entries] : res.entries;
    loadError.value = null;
    const paths = new Set(entries.value.map((e) => e.path));
    selected.value = opts.keepSelection === false ? [] : selected.value.filter((p) => paths.has(p));
    status.value = `${here.value}: ${itemsLabel(res.total)}`;
    if (refocusList && !opts.more) {
      refocusList = false;
      await nextTick();
      if (entries.value.length) listRef.value?.focusFirst();
      else upButton.value?.focus();
    }
  } catch (e) {
    if (token !== requestToken) return;
    loadError.value = { message: e instanceof Error ? e.message : String(e), code: e instanceof ApiError ? e.code : 'UNKNOWN' };
    if (!opts.more) {
      entries.value = [];
      listing.value = null;
    }
  } finally {
    if (token === requestToken) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

watch(
  // A string key: the parent re-creates `root` whenever it reloads the folder list.
  () => `${props.root.dataset}\n${props.path}`,
  () => {
    selected.value = [];
    entries.value = [];
    opError.value = null;
    notice.value = null;
    void load({ keepSelection: false });
  },
  { immediate: true },
);
watch(() => `${viewPrefs.sort} ${viewPrefs.order} ${viewPrefs.showHidden}`, () => void load());

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void load(), 400);
}

const stopUploads = onUploaded((folder, dir) => {
  if (folder !== props.root.dataset) return;
  if (dir === props.path || props.path.startsWith(dir ? `${dir}/` : '')) scheduleReload();
});
onBeforeUnmount(() => {
  stopUploads();
  clearTimeout(reloadTimer);
});

// ---- tasks (move, copy, delete) ----

const runningTasks = computed(() =>
  Object.values(live.tasks).filter((t) => t.status === 'running' && t.type.startsWith('files-') && t.ref === props.root.name),
);

watch(
  () => runningTasks.value.map((t) => t.id).join(','),
  (now, before) => {
    // A files task for this folder finished (here or in another window): refresh.
    if (before && before.split(',').some((id) => id && !now.split(',').includes(id))) void load();
  },
);

watch(
  () => startedTasks.value.map((id) => live.tasks[id]?.status ?? 'running').join(','),
  () => {
    for (const id of [...startedTasks.value]) {
      const t: Task | undefined = live.tasks[id];
      if (!t || t.status === 'running') continue;
      startedTasks.value = startedTasks.value.filter((x) => x !== id);
      if (t.status === 'failed') opError.value = t.error ?? `${t.title} failed`;
      else notice.value = `${t.title.replace(/^(\w+)ing /, (_m, w: string) => `${doneVerb(w)} `)}.`;
      void load();
    }
  },
);

function doneVerb(stem: string): string {
  return { Mov: 'Moved', Copy: 'Copied', Delet: 'Deleted' }[stem] ?? `${stem}ed`;
}

function track(started: TaskStarted) {
  live.tasks[started.task.id] ??= started.task;
  startedTasks.value = [...startedTasks.value, started.task.id];
  opError.value = null;
  notice.value = null;
}

// ---- navigation and opening ----

/** Set when the list had keyboard focus as we navigated, so the new listing gets it back. */
let refocusList = false;

function navigate(path: string) {
  if (path === props.path) return;
  refocusList = !!document.activeElement?.closest('.file-table');
  emit('navigate', path);
}

function goUp() {
  if (props.path) navigate(parentPath(props.path));
}

function openEntry(entry: FileEntry) {
  if (entry.type === 'folder') navigate(entry.path);
  else if (entry.type === 'file') void downloadAll(props.root.dataset, [entry.path]);
  else notice.value = `“${entry.name}” is a link or special file. For safety, ApexOs doesn’t open it.`;
}

function downloadSelection() {
  const files = selection.value.filter((e) => e.type === 'file');
  if (!files.length) return;
  void downloadAll(props.root.dataset, files.map((f) => f.path));
  if (files.length > 1) notice.value = `Downloading ${files.length} files. Your browser may ask to allow several downloads.`;
}

// ---- dialogs ----

function openDialog(d: Dialog) {
  dialogError.value = null;
  dialogBusy.value = false;
  dialog.value = d;
}

function closeDialog() {
  if (dialogBusy.value) return;
  dialog.value = null;
}

async function createFolder(name: string) {
  dialogBusy.value = true;
  dialogError.value = null;
  try {
    const entry = await api.post<FileEntry>('/files/mkdir', { folder: props.root.dataset, path: props.path, name });
    dialog.value = null;
    await load();
    selected.value = [entry.path];
    status.value = `Created folder ${entry.name}`;
  } catch (e) {
    dialogError.value = e instanceof Error ? e.message : String(e);
  } finally {
    dialogBusy.value = false;
  }
}

async function renameTo(entry: FileEntry, newName: string) {
  if (newName === entry.name) {
    dialog.value = null;
    return;
  }
  dialogBusy.value = true;
  dialogError.value = null;
  try {
    const renamed = await api.post<FileEntry>('/files/rename', { folder: props.root.dataset, path: entry.path, newName });
    dialog.value = null;
    await load();
    selected.value = [renamed.path];
    status.value = `Renamed to ${renamed.name}`;
  } catch (e) {
    dialogError.value = e instanceof Error ? e.message : String(e);
  } finally {
    dialogBusy.value = false;
  }
}

async function deleteItems(items: FileEntry[]) {
  dialogBusy.value = true;
  dialogError.value = null;
  try {
    const started = await api.post<TaskStarted>('/files/delete', { folder: props.root.dataset, paths: items.map((i) => i.path) });
    track(started);
    dialogBusy.value = false;
    dialog.value = null;
    selected.value = [];
  } catch (e) {
    dialogError.value = e instanceof Error ? e.message : String(e);
    dialogBusy.value = false;
  }
}

function transferStarted(started: TaskStarted) {
  track(started);
  dialog.value = null;
}

const deleteMessage = computed(() => {
  if (dialog.value?.kind !== 'delete') return '';
  const items = dialog.value.items;
  const what = items.length === 1 ? `“${items[0]!.name}”` : itemsLabel(items.length);
  const folders = items.some((i) => i.type === 'folder') ? ' Folders are deleted with everything inside them.' : '';
  return `${what} will be deleted from the server for good. There’s no trash to restore from.${folders}`;
});

// ---- uploads ----

async function startUpload(files: ReturnType<typeof filesFromInput>, emptyDirs: string[] = []) {
  opError.value = null;
  try {
    await queueUpload(props.root.dataset, props.path, files, emptyDirs);
  } catch (e) {
    opError.value = uploadErrorText(e);
  }
}

function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) void startUpload(filesFromInput(input.files));
  input.value = '';
}

function isFileDrag(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes('Files');
}

function onDragEnter(e: DragEvent) {
  if (!isFileDrag(e)) return;
  dragDepth.value++;
}
function onDragLeave(e: DragEvent) {
  if (!isFileDrag(e)) return;
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}
function onDragOver(e: DragEvent) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}
async function onDrop(e: DragEvent) {
  if (!isFileDrag(e) || !e.dataTransfer) return;
  e.preventDefault();
  dragDepth.value = 0;
  try {
    const { files, emptyDirs } = await filesFromDrop(e.dataTransfer);
    await startUpload(files, emptyDirs);
  } catch (err) {
    opError.value = uploadErrorText(err);
  }
}

// ---- menus ----

function selectionItems(): ContextItem[] {
  const sel = selection.value;
  const one = sel.length === 1 ? sel[0]! : null;
  const separateHint = 'Stored separately (its own dataset): it can’t be renamed, moved or deleted here';
  const items: ContextItem[] = [];
  if (one?.type === 'folder') items.push({ key: 'open', label: 'Open', icon: FolderOpen });
  items.push({
    key: 'download',
    label: onlyFiles.value && sel.length > 1 ? `Download ${sel.length} files` : 'Download',
    icon: Download,
    disabled: !onlyFiles.value,
    hint: onlyFiles.value ? undefined : 'Only files can be downloaded; open folders to pick files',
  });
  if (one) items.push({ key: 'rename', label: 'Rename…', icon: Pencil, disabled: one.separate, hint: one.separate ? separateHint : undefined });
  items.push(
    { key: 'move', label: 'Move to…', icon: FolderInput, disabled: anyProtected.value, hint: anyProtected.value ? separateHint : undefined },
    { key: 'copy', label: 'Copy to…', icon: Copy, disabled: anyProtected.value, hint: anyProtected.value ? separateHint : undefined },
    { key: 'delete', label: sel.length > 1 ? `Delete ${sel.length} items…` : 'Delete…', icon: Trash2, danger: true, disabled: anyProtected.value, hint: anyProtected.value ? separateHint : undefined },
  );
  return items;
}

function backgroundItems(): ContextItem[] {
  return [
    { key: 'upload-files', label: 'Upload files…', icon: Upload },
    { key: 'upload-folder', label: 'Upload a folder…', icon: FolderUp },
    { key: 'mkdir', label: 'New folder…', icon: FolderPlus },
    { key: 'refresh', label: 'Refresh', icon: RefreshCw },
  ];
}

function onListMenu(payload: { entry: FileEntry | null; x: number; y: number }) {
  // The list updates the selection before asking; read it on the next tick.
  queueMicrotask(() => {
    menu.value = payload.entry
      ? { x: payload.x, y: payload.y, items: selectionItems(), label: `Actions for ${selection.value.length > 1 ? itemsLabel(selection.value.length) : payload.entry.name}` }
      : { x: payload.x, y: payload.y, items: backgroundItems(), label: 'Folder actions' };
  });
}

function onBackgroundMenu(e: MouseEvent) {
  selected.value = [];
  menu.value = { x: e.clientX, y: e.clientY, items: backgroundItems(), label: 'Folder actions' };
}

function openMenuAt(e: MouseEvent, items: ContextItem[], label: string) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { x: rect.left, y: rect.bottom + 4, items, label };
}

function viewItems(): ContextItem[] {
  return [
    ...(Object.keys(SORT_LABELS) as FileSortKey[]).map((k) => ({ key: `sort:${k}`, label: `Sort by ${SORT_LABELS[k].toLowerCase()}`, checked: viewPrefs.sort === k })),
    { key: 'order:asc', label: 'Ascending', checked: viewPrefs.order === 'asc' },
    { key: 'order:desc', label: 'Descending', checked: viewPrefs.order === 'desc' },
    { key: 'toggle:hidden', label: 'Show hidden files', checked: viewPrefs.showHidden },
    { key: 'toggle:ext', label: 'Show file extensions', checked: viewPrefs.showExtensions },
  ];
}

function runAction(key: string) {
  const sel = selection.value;
  if (key.startsWith('sort:')) viewPrefs.sort = key.slice(5) as FileSortKey;
  else if (key === 'order:asc' || key === 'order:desc') viewPrefs.order = key === 'order:asc' ? 'asc' : 'desc';
  else if (key === 'toggle:hidden') viewPrefs.showHidden = !viewPrefs.showHidden;
  else if (key === 'toggle:ext') viewPrefs.showExtensions = !viewPrefs.showExtensions;
  else if (key === 'open' && sel[0]) openEntry(sel[0]);
  else if (key === 'download') downloadSelection();
  else if (key === 'rename' && sel.length === 1 && !sel[0]!.separate) openDialog({ kind: 'rename', entry: sel[0]! });
  else if ((key === 'move' || key === 'copy') && sel.length && !anyProtected.value) openDialog({ kind: 'transfer', mode: key, items: sel });
  else if (key === 'delete' && sel.length && !anyProtected.value) openDialog({ kind: 'delete', items: sel });
  else if (key === 'upload-files') fileInput.value?.click();
  else if (key === 'upload-folder') folderInput.value?.click();
  else if (key === 'mkdir') openDialog({ kind: 'mkdir' });
  else if (key === 'refresh') void load();
}

function setSort(key: FileSortKey) {
  if (viewPrefs.sort === key) viewPrefs.order = viewPrefs.order === 'asc' ? 'desc' : 'asc';
  else {
    viewPrefs.sort = key;
    viewPrefs.order = key === 'modified' || key === 'size' ? 'desc' : 'asc';
  }
}

watch(selected, (sel) => {
  if (sel.length) status.value = `${itemsLabel(sel.length)} selected`;
});
</script>

<template>
  <div class="browser stack" style="--gap: 14px" @dragenter="onDragEnter" @dragleave="onDragLeave" @dragover="onDragOver" @drop="onDrop">
    <nav class="row crumb-bar" aria-label="Location">
      <button ref="upButton" type="button" class="btn small" :disabled="!path" aria-label="Up one level" title="Up one level (Backspace)" @click="goUp"><ArrowUp :size="16" /></button>
      <ol class="crumbs">
        <li v-for="(c, i) in crumbs" :key="c.path" class="crumb">
          <ChevronRight v-if="i" :size="14" class="muted" aria-hidden="true" />
          <RouterLink
            v-if="i < crumbs.length - 1"
            class="crumb-link"
            :to="{ path: '/files', query: c.path ? { folder: linkFolder, path: c.path } : { folder: linkFolder } }"
          >{{ c.name }}</RouterLink>
          <span v-else class="crumb-current" aria-current="location">{{ c.name }}</span>
        </li>
      </ol>
    </nav>

    <div class="row wrap toolbar" role="toolbar" aria-label="File actions">
      <button type="button" class="btn small" title="New folder" @click="openDialog({ kind: 'mkdir' })"><FolderPlus :size="16" /><span class="label">New folder</span></button>
      <button type="button" class="btn small primary" aria-haspopup="menu" title="Upload" @click="openMenuAt($event, backgroundItems().slice(0, 2), 'Upload')">
        <Upload :size="16" /><span class="label">Upload</span>
      </button>
      <span class="divider" aria-hidden="true" />
      <button type="button" class="btn small" :disabled="!onlyFiles" title="Download" @click="downloadSelection"><Download :size="16" /><span class="label">Download</span></button>
      <button type="button" class="btn small" :disabled="selection.length !== 1 || anyProtected" title="Rename (F2)" @click="runAction('rename')"><Pencil :size="16" /><span class="label">Rename</span></button>
      <button type="button" class="btn small" :disabled="!selection.length || anyProtected" title="Move to…" @click="runAction('move')"><FolderInput :size="16" /><span class="label">Move</span></button>
      <button type="button" class="btn small" :disabled="!selection.length || anyProtected" title="Copy to…" @click="runAction('copy')"><Copy :size="16" /><span class="label">Copy</span></button>
      <button type="button" class="btn small danger" :disabled="!selection.length || anyProtected" title="Delete (Delete key)" @click="runAction('delete')"><Trash2 :size="16" /><span class="label">Delete</span></button>
      <span class="spacer" />
      <button type="button" class="btn small" aria-haspopup="menu" title="View options" @click="openMenuAt($event, viewItems(), 'View options')"><SlidersHorizontal :size="16" /><span class="label">View</span></button>
      <button type="button" class="btn small" aria-label="Refresh" title="Refresh" :disabled="loading" @click="load()"><RefreshCw :size="16" /></button>
    </div>

    <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked" />
    <input ref="folderInput" type="file" webkitdirectory multiple hidden @change="onFilesPicked" />

    <p class="visually-hidden" role="status" aria-live="polite">{{ status }}</p>
    <div v-for="t in runningTasks" :key="t.id" class="callout task-line" role="status">
      <div class="row" style="--gap: 10px">
        <span class="spin" aria-hidden="true" />
        <span class="spacer task-text">{{ t.title }}<span v-if="t.message" class="muted"> · {{ t.message }}</span></span>
        <strong>{{ t.progress }}%</strong>
      </div>
      <div class="meter"><span :style="{ width: `${t.progress}%` }" /></div>
    </div>
    <p v-if="opError" class="callout err row" role="alert">
      <span class="spacer">{{ opError }}</span>
      <button type="button" class="btn ghost small" @click="opError = null">Dismiss</button>
    </p>
    <p v-if="notice" class="callout ok row" role="status">
      <span class="spacer">{{ notice }}</span>
      <button type="button" class="btn ghost small" @click="notice = null">Dismiss</button>
    </p>

    <div class="panes">
      <div class="card list-card" :class="{ dropping: dragDepth > 0 }" @contextmenu.prevent="onBackgroundMenu">
        <div v-if="dragDepth > 0" class="drop-hint" aria-hidden="true"><Upload :size="20" /> Drop to upload to {{ here }}</div>
        <div v-if="loadError" class="stack state" style="--gap: 10px">
          <template v-if="loadError.code === 'NOT_FOUND' && path">
            <strong>This location isn’t here any more</strong>
            <p class="small muted">{{ loadError.message }}</p>
            <div><button type="button" class="btn" @click="navigate('')">Go to {{ root.name }}</button></div>
          </template>
          <template v-else>
            <strong>{{ loadError.code === 'LOCKED' ? 'This folder is locked' : 'This location can’t be shown' }}</strong>
            <p class="small muted">{{ loadError.message }}</p>
            <div class="row" style="--gap: 8px">
              <button type="button" class="btn" @click="load()">Try again</button>
              <button v-if="path" type="button" class="btn ghost" @click="goUp">Up one level</button>
            </div>
          </template>
        </div>
        <div v-else-if="loading && !entries.length" class="row muted state"><span class="spin" /> Loading…</div>
        <template v-else>
          <FileList
            v-if="entries.length"
            ref="listRef"
            v-model:selected="selected"
            :entries="entries"
            :sort="viewPrefs.sort"
            :order="viewPrefs.order"
            :show-extensions="viewPrefs.showExtensions"
            :label="`Contents of ${here}`"
            @open="openEntry"
            @menu="onListMenu"
            @sort="setSort"
            @delete="runAction('delete')"
            @rename="runAction('rename')"
            @up="goUp"
          />
          <div v-else class="stack empty" style="--gap: 8px">
            <strong>This folder is empty</strong>
            <p class="small muted">Drop files here, or use <em>Upload</em> or <em>New folder</em>.</p>
          </div>
          <div v-if="listing && (remaining > 0 || listing.truncated || listing.sortFallback)" class="list-foot stack" style="--gap: 8px">
            <p v-if="listing.sortFallback" class="small muted">This folder is too big to sort by date, so it’s sorted by name.</p>
            <p v-if="listing.truncated" class="small muted">
              This folder has more than {{ listing.scanLimit.toLocaleString() }} items. Only the first {{ listing.scanLimit.toLocaleString() }} (by name) are shown; open it from another computer to see everything.
            </p>
            <div v-if="remaining > 0">
              <button type="button" class="btn small" :disabled="loadingMore" @click="load({ more: true })">
                <span v-if="loadingMore" class="spin" />Show more ({{ remaining.toLocaleString() }} left)
              </button>
            </div>
          </div>
        </template>
      </div>
      <FileDetails class="details-pane" :folder="root.dataset" :folder-name="root.name" :path="path" :selection="selection" :total="listing?.total ?? 0" :separate="listing?.separate ?? false" @open="openEntry" />
    </div>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menu.items" :label="menu.label" @select="runAction" @close="menu = null" />

    <NameDialog
      v-if="dialog?.kind === 'mkdir'"
      title="New folder"
      label="Folder name"
      action-label="Create"
      :busy="dialogBusy"
      :error="dialogError"
      @submit="createFolder"
      @close="closeDialog"
    />
    <NameDialog
      v-else-if="dialog?.kind === 'rename'"
      :title="`Rename “${dialog.entry.name}”`"
      label="New name"
      action-label="Rename"
      :initial="dialog.entry.name"
      :is-file="dialog.entry.type === 'file'"
      :busy="dialogBusy"
      :error="dialogError"
      @submit="(name) => dialog?.kind === 'rename' && renameTo(dialog.entry, name)"
      @close="closeDialog"
    />
    <DestinationDialog
      v-else-if="dialog?.kind === 'transfer'"
      :folder="root.dataset"
      :folder-name="root.name"
      :kind="dialog.mode"
      :items="dialog.items"
      :start-path="path"
      @started="transferStarted"
      @close="closeDialog"
    />
    <ConfirmDialog
      v-else-if="dialog?.kind === 'delete'"
      :title="dialog.items.length === 1 ? 'Delete this item?' : `Delete ${dialog.items.length} items?`"
      :message="deleteMessage"
      :action-label="dialog.items.length === 1 ? 'Delete' : `Delete ${dialog.items.length} items`"
      danger
      :busy="dialogBusy"
      :error="dialogError"
      @confirm="dialog?.kind === 'delete' && deleteItems(dialog.items)"
      @close="closeDialog"
    >
      <ul v-if="dialog.items.length > 1" class="small delete-list">
        <li v-for="item in dialog.items.slice(0, 6)" :key="item.path">{{ item.name }}</li>
        <li v-if="dialog.items.length > 6" class="muted">and {{ dialog.items.length - 6 }} more</li>
      </ul>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.crumb-bar {
  --gap: 10px;
  min-width: 0;
}
.crumbs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 4px;
  min-width: 0;
}
.crumb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.crumb-link,
.crumb-current {
  padding: 3px 9px;
  border-radius: 999px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumb-link {
  background: var(--surface-2);
  color: var(--text);
}
.crumb-link:hover {
  text-decoration: none;
  background: var(--accent-soft);
}
.crumb-link:focus-visible {
  outline: 2px solid var(--accent);
}
.crumb-current {
  font-weight: 650;
}
.toolbar {
  --gap: 6px;
}
.divider {
  width: 1px;
  height: 22px;
  background: var(--border);
  margin: 0 4px;
}
.panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 16px;
  align-items: start;
}
.list-card {
  padding: 4px 8px 8px;
  position: relative;
  min-height: 220px;
  container: file-list / inline-size;
}
.list-card.dropping {
  outline: 2px dashed var(--accent);
  outline-offset: 2px;
}
.drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  color: var(--accent-strong);
  font-weight: 600;
  z-index: 2;
  border-radius: var(--radius);
  pointer-events: none;
}
.state,
.empty {
  padding: 28px 16px;
  align-items: flex-start;
}
.list-foot {
  padding: 12px 8px 4px;
}
.task-line {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.task-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.delete-list {
  margin: 0;
  padding-left: 20px;
  overflow-wrap: anywhere;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media (max-width: 1100px) {
  .panes {
    grid-template-columns: minmax(0, 1fr);
  }
  .details-pane {
    display: none;
  }
}
@media (max-width: 720px) {
  .toolbar .label {
    display: none;
  }
  .divider {
    display: none;
  }
  .crumb-link,
  .crumb-current {
    max-width: 150px;
  }
}
</style>
