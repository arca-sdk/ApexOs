<script setup lang="ts">
/**
 * Restores a backed-up folder from the other server as a new folder (never over an existing one).
 * Encrypted folders come back locked; their key or passphrase unlocks them (used once, never stored).
 */
import { computed, onMounted, ref } from 'vue';
import { Lock } from 'lucide-vue-next';
import type { Backup, RestoreInfo, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import PasswordInput from '../users/PasswordInput.vue';
import TaskProgress from '../storage/TaskProgress.vue';
import { useTaskRunner } from '../storage/taskRunner.ts';
import { ApiError, api } from '../../lib/api.ts';
import { formatBytes } from '../../lib/format.ts';
import { folderNameProblem } from '../folders/folderRules.ts';
import { serverTime } from './backups.ts';

const props = defineProps<{ backup: Backup; timezone: string; existingNames: string[] }>();
const emit = defineEmits<{ close: []; done: [name: string] }>();

const info = ref<RestoreInfo | null>(null);
const loadError = ref<string | null>(null);
const point = ref('');
const name = ref('');
const pool = ref('');
const secret = ref('');
const runner = useTaskRunner(() => emit('done', name.value.trim()));

onMounted(async () => {
  try {
    const i = await api.get<RestoreInfo>(`/backups/${props.backup.id}/restore`);
    info.value = i;
    point.value = i.restorePoints[0]?.name ?? '';
    name.value = i.suggestedName;
    pool.value = i.defaultPool;
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : String(e);
  }
});

const nameProblem = computed(() => folderNameProblem(name.value, [], props.existingNames));
const chosenPool = computed(() => info.value?.pools.find((p) => p.name === pool.value) ?? null);
const spaceProblem = computed(() =>
  info.value && chosenPool.value && info.value.sizeBytes > chosenPool.value.freeBytes ? `${chosenPool.value.displayName} has only ${formatBytes(chosenPool.value.freeBytes)} free.` : null,
);
const secretLabel = computed(() => (info.value?.keyFormat === 'passphrase' ? 'Passphrase' : 'Encryption key'));

function restore() {
  if (!info.value || nameProblem.value || spaceProblem.value) return;
  void runner.start(
    api.post<TaskStarted>(`/backups/${props.backup.id}/restore`, {
      restorePoint: point.value === info.value.restorePoints[0]?.name ? null : point.value,
      name: name.value.trim(),
      pool: pool.value,
      secret: secret.value.trim() || null,
    }),
  );
}
</script>

<template>
  <Modal :title="`Restore ${backup.folder}`" @close="emit('close')">
    <div v-if="loadError" class="callout err" role="alert">{{ loadError }}</div>
    <div v-else-if="!info" class="row muted" role="status"><span class="spin" /> Asking {{ backup.destinationName }} for its restore points…</div>
    <form v-else id="rs-form" class="stack" novalidate @submit.prevent="restore">
      <p>
        ApexOs copies the folder back from {{ backup.destinationName }} into a <strong>new folder</strong>. Nothing on this server is replaced, so you can compare and
        move what you need.
      </p>
      <fieldset class="stack plain" style="--gap: 0" :disabled="runner.running.value">
        <div class="field">
          <label for="rs-point">Restore point</label>
          <select id="rs-point" v-model="point">
            <option v-for="(p, i) in info.restorePoints" :key="p.name" :value="p.name">{{ serverTime(p.createdAt, timezone) }}{{ i === 0 ? ' (newest)' : '' }}</option>
          </select>
          <span class="hint">{{ info.restorePoints.length }} restore {{ info.restorePoints.length === 1 ? 'point' : 'points' }} · {{ formatBytes(info.sizeBytes) }} on {{ backup.destinationName }}</span>
        </div>
      </fieldset>
      <fieldset class="stack plain" :disabled="runner.running.value">
        <div class="field">
          <label for="rs-name">Name of the new folder</label>
          <input id="rs-name" v-model="name" type="text" maxlength="80" autocomplete="off" :aria-invalid="!!nameProblem || !!runner.fieldErrors.value.name || undefined" />
          <span v-if="nameProblem || runner.fieldErrors.value.name" class="error-text">{{ nameProblem ?? runner.fieldErrors.value.name }}</span>
        </div>
        <div class="field">
          <label for="rs-pool">Pool</label>
          <select id="rs-pool" v-model="pool">
            <option v-for="p in info.pools" :key="p.name" :value="p.name" :disabled="p.freeBytes < info.sizeBytes">
              {{ p.displayName }} · {{ formatBytes(p.freeBytes) }} free
            </option>
          </select>
          <span v-if="spaceProblem" class="error-text">{{ spaceProblem }}</span>
        </div>
        <p class="small muted">
          {{ info.originalExists ? `The new folder gets the same access as ${backup.folder}.` : 'The new folder starts private: only the server’s admin account can open it until you give people access.' }}
        </p>

        <div v-if="info.encrypted" class="callout stack" style="--gap: 10px">
          <span class="row" style="--gap: 8px"><Lock :size="16" aria-hidden="true" /><strong>This folder is encrypted</strong></span>
          <span class="small">
            It comes back locked, exactly as it was stored. Enter the folder’s {{ info.keyFormat === 'passphrase' ? 'passphrase' : 'encryption key' }} to unlock and
            share it right away, or leave this empty and unlock it later. ApexOs uses it once and doesn’t store it. Without it, nobody can open the copy.
          </span>
          <div class="field">
            <label for="rs-secret">{{ secretLabel }} (optional)</label>
            <PasswordInput id="rs-secret" v-model="secret" autocomplete="off" />
          </div>
        </div>
      </fieldset>
      <TaskProgress v-if="runner.task.value" :task="runner.task.value" label="Restoring" />
      <p v-if="runner.error.value" class="callout err" role="alert">{{ runner.error.value }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="emit('close')">Cancel</button>
      <button class="btn primary" type="submit" form="rs-form" :disabled="!info || !!nameProblem || !!spaceProblem || runner.running.value">
        <span v-if="runner.running.value" class="spin" />Restore
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
</style>
