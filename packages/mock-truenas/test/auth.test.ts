import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { connect, failure, setup, startMock, type Any } from './helpers.ts';

/** Minimal raw JSON-RPC session, to exercise the unauthenticated first call the way a browser would. */
async function rawSession(url: string) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let id = 0;
  const call = (method: string, params: unknown[] = []) =>
    new Promise<Any>((resolve) => {
      const myId = ++id;
      const onMessage = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== myId) return;
        ws.off('message', onMessage);
        resolve(msg);
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }));
    });
  return { call, close: () => ws.close() };
}

describe('authentication', () => {
  it('accepts the default API key and serves system information', async () => {
    const { client } = await setup();
    const info = await client.call<Any>('system.info');
    expect(info).toMatchObject({
      version: '25.10.7',
      hostname: 'truenas',
      model: 'AMD Ryzen 5 5600G with Radeon Graphics',
      cores: 12,
      physical_cores: 6,
      physmem: 32 * 1024 ** 3,
      ecc_memory: false,
      timezone: 'America/Los_Angeles',
      system_manufacturer: 'ASRock',
      system_product: 'B550M Pro4',
    });
    expect(info.boottime).toHaveProperty('$date');
    expect(await client.call('system.version')).toBe('TrueNAS-25.10.7');
    expect(await client.call('system.state')).toBe('READY');
    const me = await client.call<Any>('auth.me');
    expect(me.pw_name).toBe('truenas_admin');
    expect(me.privilege.roles.$set).toContain('FULL_ADMIN');
  });

  it('rejects a wrong API key and a wrong password', async () => {
    const mock = await startMock();
    await expect(connect(mock, { type: 'apiKey', apiKey: 'nope' }).connect()).rejects.toThrow(/rejected the API key/);
    await expect(connect(mock, { type: 'password', username: 'truenas_admin', password: 'wrong' }).connect()).rejects.toThrow(/rejected the username or password/);
  });

  it('logs in with login_ex PASSWORD_PLAIN, creates an API key and logs in with it', async () => {
    const mock = await startMock();
    const raw = await rawSession(mock.url);
    expect((await raw.call('system.info')).error.data.errname).toBe('ENOTAUTHENTICATED');
    const bad = await raw.call('auth.login_ex', [{ mechanism: 'PASSWORD_PLAIN', username: 'truenas_admin', password: 'x' }]);
    expect(bad.result).toEqual({ response_type: 'AUTH_ERR' });
    const ok = await raw.call('auth.login_ex', [{ mechanism: 'PASSWORD_PLAIN', username: 'truenas_admin', password: 'demo-password' }]);
    expect(ok.result).toMatchObject({ response_type: 'SUCCESS', authenticator: 'LEVEL_1', user_info: { pw_name: 'truenas_admin', pw_uid: 950 } });

    const created = (await raw.call('api_key.create', [{ name: 'hearth-server', username: 'truenas_admin', expires_at: null }])).result;
    expect(created.key).toMatch(/^\d+-[A-Za-z0-9]{64}$/);
    expect(created).toMatchObject({ name: 'hearth-server', username: 'truenas_admin', revoked: false, expires_at: null });
    expect(created.created_at).toHaveProperty('$date');
    raw.close();

    // The new key works with both login styles.
    const viaKey = connect(mock, { type: 'apiKey', apiKey: created.key });
    await viaKey.connect();
    expect((await viaKey.call<Any>('auth.me')).pw_name).toBe('truenas_admin');
    const ex = await viaKey.call<Any>('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN', username: 'truenas_admin', api_key: created.key }]);
    expect(ex.response_type).toBe('SUCCESS');
    const wrongUser = await viaKey.call<Any>('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN', username: 'root', api_key: created.key }]);
    expect(wrongUser.response_type).toBe('AUTH_ERR');

    const keys = await viaKey.call<Any[]>('api_key.query', [[['name', '=', 'hearth-server']]]);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty('key');
  });

  it('validates api_key.create', async () => {
    const { client } = await setup();
    const err = await failure(client.call('api_key.create', [{ name: 'x', username: 'nobody-here' }]));
    expect(err.validationErrors['api_key_create.username']).toMatch(/does not exist/);
    const noRoles = await failure(client.call('api_key.create', [{ name: 'y', username: 'apps' }]));
    expect(noRoles.validationErrors['api_key_create.username']).toMatch(/roles/);
  });

  it('serves /api/versions and pinned websocket endpoints', async () => {
    const mock = await startMock();
    const versions = (await (await fetch(`${mock.baseUrl}/api/versions`)).json()) as string[];
    expect(versions).toContain('v25.10.0');
    expect(versions).toContain('v25.10.5');
    expect(versions).not.toContain('v24.10');
    const pinned = connect(mock, { type: 'password', username: 'truenas_admin', password: 'demo-password' }, mock.url.replace('/api/current', '/api/v25.10.0'));
    await pinned.connect();
    expect(await pinned.call('core.ping')).toBe('pong');
    const methods = await pinned.call<Record<string, Any>>('core.get_methods');
    expect(methods['pool.create']?.job).toBe(true);
    expect(methods['pool.dataset.create']?.job).toBe(false);
    await expect(connect(mock, { type: 'apiKey', apiKey: 'demo-api-key' }, mock.url.replace('/api/current', '/websocket')).connect()).rejects.toThrow();
  });
});
