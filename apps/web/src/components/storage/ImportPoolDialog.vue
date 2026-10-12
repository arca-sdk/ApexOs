<script setup lang="ts">
/** Finds pools on connected drives that aren't in use yet (slow) and imports the chosen one. */
import { onMounted, ref } from 'vue';
import { Database, RefreshCw } from 'lucide-vue-next';
import type { ImportablePool, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import TaskProgress from './TaskProgress.vue';
import { ApiError, api } from '../../lib/api.ts';
import { useTaskRunner } from './taskRunner.ts';

const emit = defineEmits<{ close: []; done: [] }>();

const pools = ref<ImportablePool[] | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const importing = ref<string | null>(null);
const runner = useTaskRunner(() => emit('done'));

async function load(fresh = false) {
  loading.value = true;
  loadError.value = null;
  try {
    pools.value = await api.get<ImportablePool[]>(`/storage/importable${fresh ? '?fresh=1' : ''}`);
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function start(pool: ImportablePool) {
  importing.value = pool.guid;
  void runner.start(api.post<TaskStarted>('/storage/import', { guid: pool.guid }));
}

onMounted(() => load());
</script>

<template>
  <Modal title="Import a pool" @close="emit('close')">
    <p>Bring in a pool from drives that were used in another server (or before a reinstall). Everything on it is kept: folders, files and app data.</p>

    <div v-if="loading" class="row muted searching" role="status"><span class="spin" /> Looking for pools on your drives. This can take a minute…</div>
    <div v-else-if="loadError" class="callout err stack" style="--gap: 8px">
      <span>ApexOs couldn’t look for pools: {{ loadError }}</span>
      <div><button class="btn small" @click="load(true)">Try again</button></div>
    </div>
    <template v-else-if="pools">
      <p v-if="!pools.length" class="callout">
        No pools were found. Connect all the drives of the pool you want to bring in, then search again.
      </p>
      <ul v-else class="pools">
        <li v-for="p in pools" :key="p.guid" class="row" style="--gap: 12px">
          <Database :size="20" class="icon" aria-hidden="true" />
          <div class="grow">
            <strong>{{ p.name }}</strong>
            <div class="small muted">
              {{ p.hostname ? `Last used on ${p.hostname}` : 'From another system' }} · <span :class="p.status === 'ONLINE' ? '' : 'warn'">{{ p.status === 'ONLINE' ? 'All drives present' : p.status.toLowerCase() }}</span>
            </div>
          </div>
          <button class="btn small primary" :disabled="runner.running.value" @click="start(p)">
            <span v-if="runner.running.value && importing === p.guid" class="spin" />Import
          </button>
        </li>
      </ul>
      <TaskProgress v-if="runner.task.value" :task="runner.task.value" />
      <p v-if="runner.error.value" class="callout err">{{ runner.error.value }}</p>
    </template>

    <template #footer>
      <button class="btn ghost" :disabled="loading || runner.running.value" @click="load(true)"><RefreshCw :size="15" aria-hidden="true" /> Search again</button>
      <button class="btn" @click="emit('close')">Close</button>
    </template>
  </Modal>
</template>

<style scoped>
.searching {
  padding: 14px 0;
}
.pools {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pools li {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.icon {
  color: var(--text-muted);
  flex: none;
}
.grow {
  flex: 1;
  min-width: 0;
}
.warn {
  color: var(--warn);
}
</style>
