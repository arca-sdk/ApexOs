import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import {
  apiBaseUrl,
  resolveApiUrl,
  TrueNasClient,
  TrueNasConnectionError,
  type CollectionUpdate,
  type TrueNasClientOptions,
} from '@apexos/truenas-client';

/**
 * Normalizes user input like `nas.local`, `192.168.1.20:8443` or `https://nas.local/ui` into the
 * server's HTTPS base URL. Plain HTTP is never used (TrueNAS revokes API keys sent without TLS).
 */
export function toBaseUrl(host: string): string {
  let input = host.trim();
  if (!input) throw new Error('Enter the server address');
  if (!/^[a-z]+:\/\//i.test(input)) input = `https://${input}`;
  const url = new URL(input);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'https:') throw new Error('Use an https:// address (or just the IP / hostname)');
  return `${url.protocol}//${url.host}`;
}

/** Logs in with the TrueNAS admin password once and creates a dedicated API key for ApexOs. */
export async function createApiKeyWithPassword(apiUrl: string, username: string, password: string): Promise<string> {
  const client = new TrueNasClient({ url: apiUrl, auth: { type: 'password', username, password }, reconnect: false, pingIntervalMs: 0 });
  try {
    await client.connect();
    const created = await client.call<{ key: string }>('api_key.create', [
      { name: `apexos-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`, username, expires_at: null },
    ]);
    return created.key;
  } finally {
    await client.close();
  }
}

export { resolveApiUrl };

/** Picks the API version again before every (re)connect, since a TrueNAS update adds newer ones (see `pickApiVersion`). */
const refreshApiUrl = (url: string) => resolveApiUrl(apiBaseUrl(url));

/** Events re-emitted from the middleware so the rest of the server can react to changes. */
export const WATCHED_EVENTS = [
  'pool.query',
  'zfs.pool.scan',
  'pool.dataset.query',
  'disk.query',
  'app.query',
  'docker.state',
  'alert.list',
  'user.query',
  'sharing.smb.query',
  'reporting.realtime:{"interval":2}',
  'app.stats:{"interval":2}',
];

/**
 * Owns the single connection to TrueNAS. Services ask for `client()` and the
 * manager takes care of (re)connecting and re-subscribing.
 *
 * Emits `status` (connected: boolean) and `update` (CollectionUpdate).
 */
type ConnectionOptions = Pick<TrueNasClientOptions, 'url' | 'auth' | 'rejectUnauthorized'>;

export class TrueNasManager extends EventEmitter {
  private current?: TrueNasClient;
  private options?: ConnectionOptions;

  get configured(): boolean {
    return this.current !== undefined;
  }

  get connected(): boolean {
    return this.current?.isConnected ?? false;
  }

  /** Websocket URL of the active connection. */
  get url(): string | undefined {
    return this.current?.url ?? this.options?.url;
  }

  /** Connects with new credentials; only replaces the active client if the connection succeeds. */
  async configure(options: ConnectionOptions): Promise<void> {
    const next = new TrueNasClient({ ...options, reconnect: true, resolveUrl: refreshApiUrl });
    await next.connect();
    const previous = this.current;
    this.options = options;
    this.attach(next);
    await previous?.close();
    await this.watch(next);
  }

  /**
   * Opens a fresh connection to `url` with the current credentials (e.g. after the server's address
   * changed) and makes it the active one. The current connection stays in place if this fails.
   */
  async connectTo(url: string): Promise<void> {
    if (!this.options) throw new TrueNasConnectionError('ApexOs is not connected to TrueNAS yet');
    await this.configure({ ...this.options, url });
  }

  /** Configures without failing if TrueNAS is down; the client keeps retrying in the background. */
  async configureLazy(options: ConnectionOptions): Promise<void> {
    const next = new TrueNasClient({ ...options, reconnect: true, resolveUrl: refreshApiUrl });
    this.options = options;
    this.attach(next);
    try {
      await next.connect();
      await this.watch(next);
    } catch {
      this.scheduleRetry(next);
    }
  }

  async reconnect(): Promise<boolean> {
    if (!this.current) return false;
    try {
      await this.current.connect();
      await this.watch(this.current);
      return true;
    } catch {
      return false;
    }
  }

  client(): TrueNasClient {
    if (!this.current) throw new TrueNasConnectionError('ApexOs is not connected to TrueNAS yet');
    return this.current;
  }

  async close(): Promise<void> {
    await this.current?.close();
    this.current = undefined;
  }

  private attach(client: TrueNasClient): void {
    this.current?.removeAllListeners();
    this.current = client;
    client.on('connected', () => this.emit('status', true));
    client.on('disconnected', () => this.emit('status', false));
    client.on('socket_error', () => undefined);
    client.on('collection_update', (update: CollectionUpdate) => this.emit('update', update));
  }

  private async watch(client: TrueNasClient): Promise<void> {
    for (const event of WATCHED_EVENTS) {
      await client.subscribe(event, () => undefined).catch(() => undefined);
    }
    this.emit('status', true);
  }

  private scheduleRetry(client: TrueNasClient): void {
    const timer = setTimeout(async () => {
      if (this.current !== client) return;
      try {
        await client.connect();
        await this.watch(client);
      } catch {
        this.scheduleRetry(client);
      }
    }, 5_000);
    timer.unref();
  }
}
