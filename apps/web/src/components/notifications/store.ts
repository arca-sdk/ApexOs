import { computed, reactive, ref } from 'vue';
import type { Notice, Task } from '@apexos/api-types';
import { ApiError, api } from '../../lib/api.ts';
import { live } from '../../lib/events.ts';

export type ActivityTab = 'notices' | 'activity';

/** Shared state for the notification bell, the Activity panel and the dashboard Activity card. */
export const activity = reactive({
  open: false,
  tab: 'notices' as ActivityTab,
  notices: [] as Notice[],
  loaded: false,
  loading: false,
  error: '',
});

export const unreadCount = computed(() => activity.notices.filter((n) => !n.dismissed).length);

/** Tasks sorted for display: running first (newest first), then finished ones by finish time. */
export const sortedTasks = computed<Task[]>(() => {
  const all = Object.values(live.tasks);
  const running = all.filter((t) => t.status === 'running').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const done = all
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt));
  return [...running, ...done];
});

export const runningCount = computed(() => sortedTasks.value.filter((t) => t.status === 'running').length);

export function openActivity(tab: ActivityTab = 'notices'): void {
  activity.tab = tab;
  activity.open = true;
}

export function closeActivity(): void {
  activity.open = false;
}

let inflight: Promise<void> | null = null;

export function loadNotices(): Promise<void> {
  inflight ??= (async () => {
    activity.loading = true;
    try {
      const { notices } = await api.get<{ notices: Notice[] }>('/notifications');
      activity.notices = notices;
      activity.error = '';
      activity.loaded = true;
    } catch (e) {
      activity.error = e instanceof Error ? e.message : String(e);
    } finally {
      activity.loading = false;
      inflight = null;
    }
  })();
  return inflight;
}

function message(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

/** Marks one notice dismissed right away, then asks the server; restores it if that fails. */
export async function dismissNotice(id: string): Promise<void> {
  const n = activity.notices.find((x) => x.id === id);
  if (!n || n.dismissed) return;
  n.dismissed = true;
  try {
    await api.post(`/notifications/${encodeURIComponent(id)}/dismiss`);
  } catch (e) {
    n.dismissed = false;
    activity.error = `Couldn't dismiss that notification: ${message(e)}`;
  }
}

export async function dismissAllNotices(): Promise<void> {
  const before = activity.notices.filter((n) => !n.dismissed);
  for (const n of before) n.dismissed = true;
  try {
    await api.post('/notifications/dismiss-all');
  } catch (e) {
    for (const n of before) n.dismissed = false;
    activity.error = `Couldn't dismiss notifications: ${message(e)}`;
  }
  await loadNotices();
}

/** A counter that ticks every 30 s, so relative times ("5 min ago") stay fresh. */
export const clock = ref(Date.now());
let ticking = false;
export function startClock(): void {
  if (ticking) return;
  ticking = true;
  setInterval(() => (clock.value = Date.now()), 30_000);
}
