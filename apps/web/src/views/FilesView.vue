<script setup lang="ts">
/** /files lists the folders; /files?folder=<name>&path=<sub/path> browses one of them. */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Folder, FolderLock, Lock } from 'lucide-vue-next';
import type { FileRoot, FileRootsResponse } from '@apexos/api-types';
import PageState from '../components/PageState.vue';
import FileBrowser from '../components/files/FileBrowser.vue';
import UploadConflictDialog from '../components/files/UploadConflictDialog.vue';
import UploadPanel from '../components/files/UploadPanel.vue';
import { uploads } from '../components/files/uploads.ts';
import { api } from '../lib/api.ts';
import { onServerChange } from '../lib/events.ts';

const route = useRoute();
const router = useRouter();

const roots = ref<FileRootsResponse | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    roots.value = await api.get<FileRootsResponse>('/files');
    uploads.maxBytes = roots.value.uploadMaxBytes;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function retry() {
  loading.value = true;
  void load();
}

onMounted(load);
onServerChange(['folders', 'storage'], load);

const folderRef = computed(() => (typeof route.query.folder === 'string' ? route.query.folder : null));
const path = computed(() => (typeof route.query.path === 'string' ? route.query.path.replace(/^\/+|\/+$/g, '') : ''));
const root = computed<FileRoot | null>(() => {
  const ref = folderRef.value;
  if (!ref || !roots.value) return null;
  const lower = ref.toLowerCase();
  return roots.value.folders.find((f) => f.dataset === ref) ?? roots.value.folders.find((f) => f.name === ref) ?? roots.value.folders.find((f) => f.name.toLowerCase() === lower) ?? null;
});
/** Folder names are unique per pool; show the pool when the same name exists twice. */
const duplicated = computed(() => {
  const seen = new Map<string, number>();
  for (const f of roots.value?.folders ?? []) seen.set(f.name.toLowerCase(), (seen.get(f.name.toLowerCase()) ?? 0) + 1);
  return (f: FileRoot) => (seen.get(f.name.toLowerCase()) ?? 0) > 1;
});

function folderQuery(f: FileRoot): string {
  return duplicated.value(f) ? f.dataset : f.name;
}

function navigate(next: string) {
  if (!root.value) return;
  void router.push({ path: '/files', query: next ? { folder: folderQuery(root.value), path: next } : { folder: folderQuery(root.value) } });
}
</script>

<template>
  <div class="page-header">
    <div>
      <h1>Files</h1>
      <p class="subtitle">Look through, upload and organize the files in your folders.</p>
    </div>
    <span class="spacer" />
    <RouterLink v-if="folderRef" to="/files" class="btn small">All folders</RouterLink>
  </div>

  <PageState :loading="loading" :error="error" @retry="retry">
    <template v-if="roots">
      <section v-if="!folderRef" class="stack" aria-labelledby="pick-h">
        <h2 id="pick-h" class="visually-hidden">Choose a folder</h2>
        <div v-if="roots.folders.length" class="grid" style="--min: 220px">
          <template v-for="f in roots.folders" :key="f.dataset">
            <div v-if="f.locked" class="card folder-card locked" aria-disabled="true">
              <FolderLock :size="22" aria-hidden="true" class="muted" />
              <div class="stack" style="--gap: 2px; min-width: 0">
                <strong class="ellipsis">{{ f.name }}</strong>
                <span class="small muted">On {{ f.poolDisplayName }}</span>
                <span class="badge warn"><Lock :size="12" /> Locked</span>
              </div>
            </div>
            <RouterLink v-else class="card folder-card" :to="{ path: '/files', query: { folder: folderQuery(f) } }">
              <Folder :size="22" aria-hidden="true" class="folder-icon" />
              <div class="stack" style="--gap: 2px; min-width: 0">
                <strong class="ellipsis">{{ f.name }}</strong>
                <span class="small muted">On {{ f.poolDisplayName }}</span>
              </div>
            </RouterLink>
          </template>
        </div>
        <div v-else class="card stack empty" style="--gap: 10px">
          <strong>No folders yet</strong>
          <p class="small muted">Create a folder first, then come back here to add files to it.</p>
          <div><RouterLink to="/folders?new=1" class="btn primary">New folder</RouterLink></div>
        </div>
        <p v-if="roots.folders.some((f) => f.locked)" class="small muted">Locked folders are encrypted. Unlock them to browse their files.</p>
      </section>

      <div v-else-if="!root" class="callout warn stack" style="--gap: 10px" role="status">
        <p>There’s no folder called “{{ folderRef }}”. It may have been renamed or deleted.</p>
        <div><RouterLink to="/files" class="btn small">Show all folders</RouterLink></div>
      </div>

      <div v-else-if="root.locked" class="card stack locked-state" style="--gap: 10px">
        <div class="row" style="--gap: 10px">
          <Lock :size="20" aria-hidden="true" />
          <h2>{{ root.name }} is locked</h2>
        </div>
        <p class="muted">This folder is encrypted and its key isn’t loaded, so its files can’t be shown or changed. Unlock it, then come back.</p>
        <div><RouterLink :to="{ path: '/folders', query: { folder: root.name } }" class="btn">Go to the folder</RouterLink></div>
      </div>

      <FileBrowser v-else :key="root.dataset" :root="root" :path="path" :link-folder="folderQuery(root)" @navigate="navigate" />
    </template>
  </PageState>

  <UploadPanel />
  <UploadConflictDialog />
</template>

<style scoped>
.folder-card {
  display: flex;
  align-items: center;
  gap: 14px;
  color: var(--text);
  padding: 16px 18px;
}
a.folder-card:hover {
  text-decoration: none;
  border-color: var(--accent);
}
a.folder-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.folder-card.locked {
  opacity: 0.75;
}
.folder-icon {
  color: var(--accent);
  flex: none;
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty,
.locked-state {
  align-items: flex-start;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
