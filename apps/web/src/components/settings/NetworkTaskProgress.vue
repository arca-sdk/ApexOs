<script setup lang="ts">
/** Live progress of a network change, with the countdown while TrueNAS waits, and how it ended. */
import { computed } from 'vue';
import { CircleCheck, RotateCcw, TriangleAlert } from 'lucide-vue-next';
import type { Task } from '@apexos/api-types';
import TaskItem from '../notifications/TaskItem.vue';
import { live } from '../../lib/events.ts';
import { outcome } from './network.ts';

const props = defineProps<{
  task: Task;
  /** Where ApexOs can be opened after the change, when this browser used the old address. */
  newUrl?: string | null;
  savedText?: string;
}>();

const result = computed(() => outcome(props.task));
const waitingStep = computed(() =>
  props.task.status === 'running' ? props.task.steps.find((s) => s.status === 'running' && s.name === 'Reconnecting') : undefined,
);
/** The countdown and the outcome are shown below in plain words, so the checklist doesn't repeat them. */
const shown = computed<Task>(() => ({
  ...props.task,
  error: undefined,
  steps: props.task.steps.map((s) => (s === waitingStep.value ? { ...s, message: undefined } : s)),
}));
</script>

<template>
  <div class="stack progress" style="--gap: 12px">
    <TaskItem :task="shown" show-steps />
    <div aria-live="polite" class="stack" style="--gap: 10px">
      <p v-if="waitingStep?.message" class="callout small countdown">{{ waitingStep.message }}</p>
      <p v-if="result === 'running' && !live.connected" class="callout warn small">
        ApexOs isn’t answering right now. That’s expected if it runs on this server and its address is changing.
        <template v-if="newUrl">
          If this page doesn’t recover, open ApexOs at <a :href="newUrl">{{ newUrl.replace(/\/settings.*$/, '') }}</a>.
        </template>
      </p>
      <p v-if="result === 'saved'" class="callout ok row" style="--gap: 8px">
        <CircleCheck :size="18" style="color: var(--ok); flex: none" />
        <span>{{ savedText ?? 'Saved. The new settings work and are kept.' }}</span>
      </p>
      <p v-if="result === 'saved' && newUrl" class="callout small">
        This page still uses the old address. Open ApexOs at <a :href="newUrl">{{ newUrl.replace(/\/settings.*$/, '') }}</a>.
      </p>
      <div v-if="result === 'restored'" class="callout warn stack" style="--gap: 6px">
        <strong class="row" style="--gap: 8px"><RotateCcw :size="16" /> Nothing changed</strong>
        <span>{{ task.error }}</span>
        <span class="small muted">Check the settings (for example, that the address belongs to your network) and try again.</span>
      </div>
      <div v-if="result === 'failed'" class="callout err stack" style="--gap: 6px">
        <strong class="row" style="--gap: 8px"><TriangleAlert :size="16" /> The change didn’t go through</strong>
        <span>{{ task.error ?? 'Something went wrong.' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.countdown {
  font-variant-numeric: tabular-nums;
}
</style>
