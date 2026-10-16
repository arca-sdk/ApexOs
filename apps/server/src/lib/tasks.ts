import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { UserError } from './errors.ts';

export type TaskStatus = 'running' | 'success' | 'failed';

export interface TaskStep {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  progress: number;
  message?: string;
}

export interface Task {
  id: string;
  type: string;
  title: string;
  status: TaskStatus;
  progress: number;
  message?: string;
  error?: string;
  steps: TaskStep[];
  startedAt: string;
  finishedAt?: string;
  /** Optional reference to the thing the task acts on (app id, folder name, ...). */
  ref?: string;
}

export interface TaskContext {
  /** Report overall progress (0-100) and an optional status line. */
  progress(percent: number, message?: string): void;
  /** Run a named step; steps are shown to the user as a checklist. */
  step<T>(name: string, fn: (report: (percent: number, message?: string) => void) => Promise<T>): Promise<T>;
  skip(name: string, message?: string): void;
}

const KEEP_FINISHED = 50;

/**
 * Tracks long-running operations so the UI can show progress and survive page reloads.
 * Emits `task` with the full task object on every change.
 */
export class TaskManager extends EventEmitter {
  private tasks = new Map<string, Task>();
  /** Ids of running `exclusive` tasks. */
  private exclusive = new Set<string>();

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  findRunning(type: string, ref?: string): Task | undefined {
    return this.list().find((t) => t.status === 'running' && t.type === type && (ref === undefined || t.ref === ref));
  }

  /**
   * Starts `fn` in the background and returns the task immediately.
   * `stepNames` pre-populates the checklist so the UI can show what is coming.
   * An `exclusive` task runs alone: nothing else starts until it ends, including requests that were already
   * past their own checks when it began.
   */
  start(
    opts: { type: string; title: string; ref?: string; steps?: string[]; exclusive?: boolean },
    fn: (ctx: TaskContext) => Promise<void>,
  ): Task {
    const alone = [...this.exclusive].map((id) => this.tasks.get(id)).find((t) => t?.status === 'running');
    if (alone) throw new UserError(`Wait until “${alone.title}” has finished.`, 409, 'BUSY');
    const task: Task = {
      id: randomUUID(),
      type: opts.type,
      title: opts.title,
      ref: opts.ref,
      status: 'running',
      progress: 0,
      steps: (opts.steps ?? []).map((name) => ({ name, status: 'pending', progress: 0 })),
      startedAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);
    if (opts.exclusive) this.exclusive.add(task.id);
    this.emitTask(task);

    const ensureStep = (name: string): TaskStep => {
      let step = task.steps.find((s) => s.name === name);
      if (!step) {
        step = { name, status: 'pending', progress: 0 };
        task.steps.push(step);
      }
      return step;
    };

    const recomputeProgress = () => {
      if (!task.steps.length) return;
      const total = task.steps.reduce((sum, s) => sum + (s.status === 'success' || s.status === 'skipped' ? 100 : s.progress), 0);
      task.progress = Math.round(total / task.steps.length);
    };

    const ctx: TaskContext = {
      progress: (percent, message) => {
        task.progress = clamp(percent);
        if (message !== undefined) task.message = message;
        this.emitTask(task);
      },
      step: async (name, stepFn) => {
        const step = ensureStep(name);
        step.status = 'running';
        task.message = name;
        this.emitTask(task);
        try {
          const result = await stepFn((percent, message) => {
            step.progress = clamp(percent);
            if (message !== undefined) step.message = message;
            recomputeProgress();
            this.emitTask(task);
          });
          step.status = 'success';
          step.progress = 100;
          recomputeProgress();
          this.emitTask(task);
          return result;
        } catch (err) {
          step.status = 'failed';
          step.message = errorMessage(err);
          this.emitTask(task);
          throw err;
        }
      },
      skip: (name, message) => {
        const step = ensureStep(name);
        step.status = 'skipped';
        step.message = message;
        recomputeProgress();
        this.emitTask(task);
      },
    };

    void fn(ctx).then(
      () => {
        task.status = 'success';
        task.progress = 100;
        task.message = undefined;
        this.finish(task);
      },
      (err) => {
        task.status = 'failed';
        task.error = errorMessage(err);
        this.finish(task);
      },
    );
    return task;
  }

  private finish(task: Task): void {
    task.finishedAt = new Date().toISOString();
    this.exclusive.delete(task.id);
    this.emitTask(task);
    const finished = this.list().filter((t) => t.status !== 'running');
    for (const old of finished.slice(KEEP_FINISHED)) this.tasks.delete(old.id);
  }

  private emitTask(task: Task): void {
    this.emit('task', structuredClone(task));
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'reason' in err && typeof err.reason === 'string' && err.reason) return err.reason;
  return err instanceof Error ? err.message : String(err);
}
