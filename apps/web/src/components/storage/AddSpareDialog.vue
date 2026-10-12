<script setup lang="ts">
/** Assign an unused drive as a hot spare for a protected pool. */
import { computed, ref } from 'vue';
import type { Drive, Pool, TaskStarted } from '@hearth/api-types';
import Modal from '../Modal.vue';
import DriveChoice from './DriveChoice.vue';
import TaskProgress from './TaskProgress.vue';
import { api } from '../../lib/api.ts';
import { joinProblem, largerNote, type PickerDrive } from './drives.ts';
import { useTaskRunner } from './taskRunner.ts';

const props = defineProps<{ pool: Pool; unassigned: Drive[] }>();
const emit = defineEmits<{ close: []; done: [] }>();

const choice = ref<string | null>(null);
const runner = useTaskRunner(() => emit('done'));

const protectedPool = computed(() => (props.pool.layout.faultTolerance ?? 0) > 0);
const options = computed<PickerDrive[]>(() =>
  props.unassigned.map((d) => ({ drive: d, disabledReason: joinProblem(props.pool, d, { spare: true }), note: largerNote(props.pool, d) })),
);
const canSubmit = computed(() => protectedPool.value && Boolean(choice.value) && !runner.running.value);

function submit() {
  if (!canSubmit.value) return;
  void runner.start(api.post<TaskStarted>(`/storage/pools/${props.pool.id}/spares`, { drive: choice.value }));
}
</script>

<template>
  <Modal :title="`Add a hot spare to ${pool.displayName}`" wide @close="emit('close')">
    <p>
      A hot spare sits ready and unused. If a drive in {{ pool.displayName }} fails, the spare takes over straight away and the pool starts rebuilding on its own,
      without waiting for you.
    </p>
    <p v-if="!protectedPool" class="callout warn">
      {{ pool.displayName }} has no protection, so a spare can’t help it: when one of its drives fails, the data is already gone.
    </p>

    <template v-else-if="runner.task.value">
      <TaskProgress :task="runner.task.value" />
    </template>
    <template v-else>
      <DriveChoice
        v-model="choice"
        name="spare"
        legend="Drive to keep as a spare"
        :drives="options"
        empty-text="No unused drive fits. A spare must be the same kind as the pool's drives, at least as large, and free of errors."
      />
      <p class="small muted">The chosen drive is erased.</p>
      <p v-if="runner.error.value" class="callout err">{{ runner.error.value }}</p>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">{{ protectedPool ? 'Cancel' : 'Close' }}</button>
      <button v-if="protectedPool && !runner.task.value" class="btn primary" :disabled="!canSubmit" @click="submit">
        <span v-if="runner.running.value" class="spin" />Add spare
      </button>
    </template>
  </Modal>
</template>
