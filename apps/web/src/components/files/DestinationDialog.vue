<script setup lang="ts">
/**
 * Picks where to move or copy items to, inside the same folder. Names that already exist at the
 * destination are never replaced: the person chooses to keep both (numbered) or skip them.
 */
import { computed, onMounted, ref } from 'vue';
import { ChevronRight, CornerLeftUp, Folder, FolderLock } from 'lucide-vue-next';
import type { FileEntry, FileListing, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import { api, ApiError } from '../../lib/api.ts';
import { itemsLabel, parentPath } from './files.ts';

const props = defineProps<{ folder: string; folderName: string; kind: 'move' | 'copy'; items: FileEntry[]; startPath: string }>();
const emit = defineEmits<{ close: []; started: [started: TaskStarted] }>();

const path = ref(props.startPath);
const folders = ref<FileEntry[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const conflict = ref<string | null>(null);
const truncated = ref(false);

const verb = computed(() => (props.kind === 'move' ? 'Move' : 'Copy'));
const title = computed(() => `${verb.value} ${props.items.length === 1 ? `“${props.items[0]!.name}”` : itemsLabel(props.items.length)}`);
const crumbs = computed(() => {
  const segs = path.value ? path.value.split('/') : [];
  return [{ name: props.folderName, path: '' }, ...segs.map((s, i) => ({ name: s, path: segs.slice(0, i + 1).join('/') }))];
});
const selectedFolders = computed(() => props.items.filter((i) => i.type === 'folder').map((i) => i.path));

/** Why the current location can't be the destination (or null). */
const blocked = computed(() => {
  if (selectedFolders.value.some((p) => path.value === p || path.value.startsWith(`${p}/`))) return `A folder can’t be ${props.kind === 'move' ? 'moved' : 'copied'} into itself.`;
  if (props.kind === 'move' && props.items.every((i) => parentPath(i.path) === path.value)) return 'The items are already here.';
  return null;
});

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const q = new URLSearchParams({ folder: props.folder, path: path.value, foldersOnly: '1', limit: '1000' });
    const res = await api.get<FileListing>(`/files/list?${q}`);
    folders.value = res.entries.filter((e) => e.type === 'folder');
    truncated.value = res.total > res.entries.length;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
    folders.value = [];
  } finally {
    loading.value = false;
  }
}

function go(next: string) {
  path.value = next;
  conflict.value = null;
  error.value = null;
  void load();
}

async function submit(mode: 'ask' | 'keep-both' | 'skip' = 'ask') {
  if (busy.value || blocked.value) return;
  busy.value = true;
  error.value = null;
  try {
    const started = await api.post<TaskStarted>(`/files/${props.kind}`, {
      folder: props.folder,
      paths: props.items.map((i) => i.path),
      destination: path.value,
      conflict: mode,
    });
    emit('started', started);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'CONFLICT') conflict.value = e.message;
    else error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <Modal :title="title" wide @close="emit('close')">
    <p class="small muted">Choose a place inside <strong>{{ folderName }}</strong>.</p>
    <nav class="crumbs row wrap" aria-label="Destination">
      <template v-for="(c, i) in crumbs" :key="c.path">
        <ChevronRight v-if="i" :size="14" class="muted" aria-hidden="true" />
        <button type="button" class="btn ghost small" :aria-current="i === crumbs.length - 1 ? 'location' : undefined" :disabled="busy" @click="go(c.path)">{{ c.name }}</button>
      </template>
    </nav>
    <div class="picker card flat" role="group" aria-label="Folders here">
      <button v-if="path" type="button" class="pick" :disabled="busy" @click="go(parentPath(path))"><CornerLeftUp :size="16" aria-hidden="true" /> Up one level</button>
      <p v-if="loading" class="row muted small pad"><span class="spin" /> Loading…</p>
      <p v-else-if="loadError" class="callout err">{{ loadError }}</p>
      <p v-else-if="!folders.length" class="muted small pad">No folders here.</p>
      <button
        v-for="f in folders"
        :key="f.path"
        type="button"
        class="pick"
        :disabled="busy || selectedFolders.includes(f.path)"
        :title="selectedFolders.includes(f.path) ? 'This is one of the items you selected' : f.separate ? 'Stored separately (its own dataset)' : undefined"
        @click="go(f.path)"
      >
        <FolderLock v-if="f.separate" :size="16" aria-hidden="true" class="muted" />
        <Folder v-else :size="16" aria-hidden="true" class="folder-icon" />
        <span class="pick-name">{{ f.name }}</span>
        <span v-if="f.separate" class="badge">Separate</span>
      </button>
      <p v-if="truncated" class="small muted pad">Only the first 1,000 folders are shown.</p>
    </div>
    <p v-if="blocked" class="small muted" role="status">{{ blocked }}</p>
    <div v-if="conflict" class="callout warn stack" style="--gap: 10px" role="alert">
      <p>{{ conflict }} Nothing will be replaced.</p>
      <div class="row wrap" style="--gap: 8px">
        <button type="button" class="btn small" :disabled="busy" @click="submit('keep-both')">Keep both (add a number)</button>
        <button type="button" class="btn small" :disabled="busy" @click="submit('skip')">Skip those</button>
      </div>
    </div>
    <p v-if="error" class="callout err" role="alert">{{ error }}</p>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="button" :disabled="busy || !!blocked || loading || !!conflict" @click="submit()">
        <span v-if="busy" class="spin" />{{ verb }} here
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.crumbs {
  --gap: 2px;
}
.picker {
  padding: 4px;
  max-height: min(360px, 50vh);
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.pick {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}
.pick:hover:not(:disabled),
.pick:focus-visible {
  background: var(--surface-2);
  outline: none;
}
.pick:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent);
}
.pick:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pick-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-icon {
  color: var(--accent);
}
.pad {
  padding: 8px 10px;
}
</style>
