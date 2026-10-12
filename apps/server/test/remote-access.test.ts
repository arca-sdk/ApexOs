/**
 * Two-factor sign-in, sessions and remote access, through the real HTTP API against the simulated
 * TrueNAS (configured scenario: apps pool on SSDs, LAN 192.168.1.20/24).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AccountSecurity, LoginResponse, RecoveryCodesResponse, RemoteAccessStatus, Task, TwoFactorSetup } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { loadScripts } from '../src/lib/install-script.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { base32Decode, hotp, totpStep } from '../src/lib/totp.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { securityRuntime } from '../src/services/two-factor.ts';

const catalogDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../catalog');
const PASSWORD = 'correct-horse-battery';

let mock: MockTrueNas;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let cookie = '';
let secret = '';
let recoveryCodes: string[] = [];
/** Moves the server's security clock (TOTP steps, challenges, attempt limiter). */
let clockOffset = 0;

interface Res<T> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
  cookie: string | null;
}

async function call<T>(method: string, url: string, payload?: unknown, opts: { cookie?: string; ip?: string; headers?: Record<string, string> } = {}): Promise<Res<T>> {
  const sessionCookie = opts.cookie ?? cookie;
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: payload as object,
    remoteAddress: opts.ip,
    headers: { ...(sessionCookie ? { cookie: sessionCookie } : {}), ...opts.headers },
  });
  const set = res.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : set;
  return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T), headers: res.headers, cookie: first ? first.split(';')[0]! : null };
}

async function ok<T>(method: string, url: string, payload?: unknown, opts?: Parameters<typeof call>[3]): Promise<T> {
  const res = await call<T>(method, url, payload, opts);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function finished(started: { task: Task }): Promise<Task> {
  for (let i = 0; i < 400; i++) {
    const t = ctx.tasks.get(started.task.id)!;
    if (t.status !== 'running') {
      if (t.status === 'failed') throw new Error(`Task "${t.title}" failed: ${t.error}`);
      return t;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Task did not finish');
}

const now = () => Date.now() + clockOffset;
/** The authenticator code for the current step (+ `steps`). */
const code = (steps = 0) => hotp(base32Decode(secret), totpStep(now()) + steps);
/** Moves to the next 30-second step so a fresh code can be used. */
const nextStep = () => {
  clockOffset += 30_000;
};
/** A 6-digit code that is wrong for every step in the accepted window. */
const wrongCode = () => {
  const valid = new Set([-1, 0, 1].map((d) => code(d)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
};

async function startLogin(ip?: string): Promise<string> {
  const res = await call<LoginResponse>('POST', '/api/auth/login', { username: 'owner', password: PASSWORD }, { cookie: '', ip });
  expect(res.status).toBe(200);
  expect(res.cookie).toBeNull();
  if (res.body.ok) throw new Error('Expected a second step');
  return res.body.challenge;
}

beforeAll(async () => {
  mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key', scenario: 'configured' });
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-remote-'));
  const store = new StateStore(dataDir);
  await store.load();
  await store.update((s) => {
    s.server = { name: 'homeserver', setupCompletedAt: new Date().toISOString() };
  });
  const truenas = new TrueNasManager();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
  ctx = {
    store,
    truenas,
    tasks: new TaskManager(),
    bus: new Bus(),
    host: new HostCommands(truenas),
    scripts: (await loadScripts(catalogDir)).scripts,
    demo: true,
  };
  app = await buildApp(ctx);
  securityRuntime(ctx).now = now;
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('two-factor sign-in', () => {
  it('starts with a password-only account', async () => {
    const res = await call('POST', '/api/auth/setup', { username: 'owner', password: PASSWORD });
    expect(res.status).toBe(200);
    cookie = res.cookie!;
    const security = await ok<AccountSecurity>('GET', '/api/auth/security');
    expect(security).toMatchObject({ twoFactor: { enabled: false, recoveryCodesLeft: 0 }, strongPassword: true, secureCookies: false, https: false });
    expect(await ok<LoginResponse>('POST', '/api/auth/login', { username: 'owner', password: PASSWORD })).toEqual({ ok: true });
  });

  it('refuses remote access that needs two-factor sign-in', async () => {
    const ts = await call<{ error: { code: string } }>('POST', '/api/remote/tailscale', { authKey: 'tskey-auth-abc123', hostname: 'homeserver', shareHomeNetwork: false });
    expect(ts.status).toBe(409);
    expect(ts.body.error.code).toBe('TWO_FACTOR_RECOMMENDED');
    const cf = await call<{ error: { code: string } }>('POST', '/api/remote/cloudflare', { token: tunnelToken() });
    expect(cf.status).toBe(409);
    expect(cf.body.error.code).toBe('TWO_FACTOR_REQUIRED');
  });

  it('enrolls an authenticator after one correct code', async () => {
    const setup = await call<TwoFactorSetup>('POST', '/api/auth/2fa/setup');
    expect(setup.headers['cache-control']).toBe('no-store');
    secret = setup.body.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauthUri).toBe(`otpauth://totp/ApexOs:owner%40homeserver?secret=${secret}&issuer=ApexOs&algorithm=SHA1&digits=6&period=30`);
    expect(setup.body.qr.size).toBeGreaterThanOrEqual(21);
    expect(setup.body.qr.path).toMatch(/^M0 0h7v1h-7z/);
    // Not active before it is confirmed.
    expect((await ok<AccountSecurity>('GET', '/api/auth/security')).twoFactor.enabled).toBe(false);

    const wrong = await call<{ error: { code: string } }>('POST', '/api/auth/2fa/enable', { code: wrongCode() });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVALID_CODE');

    const oldCookie = cookie;
    const enabled = await call<RecoveryCodesResponse>('POST', '/api/auth/2fa/enable', { code: code() });
    expect(enabled.status).toBe(200);
    recoveryCodes = enabled.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    // Other sessions end; this browser gets a fresh cookie.
    expect(enabled.cookie).toBeTruthy();
    cookie = enabled.cookie!;
    expect((await call('GET', '/api/auth/security', undefined, { cookie: oldCookie })).status).toBe(401);
    expect(await ok<AccountSecurity>('GET', '/api/auth/security')).toMatchObject({ twoFactor: { enabled: true, recoveryCodesLeft: 10 } });

    // Only hashes of the recovery codes are stored; the secret stays server-side in the private state file.
    const stateFile = await readFile(join(dataDir, 'state.json'), 'utf8');
    for (const c of recoveryCodes) {
      expect(stateFile).not.toContain(c);
      expect(stateFile).not.toContain(c.replace('-', ''));
    }
    expect(JSON.parse(stateFile).security.pendingTwoFactor).toBeNull();
  });

  it('signs in in two steps', async () => {
    const challenge = await startLogin();
    const wrong = await call<{ error: { code: string } }>('POST', '/api/auth/login/verify', { challenge, code: wrongCode() });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CODE');
    nextStep();
    const right = await call<{ ok: boolean; recoveryCodeUsed: boolean }>('POST', '/api/auth/login/verify', { challenge, code: code() });
    expect(right.status).toBe(200);
    expect(right.body).toMatchObject({ ok: true, recoveryCodeUsed: false });
    expect((await call('GET', '/api/auth/security', undefined, { cookie: right.cookie! })).status).toBe(200);
    // The challenge is single use.
    nextStep();
    const again = await call<{ error: { code: string } }>('POST', '/api/auth/login/verify', { challenge, code: code() });
    expect(again.body.error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('refuses a code that was already used', async () => {
    nextStep();
    const used = code();
    const first = await call('POST', '/api/auth/login/verify', { challenge: await startLogin(), code: used });
    expect(first.status).toBe(200);
    const replay = await call<{ error: { code: string; message: string } }>('POST', '/api/auth/login/verify', { challenge: await startLogin(), code: used });
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toMatch(/already used/);
  });

  it('accepts each recovery code once', async () => {
    const recovery = recoveryCodes[0]!;
    const first = await call<{ recoveryCodeUsed: boolean; recoveryCodesLeft: number }>('POST', '/api/auth/login/verify', {
      challenge: await startLogin(),
      code: ` ${recovery.toUpperCase()} `,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ recoveryCodeUsed: true, recoveryCodesLeft: 9 });
    const second = await call<{ error: { code: string } }>('POST', '/api/auth/login/verify', { challenge: await startLogin(), code: recovery });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('INVALID_CODE');
    expect((await ok<AccountSecurity>('GET', '/api/auth/security')).twoFactor.recoveryCodesLeft).toBe(9);
  });

  it('refuses tampered challenges and keeps challenges and sessions apart', async () => {
    const challenge = await startLogin();
    const tampered = `${challenge.slice(0, -2)}${challenge.endsWith('AA') ? 'BB' : 'AA'}`;
    nextStep();
    expect((await call<{ error: { code: string } }>('POST', '/api/auth/login/verify', { challenge: tampered, code: code() })).body.error.code).toBe('CHALLENGE_EXPIRED');
    // A challenge is not a session cookie.
    expect((await call('GET', '/api/auth/security', undefined, { cookie: `apexos_session=${challenge}` })).status).toBe(401);
    // Five wrong codes use up a challenge.
    const ip = '10.0.0.50';
    const limited = await startLogin(ip);
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call<{ error: { code: string } }>('POST', '/api/auth/login/verify', { challenge: limited, code: wrongCode() }, { ip })).body.error.code);
    expect(codes).toEqual(['INVALID_CODE', 'INVALID_CODE', 'INVALID_CODE', 'INVALID_CODE', 'CHALLENGE_EXPIRED']);
  });

  it('expires challenges after five minutes', async () => {
    const challenge = await startLogin();
    clockOffset += 5 * 60_000 + 1_000;
    expect((await call<{ error: { code: string } }>('POST', '/api/auth/login/verify', { challenge, code: code() })).body.error.code).toBe('CHALLENGE_EXPIRED');
  });

  it('rate-limits failed attempts per address with backoff', async () => {
    const ip = '10.0.0.9';
    const attempt = (password: string, from = ip) => call<LoginResponse & { error?: { code: string; message: string } }>('POST', '/api/auth/login', { username: 'owner', password }, { cookie: '', ip: from });
    for (let i = 0; i < 5; i++) expect((await attempt('wrong-password')).status).toBe(401);
    const sixth = await attempt('wrong-password');
    expect(sixth.status).toBe(401);
    expect(sixth.body.error!.message).toMatch(/Wait 1 second/);
    // Even the right password is refused while waiting.
    const locked = await attempt(PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.error!.code).toBe('RATE_LIMITED');
    expect(locked.headers['retry-after']).toBe('1');
    // Other addresses are unaffected.
    expect((await attempt(PASSWORD, '10.0.0.10')).status).toBe(200);
    // Each further failure doubles the wait.
    clockOffset += 1_500;
    expect((await attempt('wrong-password')).body.error!.message).toMatch(/Wait 2 seconds/);
    clockOffset += 2_500;
    expect((await attempt('wrong-password')).body.error!.message).toMatch(/Wait 4 seconds/);
    clockOffset += 4_500;
    // Wrong codes count too, and a complete sign-in clears the count.
    const challenge = (await attempt(PASSWORD)).body as { challenge: string };
    const wrong = await call<{ error: { message: string } }>('POST', '/api/auth/login/verify', { challenge: challenge.challenge, code: wrongCode() }, { ip });
    expect(wrong.body.error.message).toMatch(/Wait 8 seconds/);
    clockOffset += 8_500;
    nextStep();
    expect((await call('POST', '/api/auth/login/verify', { challenge: challenge.challenge, code: code() }, { ip })).status).toBe(200);
    expect(securityRuntime(ctx).limiter.retryAfterMs(ip)).toBe(0);
    expect((await attempt('wrong-password')).body.error!.message).toBe('Incorrect username or password.');
  });

  it('counts parallel guesses before letting more through', async () => {
    const ip = '10.0.0.77';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('POST', '/api/auth/login', { username: 'owner', password: 'wrong-password' }, { cookie: '', ip })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([401, 401, 401, 401, 401, 401, 429, 429, 429, 429]);
  });

  it('signs out everywhere', async () => {
    nextStep();
    const a = await call('POST', '/api/auth/login/verify', { challenge: await startLogin(), code: code() });
    nextStep();
    const b = await call('POST', '/api/auth/login/verify', { challenge: await startLogin(), code: code() });
    expect((await call('GET', '/api/auth/security', undefined, { cookie: b.cookie! })).status).toBe(200);
    const out = await call('POST', '/api/auth/sign-out-everywhere', {}, { cookie: a.cookie! });
    expect(out.status).toBe(200);
    for (const c of [a.cookie!, b.cookie!, cookie]) expect((await call('GET', '/api/auth/security', undefined, { cookie: c })).status).toBe(401);
    nextStep();
    const again = await call('POST', '/api/auth/login/verify', { challenge: await startLogin(), code: code() });
    cookie = again.cookie!;
    expect((await call('GET', '/api/auth/security')).status).toBe(200);
  });

  it('keeps this browser signed in when the password changes, and ends the others', async () => {
    nextStep();
    const other = await call('POST', '/api/auth/login/verify', { challenge: await startLogin(), code: code() });
    const changed = await call('PUT', '/api/settings/password', { current: PASSWORD, next: 'short-pw' });
    expect(changed.status).toBe(200);
    cookie = changed.cookie!;
    expect((await call('GET', '/api/auth/security', undefined, { cookie: other.cookie! })).status).toBe(401);
    expect((await ok<AccountSecurity>('GET', '/api/auth/security')).strongPassword).toBe(false);
    const back = await call('PUT', '/api/settings/password', { current: 'short-pw', next: PASSWORD });
    cookie = back.cookie!;
    expect((await ok<AccountSecurity>('GET', '/api/auth/security')).strongPassword).toBe(true);
  });

  it('replaces recovery codes with a current code', async () => {
    nextStep();
    const wrong = await call('POST', '/api/auth/2fa/recovery-codes', { code: wrongCode() });
    expect(wrong.status).toBe(400);
    const fresh = await ok<RecoveryCodesResponse>('POST', '/api/auth/2fa/recovery-codes', { code: code() });
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(fresh.recoveryCodes).not.toContain(recoveryCodes[1]);
    recoveryCodes = fresh.recoveryCodes;
    expect((await ok<AccountSecurity>('GET', '/api/auth/security')).twoFactor.recoveryCodesLeft).toBe(10);
  });
});

function tunnelToken(): string {
  return Buffer.from(JSON.stringify({ a: 'b7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5', t: '4f5e6d7c-1a2b-4c3d-9e8f-0a1b2c3d4e5f', s: 'c2VjcmV0LXR1bm5lbC1zZWNyZXQtdmFsdWU=' })).toString('base64');
}

describe('remote access', () => {
  it('turns on Tailscale with the community train and host networking', async () => {
    const bad = await call<{ error: { fields: Record<string, string> } }>('POST', '/api/remote/tailscale', { authKey: 'abc123', hostname: 'homeserver', shareHomeNetwork: false });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.authKey).toMatch(/tskey-/);
    const badName = await call('POST', '/api/remote/tailscale', { authKey: 'tskey-auth-abc123', hostname: '-Home Server', shareHomeNetwork: false });
    expect(badName.status).toBe(400);

    const before = await ok<RemoteAccessStatus>('GET', '/api/remote');
    expect(before).toMatchObject({ appsReady: true, lanIp: '192.168.1.20', twoFactorEnabled: true, connectedVia: 'direct' });
    expect(before.tailscale).toMatchObject({ enabled: false, external: false, state: null, suggestedHostname: 'homeserver', homeNetwork: '192.168.1.0/24' });
    expect(before.checklist.find((c) => c.id === 'two-factor')!.ok).toBe(true);

    await finished(await ok<{ task: Task }>('POST', '/api/remote/tailscale', { authKey: 'tskey-auth-abc123', hostname: 'HomeServer', shareHomeNetwork: true }));
    const installed = mock.state.apps.find((a) => a.catalog_app === 'tailscale')!;
    expect(installed).toMatchObject({ name: 'tailscale', train: 'community', state: 'RUNNING' });
    expect(installed.config.tailscale).toMatchObject({
      hostname: 'homeserver',
      auth_key: 'tskey-auth-abc123',
      auth_once: true,
      userspace: false,
      accept_dns: false,
      advertise_routes: ['192.168.1.0/24'],
      extra_args: [],
    });
    expect(installed.config.network).toMatchObject({ host_network: true });
    // Subnet routes need IPv4 forwarding, made persistent with a sysctl tunable.
    expect(mock.state.tunables).toEqual([expect.objectContaining({ type: 'SYSCTL', var: 'net.ipv4.ip_forward', value: '1', enabled: true })]);
    // ApexOs keeps no copy of the auth key.
    expect(await readFile(join(dataDir, 'state.json'), 'utf8')).not.toContain('tskey-auth-abc123');

    const status = await ok<RemoteAccessStatus>('GET', '/api/remote');
    expect(status.tailscale).toMatchObject({
      enabled: true,
      state: 'running',
      appName: 'tailscale',
      hostname: 'homeserver',
      routes: ['192.168.1.0/24'],
      filesAddress: '\\\\homeserver',
      tailnetIp: null,
      appVersion: 'v1.102.5',
    });
    expect(status.tailscale.remoteUrl).toMatch(/^http:\/\/homeserver:\d+$/);

    const twice = await call<{ error: { code: string } }>('POST', '/api/remote/tailscale', { authKey: 'tskey-auth-abc123', hostname: 'homeserver', shareHomeNetwork: false });
    expect(twice.body.error.code).toBe('ALREADY_ON');
  });

  it('learns the tailnet address when ApexOs is opened through Tailscale', async () => {
    const res = await ok<RemoteAccessStatus>('GET', '/api/remote', undefined, { ip: '100.101.102.103', headers: { host: '100.88.1.2:8080' } });
    expect(res.connectedVia).toBe('tailscale');
    expect(res.port).toBe(8080);
    expect(res.tailscale).toMatchObject({ tailnetIp: '100.88.1.2', remoteUrl: 'http://homeserver:8080' });
    await ok('GET', '/api/remote', undefined, { ip: '100.101.102.103', headers: { host: 'homeserver.tail1234.ts.net:8080' } });
    expect((await ok<RemoteAccessStatus>('GET', '/api/remote')).tailscale).toMatchObject({ tailnetIp: '100.88.1.2', tailnetName: 'homeserver.tail1234.ts.net' });
  });

  it('turns Tailscale off and keeps nothing behind', async () => {
    await finished(await ok<{ task: Task }>('DELETE', '/api/remote/tailscale'));
    expect(mock.state.apps.some((a) => a.catalog_app === 'tailscale')).toBe(false);
    expect(mock.state.datasets.some((d) => d.id.includes('app_mounts/tailscale'))).toBe(false);
    expect(mock.state.tunables).toEqual([]);
    const status = await ok<RemoteAccessStatus>('GET', '/api/remote');
    expect(status.tailscale).toMatchObject({ enabled: false, state: null, tailnetIp: null });
    expect(JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')).remoteAccess.tailscale).toBeNull();
  });

  it('leaves a Tailscale app installed outside ApexOs alone', async () => {
    await ctx.truenas.client().job('app.create', [
      { app_name: 'ts-manual', catalog_app: 'tailscale', train: 'community', values: { tailscale: { hostname: 'nas-manual', auth_key: 'tskey-auth-x' } } },
    ]);
    const status = await ok<RemoteAccessStatus>('GET', '/api/remote');
    expect(status.tailscale).toMatchObject({ enabled: false, external: true, appName: 'ts-manual', hostname: 'nas-manual', state: 'running' });
    const refused = await call<{ error: { code: string } }>('POST', '/api/remote/tailscale', { authKey: 'tskey-auth-abc123', hostname: 'homeserver', shareHomeNetwork: false });
    expect(refused.body.error.code).toBe('ALREADY_INSTALLED');
    await ctx.truenas.client().job('app.delete', ['ts-manual', { remove_ix_volumes: true }]);
  });

  it('turns on Cloudflare Tunnel once two-factor sign-in is on', async () => {
    const bad = await call<{ error: { fields: Record<string, string> } }>('POST', '/api/remote/cloudflare', { token: 'not-a-token' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.token).toBeTruthy();
    // The whole install command from the Cloudflare dashboard is accepted too.
    const started = await ok<{ task: Task }>('POST', '/api/remote/cloudflare', {
      token: `sudo cloudflared service install ${tunnelToken()}`,
      publicHostname: 'https://NAS.Example.com/',
    });
    await finished(started);
    const installed = mock.state.apps.find((a) => a.catalog_app === 'cloudflared')!;
    expect(installed).toMatchObject({ name: 'cloudflared', train: 'community', state: 'RUNNING' });
    expect(installed.config.cloudflared).toMatchObject({ tunnel_token: tunnelToken() });
    expect(installed.config.network).toMatchObject({ host_network: false });
    expect(await readFile(join(dataDir, 'state.json'), 'utf8')).not.toContain(tunnelToken());

    const status = await ok<RemoteAccessStatus>('GET', '/api/remote');
    expect(status.cloudflare).toMatchObject({ enabled: true, state: 'running', publicHostname: 'nas.example.com', appVersion: '2026.10.0' });
    expect(status.cloudflare.serviceUrl).toMatch(/^http:\/\/192\.168\.1\.20:\d+$/);
    // Without APEXOS_SECURE_COOKIES the checklist flags cookies while the login page is public.
    expect(status.checklist.find((c) => c.id === 'secure-cookies')!.ok).toBe(false);
  });

  it('marks the cookie Secure for requests that arrive over HTTPS', async () => {
    const res = await call('PUT', '/api/settings/password', { current: PASSWORD, next: PASSWORD }, { headers: { 'x-forwarded-proto': 'https' } });
    expect(String(res.headers['set-cookie'])).toMatch(/; Secure/i);
    cookie = res.cookie!;
    const viaCloudflare = await ok<RemoteAccessStatus>('GET', '/api/remote', undefined, { headers: { 'cf-connecting-ip': '203.0.113.7', host: 'nas.example.com' } });
    expect(viaCloudflare.connectedVia).toBe('cloudflare');
  });

  it('keeps two-factor sign-in on while the tunnel runs', async () => {
    nextStep();
    const refused = await call<{ error: { code: string } }>('POST', '/api/auth/2fa/disable', { password: PASSWORD, code: code() });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('REMOTE_ACCESS_ON');
    await finished(await ok<{ task: Task }>('DELETE', '/api/remote/cloudflare'));
    expect(mock.state.apps.some((a) => a.catalog_app === 'cloudflared')).toBe(false);
    expect((await ok<RemoteAccessStatus>('GET', '/api/remote')).cloudflare).toMatchObject({ enabled: false, state: null });
  });

  it('turns two-factor sign-in off with the password and a code', async () => {
    nextStep();
    const wrongPassword = await call<{ error: { code: string } }>('POST', '/api/auth/2fa/disable', { password: 'nope-nope', code: code() });
    expect(wrongPassword.status).toBe(400);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    const wrong = await call<{ error: { code: string } }>('POST', '/api/auth/2fa/disable', { password: PASSWORD, code: wrongCode() });
    expect(wrong.body.error.code).toBe('INVALID_CODE');
    await ok('POST', '/api/auth/2fa/disable', { password: PASSWORD, code: recoveryCodes[3] });
    expect((await ok<AccountSecurity>('GET', '/api/auth/security')).twoFactor).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
    expect(await ok<LoginResponse>('POST', '/api/auth/login', { username: 'owner', password: PASSWORD }, { cookie: '' })).toEqual({ ok: true });
  });

  it('allows Tailscale without two-factor sign-in only when the user accepts the risk', async () => {
    await finished(
      await ok<{ task: Task }>('POST', '/api/remote/tailscale', { authKey: 'tskey-auth-abc123', hostname: 'homeserver', shareHomeNetwork: false, acceptWithoutTwoFactor: true }),
    );
    expect(mock.state.apps.find((a) => a.catalog_app === 'tailscale')!.config.tailscale).toMatchObject({ advertise_routes: [] });
    expect(mock.state.tunables ?? []).toEqual([]);
    await finished(await ok<{ task: Task }>('DELETE', '/api/remote/tailscale'));
    const cf = await call<{ error: { code: string } }>('POST', '/api/remote/cloudflare', { token: tunnelToken() });
    expect(cf.body.error.code).toBe('TWO_FACTOR_REQUIRED');
  });
});
