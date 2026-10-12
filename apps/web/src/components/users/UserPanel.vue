<script setup lang="ts">
/** A user's page: every folder they can open, with links, plus edit/delete. */
import { computed } from 'vue';
import { Folder as FolderIcon, Globe, Pencil, Trash2 } from 'lucide-vue-next';
import type { Folder, ShareUser } from '@hearth/api-types';
import SidePanel from '../folders/SidePanel.vue';
import { LEVEL_LABELS } from '../folders/folderRules.ts';

const props = defineProps<{ user: ShareUser; folders: Folder[] }>();
const emit = defineEmits<{ close: []; edit: []; delete: [] }>();

const rows = computed(() =>
  props.user.folders.map((f) => {
    const folder = props.folders.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
    return { ...f, public: folder?.access === 'public', pool: folder?.poolDisplayName ?? null };
  }),
);
const privateRows = computed(() => rows.value.filter((r) => !r.public));
const publicRows = computed(() => rows.value.filter((r) => r.public));
</script>

<template>
  <SidePanel :title="user.username" subtitle="Network user" @close="emit('close')">
    <p class="small muted">
      {{ user.username }} can open the folders below from another computer by signing in with this username and password. Users can’t sign in to
      Hearth.
    </p>

    <section class="stack" style="--gap: 8px" aria-labelledby="up-private">
      <h3 id="up-private">Private folders they can open</h3>
      <ul v-if="privateRows.length" class="list">
        <li v-for="r in privateRows" :key="r.name" class="row" style="--gap: 10px">
          <FolderIcon :size="16" class="muted" />
          <RouterLink :to="{ path: '/folders', query: { folder: r.name } }">{{ r.name }}</RouterLink>
          <span class="spacer" />
          <span class="badge" :class="r.level === 'full' ? 'ok' : ''">{{ LEVEL_LABELS[r.level] }}</span>
        </li>
      </ul>
      <p v-else class="small muted">None yet. Open a private folder and choose Edit to give {{ user.username }} access.</p>
    </section>

    <section v-if="publicRows.length" class="stack" style="--gap: 8px" aria-labelledby="up-public">
      <h3 id="up-public">Public folders</h3>
      <p class="small muted">Everyone on your network can open these, including {{ user.username }}.</p>
      <ul class="list">
        <li v-for="r in publicRows" :key="r.name" class="row" style="--gap: 10px">
          <Globe :size="16" class="muted" />
          <RouterLink :to="{ path: '/folders', query: { folder: r.name } }">{{ r.name }}</RouterLink>
          <span class="spacer" />
          <span class="badge info">{{ LEVEL_LABELS[r.level] }}</span>
        </li>
      </ul>
    </section>

    <template #footer>
      <button class="btn" @click="emit('edit')"><Pencil :size="16" /> Edit</button>
      <span class="spacer" />
      <button class="btn danger" @click="emit('delete')"><Trash2 :size="16" /> Delete</button>
    </template>
  </SidePanel>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
