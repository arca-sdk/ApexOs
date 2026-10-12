/**
 * Network settings against the simulated TrueNAS: staged changes, commit with automatic rollback,
 * check-in, and the restore path when ApexOs can't confirm in time.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NetworkSettings, Task } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { TrueNasClient } from '@apexos/truenas-client';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { networkTimings } from '../src/services/network.ts';

let mock: MockTrueNas;
let app: FastifyInstance;
let ctx: AppContext;
let dataDir: string;
let cookie = '';

type ErrorBody = { error: { code: string; message: string; fields?: Record<string, string> } };

async function call<T>(method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T) };
}

async function ok<T>(method: string, url: string, payload?: unknown): Promise<T> {
  const res = await call<T>(method, url, payload);
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function settle(started: { task: Task }): Promise<Task> {
  for (let i = 0; i < 1500; i++) {
    const t = ctx.tasks.get(started.task.id)!;
    if (t.status !== 'running') return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Task did not finish');
}

async function succeeds(method: string, url: string, payload?: unknown): Promise<Task> {
  const task = await settle(await ok<{ task: Task }>(method, url, payload));
  if (task.status !== 'success') throw new Error(`Task "${task.title}" failed: ${task.error}\n${JSON.stringify(task.steps, null, 1)}`);
  return task;
}

const network = () => ok<NetworkSettings>('GET', '/api/system/network');
const port = (n: NetworkSettings, name: string) => n.interfaces.find((i) => i.name === name)!;

/** A direct middleware session, like someone using the TrueNAS web interface at the same time. */
async function truenasUi<T>(method: string, params: unknown[] = []): Promise<T> {
  const client = new TrueNasClient({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' }, reconnect: false, pingIntervalMs: 0 });
  try {
    await client.connect();
    return await client.call<T>(method, params);
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  Object.assign(networkTimings, { checkinTimeoutSeconds: 2, graceMs: 5_000, retryMs: 100, attemptTimeoutMs: 2_000 });
  mock = await startMockTrueNas({ jobDelayMs: 0, apiKey: 'test-key' });
  dataDir = await mkdtemp(join(tmpdir(), 'apexos-net-'));
  const store = new StateStore(dataDir);
  await store.load();
  const truenas = new TrueNasManager();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'test-key' } });
  ctx = { store, truenas, tasks: new TaskManager(), bus: new Bus(), host: new HostCommands(truenas), scripts: new Map(), demo: true };
  app = await buildApp(ctx);
  const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'correct-horse' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  await app?.close();
  await ctx?.truenas.close();
  await mock?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('reading the network settings', () => {
  it('describes ports, DHCP-provided DNS and gateway, and the port ApexOs uses', async () => {
    const n = await network();
    expect(n).toMatchObject({
      hostname: 'truenas',
      gateway: ['192.168.1.1'],
      nameservers: ['192.168.1.1'],
      configuredGateway: '',
      configuredNameservers: [],
      gatewayFromDhcp: true,
      nameserversFromDhcp: true,
      dhcpInterface: 'enp5s0',
      apexosAddress: '192.168.1.20',
      pendingChanges: false,
      rollbackSecondsLeft: null,
      checkinTimeoutSeconds: 2,
    });
    expect(port(n, 'enp5s0')).toMatchObject({
      type: 'PHYSICAL',
      linkUp: true,
      speedMbps: 1000,
      dhcp: true,
      mode: 'dhcp',
      configuredAddresses: [],
      liveAddresses: [{ address: '192.168.1.20', prefix: 24 }],
      usedByApexOs: true,
      editable: true,
      applied: true,
      vlan: null,
    });
    // The fields the read-only page used keep working.
    expect(port(n, 'enp5s0').addresses).toContain('192.168.1.20/24');
    expect(port(n, 'enp6s0')).toMatchObject({ mode: 'none', linkUp: false, usedByApexOs: false });
  });
});

describe('validation', () => {
  const put = (name: string, body: unknown) => call<ErrorBody>('PUT', `/api/system/network/interfaces/${name}`, body);

  it('rejects bad addresses, gateways outside the network and addresses in use', async () => {
    const bad = await put('enp5s0', { mode: 'static', address: '192.168.1.300', prefix: 24, acknowledgeConnectionRisk: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields?.address).toMatch(/IPv4 address/);

    const broadcast = await put('enp5s0', { mode: 'static', address: '192.168.1.255', prefix: 24, acknowledgeConnectionRisk: true });
    expect(broadcast.body.error.fields?.address).toMatch(/broadcast/);

    const outside = await put('enp5s0', { mode: 'static', address: '192.168.1.50', prefix: 24, gateway: '10.0.0.1', acknowledgeConnectionRisk: true });
    expect(outside.status).toBe(400);
    expect(outside.body.error.fields?.gateway).toMatch(/server’s network \(192\.168\.1\.0\/24\)/);

    const inUse = await put('enp6s0', { mode: 'static', address: '192.168.1.20', prefix: 24 });
    expect(inUse.body.error.fields?.address).toBe('192.168.1.20 is already used by enp5s0.');

    const badDns = await put('enp5s0', { mode: 'static', address: '192.168.1.50', prefix: 24, nameservers: ['127.0.0.1'], acknowledgeConnectionRisk: true });
    expect(badDns.body.error.fields?.['nameservers.0']).toMatch(/loopback/);

    const prefix = await put('enp5s0', { mode: 'static', address: '192.168.1.50', prefix: 40 });
    expect(prefix.body.error.fields?.prefix).toMatch(/subnet mask/);
  });

  it('allows DHCP on one connection only', async () => {
    const res = await put('enp6s0', { mode: 'dhcp' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields?.mode).toMatch(/enp5s0 already does/);
  });

  it('asks for an acknowledgement before changing the connection ApexOs uses', async () => {
    const res = await put('enp5s0', { mode: 'static', address: '192.168.1.50', prefix: 24 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONNECTION_RISK_NOT_ACKNOWLEDGED');
  });

  it('refuses no-op changes and unknown ports', async () => {
    expect((await put('enp5s0', { mode: 'dhcp' })).body.error.code).toBe('NO_CHANGES');
    expect((await put('eth7', { mode: 'dhcp' })).status).toBe(404);
  });

  it('checks VLAN numbers and parents', async () => {
    const range = await call<ErrorBody>('POST', '/api/system/network/vlans', { parent: 'enp5s0', tag: 5000, mode: 'static', address: '10.0.50.2', prefix: 24 });
    expect(range.status).toBe(400);
    expect(range.body.error.fields?.tag).toBe('Use a VLAN number from 1 to 4094');
    const parent = await call<ErrorBody>('POST', '/api/system/network/vlans', { parent: 'eth9', tag: 5, mode: 'static', address: '10.0.50.2', prefix: 24 });
    expect(parent.body.error.fields?.parent).toMatch(/Choose the network port/);
    const dhcp = await call<ErrorBody>('POST', '/api/system/network/vlans', { parent: 'enp5s0', tag: 5, mode: 'dhcp' });
    expect(dhcp.body.error.fields?.mode).toMatch(/Give the VLAN a fixed address/);
  });

  it('reports changes left unapplied in the TrueNAS UI and can discard them', async () => {
    await truenasUi('interface.update', ['enp6s0', { ipv4_dhcp: false, aliases: [{ type: 'INET', address: '10.9.0.2', netmask: 24 }] }]);
    expect((await network()).pendingChanges).toBe(true);
    const blocked = await call<ErrorBody>('PUT', '/api/system/network/dns', { nameservers: ['1.1.1.1'], gateway: '' });
    expect(blocked.body.error.code).toBe('PENDING_CHANGES');
    await ok('POST', '/api/system/network/discard');
    const n = await network();
    expect(n.pendingChanges).toBe(false);
    expect(port(n, 'enp6s0').mode).toBe('none');
  });
});

describe('changing a port', () => {
  it('switches the port ApexOs uses to a fixed address, keeping DNS and gateway, and confirms it', async () => {
    const task = await succeeds('PUT', '/api/system/network/interfaces/enp5s0', {
      mode: 'static',
      address: '192.168.1.50',
      prefix: 24,
      acknowledgeConnectionRisk: true,
    });
    expect(task.steps.map((s) => [s.name, s.status])).toEqual([
      ['Checking the current settings', 'success'],
      ['Saving DNS servers', 'success'],
      ['Staging the change', 'success'],
      ['Applying (TrueNAS undoes this automatically if ApexOs can’t confirm)', 'success'],
      ['Reconnecting', 'success'],
      ['Confirming', 'success'],
    ]);
    const n = await network();
    expect(port(n, 'enp5s0')).toMatchObject({
      mode: 'static',
      configuredAddresses: [{ address: '192.168.1.50', prefix: 24 }],
      liveAddresses: [{ address: '192.168.1.50', prefix: 24 }],
      usedByApexOs: true,
    });
    // DNS before static: the servers DHCP handed out were pinned, and the gateway kept.
    expect(n).toMatchObject({ configuredNameservers: ['192.168.1.1'], configuredGateway: '192.168.1.1', gateway: ['192.168.1.1'], nameservers: ['192.168.1.1'] });
    expect(n.dhcpInterface).toBeNull();
    expect(n.pendingChanges).toBe(false);

    // Checked in: nothing is undone after the timeout.
    await new Promise((r) => setTimeout(r, 2200));
    expect(port(await network(), 'enp5s0').liveAddresses).toEqual([{ address: '192.168.1.50', prefix: 24 }]);
  });

  it('requires DNS servers and a gateway when no connection uses DHCP', async () => {
    const res = await call<ErrorBody>('PUT', '/api/system/network/dns', { nameservers: [], gateway: '' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.fields ?? {})).toEqual(['nameservers', 'gateway']);
  });

  it('switches back to automatic addressing and lets DHCP provide DNS and gateway again', async () => {
    const task = await succeeds('PUT', '/api/system/network/interfaces/enp5s0', {
      mode: 'dhcp',
      gateway: '',
      nameservers: [],
      acknowledgeConnectionRisk: true,
    });
    expect(task.steps.find((s) => s.name === 'Saving DNS servers')?.status).toBe('skipped');
    expect(task.steps.at(-1)).toMatchObject({ name: 'Finishing up', status: 'success' });
    const n = await network();
    expect(port(n, 'enp5s0')).toMatchObject({ mode: 'dhcp', configuredAddresses: [], liveAddresses: [{ address: '192.168.1.20', prefix: 24 }] });
    expect(n).toMatchObject({ configuredNameservers: [], configuredGateway: '', nameserversFromDhcp: true, gatewayFromDhcp: true, dhcpInterface: 'enp5s0' });
  });

  it('gives a second port a fixed address without touching DNS or the gateway', async () => {
    await succeeds('PUT', '/api/system/network/interfaces/enp6s0', { mode: 'static', address: '10.10.0.2', prefix: 24 });
    const n = await network();
    expect(port(n, 'enp6s0')).toMatchObject({ mode: 'static', configuredAddresses: [{ address: '10.10.0.2', prefix: 24 }], usedByApexOs: false });
    expect(n.configuredNameservers).toEqual([]);
    const overlap = await call<ErrorBody>('POST', '/api/system/network/vlans', { parent: 'enp5s0', tag: 7, mode: 'static', address: '10.10.0.9', prefix: 24 });
    expect(overlap.body.error.fields?.address).toMatch(/10\.10\.0\.0\/24 is already used by enp6s0/);
  });
});

describe('DNS servers and gateway', () => {
  it('sets them by hand and back to automatic', async () => {
    const task = await succeeds('PUT', '/api/system/network/dns', { nameservers: ['1.1.1.1', '9.9.9.9'], gateway: '192.168.1.254' });
    expect(task.steps.map((s) => s.status)).toEqual(['success', 'success', 'success', 'success']);
    let n = await network();
    expect(n).toMatchObject({ nameservers: ['1.1.1.1', '9.9.9.9'], gateway: ['192.168.1.254'], configuredGateway: '192.168.1.254', nameserversFromDhcp: false, gatewayFromDhcp: false });

    const outside = await call<ErrorBody>('PUT', '/api/system/network/dns', { nameservers: ['1.1.1.1'], gateway: '172.16.0.1' });
    expect(outside.body.error.fields?.gateway).toMatch(/same network/);

    await succeeds('PUT', '/api/system/network/dns', { nameservers: [], gateway: '' });
    n = await network();
    expect(n).toMatchObject({ nameservers: ['192.168.1.1'], gateway: ['192.168.1.1'], configuredNameservers: [], configuredGateway: '' });
  });
});

describe('when ApexOs cannot confirm', () => {
  it('reports that TrueNAS put the previous settings back and restores the DNS servers', async () => {
    Object.assign(networkTimings, { checkinTimeoutSeconds: 1 });
    mock.cutConnectionOnNextCommit();
    const started = await ok<{ task: Task }>('PUT', '/api/system/network/interfaces/enp5s0', {
      mode: 'static',
      address: '192.168.1.60',
      prefix: 24,
      nameservers: ['1.1.1.1'],
      gateway: '192.168.1.1',
      acknowledgeConnectionRisk: true,
    });
    // One network change at a time.
    expect((await call<ErrorBody>('PUT', '/api/system/network/dns', { nameservers: ['8.8.8.8'], gateway: '' })).body.error.code).toBe('BUSY');

    const task = await settle(started);
    expect(task.status).toBe('failed');
    expect(task.error).toBe('Your previous settings were restored because ApexOs couldn’t reach the server at its new address 192.168.1.60 within 1 second.');
    expect(task.steps.find((s) => s.name === 'Restoring your previous settings')?.status).toBe('success');
    expect(task.steps.find((s) => s.name === 'Saving DNS servers')?.status).toBe('success');

    const n = await network();
    expect(port(n, 'enp5s0')).toMatchObject({ mode: 'dhcp', liveAddresses: [{ address: '192.168.1.20', prefix: 24 }] });
    expect(n).toMatchObject({ configuredNameservers: [], configuredGateway: '', pendingChanges: false, rollbackSecondsLeft: null });
  });

  it('also recovers when the new address is on another network', async () => {
    const task = await settle(
      await ok<{ task: Task }>('PUT', '/api/system/network/interfaces/enp5s0', {
        mode: 'static',
        address: '10.0.0.5',
        prefix: 24,
        gateway: '10.0.0.1',
        nameservers: ['10.0.0.1'],
        acknowledgeConnectionRisk: true,
      }),
    );
    expect(task.status).toBe('failed');
    expect(task.error).toMatch(/^Your previous settings were restored because ApexOs couldn’t reach the server at its new address 10\.0\.0\.5/);
    const n = await network();
    expect(port(n, 'enp5s0').liveAddresses).toEqual([{ address: '192.168.1.20', prefix: 24 }]);
    expect(n).toMatchObject({ configuredNameservers: [], configuredGateway: '', gateway: ['192.168.1.1'] });
    Object.assign(networkTimings, { checkinTimeoutSeconds: 2 });
  });
});

describe('VLANs', () => {
  it('adds a VLAN with a fixed address, refuses a duplicate tag and removes it', async () => {
    await succeeds('POST', '/api/system/network/vlans', { parent: 'enp5s0', tag: 10, mode: 'static', address: '10.0.10.2', prefix: 24, description: 'Cameras' });
    let n = await network();
    expect(port(n, 'vlan10')).toMatchObject({
      type: 'VLAN',
      mode: 'static',
      description: 'Cameras',
      vlan: { parent: 'enp5s0', tag: 10 },
      applied: true,
      linkUp: true,
      liveAddresses: [{ address: '10.0.10.2', prefix: 24 }],
    });

    const twin = await call<ErrorBody>('POST', '/api/system/network/vlans', { parent: 'enp5s0', tag: 10, mode: 'static', address: '10.0.11.2', prefix: 24 });
    expect(twin.body.error.fields?.tag).toBe('enp5s0 already has VLAN 10 (vlan10)');
    const notPhysical = await call<ErrorBody>('POST', '/api/system/network/vlans', { parent: 'vlan10', tag: 11, mode: 'static', address: '10.0.11.2', prefix: 24 });
    expect(notPhysical.body.error.fields?.parent).toMatch(/physical network port/);

    const removed = await succeeds('DELETE', '/api/system/network/vlans/vlan10');
    expect(removed.steps.map((s) => s.name)).toContain('Removing the VLAN');
    n = await network();
    expect(n.interfaces.map((i) => i.name)).toEqual(['enp5s0', 'enp6s0']);
    expect((await call<ErrorBody>('DELETE', '/api/system/network/vlans/enp5s0')).body.error.code).toBe('NOT_SUPPORTED');
  });

  it('keeps the main port on DHCP when the first change is made on a fresh install', async () => {
    // Make the server look freshly installed: no interface configuration at all.
    await truenasUi('interface.delete', ['enp5s0']);
    await truenasUi('interface.delete', ['enp6s0']);
    await truenasUi('interface.commit', [{ rollback: false }]);
    expect((await network()).interfaces.every((i) => i.mode === 'dhcp')).toBe(true);

    await succeeds('POST', '/api/system/network/vlans', { parent: 'enp6s0', tag: 20, mode: 'static', address: '10.0.20.2', prefix: 24 });
    const n = await network();
    expect(port(n, 'enp5s0')).toMatchObject({ mode: 'dhcp', liveAddresses: [{ address: '192.168.1.20', prefix: 24 }] });
    expect(port(n, 'vlan20')).toMatchObject({ applied: true, vlan: { parent: 'enp6s0', tag: 20 } });
    expect(n.dhcpInterface).toBe('enp5s0');
  });
});
