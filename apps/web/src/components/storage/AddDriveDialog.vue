<script setup lang="ts">
/** Grow a RAIDZ pool by one drive (RAIDZ expansion). Only offered when `layout.expandable`. */
import { computed, ref } from 'vue';
import type { Drive, Pool, TaskStarted } from '@apexos/api-types';
import Modal from '../Modal.vue';
import DriveChoice from './DriveChoice.vue';
import TaskProgress from './TaskProgress.vue';
import { api } from '../../lib/api.ts';
import { joinProblem, largerNote, type PickerDrive } from './drives.ts';
import { useTaskRunner } from './taskRunner.ts';

const props = defineProps<{ pool: Pool; unassigned: Drive[] }>();
const emit = defineEmits<{ close: []; done: [] }>();

const choice = ref<string | null>(null);
const consent = ref(false);
const runner = useTaskRunner(() => emit('done'));

const options = computed<PickerDrive[]>(() =>
  props.unassigned.map((d) => ({ drive: d, disabledReason: joinProblem(props.pool, d), note: largerNote(props.pool, d) })),
);
const canSubmit = computed(() => Boolean(choice.value) && consent.value && !runner.running.value);

function submit() {
  if (!canSubmit.value) return;
  void runner.start(api.post<TaskStarted>(`/storage/pools/${props.pool.id}/drives`, { drive: choice.value }));
}
</script>

<template>
  <Modal :title="`Add a drive to ${pool.displayName}`" wide @close="emit('close')">
    <p>
      Adding a drive gives {{ pool.displayName }} more space. Afterwards your existing files are spread onto the new drive in the background. That can take many
      hours; the pool stays usable, just a bit slower.
    </p>
    <p class="small muted">A drive can’t be taken out of a pool again once it has been added.</p>

    <template v-if="runner.task.value">
      <TaskProgress :task="runner.task.value" />
      <p class="small muted">You can close this window; the progress also shows on the pool.</p>
    </template>
    <template v-else>
      <DriveChoice
        v-model="choice"
        name="add-drive"
        legend="Drive to add"
        :drives="options"
        empty-text="No unused drive fits. Connect a drive of the same kind that is at least as large as the others in the pool."
      />
      <label class="row consent" style="--gap: 10px">
        <input v-model="consent" type="checkbox" :disabled="!choice" />
        <span>I understand that the chosen drive will be erased.</span>
      </label>
      <p v-if="runner.error.value" class="callout err">{{ runner.error.value }}</p>
    </template>

    <template #footer>
      <button v-if="runner.task.value" class="btn" @click="emit('close')">Close</button>
      <template v-else>
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn primary" :disabled="!canSubmit" @click="submit"><span v-if="runner.running.value" class="spin" />Add drive</button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.consent {
  align-items: flex-start;
  font-weight: 550;
}
.consent input {
  margin-top: 3px;
  flex: none;
}
</style>
