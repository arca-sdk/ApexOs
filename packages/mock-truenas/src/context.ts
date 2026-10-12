import type { RpcServer } from './rpc.ts';
import type { MockState } from './state.ts';

export interface MockConfig {
  apiKey: string;
  adminUsername: string;
  adminPassword: string;
  jobDelayMs: number;
  scenario: 'fresh' | 'configured';
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

  /** Primary LAN address (enp5s0). */
  get lanIp(): string {
    for (const i of this.state.network.interfaces) {
      const a = i.addresses[0];
      if (i.linkUp && a) return a.address;
    }
    return '127.0.0.1';
  }

  sleep(ms: number): Promise<void> {
    return this.closed ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
  }
}
