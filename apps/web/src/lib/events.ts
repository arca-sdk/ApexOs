import { onBeforeUnmount, reactive, shallowRef } from 'vue';
import type { ChangeTopic, MetricsSample, Task } from '@hearth/api-types';

export type { Task };

/** Number of metric samples kept for live charts (2 s apart → 2 minutes). */
const HISTORY = 60;

/** Live view of server-side tasks and metrics, kept up to date over Server-Sent Events. */
export const live = reactive({
  connected: false,
  tasks: {} as Record<string, Task>,
});

/** Latest metrics samples, oldest first. */
export const metrics = shallowRef<MetricsSample[]>([]);

type Listener = (topic: ChangeTopic) => void;
const listeners = new Set<Listener>();
let source: EventSource | undefined;
let wanted = false;
let retryDelay = 1_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setInterval> | undefined;
let lastMessage = 0;

/** The server sends a `ping` every 15 s; silence for this long means the connection is dead. */
const STALE_AFTER_MS = 40_000;

function open(): void {
  source?.close();
  const es = new EventSource('/api/events');
  source = es;
  lastMessage = Date.now();
  const seen = () => {
    lastMessage = Date.now();
    if (!live.connected) {
      live.connected = true;
      retryDelay = 1_000;
      // Anything may have changed while we were away.
      for (const l of listeners) for (const topic of ['storage', 'folders', 'users', 'apps', 'alerts', 'locations', 'system'] as const) l(topic);
    }
  };
  es.addEventListener('open', seen);
  es.addEventListener('ping', seen);
  es.addEventListener('error', () => {
    live.connected = false;
    // The browser retries on its own unless the stream was closed for good (e.g. an error response).
    if (es.readyState === EventSource.CLOSED) scheduleReconnect();
  });
  es.addEventListener('task', (ev) => {
    seen();
    const task = JSON.parse((ev as MessageEvent).data) as Task;
    live.tasks[task.id] = task;
  });
  es.addEventListener('tasks', (ev) => {
    seen();
    const tasks = JSON.parse((ev as MessageEvent).data) as Task[];
    live.tasks = Object.fromEntries(tasks.map((t) => [t.id, t]));
  });
  es.addEventListener('changed', (ev) => {
    seen();
    const { topic } = JSON.parse((ev as MessageEvent).data) as { topic: ChangeTopic };
    for (const l of listeners) l(topic);
  });
  es.addEventListener('metrics', (ev) => {
    seen();
    const sample = JSON.parse((ev as MessageEvent).data) as MetricsSample;
    metrics.value = [...metrics.value.slice(-(HISTORY - 1)), sample];
  });
}

function scheduleReconnect(): void {
  if (!wanted || retryTimer) return;
  source?.close();
  source = undefined;
  live.connected = false;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (wanted) open();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30_000);
}

export function connectEvents(): void {
  if (wanted) return;
  wanted = true;
  open();
  watchdog = setInterval(() => {
    if (Date.now() - lastMessage > STALE_AFTER_MS) scheduleReconnect();
  }, 5_000);
}

export function disconnectEvents(): void {
  wanted = false;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  clearInterval(watchdog);
  source?.close();
  source = undefined;
  live.connected = false;
}

/** Calls `fn` whenever the server reports a change to one of `topics` (for the lifetime of the component). */
export function onServerChange(topics: ChangeTopic[], fn: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener: Listener = (topic) => {
    if (!topics.includes(topic)) return;
    clearTimeout(timer);
    timer = setTimeout(fn, 150);
  };
  listeners.add(listener);
  onBeforeUnmount(() => {
    clearTimeout(timer);
    listeners.delete(listener);
  });
}

/** Resolves when the task finishes; rejects with the task error if it failed. */
export function waitForTask(id: string): Promise<Task> {
  return new Promise((resolve, reject) => {
    let polls = 0;
    const settle = (t: Task | undefined) => {
      if (!t || t.status === 'running') return false;
      clearInterval(timer);
      if (t.status === 'success') resolve(t);
      else reject(new Error(t.error ?? 'Task failed'));
      return true;
    };
    const check = async () => {
      if (settle(live.tasks[id])) return;
      // If the live connection is down, ask the server directly every few seconds.
      if (!live.connected && ++polls % 8 === 0) {
        try {
          const res = await fetch('/api/tasks', { credentials: 'same-origin' });
          if (res.ok) {
            const task = ((await res.json()) as Task[]).find((t) => t.id === id);
            if (task) live.tasks[id] = task;
            settle(task);
          }
        } catch {
          // Server unreachable; keep waiting.
        }
      }
    };
    const timer = setInterval(check, 250);
    void check();
  });
}
