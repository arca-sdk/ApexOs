import { computed, ref, watch } from 'vue';
import type { Task, TaskStarted } from '@apexos/api-types';
import { ApiError } from '../../lib/api.ts';
import { live } from '../../lib/events.ts';
import { pollRunningTask } from './taskPoll.ts';

/**
 * Starts a server task from a dialog and follows it live, so the dialog can show progress,
 * close itself on success, or show the error (and API error code/fields) on failure.
 */
export function useTaskRunner(onSuccess: (task: Task) => void) {
  const started = ref<Task | null>(null);
  const starting = ref(false);
  const error = ref<string | null>(null);
  const code = ref<string | null>(null);
  const fieldErrors = ref<Record<string, string>>({});

  const task = computed<Task | null>(() => (started.value ? (live.tasks[started.value.id] ?? started.value) : null));
  pollRunningTask(() => started.value?.id);
  const running = computed(() => starting.value || task.value?.status === 'running');

  watch(
    () => task.value?.status,
    (status) => {
      const t = task.value;
      if (!t) return;
      if (status === 'success') {
        started.value = null;
        onSuccess(t);
      } else if (status === 'failed') {
        error.value = t.error ?? 'Something went wrong.';
        started.value = null;
      }
    },
  );

  async function start(request: Promise<TaskStarted>): Promise<void> {
    error.value = null;
    code.value = null;
    fieldErrors.value = {};
    starting.value = true;
    try {
      const { task: t } = await request;
      started.value = t;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      if (e instanceof ApiError) {
        code.value = e.code;
        fieldErrors.value = e.fields;
      }
    } finally {
      starting.value = false;
    }
  }

  return { task, running, error, code, fieldErrors, start };
}
