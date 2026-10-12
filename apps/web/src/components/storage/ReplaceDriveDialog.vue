<script setup lang="ts">
/**
 * Replace a pool drive (failed or healthy) with an unused one. When another pool is degraded or
 * rebuilding the server asks for an explicit risk acknowledgement (RISK_NOT_ACKNOWLEDGED).
 */
import { computed, ref } from 'vue';
import type { Drive, Pool, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import DriveChoice from './DriveChoice.vue';
import DriveRow from './DriveRow.vue';
import TaskProgress from './TaskProgress.vue';
import { api } from '../../lib/api.ts';
import { joinProblem, largerNote, poolAtRisk, type PickerDrive } from './drives.ts';
import { useTaskRunner } from './taskRunner.ts';

const props = defineProps<{ pool: Pool; drive: Drive; unassigned: Drive[]; pools: Pool[] }>();
const emit = defineEmits<{ close: []; done: [] }>();

const choice = ref<string | null>(null);
const acknowledged = ref(false);
const runner = useTaskRunner(() => emit('done'));

const failing = computed(() => props.drive.missing || (props.drive.status ?? 'ONLINE').toUpperCase() !== 'ONLINE');
const options = computed<PickerDrive[]>(() =>
  props.unassigned.map((d) => ({
    drive: d,
    disabledReason: joinProblem(props.pool, d, { exclude: props.drive.identifier }),
    note: largerNote(props.pool, d, props.drive.identifier),
  })),
);

/** Pool whose state makes touching drives risky (the server re-checks; this just warns up front). */
const risky = computed(() => (failing.value ? undefined : poolAtRisk(props.pools)));
const needsAck = computed(() => Boolean(risky.value) || runner.code.value === 'RISK_NOT_ACKNOWLEDGED');
const canSubmit = computed(() => Boolean(choice.value) && (!needsAck.value || acknowledged.value) && !runner.running.value);

function submit() {
  if (!canSubmit.value || !choice.value) return;
  void runner.start(
    api.post<TaskStarted>(`/storage/pools/${props.pool.id}/replace`, {
      oldDrive: props.drive.identifier,
      newDrive: choice.value,
      acknowledgeRisk: acknowledged.value,
    }),
  );
}
</script>

<template>
  <Modal title="Replace a drive" wide @close="emit('close')">
    <p>
      <template v-if="failing">Pick a drive to take the place of the failed one. ZFS rebuilds the pool onto it; your files stay available meanwhile.</template>
      <template v-else>
        The old drive stays in use until the new one holds a full copy of its data, so the pool keeps its protection the whole time. Handy for upgrading to bigger drives
        one at a time.
      </template>
    </p>
    <div class="old">
      <div class="small muted">Replacing in {{ pool.displayName }}</div>
      <DriveRow :drive="drive" />
    </div>

    <template v-if="runner.task.value">
      <TaskProgress :task="runner.task.value" label="Replacing the drive" />
      <p class="small muted">You can close this window; the rebuild keeps going and its progress shows on the pool.</p>
    </template>
    <template v-else>
      <DriveChoice
        v-model="choice"
        name="replacement"
        legend="Replacement drive"
        :drives="options"
        empty-text="No unused drive fits. Connect a drive of the same kind that is at least as large as the others in the pool."
      />
      <p class="small muted">The replacement drive is erased. Replace one drive at a time and wait for the rebuild to finish before the next.</p>

      <div v-if="needsAck" class="callout warn stack" style="--gap: 8px">
        <span>
          {{ risky ? `${risky.displayName} is ${risky.health}.` : runner.error.value }}
          Changing drives now puts more strain on your pools. If something else fails, data could be lost.
        </span>
        <label class="row consent" style="--gap: 10px">
          <input v-model="acknowledged" type="checkbox" />
          <span>I understand the risk and want to replace this drive now.</span>
        </label>
      </div>
      <p v-if="runner.error.value && runner.code.value !== 'RISK_NOT_ACKNOWLEDGED'" class="callout err">{{ runner.error.value }}</p>
    </template>

    <template #footer>
      <template v-if="runner.task.value">
        <button class="btn" @click="emit('close')">Close</button>
      </template>
      <template v-else>
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn primary" :disabled="!canSubmit" @click="submit"><span v-if="runner.running.value" class="spin" />Replace drive</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.old {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.consent {
  align-items: flex-start;
  font-weight: 550;
}
.consent input {
  margin-top: 3px;
  flex: none;
}
</style>
