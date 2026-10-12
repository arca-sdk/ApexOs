<script setup lang="ts">
import { computed } from 'vue';
import { Activity, Bell } from 'lucide-vue-next';
import TaskItem from '../notifications/TaskItem.vue';
import { openActivity, runningCount, sortedTasks, unreadCount } from '../notifications/store.ts';

/** Running jobs first; when nothing runs, the latest finished ones. */
const shown = computed(() => {
  const running = sortedTasks.value.filter((t) => t.status === 'running');
  return running.length ? running.slice(0, 3) : sortedTasks.value.slice(0, 3);
});
</script>

<template>
  <section class="card metric" aria-labelledby="activity-title">
    <header class="card-header">
      <Activity :size="18" class="icon" aria-hidden="true" />
      <h3 id="activity-title">Activity</h3>
      <span class="spacer" />
      <span v-if="runningCount" class="badge info"><span class="spin tiny" aria-hidden="true" />{{ runningCount }} running</span>
    </header>

    <ul v-if="shown.length" class="tasks">
      <li v-for="t in shown" :key="t.id"><TaskItem :task="t" compact /></li>
    </ul>
    <p v-else class="muted small quiet">All quiet. Jobs like installing apps or creating folders show their progress here.</p>

    <footer class="foot">
      <button v-if="unreadCount" class="btn small" @click="openActivity('notices')">
        <Bell :size="14" aria-hidden="true" /> {{ unreadCount }} unread {{ unreadCount === 1 ? 'notification' : 'notifications' }}
      </button>
      <span class="spacer" />
      <button class="btn ghost small" @click="openActivity('activity')">See all activity</button>
    </footer>
  </section>
</template>

<style scoped>
.metric {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.card-header {
  margin-bottom: 0;
  gap: 8px;
}
.icon {
  color: var(--accent);
}
.tasks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.quiet {
  padding: 8px 0;
}
.foot {
  margin-top: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.tiny {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
}
</style>
