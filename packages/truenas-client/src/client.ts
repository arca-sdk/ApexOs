import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export type JobState = 'WAITING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'ABORTED';

export interface JobProgress {
  percent: number | null;
  description: string | null;
  extra?: unknown;
}

export interface Job<T = unknown> {
  id: number;
  method: string;
  arguments?: unknown[];
  state: JobState;
  progress: JobProgress;
  result: T | null;
  error: string | null;
  exception?: string | null;
  exc_info?: { type?: string; errno?: number; extra?: unknown; repr?: string } | null;
  time_started?: unknown;
  time_finished?: unknown;
}

export interface CollectionUpdate<T = unknown> {
  msg: 'added' | 'changed' | 'removed';
  collection: string;
  id?: number | string;
  fields?: T;
}

/** Per-field validation error reported by the middleware: [attribute, message, errno]. */
export type ValidationExtra = [string, string, number];

export class TrueNasError extends Error {
  readonly code: number;
  readonly errname?: string;
  readonly reason?: string;
  readonly extra?: unknown;
  readonly method?: string;

  constructor(message: string, opts: { code?: number; errname?: string; reason?: string; extra?: unknown; method?: string } = {}) {
    super(message);
    this.name = 'TrueNasError';
    this.code = opts.code ?? -1;
    this.errname = opts.errname;
    this.reason = opts.reason;
    this.extra = opts.extra;
    this.method = opts.method;
  }

  /** Validation errors as `{ attribute: message }` when the middleware returned them. */
  get validationErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.extra)) {
      for (const item of this.extra) {
        if (Array.isArray(item) && typeof item[0] === 'string') out[item[0]] = String(item[1]);
      }
    }
    return out;
  }
}

export class TrueNasConnectionError extends TrueNasError {
  constructor(message: string) {
    super(message, { code: -2 });
    this.name = 'TrueNasConnectionError';
  }
}

export type TrueNasAuth =
  | { type: 'apiKey'; apiKey: string; username?: string }
  | { type: 'password'; username: string; password: string };

export interface TrueNasClientOptions {
  /** e.g. `wss://nas.local/api/current` */
  url: string;
  auth: TrueNasAuth;
  /** TrueNAS ships with a self-signed certificate, so this defaults to false. */
  rejectUnauthorized?: boolean;
  callTimeoutMs?: number;
  /** Reconnect automatically after an established connection drops. */
  reconnect?: boolean;
  pingIntervalMs?: number;
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

interface JobWaiter {
  resolve: (job: Job) => void;
  onProgress?: (job: Job) => void;
}

const FINAL_JOB_STATES: ReadonlySet<JobState> = new Set(['SUCCESS', 'FAILED', 'ABORTED']);
const RECENT_JOB_LIMIT = 200;

/**
 * Minimal JSON-RPC 2.0 client for the TrueNAS SCALE middleware websocket API.
 *
 * Events:
 * - `connected` / `disconnected` / `reconnecting`
 * - `collection_update` (CollectionUpdate) for every subscribed event
 * - `job` (Job) whenever a job changes state or progress
 */
export class TrueNasClient extends EventEmitter {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private subscriptions = new Map<string, Set<(update: CollectionUpdate) => void>>();
  private jobWaiters = new Map<number, JobWaiter[]>();
  private recentJobs = new Map<number, Job>();
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private closedByUser = false;
  private connecting?: Promise<void>;
  private ready = false;

  constructor(private readonly options: TrueNasClientOptions) {
    super();
  }

  get isConnected(): boolean {
    return this.ready;
  }

  get url(): string {
    return this.options.url;
  }

  connect(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.closedByUser = false;
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = undefined;
    this.ready = false;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
      });
    }
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.ready) await this.connect();
    return this.send<T>(method, params);
  }

  /** Calls a job-based method and resolves with the job result once it finishes. */
  async job<T = unknown>(method: string, params: unknown[] = [], onProgress?: (job: Job) => void): Promise<T> {
    const jobId = await this.call<number>(method, params);
    const job = await this.waitForJob(jobId, onProgress);
    if (job.state !== 'SUCCESS') {
      throw new TrueNasError(job.error ?? `Job ${method} ${job.state.toLowerCase()}`, {
        errname: job.exc_info?.type,
        extra: job.exc_info?.extra,
        method,
      });
    }
    return job.result as T;
  }

  async waitForJob(jobId: number, onProgress?: (job: Job) => void): Promise<Job> {
    const known = this.recentJobs.get(jobId);
    if (known && FINAL_JOB_STATES.has(known.state)) return known;

    const done = new Promise<Job>((resolve) => {
      const waiters = this.jobWaiters.get(jobId) ?? [];
      waiters.push({ resolve, onProgress });
      this.jobWaiters.set(jobId, waiters);
    });

    // The job may have finished before we started listening.
    const [current] = await this.call<Job[]>('core.get_jobs', [[['id', '=', jobId]]]);
    if (current) this.handleJob(current);
    return done;
  }

  /** Subscribe to a middleware event (e.g. `alert.list`, `app.query`). Returns an unsubscribe function. */
  async subscribe<T = unknown>(event: string, handler: (update: CollectionUpdate<T>) => void): Promise<() => void> {
    let handlers = this.subscriptions.get(event);
    const isNew = !handlers;
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(event, handlers);
    }
    handlers.add(handler as (update: CollectionUpdate) => void);
    if (isNew && this.ready) await this.send('core.subscribe', [event]);
    return () => {
      handlers.delete(handler as (update: CollectionUpdate) => void);
    };
  }

  private async open(): Promise<void> {
    assertSecureTransport(this.options.url);
    const ws = new WebSocket(this.options.url, {
      rejectUnauthorized: this.options.rejectUnauthorized ?? false,
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(new TrueNasConnectionError(`Cannot connect to TrueNAS at ${this.options.url}: ${err.message}`));
      };
      const onOpen = () => {
        ws.off('error', onError);
        resolve();
      };
      ws.once('error', onError);
      ws.once('open', onOpen);
    });

    ws.on('message', (data) => this.handleMessage(data.toString()));
    ws.on('error', (err) => this.emit('socket_error', err));
    ws.on('close', () => this.handleClose(ws));

    try {
      await this.authenticate();
      await this.send('core.subscribe', ['core.get_jobs']);
      for (const event of this.subscriptions.keys()) await this.send('core.subscribe', [event]);
    } catch (err) {
      this.closedByUser = true;
      ws.close();
      throw err;
    }

    this.ready = true;
    const pingInterval = this.options.pingIntervalMs ?? 30_000;
    if (pingInterval > 0) {
      this.pingTimer = setInterval(() => {
        this.send('core.ping').catch(() => undefined);
      }, pingInterval);
      this.pingTimer.unref();
    }
    this.emit('connected');
  }

  private async authenticate(): Promise<void> {
    const { auth } = this.options;
    if (auth.type === 'apiKey') {
      const ok = await this.send<boolean>('auth.login_with_api_key', [auth.apiKey]);
      if (!ok) throw new TrueNasError('TrueNAS rejected the API key (it may have been revoked or deleted)', { errname: 'EACCES' });
      return;
    }
    const res = await this.send<{ response_type: string }>('auth.login_ex', [
      { mechanism: 'PASSWORD_PLAIN', username: auth.username, password: auth.password },
    ]);
    if (res?.response_type === 'OTP_REQUIRED') {
      throw new TrueNasError('This TrueNAS account uses two-factor authentication; create an API key instead', { errname: 'EOTP' });
    }
    if (res?.response_type !== 'SUCCESS') {
      throw new TrueNasError('TrueNAS rejected the username or password', { errname: 'EACCES' });
    }
  }

  private send<T>(method: string, params: unknown[] = []): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new TrueNasConnectionError('Not connected to TrueNAS'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const call: PendingCall = { method, resolve: resolve as (v: unknown) => void, reject };
      const timeout = this.options.callTimeoutMs ?? 60_000;
      if (timeout > 0) {
        call.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new TrueNasError(`TrueNAS call ${method} timed out`, { errname: 'ETIMEDOUT', method }));
        }, timeout);
      }
      this.pending.set(id, call);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
      const call = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) {
        const data = msg.error.data ?? {};
        call.reject(
          new TrueNasError(data.reason ?? msg.error.message ?? 'TrueNAS error', {
            code: msg.error.code,
            errname: data.errname,
            reason: data.reason,
            extra: data.extra,
            method: call.method,
          }),
        );
      } else {
        call.resolve(msg.result);
      }
      return;
    }

    if (msg.method === 'collection_update' && msg.params) {
      const update = msg.params as CollectionUpdate;
      if (update.collection === 'core.get_jobs' && update.fields) {
        this.handleJob({ id: update.id, ...(update.fields as object) } as Job);
      }
      this.emit('collection_update', update);
      for (const handler of this.subscriptions.get(update.collection) ?? []) handler(update);
    }
  }

  private handleJob(job: Job): void {
    const merged = { ...this.recentJobs.get(job.id), ...job } as Job;
    this.recentJobs.set(job.id, merged);
    if (this.recentJobs.size > RECENT_JOB_LIMIT) {
      const oldest = this.recentJobs.keys().next().value;
      if (oldest !== undefined) this.recentJobs.delete(oldest);
    }
    this.emit('job', merged);

    const waiters = this.jobWaiters.get(job.id);
    if (!waiters) return;
    if (FINAL_JOB_STATES.has(merged.state)) {
      this.jobWaiters.delete(job.id);
      for (const w of waiters) w.resolve(merged);
    } else {
      for (const w of waiters) w.onProgress?.(merged);
    }
  }

  private handleClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    const wasReady = this.ready;
    this.ready = false;
    this.ws = undefined;
    clearInterval(this.pingTimer);
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new TrueNasConnectionError(`Connection to TrueNAS closed during ${call.method}`));
      this.pending.delete(id);
    }
    if (wasReady) this.emit('disconnected');
    if (!this.closedByUser && wasReady && this.options.reconnect !== false) this.scheduleReconnect(1_000);
  }

  private scheduleReconnect(delayMs: number): void {
    this.emit('reconnecting', delayMs);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => this.scheduleReconnect(Math.min(delayMs * 2, 30_000)));
    }, delayMs);
    this.reconnectTimer.unref();
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * TrueNAS revokes an API key the first time it is presented over plain HTTP/WS from a
 * non-loopback address, so refuse to even try.
 */
export function assertSecureTransport(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol === 'ws:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new TrueNasConnectionError(
      `Refusing to connect to ${parsed.host} without TLS: TrueNAS revokes API keys used over plain ws://. Use wss:// instead.`,
    );
  }
}
