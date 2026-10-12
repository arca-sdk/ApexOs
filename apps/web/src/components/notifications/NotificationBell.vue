<script setup lang="ts">
/** Bell button with the unread count; opens the Notifications & activity panel. */
import { computed, onMounted, watch } from 'vue';
import { Bell } from 'lucide-vue-next';
import { live, onServerChange } from '../../lib/events.ts';
import NotificationsPanel from './NotificationsPanel.vue';
import { activity, loadNotices, openActivity, runningCount, startClock, unreadCount } from './store.ts';

const label = computed(() => {
  const parts = [unreadCount.value ? `${unreadCount.value} unread` : 'no unread notifications'];
  if (runningCount.value) parts.push(`${runningCount.value} job${runningCount.value === 1 ? '' : 's'} running`);
  return `Notifications and activity (${parts.join(', ')})`;
});
const badge = computed(() => (unreadCount.value > 99 ? '99+' : String(unreadCount.value)));

onMounted(() => {
  startClock();
  void loadNotices();
});
onServerChange(['alerts'], () => void loadNotices());
// Catch up on anything missed while the live connection was down.
watch(
  () => live.connected,
  (on, was) => {
    if (on && was === false) void loadNotices();
  },
);
</script>

<template>
  <div class="bell-wrap">
    <button
      class="btn ghost bell"
      :class="{ busy: runningCount > 0 }"
      :aria-label="label"
      :title="label"
      aria-haspopup="dialog"
      :aria-expanded="activity.open"
      @click="openActivity(unreadCount || !runningCount ? 'notices' : 'activity')"
    >
      <Bell :size="19" />
      <span v-if="unreadCount" class="badge-count" aria-hidden="true">{{ badge }}</span>
      <span v-else-if="runningCount" class="busy-dot" aria-hidden="true" />
    </button>
    <NotificationsPanel v-if="activity.open" />
  </div>
</template>

<style scoped>
.bell-wrap {
  margin-left: auto;
  flex: none;
}
.bell {
  position: relative;
  padding: 7px;
  color: var(--text-muted);
}
.bell:hover {
  color: var(--text);
}
.badge-count {
  position: absolute;
  top: 1px;
  right: 0;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 0.7rem;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--surface);
}
.busy-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--info);
  box-shadow: 0 0 0 2px var(--surface);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .busy-dot {
    animation: none;
  }
}
</style>
