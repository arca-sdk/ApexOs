import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATE_VERSION, type MockState } from './state.ts';
import { diskById } from './storage.ts';

/** Debounced, atomic (write + rename) JSON persistence of `MockState`. */
export class StateStore {
  private timer?: NodeJS.Timeout;
  private lastSaved?: string;
  private disposed = false;

  constructor(
    readonly file: string,
    private readonly debounceMs = 100,
  ) {}

  /** Loads a previously saved state; null when missing, unreadable or from another schema version. */
  load(): MockState | null {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as MockState;
      if (parsed?.version !== STATE_VERSION) return null;
      this.lastSaved = raw;
      return parsed;
    } catch {
      return null;
    }
  }

  schedule(get: () => MockState): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.save(get());
    }, this.debounceMs);
    this.timer.unref();
  }

  save(state: MockState): void {
    if (this.disposed) return;
    const json = JSON.stringify(state);
    if (json === this.lastSaved) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, this.file);
    this.lastSaved = json;
  }

  /** Writes pending changes now and stops further saves. */
  close(state: MockState): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.save(state);
    this.disposed = true;
  }
}

/**
 * Settles operations that were in flight when the state was saved (their jobs died with the process):
 * resilvers complete, scrubs are canceled, expansions finish, deploying apps come up.
 */
export function normalizeLoadedState(state: MockState): void {
  const now = Date.now();
  for (const pool of state.pools) {
    if (pool.scan?.state === 'SCANNING') {
      if (pool.scan.function === 'RESILVER') Object.assign(pool.scan, { state: 'FINISHED', percentage: 100, end_time: now, total_secs_left: null });
      else Object.assign(pool.scan, { state: 'CANCELED', end_time: now, total_secs_left: null, pause: null });
    }
    if (pool.expand?.state === 'EXPANDING') Object.assign(pool.expand, { state: 'FINISHED', percentage: 100, end_time: now, total_secs_left: null });
    for (const cat of ['data', 'special', 'dedup', 'log', 'cache'] as const) {
      for (const vdev of pool.topology[cat]) {
        vdev.children = vdev.children.map((leaf) => {
          if (!leaf.replacing) return leaf;
          const old = diskById(state, leaf.disk);
          if (old) old.zfs_guid = null;
          return leaf.replacing;
        });
      }
    }
  }
  for (const app of state.apps) {
    if (app.state === 'DEPLOYING') app.state = 'RUNNING';
    if (app.state === 'STOPPING') app.state = 'STOPPED';
  }
  const d = state.docker;
  if (d.status === 'INITIALIZING' || d.status === 'PENDING') d.status = d.pool ? 'RUNNING' : 'UNCONFIGURED';
  if (d.status === 'STOPPING') d.status = 'STOPPED';
}
