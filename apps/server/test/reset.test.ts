/**
 * "Erase everything and start over": what it lists, the confirmation it needs, and what's left afterwards.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ResetPreview, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';

let mock: MockTrueNas;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let cookie = '';
const PASSWORD = 'correct-horse';

async function call<T>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T) };
}

async function ok<T>(method: string, url: string, payload?: unknown): Promise<T> {
  const res = await call<T>(method, url, payload);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function finished(started: { task: Task }): Promise<Task> {
  for (let i = 0; i < 800; i++) {
    const t = ctx.tasks.get(started.task.id)!;
    if (t.status !== 'running') {
      if (t.status === 'failed') throw new Error(`Task "${t.title}" failed: ${t.error}`);
      return t;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Task did not finish');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const tn = <T = any>(method: string, params: unknown[] = []) => ctx.truenas.client().call<T>(method, params);
type ErrorBody = { error: { code: string } };

beforeAll(async () => {
  // Configured scenario: pools HDDs and SSDs with shared folders, Jellyfin, and the share user alice.
  mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key', scenario: 'configured' });
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-reset-'));
  const store = new StateStore(dataDir);
  await store.load();
  const truenas = new TrueNasManager();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
  ctx = { store, truenas, tasks: new TaskManager(), bus: new Bus(), host: new HostCommands(truenas), scripts: new Map(), demo: true };
  app = await buildApp(ctx);
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: PASSWORD } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;

  // Tailscale was shared with the home network: ApexOs created the forwarding tunable.
  const tunable = await ctx.truenas.client().job<{ id: number }>('tunable.create', [{ type: 'SYSCTL', var: 'net.ipv4.ip_forward', value: '1', enabled: true }]);
  await store.update((s) => {
    s.server = { name: 'homeserver', setupCompletedAt: new Date().toISOString() };
    s.preferences.locations = { Media: '/mnt/HDDs/Media' };
    s.poolNames = { HDDs: 'Big drives' };
    s.remoteAccess.tailscale = {
      appName: 'tailscale',
      hostname: 'homeserver',
      routes: ['192.168.1.0/24'],
      controlServer: null,
      ipForwarding: { tunableId: tunable.id, created: true, previous: null },
      tailnetIp: null,
      tailnetName: null,
      enabledAt: new Date().toISOString(),
    };
  });
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('erasing everything and starting over', () => {
  it('lists everything that goes', async () => {
    const preview = await ok<ResetPreview>('GET', '/api/system/reset');
    expect(preview).toMatchObject({ confirmText: 'homeserver', needsCode: false, apps: ['Jellyfin'], users: ['alice'], backups: [], hostsBackups: false, blockers: [] });
    expect(preview.pools.map((p) => p.displayName)).toEqual(['Big drives', 'SSDs']);
  });

  it('needs the server name, the password, and a code when two-factor sign-in is on', async () => {
    const typo = await call<ErrorBody>('POST', '/api/system/reset', { password: PASSWORD, confirm: 'homeservr' });
    expect([typo.status, typo.body.error.code]).toEqual([400, 'VALIDATION']);
    const wrong = await call<ErrorBody>('POST', '/api/system/reset', { password: 'not-it', confirm: 'homeserver' });
    expect([wrong.status, wrong.body.error.code]).toEqual([400, 'INVALID_CREDENTIALS']);

    await ctx.store.update((s) => {
      s.security.twoFactor = { secret: 'JBSWY3DPEHPK3PXP', enabledAt: new Date().toISOString(), lastUsedStep: 0, recoveryCodes: [] };
    });
    expect((await ok<ResetPreview>('GET', '/api/system/reset')).needsCode).toBe(true);
    const noCode = await call<ErrorBody>('POST', '/api/system/reset', { password: PASSWORD, confirm: 'homeserver' });
    expect([noCode.status, noCode.body.error.code]).toEqual([400, 'CODE_REQUIRED']);
    const badCode = await call<ErrorBody>('POST', '/api/system/reset', { password: PASSWORD, code: '000000', confirm: 'homeserver' });
    expect([badCode.status, badCode.body.error.code]).toEqual([400, 'INVALID_CODE']);
    await ctx.store.update((s) => {
      s.security.twoFactor = null;
    });
    expect(await tn('pool.query')).toHaveLength(2);
  });

  it('erases pools, apps, users and the forwarding setting, then runs setup again', async () => {
    const task = await finished(await ok<{ task: Task }>('POST', '/api/system/reset', { password: PASSWORD, confirm: 'homeserver' }));
    expect(task.steps.map((s) => [s.name, s.status])).toEqual([
      ['Removing backups', 'success'],
      ['Removing apps', 'success'],
      ['Turning off traffic forwarding', 'success'],
      ['Removing users', 'success'],
      ['Erasing pools', 'success'],
      ['Resetting ApexOs', 'success'],
    ]);

    expect(await tn('pool.query')).toEqual([]);
    expect(await tn('app.query')).toEqual([]);
    expect((await tn<{ username: string }[]>('user.query', [[['builtin', '=', false]]])).map((u) => u.username)).not.toContain('alice');
    expect(await tn('sharing.smb.query')).toEqual([]);
    expect(await tn('tunable.query', [[['var', '=', 'net.ipv4.ip_forward']]])).toEqual([]);

    const state = ctx.store.get();
    expect(state.server).toEqual({ name: 'homeserver' });
    expect(state.admin?.username).toBe('owner');
    expect(state.preferences.locations).toEqual({});
    expect(state.poolNames).toEqual({});
    expect(state.remoteAccess).toEqual({ tailscale: null, cloudflare: null });
    // Still signed in, and sent to setup.
    expect(await ok('GET', '/api/status')).toMatchObject({ authenticated: true, setupComplete: false });
    expect((await ok<{ drives: { identifier: string }[] }>('GET', '/api/setup')).drives.length).toBeGreaterThan(0);
  });
});
