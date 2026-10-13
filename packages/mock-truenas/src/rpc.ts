import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

/** Error thrown by mock method handlers; mirrors the middleware's JSON-RPC error data. */
export class CallError extends Error {
  constructor(
    readonly errname: string,
    readonly reason: string,
    readonly extra: Array<[string, string, number]> | null = null,
    readonly errno = 22,
  ) {
    super(reason);
  }
}

/** Field validation error, like middleware's ValidationErrors. */
export function validationError(attribute: string, message: string): CallError {
  return new CallError('EINVAL', `[EINVAL] ${attribute}: ${message}`, [[attribute, message, 22]]);
}

/** Several field validation errors reported together. */
export function validationErrors(errors: Array<[attribute: string, message: string]>): CallError {
  return new CallError(
    'EINVAL',
    errors.map(([a, m]) => `[EINVAL] ${a}: ${m}`).join('\n'),
    errors.map(([a, m]) => [a, m, 22]),
  );
}

const ERRNO: Record<string, number> = {
  EPERM: 1,
  ENOENT: 2,
  EIO: 5,
  EACCES: 13,
  EFAULT: 14,
  EBUSY: 16,
  EEXIST: 17,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENOSPC: 28,
  ENOTEMPTY: 39,
  ENOTSUP: 95,
  ETIMEDOUT: 110,
};

/** A `CallError` whose reason has the `[ERRNAME] message` form produced by the middleware's `str(CallError)`. */
export function callError(errname: string, message: string, errno?: number): CallError {
  return new CallError(errname, `[${errname}] ${message}`, null, errno ?? ERRNO[errname] ?? 14);
}

export type JobState = 'WAITING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'ABORTED';

export interface MockJob {
  id: number;
  message_ids: Array<number | string>;
  method: string;
  arguments: unknown[];
  transient: boolean;
  description: string | null;
  abortable: boolean;
  logs_path: string | null;
  logs_excerpt: string | null;
  state: JobState;
  progress: { percent: number; description: string; extra: null };
  result: unknown;
  result_encoding_error: null;
  error: string | null;
  exception: string | null;
  exc_info: { type: string; extra: unknown; errno: number; repr: string } | null;
  time_started: { $date: number };
  time_finished: { $date: number } | null;
  credentials: { type: string; data: Record<string, unknown> } | null;
}

export interface JobControl {
  readonly id: number;
  progress(percent: number, description?: string): void;
  /** Appends text to the job's log file (jobs created with logs=True in the real middleware). */
  log(text: string): void;
  /** Simulated work; scaled by the server's `jobDelayMs`. Resolves immediately once the server is closed. */
  sleep(units?: number): Promise<void>;
  /** True once the server has been closed; long-running loops should stop. */
  readonly closed: boolean;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

/** TrueNAS keeps the first and last 10 lines of a job log as `logs_excerpt`. */
export function logsExcerpt(text: string): string {
  const lines = text.split(/(?<=\n)/);
  if (lines.length <= 20) return text;
  return `${lines.slice(0, 10).join('')}... ${lines.length - 20} more lines ...\n${lines.slice(-10).join('')}`;
}

export interface MethodContext {
  authenticated: boolean;
  /** Username of the authenticated session (null before login or for anonymous logins). */
  username: string | null;
  setAuthenticated(username?: string): void;
  logout(): void;
  /** Local address of the websocket connection (what `interface.websocket_local_ip` reports on a real box). */
  localAddress: string | null;
}

export type MethodHandler = (params: unknown[], ctx: MethodContext) => unknown;
export type JobHandler = (params: unknown[], job: JobControl) => Promise<unknown>;

/** Context handed to an event source instance (one per subscription). */
export interface EventSourceContext {
  /** Full subscription name, including any `:{json}` arguments. */
  name: string;
  args: Record<string, unknown>;
  /** Sends a `collection_update` to the subscribing client. */
  send(fields: unknown, msg?: 'added' | 'changed' | 'removed', id?: unknown): void;
}

/** Starts an event source for one subscription and returns a function that stops it. */
export type EventSourceFactory = (ctx: EventSourceContext) => () => void;

export interface RpcServerOptions {
  port?: number;
  host?: string;
  /** Delay per simulated job step, in ms. Use 0 in tests. */
  jobDelayMs?: number;
}

/** API versions served by a 25.10.7 box (`GET /api/versions`; v24.10 is served but not listed). */
export const API_VERSIONS = [
  'v25.04.0',
  'v25.04.1',
  'v25.04.2',
  'v25.10.0',
  'v25.10.1',
  'v25.10.2',
  'v25.10.3',
  'v25.10.4',
  'v25.10.5',
];
const WS_PATHS = new Set(['/api/current', '/api/v24.10', ...API_VERSIONS.map((v) => `/api/${v}`)]);

/**
 * Replies a 25.10.7 box can't send on an older API version: converting them for that version leaves an
 * internal "not set" marker in the reply, which then fails to encode (the method itself has already run).
 */
const LEGACY_REPLY_FAILURES = new Set(['interface.query', 'network.configuration.config', 'network.configuration.update']);

/** Only the newest version (also served as `current`) is answered without conversion. */
function isLegacyApi(version: string): boolean {
  return version !== 'current' && version !== API_VERSIONS.at(-1);
}

interface Subscription {
  name: string;
  stop?: () => void;
}

interface Client {
  ws: WebSocket;
  authenticated: boolean;
  username: string | null;
  subscriptions: Map<string, Subscription>;
  legacyJobs: boolean;
  localAddress: string | null;
  /** `current` or the `vXX.YY.Z` the client connected to. */
  apiVersion: string;
}

const UNAUTHENTICATED_METHODS = new Set([
  'auth.login',
  'auth.login_with_api_key',
  'auth.login_ex',
  'auth.login_with_token',
  'auth.mechanism_choices',
  'core.ping',
  'core.set_options',
  'system.ready',
  'system.boot_id',
]);

const FINAL_STATES: ReadonlySet<JobState> = new Set(['SUCCESS', 'FAILED', 'ABORTED']);
const MAX_JOBS = 1000;

/** JSON-RPC 2.0 websocket server shaped like the TrueNAS middleware `/api/current` endpoint. */
export class RpcServer {
  private methods = new Map<string, MethodHandler>();
  private jobMethods = new Set<string>();
  private eventSources = new Map<string, EventSourceFactory>();
  private jobs = new Map<number, MockJob>();
  private jobWaiters = new Map<number, Array<(job: MockJob) => void>>();
  private activityListeners = new Set<() => void>();
  private nextJobId = 1;
  private clients = new Set<Client>();
  private httpRoutes = new Map<string, HttpHandler>();
  /** Job logs by job id (`core.job_download_logs`). */
  readonly jobLogs = new Map<number, string>();
  private http?: Server;
  private wss?: WebSocketServer;
  private isClosed = false;
  private unreachable = false;
  readonly jobDelayMs: number;
  /** Changes on simulated reboots (`GET /api/boot_id`, `system.boot_id`). */
  bootId = randomUUID();
  port = 0;

  constructor(private readonly options: RpcServerOptions = {}) {
    this.jobDelayMs = options.jobDelayMs ?? 150;
    this.method('core.ping', () => 'pong');
    this.method('core.subscribe', () => undefined); // handled specially in dispatch
    this.method('core.unsubscribe', () => undefined); // handled specially in dispatch
    this.method('core.set_options', () => undefined); // handled specially in dispatch
    this.method('core.get_jobs', (params) => queryFilter([...this.jobs.values()], params[0], params[1]));
    this.method('core.job_abort', (params) => {
      const job = this.jobs.get(Number(params[0]));
      if (!job) throw callError('ENOENT', `Job ${String(params[0])} not found`);
      if (!job.abortable) throw callError('EINVAL', 'Job is not abortable');
      return null;
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** False while the simulated server can't be reached over the network. */
  get reachable(): boolean {
    return !this.unreachable;
  }

  /**
   * Simulates the server dropping off (false) or coming back on (true) the network. While it is
   * unreachable, connections are cut and new connections and HTTP requests fail.
   */
  setReachable(reachable: boolean): void {
    this.unreachable = !reachable;
    if (!reachable) this.dropConnections();
  }

  /** Cuts every websocket connection abruptly, as when the address clients connected to disappears. */
  dropConnections(): void {
    for (const c of this.clients) {
      stopAll(c);
      c.ws.terminate();
    }
    this.clients.clear();
  }

  getJob(id: number): MockJob | undefined {
    return this.jobs.get(id);
  }

  /** Serves `GET <prefix>...` over plain HTTP (e.g. `/_download/`). */
  httpRoute(prefix: string, handler: HttpHandler): void {
    this.httpRoutes.set(prefix, handler);
  }

  method(name: string, handler: MethodHandler): void {
    this.methods.set(name, handler);
  }

  /**
   * Registers a job-based method: the call returns a job id and the work runs in the background.
   * `validate` runs synchronously before the job is created (like pydantic argument validation),
   * so its errors come back as a normal JSON-RPC error instead of a failed job.
   */
  job(name: string, handler: JobHandler, validate?: (params: unknown[]) => void): void {
    this.jobMethods.add(name);
    this.methods.set(name, (params) => {
      validate?.(params);
      return this.startJob(name, params, handler);
    });
  }

  /** Registers an event source, subscribed to as `name` or `name:{json args}`. */
  eventSource(name: string, factory: EventSourceFactory): void {
    this.eventSources.set(name, factory);
  }

  /** Every registered method name with whether it is a job. */
  listMethods(): Array<{ name: string; job: boolean }> {
    return [...this.methods.keys()].sort().map((name) => ({ name, job: this.jobMethods.has(name) }));
  }

  /** Called after every method call and job state change (used for persistence). */
  onActivity(listener: () => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  private activity(): void {
    for (const l of this.activityListeners) l();
  }

  startJob(name: string, params: unknown[], handler: JobHandler, messageId?: number | string): number {
    const job: MockJob = {
      id: this.nextJobId++,
      message_ids: messageId === undefined ? [] : [messageId],
      method: name,
      arguments: params,
      transient: false,
      description: null,
      abortable: false,
      logs_path: null,
      logs_excerpt: null,
      state: 'WAITING',
      progress: { percent: 0, description: '', extra: null },
      result: null,
      result_encoding_error: null,
      error: null,
      exception: null,
      exc_info: null,
      time_started: { $date: Date.now() },
      time_finished: null,
      credentials: { type: 'LOGIN_PASSWORD', data: { username: 'truenas_admin' } },
    };
    this.jobs.set(job.id, job);
    this.pruneJobs();
    this.emit('core.get_jobs', 'added', job.id, job);

    const isClosed = () => this.isClosed;
    const control: JobControl = {
      id: job.id,
      progress: (percent, description = '') => {
        job.progress = { percent, description, extra: null };
        this.emit('core.get_jobs', 'changed', job.id, job);
        this.activity();
      },
      sleep: (units = 1) =>
        this.isClosed ? Promise.resolve() : new Promise((r) => setTimeout(r, this.jobDelayMs * units)),
      log: (text) => {
        job.logs_path = `/var/log/jobs/${job.id}.log`;
        this.jobLogs.set(job.id, (this.jobLogs.get(job.id) ?? '') + text);
      },
      get closed() {
        return isClosed();
      },
    };

    setImmediate(async () => {
      job.state = 'RUNNING';
      this.emit('core.get_jobs', 'changed', job.id, job);
      try {
        job.result = (await handler(params, control)) ?? null;
        job.state = 'SUCCESS';
        job.progress = { percent: 100, description: job.progress.description || 'Done', extra: null };
      } catch (err) {
        job.state = 'FAILED';
        const e = err instanceof CallError ? err : new CallError('EFAULT', (err as Error).message ?? String(err));
        job.error = e.reason;
        job.exception = `Traceback (most recent call last):\n  (simulated)\n${e.extra ? 'ValidationErrors' : 'CallError'}: ${e.reason}`;
        job.exc_info = { type: e.extra ? 'VALIDATION' : 'CallError', extra: e.extra, errno: e.errno, repr: e.reason };
      }
      job.time_finished = { $date: Date.now() };
      const logs = this.jobLogs.get(job.id);
      if (logs !== undefined) job.logs_excerpt = logsExcerpt(logs);
      this.emit('core.get_jobs', 'changed', job.id, job);
      const waiters = this.jobWaiters.get(job.id) ?? [];
      this.jobWaiters.delete(job.id);
      for (const w of waiters) w(job);
      this.activity();
    });
    return job.id;
  }

  /** Resolves once the job reaches a final state. */
  waitJob(id: number): Promise<MockJob> {
    const job = this.jobs.get(id);
    if (job && FINAL_STATES.has(job.state)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const list = this.jobWaiters.get(id) ?? [];
      list.push(resolve);
      this.jobWaiters.set(id, list);
    });
  }

  private pruneJobs(): void {
    if (this.jobs.size <= MAX_JOBS) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break;
      if (FINAL_STATES.has(job.state)) this.jobs.delete(id);
    }
  }

  /** Sends a collection_update notification to every client subscribed to `collection`. */
  emit(collection: string, msg: 'added' | 'changed' | 'removed', id: unknown, fields?: unknown): void {
    let payload: string | undefined;
    for (const client of this.clients) {
      if (!client.authenticated || !isSubscribed(client, collection)) continue;
      payload ??= JSON.stringify({ jsonrpc: '2.0', method: 'collection_update', params: { msg, collection, id, fields } });
      client.ws.send(payload);
    }
  }

  /** True when at least one authenticated client is subscribed to `collection`. */
  hasSubscribers(collection: string): boolean {
    for (const client of this.clients) if (client.authenticated && isSubscribed(client, collection)) return true;
    return false;
  }

  async listen(): Promise<string> {
    this.http = createServer((req, res) => {
      if (this.unreachable) {
        req.socket.destroy();
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/versions') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(API_VERSIONS));
      } else if (req.method === 'GET' && path === '/api/boot_id') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.bootId));
      } else {
        const route = [...this.httpRoutes.entries()].find(([prefix]) => path.startsWith(prefix));
        if (route) route[1](req, res, new URL(req.url ?? '/', 'http://localhost'));
        else res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      }
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (this.unreachable) {
        socket.destroy();
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!WS_PATHS.has(path)) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
    const host = this.options.host ?? '127.0.0.1';
    await new Promise<void>((resolve) => this.http!.listen(this.options.port ?? 0, host, resolve));
    this.port = (this.http.address() as AddressInfo).port;
    return `ws://${host}:${this.port}/api/current`;
  }

  async close(): Promise<void> {
    this.isClosed = true;
    for (const c of this.clients) {
      stopAll(c);
      c.ws.terminate();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: Client = {
      ws,
      authenticated: false,
      username: null,
      subscriptions: new Map(),
      legacyJobs: true,
      localAddress: req.socket.localAddress ?? null,
      apiVersion: new URL(req.url ?? '/', 'http://localhost').pathname.slice('/api/'.length),
    };
    this.clients.add(client);
    ws.on('close', () => {
      stopAll(client);
      this.clients.delete(client);
    });
    ws.on('message', (raw) => {
      void this.dispatch(client, raw.toString());
    });
  }

  private async dispatch(client: Client, raw: string): Promise<void> {
    const { ws } = client;
    let msg: { id?: number | string | null; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    if (Array.isArray(msg)) {
      ws.send(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch messages are not supported' } }),
      );
      return;
    }
    const reply = (body: object) => {
      if (msg.id === undefined || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
    };
    if (typeof msg.method !== 'string' || (msg.params !== undefined && !Array.isArray(msg.params))) {
      reply({ error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const method = msg.method;
    const params = Array.isArray(msg.params) ? (msg.params as unknown[]) : [];

    const handler = this.methods.get(method);
    if (!handler) {
      reply({
        error: {
          code: -32601,
          message: 'Method does not exist',
          data: { error: 22, errname: 'ENOMETHOD', reason: `Method ${method} not found`, extra: null, trace: null },
        },
      });
      return;
    }
    if (!client.authenticated && !UNAUTHENTICATED_METHODS.has(method)) {
      reply({
        error: {
          code: -32001,
          message: 'Not authenticated',
          data: { error: 13, errname: 'ENOTAUTHENTICATED', reason: 'Not authenticated', extra: null, trace: null },
        },
      });
      return;
    }

    try {
      if (method === 'core.subscribe') {
        reply({ result: this.subscribe(client, String(params[0] ?? '')) });
        return;
      }
      if (method === 'core.unsubscribe') {
        const sub = client.subscriptions.get(String(params[0]));
        sub?.stop?.();
        client.subscriptions.delete(String(params[0]));
        reply({ result: null });
        return;
      }
      if (method === 'core.set_options') {
        const opts = (params[0] ?? {}) as { legacy_jobs?: unknown };
        if (typeof opts.legacy_jobs === 'boolean') client.legacyJobs = opts.legacy_jobs;
        reply({ result: { legacy_jobs: client.legacyJobs, private_methods: false, py_exceptions: false } });
        return;
      }
      let result = await handler(params, {
        authenticated: client.authenticated,
        username: client.username,
        localAddress: client.localAddress,
        setAuthenticated: (username) => {
          client.authenticated = true;
          client.username = username ?? client.username;
        },
        logout: () => {
          client.authenticated = false;
          client.username = null;
          stopAll(client);
        },
      });
      if (this.jobMethods.has(method) && !client.legacyJobs && typeof result === 'number') {
        const job = this.jobs.get(result);
        job?.message_ids.push(msg.id ?? '');
        const done = await this.waitJob(result);
        if (done.state !== 'SUCCESS') {
          const extra = (done.exc_info?.extra ?? null) as Array<[string, string, number]> | null;
          throw new CallError(done.exc_info?.type === 'VALIDATION' ? 'EINVAL' : 'EFAULT', done.error ?? 'Job failed', extra, done.exc_info?.errno ?? 14);
        }
        result = done.result;
      }
      if (LEGACY_REPLY_FAILURES.has(method) && isLegacyApi(client.apiVersion)) {
        throw new CallError('EFAULT', 'Object of type _NotRequired is not JSON serializable', null, 14);
      }
      reply({ result: result ?? null });
    } catch (err) {
      const e = err instanceof CallError ? err : new CallError('EFAULT', (err as Error).message ?? String(err), null, 14);
      reply({
        error: {
          code: e.extra ? -32602 : -32001,
          message: e.extra ? 'Invalid params' : 'Method call error',
          data: {
            error: e.errno,
            errname: e.errname,
            reason: e.reason,
            extra: e.extra,
            trace: { class: e.extra ? 'ValidationErrors' : 'CallError', frames: [], formatted: e.reason, repr: e.reason },
          },
        },
      });
    } finally {
      this.activity();
    }
  }

  private subscribe(client: Client, name: string): string {
    if (!name) throw validationError('core.subscribe.event', 'Event name is required');
    const id = randomUUID();
    const colon = name.indexOf(':');
    const base = colon === -1 ? name : name.slice(0, colon);
    const factory = this.eventSources.get(base);
    if (!factory) {
      client.subscriptions.set(id, { name });
      return id;
    }
    let args: Record<string, unknown> = {};
    if (colon !== -1) {
      try {
        const parsed: unknown = JSON.parse(name.slice(colon + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        throw callError('EINVAL', `Invalid arguments for event source ${base}`);
      }
    }
    const stop = factory({
      name,
      args,
      send: (fields, msg = 'added', eventId) => {
        if (client.ws.readyState !== client.ws.OPEN) return;
        client.ws.send(
          JSON.stringify({ jsonrpc: '2.0', method: 'collection_update', params: { msg, collection: name, id: eventId, fields } }),
        );
      },
    });
    client.subscriptions.set(id, { name, stop });
    return id;
  }
}

function isSubscribed(client: Client, collection: string): boolean {
  for (const sub of client.subscriptions.values()) if (sub.name === collection) return true;
  return false;
}

function stopAll(client: Client): void {
  for (const sub of client.subscriptions.values()) sub.stop?.();
  client.subscriptions.clear();
}

// ---------------------------------------------------------------------------
// query-filters / query-options
// ---------------------------------------------------------------------------

type Filter = [string, string, unknown] | ['OR', unknown[]];

export function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === undefined || a === null) && (b === undefined || b === null)) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function lower(v: unknown): unknown {
  if (typeof v === 'string') return v.toLowerCase();
  if (Array.isArray(v)) return v.map(lower);
  return v;
}

function matches(item: unknown, filter: unknown): boolean {
  if (!Array.isArray(filter)) throw validationError('query-filters', 'Invalid filter');
  if (filter[0] === 'OR') {
    const alternatives = filter[1];
    if (!Array.isArray(alternatives)) throw validationError('query-filters', 'OR requires a list of filters');
    return alternatives.some((alt) =>
      Array.isArray(alt) && Array.isArray(alt[0]) ? (alt as unknown[]).every((f) => matches(item, f)) : matches(item, alt),
    );
  }
  if (filter[0] === 'AND') {
    const all = filter[1];
    return Array.isArray(all) && all.every((f) => matches(item, f));
  }
  const [field, rawOp, rawValue] = filter as [string, string, unknown];
  const caseInsensitive = typeof rawOp === 'string' && rawOp.length > 1 && rawOp.startsWith('C');
  const op = caseInsensitive ? rawOp.slice(1) : rawOp;
  let actual = getPath(item, field);
  let value = rawValue;
  if (caseInsensitive) {
    actual = lower(actual);
    value = lower(value);
  }
  switch (op) {
    case '=':
      return eq(actual, value);
    case '!=':
      return !eq(actual, value);
    case '>':
      return (actual as number) > (value as number);
    case '>=':
      return (actual as number) >= (value as number);
    case '<':
      return (actual as number) < (value as number);
    case '<=':
      return (actual as number) <= (value as number);
    case '~':
      return typeof actual === 'string' && new RegExp(String(value)).test(actual);
    case 'in':
      return Array.isArray(value) && value.some((v) => eq(v, actual));
    case 'nin':
      return Array.isArray(value) && !value.some((v) => eq(v, actual));
    case 'rin':
      return Array.isArray(actual) ? actual.some((v) => eq(v, value)) : typeof actual === 'string' && actual.includes(String(value));
    case 'rnin':
      return Array.isArray(actual) ? !actual.some((v) => eq(v, value)) : !(typeof actual === 'string' && actual.includes(String(value)));
    case '^':
      return typeof actual === 'string' && actual.startsWith(String(value));
    case '!^':
      return !(typeof actual === 'string' && actual.startsWith(String(value)));
    case '$':
      return typeof actual === 'string' && actual.endsWith(String(value));
    case '!$':
      return !(typeof actual === 'string' && actual.endsWith(String(value)));
    default:
      throw validationError('query-filters', `Unsupported filter operator ${String(rawOp)}`);
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = target;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (!next || typeof next !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

function select(item: unknown, fields: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (Array.isArray(f)) {
      const [src, rename] = f as [string, string];
      out[rename] = getPath(item, src);
    } else if (typeof f === 'string') {
      const v = getPath(item, f);
      if (v !== undefined) setPath(out, f, v);
    }
  }
  return out;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

/** Implements middleware `query-filters` / `query-options` (filters, select, order_by, offset, limit, count, get). */
export function queryFilter<T>(items: T[], filters?: unknown, options?: unknown): T | T[] | number {
  if (filters !== undefined && filters !== null && !Array.isArray(filters)) {
    throw validationError('query-filters', 'Input should be a valid list');
  }
  let out = items.filter((item) => (Array.isArray(filters) ? (filters as Filter[]).every((f) => matches(item, f)) : true));
  const opts = (options ?? {}) as {
    get?: boolean;
    count?: boolean;
    order_by?: string[];
    limit?: number;
    offset?: number;
    select?: unknown[];
  };
  if (opts.order_by?.length) {
    const keys = opts.order_by.map((raw) => {
      let key = raw.replace(/^nulls_(first|last):/, '');
      const desc = key.startsWith('-');
      if (desc) key = key.slice(1);
      return { key, desc };
    });
    out = [...out].sort((a, b) => {
      for (const { key, desc } of keys) {
        const c = compare(getPath(a, key), getPath(b, key));
        if (c !== 0) return desc ? -c : c;
      }
      return 0;
    });
  }
  if (opts.offset) out = out.slice(opts.offset);
  if (opts.limit) out = out.slice(0, opts.limit);
  if (opts.count) return out.length;
  const shaped = (opts.select?.length ? out.map((i) => select(i, opts.select!)) : out) as T[];
  if (opts.get) {
    if (!shaped.length) throw callError('ENOENT', 'Object not found', 2);
    return structuredClone(shaped[0]!);
  }
  return structuredClone(shaped);
}
