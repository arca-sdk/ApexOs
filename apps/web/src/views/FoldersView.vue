<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { FolderPlus, Users } from 'lucide-vue-next';
import type { Folder, FoldersResponse, ShareUser } from '@apexos/api-types';
import PageState from '../components/PageState.vue';
import DeleteFolderDialog from '../components/folders/DeleteFolderDialog.vue';
import FolderCard from '../components/folders/FolderCard.vue';
import FolderPanel from '../components/folders/FolderPanel.vue';
import FolderWizard from '../components/folders/FolderWizard.vue';
import { api } from '../lib/api.ts';
import { onServerChange } from '../lib/events.ts';

const route = useRoute();
const router = useRouter();

const data = ref<FoldersResponse | null>(null);
const users = ref<ShareUser[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    const [folders, people] = await Promise.all([api.get<FoldersResponse>('/folders'), api.get<ShareUser[]>('/users').catch(() => users.value)]);
    data.value = folders;
    users.value = people;
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
onServerChange(['folders', 'users', 'locations', 'apps'], load);

const personal = computed(() => data.value?.folders.filter((f) => !f.system) ?? []);
const system = computed(() => data.value?.folders.filter((f) => f.system) ?? []);

// ---- selection via the URL (/folders?folder=Name) so every folder has a direct link ----
const selectedName = computed(() => (typeof route.query.folder === 'string' ? route.query.folder : null));
const selected = computed<Folder | null>(() => {
  if (!selectedName.value || !data.value) return null;
  const lower = selectedName.value.toLowerCase();
  return data.value.folders.find((f) => f.name.toLowerCase() === lower) ?? null;
});
const missing = computed(() => !!selectedName.value && !!data.value && !selected.value);

function openFolder(name: string) {
  router.push({ path: '/folders', query: { folder: name } });
}
function closePanel() {
  router.replace({ path: '/folders' });
}

// ---- wizard (/folders?new=1 opens it, e.g. from Settings → Locations) ----
const wizard = ref<{ folder: Folder | null } | null>(route.query.new ? { folder: null } : null);
watch(
  () => route.query.new,
  (isNew) => {
    if (isNew && !wizard.value) wizard.value = { folder: null };
  },
);
const existingNames = computed(() => data.value?.folders.map((f) => f.name) ?? []);

function newFolder() {
  wizard.value = { folder: null };
}
function editFolder(folder: Folder) {
  wizard.value = { folder };
}
function closeWizard() {
  wizard.value = null;
  if (route.query.new) router.replace({ path: '/folders', query: selectedName.value ? { folder: selectedName.value } : {} });
}
async function wizardDone(name: string) {
  wizard.value = null;
  await load();
  openFolder(name);
}

// ---- delete ----
const deleting = ref<Folder | null>(null);
async function deleted() {
  deleting.value = null;
  closePanel();
  await load();
}
</script>

<template>
  <div class="page-header">
    <div>
      <h1>Folders</h1>
      <p class="subtitle">Shared folders you can open from any computer on your home network.</p>
    </div>
    <span class="spacer" />
    <button class="btn primary" :disabled="!data" @click="newFolder"><FolderPlus :size="18" /> New folder</button>
  </div>

  <PageState :loading="loading" :error="error" @retry="retry">
    <div v-if="data" class="stack" style="--gap: 32px">
      <p v-if="missing" class="callout warn" role="status">
        There’s no folder called “{{ selectedName }}”. It may have been deleted.
        <button class="btn ghost small" @click="closePanel">Dismiss</button>
      </p>

      <section class="stack" aria-labelledby="personal-h">
        <h2 id="personal-h">Your folders</h2>
        <div v-if="personal.length" class="grid" style="--min: 240px">
          <FolderCard v-for="f in personal" :key="f.dataset" :folder="f" />
        </div>
        <div v-else class="card stack empty" style="--gap: 10px">
          <strong>No folders yet</strong>
          <p class="muted small">Create a folder to keep files on your server and open them from your Mac, PC or phone.</p>
          <div><button class="btn primary" @click="newFolder"><FolderPlus :size="18" /> New folder</button></div>
        </div>
      </section>

      <section v-if="system.length" class="stack" aria-labelledby="system-h">
        <div class="stack" style="--gap: 4px">
          <h2 id="system-h">System folders</h2>
          <p class="small muted">ApexOs sets these up for apps and locations, such as Media or Downloads, and looks after them for you.</p>
        </div>
        <div class="grid" style="--min: 240px">
          <FolderCard v-for="f in system" :key="f.dataset" :folder="f" />
        </div>
      </section>

      <section class="card row wrap people" aria-labelledby="people-h">
        <Users :size="20" class="muted" />
        <div class="stack" style="--gap: 2px; flex: 1; min-width: 200px">
          <h2 id="people-h" class="people-title">People</h2>
          <p class="small muted">
            <template v-if="users.length">
              {{ users.length === 1 ? '1 user' : `${users.length} users` }} can sign in to private folders:
              {{ users.map((u) => u.username).join(', ') }}.
            </template>
            <template v-else>Add users to give family members their own sign-in for private folders.</template>
          </p>
        </div>
        <RouterLink to="/users" class="btn small">Manage users</RouterLink>
      </section>
    </div>
  </PageState>

  <FolderPanel v-if="selected" :key="selected.dataset" :folder="selected" @close="closePanel" @edit="editFolder(selected)" @delete="deleting = selected" />

  <FolderWizard
    v-if="wizard"
    :folder="wizard.folder"
    :existing-names="existingNames"
    :reserved-names="data?.reservedNames ?? []"
    @close="closeWizard"
    @done="wizardDone"
  />

  <DeleteFolderDialog v-if="deleting" :folder="deleting" @close="deleting = null" @deleted="deleted" />
</template>

<style scoped>
.empty {
  align-items: flex-start;
}
.people {
  --gap: 14px;
}
.people-title {
  font-size: 1rem;
}
</style>
