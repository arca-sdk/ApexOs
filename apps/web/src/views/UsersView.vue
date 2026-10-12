<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ChevronRight, UserPlus } from 'lucide-vue-next';
import type { Folder, FoldersResponse, ShareUser } from '@apexos/api-types';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import PageState from '../components/PageState.vue';
import UserForm from '../components/users/UserForm.vue';
import UserPanel from '../components/users/UserPanel.vue';
import { api } from '../lib/api.ts';
import { onServerChange } from '../lib/events.ts';

const route = useRoute();
const router = useRouter();

const users = ref<ShareUser[]>([]);
const folders = ref<Folder[]>([]);
const loaded = ref(false);
const loading = ref(true);
const error = ref<string | null>(null);

async function load() {
  error.value = null;
  try {
    const [list, f] = await Promise.all([
      api.get<ShareUser[]>('/users'),
      api.get<FoldersResponse>('/folders').catch(() => ({ folders: folders.value, reservedNames: [] })),
    ]);
    users.value = list;
    folders.value = f.folders;
    loaded.value = true;
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
onServerChange(['users', 'folders'], load);

const publicNames = computed(() => new Set(folders.value.filter((f) => f.access === 'public').map((f) => f.name.toLowerCase())));
function summary(u: ShareUser): string {
  const own = u.folders.filter((f) => !publicNames.value.has(f.name.toLowerCase()));
  if (!own.length) return 'No private folders yet';
  const names = own.map((f) => f.name);
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

// ---- selection via ?user=<username> ----
const selectedName = computed(() => (typeof route.query.user === 'string' ? route.query.user : null));
const selected = computed(() => (selectedName.value ? (users.value.find((u) => u.username.toLowerCase() === selectedName.value!.toLowerCase()) ?? null) : null));
const missing = computed(() => !!selectedName.value && loaded.value && !selected.value);

function closePanel() {
  router.replace({ path: '/users' });
}

// ---- add / edit ----
const form = ref<{ user: ShareUser | null } | null>(null);
const notice = ref('');
async function saved(user: ShareUser) {
  const wasEdit = !!form.value?.user;
  form.value = null;
  notice.value = wasEdit ? `Saved changes to ${user.username}.` : `${user.username} was added. Give them access from a folder’s Edit screen.`;
  await load();
  router.replace({ path: '/users', query: { user: user.username } });
}

// ---- delete ----
const deleting = ref<ShareUser | null>(null);
const deleteBusy = ref(false);
const deleteError = ref<string | null>(null);
const deleteMessage = computed(() => {
  const u = deleting.value;
  if (!u) return '';
  const own = u.folders.filter((f) => !publicNames.value.has(f.name.toLowerCase())).map((f) => f.name);
  const lose = own.length ? ` They’ll lose access to ${own.join(', ')}.` : '';
  return `${u.username} won’t be able to open folders from other computers anymore.${lose} Files they saved stay where they are.`;
});
async function confirmDelete() {
  if (!deleting.value) return;
  deleteBusy.value = true;
  deleteError.value = null;
  try {
    const name = deleting.value.username;
    await api.del(`/users/${deleting.value.id}`);
    deleting.value = null;
    notice.value = `${name} was deleted.`;
    closePanel();
    await load();
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e);
  } finally {
    deleteBusy.value = false;
  }
}
function openDelete(u: ShareUser) {
  deleteError.value = null;
  deleting.value = u;
}
</script>

<template>
  <div class="page-header">
    <div>
      <h1>Users</h1>
      <p class="subtitle">Sign-ins for opening private folders from other computers. Users can’t manage the server.</p>
    </div>
    <span class="spacer" />
    <button class="btn primary" @click="form = { user: null }"><UserPlus :size="18" /> Add user</button>
  </div>

  <PageState :loading="loading" :error="error" @retry="retry">
    <div class="stack">
      <p v-if="notice" class="callout ok row" role="status" style="--gap: 8px">
        <span style="flex: 1">{{ notice }}</span>
        <button class="btn ghost small" @click="notice = ''">Dismiss</button>
      </p>
      <p v-if="missing" class="callout warn" role="status">There’s no user called “{{ selectedName }}”. They may have been deleted.</p>

      <ul v-if="users.length" class="card user-list">
        <li v-for="u in users" :key="u.id">
          <RouterLink :to="{ path: '/users', query: { user: u.username } }" class="user-row">
            <span class="avatar" aria-hidden="true">{{ u.username.slice(0, 1).toUpperCase() }}</span>
            <span class="stack" style="--gap: 0; min-width: 0; flex: 1">
              <strong class="uname">{{ u.username }}</strong>
              <span class="small muted folders">{{ summary(u) }}</span>
            </span>
            <ChevronRight :size="18" class="muted" />
          </RouterLink>
        </li>
      </ul>
      <div v-else class="card stack empty" style="--gap: 10px">
        <strong>No users yet</strong>
        <p class="small muted">
          Public folders don’t need a sign-in. For private folders, add a user for each person, then pick which folders they can open.
        </p>
        <div><button class="btn primary" @click="form = { user: null }"><UserPlus :size="18" /> Add user</button></div>
      </div>
      <p class="small muted">The server’s admin account isn’t listed here. It can always open every folder.</p>
    </div>
  </PageState>

  <UserPanel v-if="selected" :key="selected.id" :user="selected" :folders="folders" @close="closePanel" @edit="form = { user: selected }" @delete="openDelete(selected)" />

  <UserForm v-if="form" :user="form.user" :taken-names="users.map((u) => u.username)" @close="form = null" @saved="saved" />

  <ConfirmDialog
    v-if="deleting"
    :title="`Delete ${deleting.username}?`"
    :message="deleteMessage"
    action-label="Delete user"
    danger
    :busy="deleteBusy"
    :error="deleteError"
    @confirm="confirmDelete"
    @close="deleting = null"
  />
</template>

<style scoped>
.user-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: hidden;
  /* Long, non-wrapping names are cut with an ellipsis instead of widening the page. */
  contain: inline-size;
}
.user-list li + li {
  border-top: 1px solid var(--border);
}
.user-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  color: var(--text);
}
.user-row:hover {
  background: var(--surface-2);
  text-decoration: none;
}
.user-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.avatar {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 650;
  flex-shrink: 0;
}
.uname,
.folders {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  align-items: flex-start;
}
</style>
