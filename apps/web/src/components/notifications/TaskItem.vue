<script setup lang="ts">
/** One server task: status, progress and (optionally) its checklist of steps. */
import { computed, ref, watch } from 'vue';
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleMinus, CircleX } from 'lucide-vue-next';
import type { Task } from '@apexos/api-types';
import { formatRelative } from '../../lib/format.ts';
import { clock } from './store.ts';

const props = defineProps<{
  task: Task;
  /** Hide the steps entirely (dashboard card). */
  compact?: boolean;
  /** Always show the steps without a toggle (install dialog). */
  showSteps?: boolean;
}>();

const expanded = ref(props.task.status !== 'success');
watch(
  () => props.task.status,
  (s) => {
    if (s === 'failed') expanded.value = true;
  },
);

const stepsVisible = computed(() => !props.compact && props.task.steps.length > 0 && (props.showSteps || expanded.value));

function took(task: Task): string {
  if (!task.finishedAt) return '';
  const s = Math.max(0, Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const when = computed(() => {
  void clock.value;
  const t = props.task;
  if (t.status === 'running') return `Started ${formatRelative(t.startedAt)}`;
  const verb = t.status === 'success' ? 'Finished' : 'Stopped';
  return `${verb} ${formatRelative(t.finishedAt ?? t.startedAt)} · took ${took(t)}`;
});

const stepsId = computed(() => `task-steps-${props.task.id}`);
/** The failed step already shows the error when the steps are visible. */
const errorShownInSteps = computed(() => stepsVisible.value && props.task.steps.some((s) => s.status === 'failed' && s.message === props.task.error));
</script>

<template>
  <div class="task" :class="task.status">
    <div class="head">
      <span class="status-icon" aria-hidden="true">
        <span v-if="task.status === 'running'" class="spin" />
        <CircleCheck v-else-if="task.status === 'success'" :size="18" />
        <CircleX v-else :size="18" />
      </span>
      <div class="body">
        <div class="title-row">
          <strong class="title" :title="task.title">{{ task.title }}</strong>
          <span class="visually-hidden">
            {{ task.status === 'running' ? 'In progress' : task.status === 'success' ? 'Done' : 'Failed' }}
          </span>
        </div>
        <div class="small muted">{{ when }}</div>
      </div>
      <button
        v-if="!compact && !showSteps && task.steps.length"
        class="btn ghost small toggle"
        :aria-expanded="expanded"
        :aria-controls="stepsId"
        :aria-label="expanded ? `Hide steps for ${task.title}` : `Show steps for ${task.title}`"
        @click="expanded = !expanded"
      >
        <ChevronDown v-if="expanded" :size="16" />
        <ChevronRight v-else :size="16" />
      </button>
    </div>

    <template v-if="task.status === 'running'">
      <p v-if="task.message && (compact || !task.steps.length)" class="small muted msg">{{ task.message }}</p>
      <div
        class="meter"
        role="progressbar"
        :aria-valuenow="task.progress"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="`${task.title} progress`"
      >
        <span :style="{ width: `${Math.max(task.progress, 3)}%` }" />
      </div>
    </template>
    <p v-if="task.status === 'failed' && task.error && !errorShownInSteps" class="small err-text">{{ task.error }}</p>

    <ol v-if="stepsVisible" :id="stepsId" class="steps">
      <li v-for="step in task.steps" :key="step.name" :class="step.status">
        <span class="step-icon" aria-hidden="true">
          <span v-if="step.status === 'running'" class="spin small-spin" />
          <CircleCheck v-else-if="step.status === 'success'" :size="15" />
          <CircleX v-else-if="step.status === 'failed'" :size="15" />
          <CircleMinus v-else-if="step.status === 'skipped'" :size="15" />
          <Circle v-else :size="15" />
        </span>
        <div class="step-body">
          <span>{{ step.name }}</span>
          <span class="visually-hidden">({{ step.status }})</span>
          <span v-if="step.status === 'running' && step.progress > 0" class="small muted"> · {{ step.progress }}%</span>
          <div v-if="step.message && step.message !== step.name && step.status !== 'success' && step.status !== 'pending'" class="small" :class="step.status === 'failed' ? 'err-text' : 'muted'">
            {{ step.message }}
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.task {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.status-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 22px;
}
.running .status-icon {
  color: var(--accent);
}
.success .status-icon {
  color: var(--ok);
}
.failed .status-icon {
  color: var(--err);
}
.body {
  flex: 1;
  min-width: 0;
}
.title {
  display: block;
  font-size: 0.93rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toggle {
  flex: none;
  padding: 4px 6px;
}
.msg {
  margin-left: 30px;
}
.meter {
  margin-left: 30px;
  height: 6px;
}
.err-text {
  color: var(--err);
  margin-left: 30px;
}
.steps .err-text {
  margin-left: 0;
}
.steps {
  list-style: none;
  margin: 0 0 0 30px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.88rem;
}
.steps li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.step-icon {
  flex: none;
  width: 16px;
  height: 20px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
}
.steps li.success .step-icon {
  color: var(--ok);
}
.steps li.failed .step-icon {
  color: var(--err);
}
.steps li.running .step-icon {
  color: var(--accent);
}
.steps li.pending {
  color: var(--text-muted);
}
.step-body {
  min-width: 0;
  overflow-wrap: anywhere;
}
.small-spin {
  width: 12px;
  height: 12px;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
