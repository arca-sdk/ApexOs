<script setup lang="ts">
/** "Backing up to" section of a folder's panel: where the folder is copied, how it's doing, Back up now. */
import { computed, onMounted, ref } from 'vue';
import { Server, Upload } from 'lucide-vue-next';
import type { BackupsResponse, Folder, TaskStarted } from '@apexos/api-types';
import { ApiError, api, runTask } from '../../lib/api.ts';
import { live, onServerChange } from '../../lib/events.ts';
import { ago, STATE_BADGE } from './backups.ts';

const props = defineProps<{ folder: Folder }>();

const data = ref<BackupsResponse | null>(null);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);

async function load() {
  try {
    data.value = await api.get<BackupsResponse>('/backups');
    error.value = null;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e);
  }
}
onMounted(load);
onServerChange(['backups', 'folders'], load);

const mine = computed(() => data.value?.backups.filter((b) => b.dataset === props.folder.dataset) ?? []);
const health = (id: string) => data.value?.destinations.find((d) => d.id === id)?.health;
const runningTask = (id: string) => Object.values(live.tasks).some((t) => t.status === 'running' && t.ref === id && (t.type === 'backup-run' || t.type === 'backup-fresh-copy'));

async function runNow(id: string) {
  actionError.value = null;
  try {
    await runTask(api.post<TaskStarted>(`/backups/${id}/run`));
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e);
  }
  await load();
}
</script>

<template>
  <section class="stack" style="--gap: 8px" aria-labelledby="fp-backups">
    <h3 id="fp-backups">Backing up to</h3>
    <p v-if="error" class="small muted">Backups can’t be shown right now.</p>
    <template v-else-if="data">
      <ul v-if="mine.length" class="list">
        <li v-for="b in mine" :key="b.id" class="stack" style="--gap: 4px">
          <div class="row" style="--gap: 10px">
            <Server :size="16" class="muted" aria-hidden="true" />
            <strong class="dest">{{ b.destinationName }}</strong>
            <span class="spacer" />
            <span class="badge" :class="STATE_BADGE[runningTask(b.id) ? 'running' : b.status.state]">{{ runningTask(b.id) ? 'Backing up' : b.status.label }}</span>
          </div>
          <div class="row wrap small" style="--gap: 8px">
            <span class="muted">Last backup: {{ ago(b.status.lastSuccessAt) }}</span>
            <span class="spacer" />
            <button
              class="btn small"
              :disabled="runningTask(b.id) || b.status.state === 'running' || b.paused || health(b.destinationId) === 'unreachable'"
              @click="runNow(b.id)"
            >
              <Upload :size="14" /> Back up now
            </button>
          </div>
          <p v-if="b.status.detail" class="small muted">{{ b.status.detail }}</p>
        </li>
      </ul>
      <p v-else class="small muted">
        This folder isn’t copied to another server.
        <template v-if="!data.destinations.length">Add one of your other servers under Backups to keep a copy there.</template>
      </p>
      <p v-if="actionError" class="small" style="color: var(--err)">{{ actionError }}</p>
      <RouterLink class="small" :to="mine.length ? '/backups' : { path: '/backups', query: { backup: folder.name } }">
        {{ mine.length ? 'Manage backups' : data.destinations.length ? 'Back up this folder' : 'Set up backups' }}
      </RouterLink>
    </template>
    <p v-else class="small muted row" style="--gap: 8px"><span class="spin" /> Checking backups…</p>
  </section>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dest {
  overflow-wrap: anywhere;
}
</style>
