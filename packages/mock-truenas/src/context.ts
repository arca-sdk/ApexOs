import { primaryAddress, type NetworkSnapshot } from './network.ts';
import type { ServerResponse } from 'node:http';
import type { RpcServer } from './rpc.ts';
import type { MockState } from './state.ts';

export interface MockConfig {
  apiKey: string;
  adminUsername: string;
  adminPassword: string;
  jobDelayMs: number;
  scenario: 'fresh' | 'configured';
}

export interface CronJobState {
  id: number;
  enabled: boolean;
  stdout: boolean;
  stderr: boolean;
  schedule: { minute: string; hour: string; dom: string; month: string; dow: string };
  command: string;
  description: string;
  user: string;
}

/** Runtime data that is not persisted (scrub controls, tokens, boot time). */
export interface ScrubControl {
  stop: boolean;
}

/** Everything a namespace module needs: persistent state, the RPC server and runtime-only data. */
export class Mock {
  /** Simulated boot time; uptime counts from here (reset by system.reboot / update.run with reboot). */
  bootTime = Date.now();
  readonly scrubControls = new Map<number, ScrubControl>();
  readonly tokens = new Map<string, { username: string; expires: number; singleUse: boolean }>();
  /** Cron jobs (runtime only: ApexOs creates them temporarily). */
  readonly cronjobs = new Map<number, CronJobState>();
  nextCronId = 1;
  /**
   * Single-use `/_download/<job>` tokens (see download.ts). `serve` streams a job's output directly (file
   * downloads); otherwise the collected output or the job log is served.
   */
  readonly downloads = new Map<string, { jobId: number; expires: number; filename?: string; serve?: (res: ServerResponse) => void }>();
  /** What `core.download` jobs wrote to their output pipe, until it is downloaded. */
  readonly downloadOutputs = new Map<number, { text: string }>();
  /** Mail the middleware would have sent (e.g. cron output to the run-as user's address). */
  readonly mailLog: { to: string; subject: string; text: string }[] = [];
  /** Interface changes in flight (in memory only, like the middleware's copy of its network tables). */
  readonly network: {
    /** Taken by the first staged change; restored by a rollback, dropped by a check-in. */
    snapshot: NetworkSnapshot | null;
    rollbackTimer?: NodeJS.Timeout;
    /** When the pending rollback fires (ms since epoch). */
    rollbackAt: number;
    /** Test hook: the next commit cuts clients off until the change is rolled back. */
    cutNextCommit: boolean;
  } = { snapshot: null, rollbackAt: 0, cutNextCommit: false };

  constructor(
    public state: MockState,
    readonly server: RpcServer,
    readonly config: MockConfig,
  ) {}

  get closed(): boolean {
    return this.server.closed;
  }

  emit(collection: string, msg: 'added' | 'changed' | 'removed', id: unknown, fields?: unknown): void {
    this.server.emit(collection, msg, id, fields);
  }

  nextTxg(): number {
    this.state.txg += 1;
    return this.state.txg;
  }

  /** Primary LAN address (enp5s0 unless its address was changed). */
  get lanIp(): string {
    return primaryAddress(this.state.network);
  }

  sleep(ms: number): Promise<void> {
    return this.closed ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
  }
}
