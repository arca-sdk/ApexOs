<script setup lang="ts">
/** Picks folders, a destination and the schedule; ApexOs creates the tasks and starts the first copies. */
import { computed, ref, watch } from 'vue';
import { Lock } from 'lucide-vue-next';
import type { Backup, BackupDestination, BackupOptions, Folder, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import TaskProgress from '../storage/TaskProgress.vue';
import { useTaskRunner } from '../storage/taskRunner.ts';
import { api } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';
import BackupOptionsFields from './BackupOptionsFields.vue';
import { defaultOptions } from './backups.ts';

const props = defineProps<{
  destinations: BackupDestination[];
  backups: Backup[];
  folders: Folder[];
  timezone: string;
  folder?: string | null;
  destinationId?: string | null;
}>();
const emit = defineEmits<{ close: []; done: [] }>();

const destinationId = ref(props.destinationId ?? props.destinations.find((d) => d.health !== 'unreachable')?.id ?? props.destinations[0]?.id ?? '');
const destination = computed(() => props.destinations.find((d) => d.id === destinationId.value) ?? null);
const selected = ref<string[]>(props.folder ? [props.folder] : []);
const options = ref<BackupOptions>(defaultOptions());
const runner = useTaskRunner(() => emit('done'));

/** Folders already backed up to the chosen destination can't be added again. */
const taken = computed(() => new Set(props.backups.filter((b) => b.destinationId === destinationId.value).map((b) => b.dataset)));
watch(destinationId, () => {
  selected.value = selected.value.filter((name) => !taken.value.has(props.folders.find((f) => f.name === name)?.dataset ?? ''));
});

const selectedBytes = computed(() => props.folders.filter((f) => selected.value.includes(f.name)).reduce((a, f) => a + f.usedBytes, 0));
const freeBytes = computed(() => (destination.value?.usedBytes === null || !destination.value ? null : Math.max(0, destination.value.grantedBytes - destination.value.usedBytes)));
const tooBig = computed(() => freeBytes.value !== null && selectedBytes.value > freeBytes.value);

function submit() {
  if (!destination.value || !selected.value.length) return;
  void runner.start(api.post<TaskStarted>('/backups', { destinationId: destinationId.value, folders: selected.value, ...options.value }));
}
</script>

<template>
  <Modal title="Back up folders" wide @close="emit('close')">
    <form id="nb-form" class="stack" style="--gap: 20px" @submit.prevent="submit">
      <div class="field">
        <label for="nb-dest">Back up to</label>
        <select id="nb-dest" v-model="destinationId" :disabled="runner.running.value">
          <option v-for="d in destinations" :key="d.id" :value="d.id">{{ d.name }}{{ d.health === 'unreachable' ? ' (can’t be reached right now)' : '' }}</option>
        </select>
        <span v-if="destination && freeBytes !== null" class="hint">{{ formatBytes(freeBytes) }} free of the {{ formatBytes(destination.grantedBytes) }} set aside on {{ destination.name }}.</span>
        <span v-if="destination?.health === 'unreachable'" class="error-text">{{ destination.problem }}</span>
      </div>

      <p v-if="destination?.encryptedOnly" class="callout warn">
        The backup space on {{ destination.name }} is in an encrypted pool, so only encrypted folders can be backed up there. Unencrypted folders would have to be
        re-encrypted with {{ destination.name }}’s own key.
      </p>

      <fieldset class="stack plain" style="--gap: 6px" :disabled="runner.running.value">
        <legend class="field-label">Folders</legend>
        <p v-if="!folders.length" class="small muted">There are no folders to back up yet.</p>
        <ul class="folders">
          <li v-for="f in folders" :key="f.dataset">
            <label class="folder" :class="{ off: taken.has(f.dataset) }">
              <input v-model="selected" type="checkbox" :value="f.name" :disabled="taken.has(f.dataset)" />
              <span class="name">{{ f.name }}</span>
              <span class="small muted">{{ taken.has(f.dataset) ? 'Already backed up there' : formatBytes(f.usedBytes) }}</span>
            </label>
          </li>
        </ul>
        <p class="small muted row" style="--gap: 6px"><Lock :size="14" aria-hidden="true" /> Encrypted folders stay encrypted on the other server: it can store them but can’t open them.</p>
      </fieldset>

      <p v-if="tooBig" class="callout warn">
        The selected folders use {{ formatBytes(selectedBytes) }}, more than the {{ formatBytes(freeBytes ?? 0) }} free on {{ destination?.name }}. Set aside more space there or pick fewer folders.
      </p>

      <BackupOptionsFields v-model="options" :timezone="timezone" :errors="runner.fieldErrors.value" />

      <TaskProgress v-if="runner.task.value" :task="runner.task.value" label="Setting up backups" />
      <p v-if="runner.error.value" class="callout err" role="alert">{{ runner.error.value }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="nb-form" :disabled="!selected.length || !destination || runner.running.value">
        <span v-if="runner.running.value" class="spin" />Start backing up
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.plain {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.plain legend {
  padding: 0;
  margin-bottom: 4px;
}
.folders {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  max-height: 260px;
  overflow-y: auto;
}
.folders li + li {
  border-top: 1px solid var(--border);
}
.folder {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
}
.folder.off {
  cursor: default;
  opacity: 0.65;
}
.name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: 550;
}
</style>
