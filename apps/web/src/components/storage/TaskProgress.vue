<script setup lang="ts">
/** Inline progress for a running server task (title, current message and a meter). */
import type { Task } from '@hearth/api-types';

defineProps<{ task: Task; label?: string }>();
</script>

<template>
  <div class="task-progress" role="status" aria-live="polite">
    <div class="row small" style="--gap: 8px">
      <span class="spin" aria-hidden="true" />
      <strong>{{ label ?? task.title }}</strong>
      <span class="spacer" />
      <span class="muted">{{ Math.round(task.progress) }}%</span>
    </div>
    <p v-if="task.message" class="small muted">{{ task.message }}</p>
    <div class="meter" role="progressbar" :aria-valuenow="Math.round(task.progress)" aria-valuemin="0" aria-valuemax="100">
      <span :style="{ width: `${task.progress}%` }" />
    </div>
  </div>
</template>

<style scoped>
.task-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text);
}
.spin {
  width: 14px;
  height: 14px;
  color: var(--accent);
}
</style>
