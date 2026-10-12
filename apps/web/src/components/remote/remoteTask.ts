import { computed, ref } from 'vue';
import type { Task, TaskStarted } from '@apexos/api-types';
import { live, waitForTask } from '../../lib/events.ts';

/**
 * Tracks the turn-on / turn-off task of one remote access method (`ref` is the task's ref, e.g.
 * "Tailscale"). Also picks up a task that was already running when the page was opened.
 */
export function useRemoteTask(taskRef: string, onFinished: () => void) {
  const startedId = ref<string | null>(null);
  const error = ref<string | null>(null);

  const task = computed<Task | undefined>(() => {
    const started = startedId.value ? live.tasks[startedId.value] : undefined;
    if (started?.status === 'running') return started;
    return Object.values(live.tasks).find((t) => t.status === 'running' && (t.type === 'remote-enable' || t.type === 'remote-disable') && t.ref === taskRef);
  });

  async function follow(start: Promise<TaskStarted>): Promise<void> {
    error.value = null;
    const { task: started } = await start;
    startedId.value = started.id;
    live.tasks[started.id] ??= started;
    try {
      await waitForTask(started.id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      onFinished();
    }
  }

  return { task, error, follow };
}
