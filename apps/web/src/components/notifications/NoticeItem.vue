<script setup lang="ts">
import { computed } from 'vue';
import { CircleAlert, Info, OctagonAlert, TriangleAlert, X } from 'lucide-vue-next';
import type { Notice } from '@hearth/api-types';
import { formatRelative } from '../../lib/format.ts';
import { clock } from './store.ts';

const props = defineProps<{ notice: Notice }>();
const emit = defineEmits<{ dismiss: []; navigate: [] }>();

const LEVELS = {
  info: { icon: Info, label: 'Info' },
  warning: { icon: TriangleAlert, label: 'Warning' },
  error: { icon: CircleAlert, label: 'Problem' },
  critical: { icon: OctagonAlert, label: 'Urgent' },
} as const;

const PAGES: Record<string, string> = {
  '/': 'Dashboard',
  '/storage': 'Storage',
  '/folders': 'Folders',
  '/users': 'Users',
  '/apps': 'Apps',
  '/settings': 'Settings',
};

const level = computed(() => LEVELS[props.notice.level] ?? LEVELS.info);
const linkLabel = computed(() => {
  const link = props.notice.link;
  if (!link) return '';
  const page = PAGES[link.split(/[?#]/)[0]!];
  return page ? `Go to ${page}` : 'Open';
});
const when = computed(() => {
  void clock.value;
  return formatRelative(props.notice.time);
});
const fullTime = computed(() => new Date(props.notice.time).toLocaleString());
</script>

<template>
  <article class="notice" :class="[notice.level, { dismissed: notice.dismissed }]">
    <span class="icon" :title="level.label">
      <component :is="level.icon" :size="18" aria-hidden="true" />
      <span class="visually-hidden">{{ level.label }}:</span>
    </span>
    <div class="body">
      <div class="title-row">
        <h3 class="title">{{ notice.title }}</h3>
        <button v-if="!notice.dismissed" class="btn ghost small dismiss" :aria-label="`Dismiss “${notice.title}”`" title="Dismiss" @click="emit('dismiss')">
          <X :size="15" />
        </button>
      </div>
      <p v-if="notice.message && notice.message !== notice.title" class="message small" :title="notice.message">{{ notice.message }}</p>
      <div class="meta small muted">
        <time :datetime="notice.time" :title="fullTime">{{ when }}</time>
        <span v-if="notice.source === 'truenas'">· from TrueNAS</span>
        <span v-if="notice.level === 'critical'" class="badge err" aria-hidden="true">Urgent</span>
        <span class="spacer" />
        <RouterLink v-if="notice.link" :to="notice.link" class="go" @click="emit('navigate')">{{ linkLabel }}</RouterLink>
      </div>
    </div>
  </article>
</template>

<style scoped>
.notice {
  display: flex;
  gap: 10px;
  padding: 12px 12px 12px 10px;
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--border);
  background: var(--surface);
}
.notice.info {
  border-left-color: var(--info);
}
.notice.warning {
  border-left-color: var(--warn);
}
.notice.error,
.notice.critical {
  border-left-color: var(--err);
}
.notice.critical {
  background: var(--err-soft);
}
.notice.dismissed {
  opacity: 0.7;
  border-left-color: var(--border);
}
.icon {
  flex: none;
  padding-top: 1px;
}
.info .icon {
  color: var(--info);
}
.warning .icon {
  color: var(--warn);
}
.error .icon,
.critical .icon {
  color: var(--err);
}
.dismissed .icon {
  color: var(--text-muted);
}
.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.title-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.title {
  flex: 1;
  font-size: 0.93rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.dismiss {
  flex: none;
  padding: 2px 4px;
  margin: -2px -4px 0 0;
  color: var(--text-muted);
}
.message {
  color: var(--text);
  overflow-wrap: anywhere;
  white-space: pre-line;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.go {
  font-weight: 600;
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
