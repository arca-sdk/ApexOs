<script setup lang="ts">
/**
 * The list of entries in one directory, as an accessible grid with row focus.
 *
 * Mouse: click selects, Ctrl/Cmd+click toggles, Shift+click selects a range, double-click opens;
 * a folder's name opens it; right-click opens the context menu. Touch: the checkboxes select several.
 * Keyboard: arrows move (Shift extends), Home/End, Space toggles, Enter opens, Ctrl/Cmd+A selects all,
 * Escape clears, Delete deletes, F2 renames, Backspace or Alt+↑ goes up, Shift+F10 / Menu opens the menu.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { ArrowDown, ArrowUp, EllipsisVertical } from 'lucide-vue-next';
import type { FileEntry, FileSortKey, FileSortOrder } from '@apexos/api-types';
import { formatBytes } from '../../lib/format.ts';
import { displayName, entryIcon, formatDate, kindLabel } from './files.ts';

const props = defineProps<{
  entries: FileEntry[];
  selected: string[];
  sort: FileSortKey;
  order: FileSortOrder;
  showExtensions: boolean;
  label: string;
}>();
const emit = defineEmits<{
  'update:selected': [paths: string[]];
  open: [entry: FileEntry];
  menu: [payload: { entry: FileEntry | null; x: number; y: number }];
  sort: [key: FileSortKey];
  delete: [];
  rename: [];
  up: [];
}>();

const table = ref<HTMLTableElement | null>(null);
const focusPath = ref<string | null>(null);
const anchor = ref<string | null>(null);
const selectedSet = computed(() => new Set(props.selected));
const allSelected = computed(() => props.entries.length > 0 && props.entries.every((e) => selectedSet.value.has(e.path)));
const someSelected = computed(() => props.selected.length > 0 && !allSelected.value);

// Keep the focused row valid when the listing changes.
watch(
  () => props.entries,
  (entries) => {
    if (focusPath.value && !entries.some((e) => e.path === focusPath.value)) focusPath.value = null;
    if (anchor.value && !entries.some((e) => e.path === anchor.value)) anchor.value = null;
  },
);

const tabStop = computed(() => focusPath.value ?? props.selected.find((p) => props.entries.some((e) => e.path === p)) ?? props.entries[0]?.path ?? null);

function setSelected(paths: string[]) {
  emit('update:selected', paths);
}

function indexOf(path: string | null): number {
  return path === null ? -1 : props.entries.findIndex((e) => e.path === path);
}

function rangePaths(from: number, to: number): string[] {
  const [a, b] = from <= to ? [from, to] : [to, from];
  return props.entries.slice(a, b + 1).map((e) => e.path);
}

async function focusRow(path: string) {
  focusPath.value = path;
  await nextTick();
  const row = table.value?.querySelector<HTMLElement>(`tr[data-path="${CSS.escape(path)}"]`);
  row?.focus();
  row?.scrollIntoView({ block: 'nearest' });
}

function onRowClick(e: MouseEvent, entry: FileEntry) {
  const i = indexOf(entry.path);
  if (e.shiftKey && anchor.value !== null && indexOf(anchor.value) >= 0) {
    const range = rangePaths(indexOf(anchor.value), i);
    setSelected(e.ctrlKey || e.metaKey ? [...new Set([...props.selected, ...range])] : range);
  } else if (e.ctrlKey || e.metaKey) {
    toggle(entry);
    anchor.value = entry.path;
  } else {
    setSelected([entry.path]);
    anchor.value = entry.path;
  }
  focusPath.value = entry.path;
}

function toggle(entry: FileEntry) {
  const set = new Set(props.selected);
  if (set.has(entry.path)) set.delete(entry.path);
  else set.add(entry.path);
  setSelected([...set]);
}

function onCheckbox(entry: FileEntry) {
  toggle(entry);
  anchor.value = entry.path;
  focusPath.value = entry.path;
}

function toggleAll() {
  setSelected(allSelected.value ? [] : props.entries.map((e) => e.path));
}

function onContext(e: MouseEvent, entry: FileEntry | null) {
  if (entry && !selectedSet.value.has(entry.path)) {
    setSelected([entry.path]);
    anchor.value = entry.path;
  }
  if (entry) focusPath.value = entry.path;
  emit('menu', { entry, x: e.clientX, y: e.clientY });
}

function openRowMenu(e: MouseEvent, entry: FileEntry) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  if (!selectedSet.value.has(entry.path)) setSelected([entry.path]);
  focusPath.value = entry.path;
  emit('menu', { entry, x: rect.left, y: rect.bottom + 4 });
}

function move(delta: number | 'home' | 'end', extend: boolean) {
  if (!props.entries.length) return;
  const current = indexOf(focusPath.value ?? tabStop.value);
  let next = delta === 'home' ? 0 : delta === 'end' ? props.entries.length - 1 : current + delta;
  next = Math.max(0, Math.min(props.entries.length - 1, current < 0 ? 0 : next));
  const entry = props.entries[next]!;
  if (extend) {
    if (anchor.value === null || indexOf(anchor.value) < 0) anchor.value = props.entries[Math.max(current, 0)]!.path;
    setSelected(rangePaths(indexOf(anchor.value), next));
  } else {
    setSelected([entry.path]);
    anchor.value = entry.path;
  }
  void focusRow(entry.path);
}

function onKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  const focused = props.entries[indexOf(focusPath.value)];
  switch (e.key) {
    case 'ArrowDown':
      if (e.altKey) return;
      move(1, e.shiftKey);
      break;
    case 'ArrowUp':
      if (e.altKey) emit('up');
      else move(-1, e.shiftKey);
      break;
    case 'Home':
      move('home', e.shiftKey);
      break;
    case 'End':
      move('end', e.shiftKey);
      break;
    case 'PageDown':
      move(10, e.shiftKey);
      break;
    case 'PageUp':
      move(-10, e.shiftKey);
      break;
    case ' ':
      if (!focused) return;
      toggle(focused);
      anchor.value = focused.path;
      break;
    case 'Enter':
      if (!focused) return;
      emit('open', focused);
      break;
    case 'Escape':
      if (!props.selected.length) return;
      setSelected([]);
      break;
    case 'Delete':
      if (!props.selected.length) return;
      emit('delete');
      break;
    case 'F2':
      if (props.selected.length !== 1) return;
      emit('rename');
      break;
    case 'Backspace':
      emit('up');
      break;
    case 'ContextMenu':
    case 'F10': {
      if (e.key === 'F10' && !e.shiftKey) return;
      const row = focused ? table.value?.querySelector<HTMLElement>(`tr[data-path="${CSS.escape(focused.path)}"]`) : null;
      const rect = row?.getBoundingClientRect() ?? table.value?.getBoundingClientRect();
      if (focused && !selectedSet.value.has(focused.path)) setSelected([focused.path]);
      emit('menu', { entry: focused ?? null, x: (rect?.left ?? 0) + 40, y: (rect?.top ?? 0) + (row ? rect!.height : 40) });
      break;
    }
    default:
      if (mod && e.key.toLowerCase() === 'a') {
        setSelected(props.entries.map((x) => x.path));
        break;
      }
      return;
  }
  e.preventDefault();
}

const SORTABLE: Array<{ key: FileSortKey; label: string; cls: string }> = [
  { key: 'name', label: 'Name', cls: 'col-name' },
  { key: 'size', label: 'Size', cls: 'col-size' },
  { key: 'type', label: 'Type', cls: 'col-type' },
  { key: 'modified', label: 'Modified', cls: 'col-date' },
];

function ariaSort(key: FileSortKey): 'ascending' | 'descending' | 'none' {
  return props.sort === key ? (props.order === 'asc' ? 'ascending' : 'descending') : 'none';
}

defineExpose({ focusFirst: () => props.entries[0] && focusRow(tabStop.value ?? props.entries[0].path) });
</script>

<template>
  <table ref="table" class="file-table" role="grid" aria-multiselectable="true" :aria-label="label" :aria-rowcount="entries.length + 1" @keydown="onKey">
    <thead>
      <tr role="row">
        <th class="col-check" role="columnheader">
          <input
            type="checkbox"
            :checked="allSelected"
            :indeterminate="someSelected"
            :disabled="!entries.length"
            aria-label="Select everything in this folder"
            @change="toggleAll"
          />
        </th>
        <th v-for="col in SORTABLE" :key="col.key" :class="col.cls" role="columnheader" :aria-sort="ariaSort(col.key)">
          <button type="button" class="sort-btn" @click="emit('sort', col.key)">
            {{ col.label }}
            <ArrowUp v-if="sort === col.key && order === 'asc'" :size="13" aria-hidden="true" />
            <ArrowDown v-else-if="sort === col.key" :size="13" aria-hidden="true" />
          </button>
        </th>
        <th class="col-actions" role="columnheader"><span class="visually-hidden">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="entry in entries"
        :key="entry.path"
        role="row"
        :data-path="entry.path"
        :aria-selected="selectedSet.has(entry.path)"
        :class="{ selected: selectedSet.has(entry.path), hidden: entry.hidden }"
        :tabindex="tabStop === entry.path ? 0 : -1"
        @click="onRowClick($event, entry)"
        @dblclick="emit('open', entry)"
        @contextmenu.prevent.stop="onContext($event, entry)"
        @focus="focusPath = entry.path"
      >
        <td class="col-check" role="gridcell">
          <input type="checkbox" tabindex="-1" :checked="selectedSet.has(entry.path)" :aria-label="`Select ${entry.name}`" @click.stop="onCheckbox(entry)" />
        </td>
        <td class="col-name" role="gridcell">
          <span class="name-cell">
            <component :is="entryIcon(entry)" :size="18" class="entry-icon" :class="entry.type" aria-hidden="true" />
            <button v-if="entry.type === 'folder'" type="button" class="name-link" tabindex="-1" :title="entry.name" @click.stop="emit('open', entry)">
              {{ displayName(entry, showExtensions) }}
            </button>
            <span v-else class="name-text" :title="entry.name">{{ displayName(entry, showExtensions) }}</span>
            <span v-if="entry.separate" class="badge" title="A separate storage area (its own dataset) inside this folder">Separate</span>
          </span>
          <span class="mobile-meta small muted">
            {{ entry.type === 'folder' ? kindLabel(entry) : formatBytes(entry.size) }}<template v-if="entry.modified"> · {{ formatDate(entry.modified) }}</template>
          </span>
        </td>
        <td class="col-size" role="gridcell">{{ entry.type === 'folder' ? '—' : formatBytes(entry.size) }}</td>
        <td class="col-type" role="gridcell">{{ kindLabel(entry) }}</td>
        <td class="col-date" role="gridcell">{{ formatDate(entry.modified) }}</td>
        <td class="col-actions" role="gridcell">
          <button type="button" class="btn ghost small row-menu" tabindex="-1" :aria-label="`Actions for ${entry.name}`" @click.stop="openRowMenu($event, entry)">
            <EllipsisVertical :size="16" aria-hidden="true" />
          </button>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.file-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.93rem;
  table-layout: fixed;
}
th {
  text-align: left;
  font-weight: 600;
  color: var(--text-muted);
  font-size: 0.8rem;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--surface);
  z-index: 1;
}
td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
tbody tr {
  cursor: default;
  outline: none;
}
tbody tr:hover {
  background: var(--surface-2);
}
tbody tr.selected {
  background: var(--accent-soft);
}
tbody tr:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent);
}
tbody tr.hidden .name-cell {
  opacity: 0.7;
}
.col-check {
  width: 40px;
  overflow: visible;
  text-overflow: clip;
}
.col-check input {
  margin: 0;
  display: block;
}
.col-size {
  width: 96px;
  text-align: right;
}
th.col-size .sort-btn {
  margin-left: auto;
}
.col-type {
  width: 130px;
}
.col-date {
  width: 168px;
}
.col-actions {
  width: 48px;
  text-align: right;
  overflow: visible;
  text-overflow: clip;
}
.sort-btn {
  appearance: none;
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.sort-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.entry-icon {
  flex: none;
  color: var(--text-muted);
}
.entry-icon.folder {
  color: var(--accent);
}
.name-link {
  appearance: none;
  border: 0;
  background: transparent;
  font: inherit;
  color: var(--text);
  font-weight: 550;
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.name-link:hover {
  text-decoration: underline;
}
.name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mobile-meta {
  display: none;
}
.row-menu {
  padding: 4px 6px;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
/* Columns give way to the name as the list gets narrower (the list card is the container). */
@container file-list (max-width: 720px) {
  .col-type {
    display: none;
  }
}
@container file-list (max-width: 500px) {
  .col-date,
  .col-size {
    display: none;
  }
  .mobile-meta {
    display: block;
    padding-left: 26px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  td {
    padding: 8px 6px;
  }
}
</style>
