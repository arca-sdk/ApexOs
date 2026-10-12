import { onBeforeUnmount, onMounted } from 'vue';
import type { Task } from '@hearth/api-types';
import { api } from '../../lib/api.ts';
import { live } from '../../lib/events.ts';

/**
 * Safety net for the live event stream: while the task returned by `getId` is running, poll
 * GET /api/tasks every few seconds and feed the result into `live.tasks`. The stream can die
 * silently (e.g. the server restarted behind a proxy that keeps the browser side open), and a
 * progress view or dialog must never wait forever for a task that already finished.
 */
export function pollRunningTask(getId: () => string | null | undefined, everyMs = 3000): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  const tick = async () => {
    const id = getId();
    if (!id || busy) return;
    const known = live.tasks[id];
    if (known && known.status !== 'running') return;
    busy = true;
    try {
      const found = (await api.get<Task[]>('/tasks')).find((t) => t.id === id);
      // Only move forward: never replace a newer live update with an older snapshot.
      const current = live.tasks[id];
      if (found && (!current || current.status === 'running')) live.tasks[id] = found;
    } catch {
      // Server unreachable; try again on the next tick.
    } finally {
      busy = false;
    }
  };
  onMounted(() => (timer = setInterval(tick, everyMs)));
  onBeforeUnmount(() => clearInterval(timer));
}
