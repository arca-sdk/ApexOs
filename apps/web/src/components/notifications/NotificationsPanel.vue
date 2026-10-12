<script setup lang="ts">
/** Slide-over panel with two tabs: Notifications (notices) and Activity (server tasks). */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { BellOff, CheckCheck, ListChecks, X } from 'lucide-vue-next';
import PageState from '../PageState.vue';
import NoticeItem from './NoticeItem.vue';
import TaskItem from './TaskItem.vue';
import { activity, closeActivity, dismissAllNotices, dismissNotice, loadNotices, runningCount, sortedTasks, unreadCount, type ActivityTab } from './store.ts';

const panel = ref<HTMLElement>();
const showDismissed = ref(false);
const clearing = ref(false);
let returnFocus: HTMLElement | null = null;

const unread = computed(() => activity.notices.filter((n) => !n.dismissed));
const dismissed = computed(() => activity.notices.filter((n) => n.dismissed));
const running = computed(() => sortedTasks.value.filter((t) => t.status === 'running'));
const recent = computed(() => sortedTasks.value.filter((t) => t.status !== 'running').slice(0, 25));

const tabs: { id: ActivityTab; label: string }[] = [
  { id: 'notices', label: 'Notifications' },
  { id: 'activity', label: 'Activity' },
];

function selectTab(id: ActivityTab) {
  activity.tab = id;
}

function onTabKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const next = activity.tab === 'notices' ? 'activity' : 'notices';
  activity.tab = next;
  nextTick(() => panel.value?.querySelector<HTMLElement>(`#activity-tab-${next}`)?.focus());
}

/** Dismisses one notice and keeps keyboard focus in the list (next notice, or the tab). */
async function dismissAt(id: string, index: number) {
  const pending = dismissNotice(id);
  await nextTick();
  const buttons = panel.value?.querySelectorAll<HTMLElement>('#activity-panel-notices .list .dismiss') ?? [];
  (buttons[Math.min(index, buttons.length - 1)] ?? panel.value?.querySelector<HTMLElement>('#activity-tab-notices'))?.focus();
  await pending;
}

async function clearAll() {
  clearing.value = true;
  try {
    await dismissAllNotices();
  } finally {
    clearing.value = false;
    panel.value?.querySelector<HTMLElement>('#activity-tab-notices')?.focus();
  }
}

function focusables(): HTMLElement[] {
  return [...(panel.value?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeActivity();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = focusables();
  if (!items.length) return;
  const first = items[0]!;
  const last = items.at(-1)!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  returnFocus = document.activeElement as HTMLElement | null;
  void loadNotices();
  nextTick(() => panel.value?.querySelector<HTMLElement>(`#activity-tab-${activity.tab}`)?.focus());
});
onBeforeUnmount(() => returnFocus?.focus?.());
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @mousedown.self="closeActivity">
      <aside ref="panel" class="panel" role="dialog" aria-modal="true" aria-labelledby="activity-heading" @keydown="onKey">
        <header class="panel-header">
          <h2 id="activity-heading">Notifications &amp; activity</h2>
          <span class="spacer" />
          <button class="btn ghost small" aria-label="Close" @click="closeActivity"><X :size="18" /></button>
        </header>

        <div class="tabs" role="tablist" aria-label="Show">
          <button
            v-for="t in tabs"
            :id="`activity-tab-${t.id}`"
            :key="t.id"
            class="tab"
            role="tab"
            :aria-selected="activity.tab === t.id"
            :aria-controls="`activity-panel-${t.id}`"
            :tabindex="activity.tab === t.id ? 0 : -1"
            @click="selectTab(t.id)"
            @keydown="onTabKey"
          >
            {{ t.label }}
            <span v-if="t.id === 'notices' && unreadCount" class="count">{{ unreadCount }}</span>
            <span v-if="t.id === 'activity' && runningCount" class="count running"><span class="spin tiny" aria-hidden="true" />{{ runningCount }}</span>
          </button>
        </div>

        <section
          v-if="activity.tab === 'notices'"
          id="activity-panel-notices"
          class="tab-body"
          role="tabpanel"
          aria-labelledby="activity-tab-notices"
        >
          <p v-if="activity.error && activity.loaded" class="callout err small">{{ activity.error }}</p>
          <PageState :loading="!activity.loaded" :error="activity.loaded ? null : activity.error" @retry="loadNotices">
            <div v-if="unread.length" class="row list-head">
              <span class="small muted">{{ unread.length }} new</span>
              <span class="spacer" />
              <button class="btn ghost small" :disabled="clearing" @click="clearAll">
                <span v-if="clearing" class="spin tiny" /><CheckCheck v-else :size="15" /> Dismiss all
              </button>
            </div>
            <div v-else class="empty">
              <BellOff :size="28" aria-hidden="true" />
              <strong>You're all caught up</strong>
              <span class="small muted">Alerts from your server and results of finished jobs show up here.</span>
            </div>
            <ul class="list">
              <li v-for="(n, i) in unread" :key="n.id">
                <NoticeItem :notice="n" @dismiss="dismissAt(n.id, i)" @navigate="closeActivity" />
              </li>
            </ul>
            <div v-if="dismissed.length" class="older">
              <button class="btn ghost small" :aria-expanded="showDismissed" @click="showDismissed = !showDismissed">
                {{ showDismissed ? 'Hide' : 'Show' }} dismissed ({{ dismissed.length }})
              </button>
              <ul v-if="showDismissed" class="list">
                <li v-for="n in dismissed" :key="n.id">
                  <NoticeItem :notice="n" @navigate="closeActivity" />
                </li>
              </ul>
            </div>
          </PageState>
        </section>

        <section v-else id="activity-panel-activity" class="tab-body" role="tabpanel" aria-labelledby="activity-tab-activity">
          <div v-if="!sortedTasks.length" class="empty">
            <ListChecks :size="28" aria-hidden="true" />
            <strong>Nothing has happened yet</strong>
            <span class="small muted">Longer jobs, like installing an app or creating a pool, show their progress here.</span>
          </div>
          <template v-if="running.length">
            <h3 class="group">In progress</h3>
            <ul class="list">
              <li v-for="t in running" :key="t.id" class="task-card"><TaskItem :task="t" /></li>
            </ul>
          </template>
          <template v-if="recent.length">
            <h3 class="group">Recent</h3>
            <ul class="list">
              <li v-for="t in recent" :key="t.id" class="task-card"><TaskItem :task="t" /></li>
            </ul>
            <p class="small muted">Finished jobs are kept until the Hearth service restarts.</p>
          </template>
        </section>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgb(0 0 0 / 0.3);
  display: flex;
  justify-content: flex-end;
}
.panel {
  width: 440px;
  max-width: 100%;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 32px rgb(0 0 0 / 0.12);
  display: flex;
  flex-direction: column;
  animation: slide-in 0.16s ease-out;
}
@keyframes slide-in {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .panel {
    animation: none;
  }
}
.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 18px 10px 20px;
}
.panel-header h2 {
  font-size: 1.1rem;
}
.tabs {
  display: flex;
  gap: 4px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}
.tab {
  appearance: none;
  background: none;
  border: none;
  font: inherit;
  font-weight: 600;
  color: var(--text-muted);
  padding: 10px 10px 9px;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tab[aria-selected='true'] {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  border-radius: 4px;
}
.count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 20px;
  justify-content: center;
  font-size: 0.75rem;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.count.running {
  background: var(--info-soft);
  color: var(--info);
}
.tab-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.list-head {
  --gap: 8px;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.list > li {
  box-shadow: var(--shadow);
  border-radius: var(--radius-sm);
}
.task-card {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 12px;
}
.group {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin-top: 4px;
}
.older {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.older .list {
  width: 100%;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 36px 16px;
  color: var(--text-muted);
}
.empty strong {
  color: var(--text);
}
.tiny {
  width: 12px;
  height: 12px;
}
</style>
