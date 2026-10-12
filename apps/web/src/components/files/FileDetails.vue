<script setup lang="ts">
/** Details for the selection (or the current folder when nothing is selected). */
import { computed } from 'vue';
import { Download, FolderOpen } from 'lucide-vue-next';
import type { FileEntry } from '@apexos/api-types';
import { formatBytes } from '../../lib/format.ts';
import { downloadUrl, entryIcon, formatDate, itemsLabel, kindLabel } from './files.ts';

const props = defineProps<{ folder: string; folderName: string; path: string; selection: FileEntry[]; total: number; separate: boolean }>();
const emit = defineEmits<{ open: [entry: FileEntry] }>();

const single = computed(() => (props.selection.length === 1 ? props.selection[0]! : null));
const fileBytes = computed(() => props.selection.reduce((s, e) => s + (e.type === 'file' ? (e.size ?? 0) : 0), 0));
const folderCount = computed(() => props.selection.filter((e) => e.type === 'folder').length);
const location = computed(() => (p: string) => [props.folderName, ...p.split('/').slice(0, -1)].join(' › '));
</script>

<template>
  <aside class="details card flat" aria-label="Details">
    <template v-if="single">
      <div class="head">
        <component :is="entryIcon(single)" :size="36" aria-hidden="true" class="big-icon" :class="single.type" />
        <h3 class="name">{{ single.name }}</h3>
      </div>
      <dl class="small">
        <dt>Type</dt>
        <dd>{{ kindLabel(single) }}</dd>
        <template v-if="single.type !== 'folder'">
          <dt>Size</dt>
          <dd>{{ formatBytes(single.size) }} <span v-if="single.size !== null && single.size >= 1000" class="muted">({{ single.size.toLocaleString() }} bytes)</span></dd>
        </template>
        <dt>Modified</dt>
        <dd>{{ formatDate(single.modified) }}</dd>
        <dt>Where</dt>
        <dd>{{ location(single.path) }}</dd>
      </dl>
      <p v-if="single.separate" class="callout small">
        This folder is stored separately (it’s its own dataset). You can open it and work inside it, but it can’t be renamed, moved or deleted here.
      </p>
      <p v-if="single.type === 'link'" class="callout small">This is a link to another place. For safety, ApexOs doesn’t open or follow links.</p>
      <div class="row wrap" style="--gap: 8px">
        <button v-if="single.type === 'folder'" type="button" class="btn small" @click="emit('open', single)"><FolderOpen :size="14" /> Open</button>
        <a v-else-if="single.type === 'file'" class="btn small" :href="downloadUrl(folder, single.path)" download><Download :size="14" /> Download</a>
      </div>
    </template>
    <template v-else-if="selection.length">
      <h3>{{ itemsLabel(selection.length) }} selected</h3>
      <p class="small muted">
        <template v-if="folderCount">{{ folderCount === 1 ? '1 folder' : `${folderCount} folders` }}<template v-if="selection.length > folderCount">, </template></template>
        <template v-if="selection.length > folderCount">{{ selection.length - folderCount === 1 ? '1 file' : `${selection.length - folderCount} files` }} ({{ formatBytes(fileBytes) }})</template>
      </p>
    </template>
    <template v-else>
      <h3>{{ path ? path.split('/').pop() : folderName }}</h3>
      <p class="small muted">{{ itemsLabel(total) }}</p>
      <p v-if="separate" class="callout small">This part of the folder is stored separately (its own dataset). Items can’t be moved or copied between it and the rest of the folder.</p>
      <p class="small muted">Select an item to see its details. Tip: right-click, or press Shift+F10, for more actions.</p>
    </template>
  </aside>
</template>

<style scoped>
.details {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-self: start;
  position: sticky;
  top: 16px;
  min-width: 0;
}
.head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.big-icon {
  color: var(--text-muted);
}
.big-icon.folder {
  color: var(--accent);
}
.name {
  overflow-wrap: anywhere;
}
dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
}
dt {
  color: var(--text-muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
