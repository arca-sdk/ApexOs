<script setup lang="ts">
import { computed, ref } from 'vue';
import { CircleCheck, CircleX, X } from 'lucide-vue-next';
import { live } from '../lib/events.ts';

const dismissed = ref(new Set<string>());

/** Running tasks plus tasks that finished in the last minute and were not dismissed. */
const visible = computed(() =>
  Object.values(live.tasks)
    .filter((t) => {
      if (dismissed.value.has(t.id)) return false;
      if (t.status === 'running') return true;
      return t.finishedAt ? Date.now() - Date.parse(t.finishedAt) < 60_000 : false;
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 4),
);

function dismiss(id: string) {
  dismissed.value = new Set([...dismissed.value, id]);
}
</script>

<template>
  <div v-if="visible.length" class="tray">
    <div v-for="task in visible" :key="task.id" class="card task">
      <div class="row" style="--gap: 10px">
        <span v-if="task.status === 'running'" class="spin" style="color: var(--accent)" />
        <CircleCheck v-else-if="task.status === 'success'" :size="18" style="color: var(--ok)" />
        <CircleX v-else :size="18" style="color: var(--err)" />
        <strong class="title">{{ task.title }}</strong>
        <span class="spacer" />
        <button v-if="task.status !== 'running'" class="btn ghost small" aria-label="Dismiss" @click="dismiss(task.id)"><X :size="14" /></button>
      </div>
      <p v-if="task.status === 'failed'" class="small" style="color: var(--err)">{{ task.error }}</p>
      <template v-else-if="task.status === 'running'">
        <p class="small muted">{{ task.message || 'Working…' }}</p>
        <div class="meter"><span :style="{ width: `${task.progress}%` }" /></div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tray {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: min(340px, calc(100vw - 40px));
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 50;
}
.task {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.title {
  font-size: 0.93rem;
}
</style>
