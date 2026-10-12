import { reactive } from 'vue';
import type { StatusResponse, Task, TaskStarted } from '@apexos/api-types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && path !== '/auth/login') session.authenticated = false;
    throw new ApiError(err.message ?? `Request failed (${res.status})`, res.status, err.code ?? 'UNKNOWN', err.fields ?? {});
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** Global session status, populated from GET /api/status. */
export const session = reactive({
  loaded: false,
  authenticated: false,
  needsAccount: false,
  truenasConfigured: false,
  truenasConnected: false,
  setupComplete: false,
  serverName: '' as string,
  demo: false,
  username: '' as string,
});

export async function refreshStatus(): Promise<void> {
  const s = await api.get<StatusResponse>('/status');
  Object.assign(session, {
    loaded: true,
    authenticated: s.authenticated,
    needsAccount: s.needsAccount,
    truenasConfigured: s.truenasConfigured,
    truenasConnected: s.truenasConnected,
    setupComplete: s.setupComplete,
    serverName: s.serverName ?? '',
    demo: s.demo,
    username: s.username ?? '',
  });
}

/** Starts a server task and resolves once it finishes (rejects with the task's error). */
export async function runTask(start: Promise<TaskStarted>): Promise<Task> {
  const { task } = await start;
  const { waitForTask } = await import('./events.ts');
  return waitForTask(task.id);
}
