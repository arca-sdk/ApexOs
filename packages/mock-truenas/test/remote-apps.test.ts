import { describe, expect, it } from 'vitest';
import { failure, setup, type Any } from './helpers.ts';

describe('remote access apps (community train)', () => {
  it('installs Tailscale with host networking and a subnet route', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const details = await client.call<Any>('catalog.get_app_details', ['tailscale', { train: 'community' }]);
    expect(details.latest_version).toBe('1.4.17');
    // app.create defaults to the stable train, where Tailscale doesn't exist.
    const wrongTrain = await failure(client.job('app.create', [{ app_name: 'tailscale', catalog_app: 'tailscale', values: {} }]));
    expect(wrongTrain.message).toMatch(/stable/);
    await client.job('app.create', [
      {
        app_name: 'tailscale',
        catalog_app: 'tailscale',
        train: 'community',
        values: { tailscale: { hostname: 'homeserver', auth_key: 'tskey-auth-test', advertise_routes: ['192.168.1.0/24'] }, network: { host_network: true } },
      },
    ]);
    const [app] = await client.call<Any[]>('app.query', [[['name', '=', 'tailscale']]]);
    expect(app).toMatchObject({ state: 'RUNNING', metadata: { name: 'tailscale', train: 'community' }, portals: {} });
    const config = await client.call<Any>('app.config', ['tailscale']);
    expect(config.tailscale).toMatchObject({ hostname: 'homeserver', auth_once: true, userspace: false, advertise_routes: ['192.168.1.0/24'] });
    expect(config.network.host_network).toBe(true);
  });

  it('requires a tunnel token for Cloudflare Tunnel', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const missing = await failure(client.job('app.create', [{ app_name: 'cloudflared', catalog_app: 'cloudflared', train: 'community', values: {} }]));
    expect(missing.message).toMatch(/tunnel_token/);
    await client.job('app.create', [{ app_name: 'cloudflared', catalog_app: 'cloudflared', train: 'community', values: { cloudflared: { tunnel_token: 'eyJhIjoiYSJ9' } } }]);
    const [app] = await client.call<Any[]>('app.query', [[['name', '=', 'cloudflared']]]);
    expect(app).toMatchObject({ state: 'RUNNING', version: '2.0.24', metadata: { title: 'Cloudflared' } });
    expect((await client.call<Any>('app.config', ['cloudflared'])).network.host_network).toBe(false);
  });

  it('manages sysctl tunables', async () => {
    const { client } = await setup();
    const created = await client.job<Any>('tunable.create', [{ type: 'SYSCTL', var: 'net.ipv4.ip_forward', value: '1', comment: 'test' }]);
    expect(created).toMatchObject({ id: 1, var: 'net.ipv4.ip_forward', value: '1', orig_value: '1', enabled: true });
    expect((await failure(client.job('tunable.create', [{ var: 'net.ipv4.ip_forward', value: '1' }]))).message).toMatch(/already exists/);
    expect((await failure(client.job('tunable.create', [{ var: 'net.nope', value: '1' }]))).message).toMatch(/does not exist in kernel/);
    await client.job('tunable.update', [created.id, { value: '0' }]);
    expect((await client.call<Any[]>('tunable.query'))[0].value).toBe('0');
    await client.job('tunable.delete', [created.id]);
    expect(await client.call<Any[]>('tunable.query')).toEqual([]);
  });
});
