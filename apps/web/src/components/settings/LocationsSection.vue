<script setup lang="ts">
/** Locations: which folder apps use for each kind of data. */
import { computed, onMounted, ref } from 'vue';
import { Boxes, MapPin } from 'lucide-vue-next';
import type { Folder, FoldersResponse, LocationInfo } from '@hearth/api-types';
import Modal from '../Modal.vue';
import PageState from '../PageState.vue';
import { ApiError, api } from '../../lib/api.ts';
import { onServerChange } from '../../lib/events.ts';

const locations = ref<LocationInfo[]>([]);
const folders = ref<Folder[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    const [locs, f] = await Promise.all([api.get<LocationInfo[]>('/locations'), api.get<FoldersResponse>('/folders')]);
    locations.value = locs;
    folders.value = f.folders;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
function retry() {
  loading.value = true;
  load();
}
onMounted(load);
onServerChange(['locations', 'folders', 'apps'], load);

const groups = computed(() => [
  { id: 'applications', title: 'App data', hint: 'Where apps keep their settings, databases and caches.', items: locations.value.filter((l) => l.group === 'applications') },
  { id: 'content', title: 'Your content', hint: 'Where apps look for and save your media, photos, documents and downloads.', items: locations.value.filter((l) => l.group === 'content') },
]);

function poolName(pool: string | null): string {
  if (!pool) return '';
  return folders.value.find((f) => f.pool === pool)?.poolDisplayName ?? pool;
}

/** "Media / Movies" for a path like /mnt/HDDs/Media/Movies. */
function folderLabel(path: string): string {
  return path.split('/').slice(3).join(' / ') || path;
}

/** "Media / Movies on HDDs" for a path like /mnt/HDDs/Media/Movies. */
function placeLabel(path: string): string {
  return `${folderLabel(path)} on ${poolName(path.split('/')[2] ?? null)}`;
}

// ---- change dialog ----
const editing = ref<LocationInfo | null>(null);
const choice = ref('');
const saveError = ref('');
const fieldError = ref('');
const busy = ref(false);

const options = computed(() => {
  const list = folders.value.map((f) => ({ path: f.path, label: `${f.name} (on ${f.poolDisplayName})` }));
  const current = editing.value?.path;
  if (current && !list.some((o) => o.path === current)) list.unshift({ path: current, label: `${folderLabel(current)} (on ${poolName(editing.value!.pool)})` });
  return list;
});

function openChange(loc: LocationInfo) {
  editing.value = loc;
  choice.value = loc.path ?? '';
  saveError.value = fieldError.value = '';
}

async function save() {
  if (!editing.value) return;
  saveError.value = fieldError.value = '';
  if (!choice.value) {
    fieldError.value = 'Pick a folder.';
    return;
  }
  if (choice.value === editing.value.path) {
    editing.value = null;
    return;
  }
  busy.value = true;
  try {
    const updated = await api.put<LocationInfo>(`/locations/${editing.value.id}`, { path: choice.value });
    locations.value = locations.value.map((l) => (l.id === updated.id ? updated : l));
    editing.value = null;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.fields.path) fieldError.value = e.fields.path;
      saveError.value = e.message;
    } else saveError.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card stack" aria-labelledby="ls-h">
    <h2 id="ls-h">Locations</h2>
    <p class="muted small">
      Apps use these folders to know where things go. Changing a location only affects files saved from now on: nothing already there is moved or deleted.
    </p>
    <PageState :loading="loading" :error="error" @retry="retry">
      <div class="stack" style="--gap: 24px">
        <div v-for="g in groups" :key="g.id" class="stack" style="--gap: 10px">
          <div class="stack" style="--gap: 2px">
            <h3>{{ g.title }}</h3>
            <p class="small muted">{{ g.hint }}</p>
          </div>
          <ul class="locs">
            <li v-for="loc in g.items" :key="loc.id" class="loc">
              <div class="row wrap" style="--gap: 10px">
                <MapPin :size="16" class="muted" />
                <strong>{{ loc.name }}</strong>
                <span class="spacer" />
                <button class="btn small" :disabled="loc.usedBy.length > 0" :aria-describedby="loc.usedBy.length ? `ls-used-${loc.id}` : undefined" @click="openChange(loc)">
                  Change
                </button>
              </div>
              <p class="small muted">{{ loc.description }}</p>
              <p v-if="loc.path" class="small">
                <span>{{ folderLabel(loc.path) }}</span>
                <span class="muted"> on {{ poolName(loc.pool) }}</span>
                <span v-if="!loc.created" class="badge" style="margin-left: 6px">Created when first needed</span>
              </p>
              <p v-else class="small muted">
                Not set yet. Hearth creates it{{ loc.suggestedPath ? ` at ${placeLabel(loc.suggestedPath)}` : '' }} the first time an app needs it.
              </p>
              <p v-if="loc.usedBy.length" :id="`ls-used-${loc.id}`" class="small row wrap used" style="--gap: 6px">
                <Boxes :size="14" class="muted" />
                <span class="muted">Used by</span>
                <RouterLink v-for="u in loc.usedBy" :key="u.id" to="/apps" class="badge">{{ u.name }}</RouterLink>
                <span class="muted">· can’t change while in use</span>
              </p>
            </li>
          </ul>
        </div>
      </div>
    </PageState>
  </section>

  <Modal v-if="editing" :title="`Change ${editing.name}`" @close="editing = null">
    <p class="small muted">{{ editing.description }}</p>
    <form id="loc-form" class="stack" style="--gap: 12px" @submit.prevent="save">
      <div class="field">
        <label for="loc-folder">Folder</label>
        <select id="loc-folder" v-model="choice" :aria-invalid="!!fieldError || undefined">
          <option value="" disabled>Choose a folder…</option>
          <option v-for="o in options" :key="o.path" :value="o.path">{{ o.label }}{{ o.path === editing.path ? ' · current' : '' }}</option>
        </select>
        <span class="hint">
          Pick any folder on one of your pools. Need a new one?
          <RouterLink to="/folders?new=1">Create a folder</RouterLink> first.
        </span>
        <span v-if="fieldError" class="error-text">{{ fieldError }}</span>
      </div>
      <p class="callout small">Only new files go to the new folder. Files that are already saved stay where they are.</p>
      <p v-if="saveError" class="callout err" role="alert">{{ saveError }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="editing = null">Cancel</button>
      <button class="btn primary" type="submit" form="loc-form" :disabled="busy"><span v-if="busy" class="spin" />Save</button>
    </template>
  </Modal>
</template>

<style scoped>
.locs {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.loc {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.loc + .loc {
  border-top: 1px solid var(--border);
}
.used .badge:hover {
  text-decoration: none;
  color: var(--text);
}
</style>
