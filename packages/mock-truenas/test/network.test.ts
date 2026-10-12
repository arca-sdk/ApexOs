import { describe, expect, it } from 'vitest';
import { TrueNasConnectionError, type TrueNasClient } from '@apexos/truenas-client';
import type { MockTrueNas } from '../src/index.ts';
import { connect, failure, setup, sleep, waitFor, type Any } from './helpers.ts';

const STATIC_50 = { ipv4_dhcp: false, aliases: [{ type: 'INET', address: '192.168.1.50', netmask: 24 }] };

async function iface(client: TrueNasClient, name: string): Promise<Any> {
  return client.call<Any>('interface.get_instance', [name]);
}

/** A fresh, connected client (the previous one may have been cut off by a commit). */
async function reconnect(mock: MockTrueNas): Promise<TrueNasClient> {
  const client = connect(mock);
  await client.connect();
  return client;
}

/** Commits; the reply is lost when the client's address goes away during the call. */
async function commit(client: TrueNasClient, options: Any = {}): Promise<'replied' | 'cut'> {
  try {
    await client.call('interface.commit', [options]);
    return 'replied';
  } catch (err) {
    if (err instanceof TrueNasConnectionError) return 'cut';
    throw err;
  }
}

describe('network: staging, commit, check-in and rollback', () => {
  it('stages changes without applying them', async () => {
    const { client } = await setup();
    expect(await client.call('interface.has_pending_changes')).toBe(false);
    const staged = await client.call<Any>('interface.update', ['enp5s0', STATIC_50]);
    expect(staged).toMatchObject({ ipv4_dhcp: false, aliases: [{ address: '192.168.1.50', netmask: 24 }] });
    expect(staged.state.aliases).toContainEqual(expect.objectContaining({ type: 'INET', address: '192.168.1.20' }));
    expect(await client.call('interface.has_pending_changes')).toBe(true);
    expect(await client.call('interface.checkin_waiting')).toBeNull();
    expect((await client.call<Any>('network.general.summary')).ips.enp5s0.IPV4).toEqual(['192.168.1.20/24']);

    // Discarding staged changes restores the configuration.
    await client.call('interface.rollback');
    expect(await client.call('interface.has_pending_changes')).toBe(false);
    expect(await iface(client, 'enp5s0')).toMatchObject({ ipv4_dhcp: true, aliases: [] });
  });

  it('applies on commit, cuts connections whose address went away, and keeps the change after a check-in', async () => {
    const { mock, client } = await setup();
    await client.call('interface.update', ['enp5s0', STATIC_50]);
    expect(await commit(client, { rollback: true, checkin_timeout: 1 })).toBe('cut');

    const again = await reconnect(mock);
    expect(await again.call('interface.websocket_local_ip')).toBe('192.168.1.50');
    const waiting = await again.call<number | null>('interface.checkin_waiting');
    expect(waiting).not.toBeNull();
    expect(waiting).toBeLessThanOrEqual(1);
    await again.call('interface.checkin');
    expect(await again.call('interface.has_pending_changes')).toBe(false);
    expect(await again.call('interface.checkin_waiting')).toBeNull();

    await sleep(1200);
    const after = await iface(again, 'enp5s0');
    expect(after.state.aliases).toContainEqual(expect.objectContaining({ type: 'INET', address: '192.168.1.50', netmask: 24 }));
    expect(mock.state.network.interfaces[0]!.addresses).toEqual([{ address: '192.168.1.50', netmask: 24 }]);
  });

  it('rolls everything back, including the gateway, when nobody checks in', async () => {
    const { mock, client } = await setup();
    await client.call('interface.update', ['enp5s0', STATIC_50]);
    await client.call('network.configuration.update', [{ ipv4gateway: '192.168.1.1' }]);
    expect(await commit(client, { checkin_timeout: 1 })).toBe('cut');
    const again = await reconnect(mock);
    expect(await again.call('interface.websocket_local_ip')).toBe('192.168.1.50');

    await waitFor(() => mock.state.network.interfaces[0]!.addresses[0]?.address === '192.168.1.20', 3000);
    const restored = await reconnect(mock);
    expect(await iface(restored, 'enp5s0')).toMatchObject({ ipv4_dhcp: true, aliases: [] });
    expect((await restored.call<Any>('network.configuration.config')).ipv4gateway).toBe('');
    expect(await restored.call('interface.has_pending_changes')).toBe(false);
    expect(await restored.call('interface.checkin_waiting')).toBeNull();
  });

  it('cancel_rollback stops the timer but keeps the snapshot', async () => {
    const { mock, client } = await setup();
    await client.call('interface.update', ['enp6s0', { ipv4_dhcp: false, aliases: [{ type: 'INET', address: '10.10.0.2', netmask: 24 }] }]);
    // enp5s0 keeps its address, so this connection survives the commit.
    expect(await commit(client, { checkin_timeout: 1 })).toBe('replied');
    await client.call('interface.cancel_rollback');
    expect(await client.call('interface.checkin_waiting')).toBeNull();
    expect(await client.call('interface.has_pending_changes')).toBe(true);
    await sleep(1100);
    expect(mock.state.network.interfaces[1]!.addresses).toEqual([{ address: '10.10.0.2', netmask: 24 }]);
    await client.call('interface.rollback');
    expect(mock.state.network.interfaces[1]!.addresses).toEqual([]);
  });

  it('loses DNS and the default route when the DHCP port goes static without them', async () => {
    const { mock, client } = await setup();
    expect(await client.call<Any>('network.general.summary')).toMatchObject({ default_routes: ['192.168.1.1'], nameservers: ['192.168.1.1'] });
    await client.call('interface.update', ['enp5s0', STATIC_50]);
    await commit(client, { rollback: false });
    const again = await reconnect(mock);
    expect(await again.call<Any>('network.general.summary')).toMatchObject({ default_routes: [], nameservers: [] });
    expect((await again.call<Any>('network.configuration.config')).state).toMatchObject({ ipv4gateway: '', nameserver1: '' });
    expect(await again.call('interface.has_pending_changes')).toBe(false);

    await again.call('network.configuration.update', [{ nameserver1: '1.1.1.1', nameserver2: '9.9.9.9', ipv4gateway: '192.168.1.1' }]);
    expect(await again.call<Any>('network.general.summary')).toMatchObject({ default_routes: ['192.168.1.1'], nameservers: ['1.1.1.1', '9.9.9.9'] });
  });

  it('validates the global configuration like the middleware', async () => {
    const { client } = await setup();
    const unreachable = await failure(client.call('network.configuration.update', [{ ipv4gateway: '10.0.0.1' }]));
    expect(unreachable.validationErrors['global_configuration_update.ipv4gateway']).toBe('Gateway 10.0.0.1 is unreachable');
    const dns = await failure(client.call('network.configuration.update', [{ nameserver1: '127.0.0.1', nameserver2: '169.254.1.1' }]));
    expect(dns.validationErrors).toMatchObject({
      'global_configuration_update.nameserver1': 'Loopback is not a valid nameserver',
      'global_configuration_update.nameserver2': '169.254/16 subnet is not valid for nameserver',
    });
    const order = await failure(client.call('network.configuration.update', [{ nameserver1: '1.1.1.1', nameserver3: '8.8.8.8' }]));
    expect(order.validationErrors['global_configuration_update.nameserver']).toMatch(/consecutive order/);
  });

  it('save_network_config needs pending changes and a gateway inside a configured network', async () => {
    const { client } = await setup();
    const none = await failure(client.call('interface.save_network_config', [{ ipv4gateway: '192.168.1.1' }]));
    expect(none.reason).toMatch(/no pending interface changes/);
    await client.call('interface.update', ['enp5s0', { ipv4_dhcp: false, aliases: [{ type: 'INET', address: '10.20.0.5', netmask: 24 }] }]);
    const outside = await failure(client.call('interface.save_network_config', [{ ipv4gateway: '192.168.1.1' }]));
    expect(outside.reason).toMatch(/not reachable from any interface/);
    await client.call('interface.save_network_config', [{ ipv4gateway: '10.20.0.1' }]);
    expect((await client.call<Any>('network.configuration.config')).ipv4gateway).toBe('10.20.0.1');
    await client.call('interface.rollback');
    expect((await client.call<Any>('network.configuration.config')).ipv4gateway).toBe('');
  });

  it('validates interface changes', async () => {
    const { client } = await setup();
    await client.call('interface.update', ['enp6s0', { ipv4_dhcp: false, aliases: [{ type: 'INET', address: '10.10.0.2', netmask: 24 }] }]);
    const overlap = await failure(client.call('interface.update', ['enp5s0', { ipv4_dhcp: false, aliases: [{ type: 'INET', address: '10.10.0.9', netmask: 16 }] }]));
    expect(overlap.validationErrors['interface_update.aliases.0']).toBe('The network 10.10.0.0/16 is already in use by another interface.');
    const dhcp = await failure(client.call('interface.update', ['enp6s0', { ipv4_dhcp: true, aliases: [] }]));
    expect(dhcp.validationErrors['interface_update.ipv4_dhcp']).toBe('Only one interface can be used for DHCP.');
    const bad = await failure(client.call('interface.update', ['enp6s0', { aliases: [{ type: 'INET', address: '10.10.0.300', netmask: 24 }], speed: 5 }]));
    expect(Object.keys(bad.validationErrors)).toEqual(['interface_update.speed']);
    const addr = await failure(client.call('interface.update', ['enp6s0', { aliases: [{ type: 'INET', address: '10.10.0.300', netmask: 24 }] }]));
    expect(addr.validationErrors['interface_update.aliases.0.address']).toMatch(/not a valid IPv4/);
  });

  it('refuses to commit when no interface would have an address', async () => {
    const { client } = await setup();
    await client.call('interface.update', ['enp5s0', { ipv4_dhcp: false, aliases: [] }]);
    const err = await failure(client.call('interface.commit', [{}]));
    expect(err.validationErrors['interface.commit']).toMatch(/At least one interface must be configured/);
    await client.call('interface.rollback');

    // With no interface in the database at all, TrueNAS falls back to DHCP on every port.
    await client.call('interface.delete', ['enp5s0']);
    expect((await client.call<Any[]>('interface.query')).map((i) => i.ipv4_dhcp)).toEqual([true, true]);
  });
});

describe('network: VLANs', () => {
  it('creates a VLAN that comes up on commit and goes away when deleted', async () => {
    const { client } = await setup();
    expect(await client.call('interface.vlan_parent_interface_choices')).toEqual({ enp5s0: 'enp5s0', enp6s0: 'enp6s0' });
    const created = await client.call<Any>('interface.create', [
      { type: 'VLAN', name: 'vlan20', vlan_parent_interface: 'enp5s0', vlan_tag: 20, ipv4_dhcp: false, aliases: [{ type: 'INET', address: '10.0.20.5', netmask: 24 }], description: 'Cameras' },
    ]);
    expect(created).toMatchObject({ name: 'vlan20', type: 'VLAN', fake: true, vlan_parent_interface: 'enp5s0', vlan_tag: 20, vlan_pcp: null, description: 'Cameras' });
    expect(created.state.aliases).toEqual([]);
    expect(await commit(client, { checkin_timeout: 5 })).toBe('replied');
    await client.call('interface.checkin');
    const live = await iface(client, 'vlan20');
    expect(live.fake).toBe(false);
    expect(live.state).toMatchObject({ link_state: 'LINK_STATE_UP', parent: 'enp5s0', tag: 20 });
    expect(live.state.aliases).toContainEqual(expect.objectContaining({ type: 'INET', address: '10.0.20.5', netmask: 24 }));
    expect((await client.call<Any>('network.general.summary')).ips.vlan20.IPV4).toEqual(['10.0.20.5/24']);

    const parentErr = await failure(client.call('interface.delete', ['enp5s0']));
    expect(parentErr.validationErrors['interface.delete']).toBe('The following VLANs depend on this interface: vlan20');

    expect(await client.call('interface.delete', ['vlan20'])).toBe('vlan20');
    expect((await client.call<Any[]>('interface.query', [[['name', '=', 'vlan20']]])).length).toBe(0);
    await commit(client, { checkin_timeout: 5 });
    await client.call('interface.checkin');
    expect((await client.call<Any>('network.general.summary')).ips.vlan20).toBeUndefined();
  });

  it('gives a DHCP VLAN an address from the VLAN network and names VLANs automatically', async () => {
    const { client } = await setup();
    await client.call('interface.update', ['enp5s0', STATIC_50]);
    const vlan = await client.call<Any>('interface.create', [{ type: 'VLAN', vlan_parent_interface: 'enp5s0', vlan_tag: 30, ipv4_dhcp: true }]);
    expect(vlan.name).toBe('vlan0');
    await client.call('interface.rollback');
    expect((await client.call<Any[]>('interface.query')).map((i) => i.name)).toEqual(['enp5s0', 'enp6s0']);
  });

  it('validates VLAN fields', async () => {
    const { client } = await setup();
    const range = await failure(client.call('interface.create', [{ type: 'VLAN', vlan_parent_interface: 'enp5s0', vlan_tag: 4095 }]));
    expect(range.validationErrors['interface_create.vlan_tag']).toBe('Input should be less than or equal to 4094');
    const missing = await failure(client.call('interface.create', [{ type: 'VLAN', vlan_parent_interface: 'enp5s0' }]));
    expect(missing.validationErrors['interface_create.vlan_tag']).toBe('This field is required');
    const parent = await failure(client.call('interface.create', [{ type: 'VLAN', vlan_parent_interface: 'eth9', vlan_tag: 5 }]));
    expect(parent.validationErrors['interface_create.vlan_parent_interface']).toBe('Not a valid interface.');
    const dhcp = await failure(client.call('interface.create', [{ type: 'VLAN', vlan_parent_interface: 'enp5s0', vlan_tag: 5, ipv4_dhcp: true }]));
    expect(dhcp.validationErrors['interface_create.ipv4_dhcp']).toBe('Only one interface can be used for DHCP.');
    const name = await failure(client.call('interface.create', [{ type: 'VLAN', name: 'iot', vlan_parent_interface: 'enp5s0', vlan_tag: 5 }]));
    expect(name.validationErrors['interface_create.name']).toMatch(/must start with "vlan"/);
  });
});

describe('network: reachability simulation', () => {
  it('cuts clients off until the rollback when the test hook is armed', async () => {
    const { mock, client } = await setup();
    await client.call('interface.update', ['enp6s0', { ipv4_dhcp: false, aliases: [{ type: 'INET', address: '10.10.0.2', netmask: 24 }] }]);
    mock.cutConnectionOnNextCommit();
    expect(await commit(client, { checkin_timeout: 1 })).toBe('cut');
    expect(mock.server.reachable).toBe(false);
    await expect(connect(mock).connect()).rejects.toThrow(TrueNasConnectionError);

    await waitFor(() => mock.server.reachable, 3000);
    const again = await reconnect(mock);
    expect(await again.call('interface.has_pending_changes')).toBe(false);
    expect(await iface(again, 'enp6s0')).toMatchObject({ ipv4_dhcp: false, aliases: [] });
  });

  it('becomes unreachable when no port keeps an address on the home network', async () => {
    const { mock, client } = await setup();
    await client.call('interface.update', ['enp5s0', { ipv4_dhcp: false, aliases: [{ type: 'INET', address: '10.0.0.5', netmask: 24 }] }]);
    expect(await commit(client, { checkin_timeout: 1 })).toBe('cut');
    expect(mock.server.reachable).toBe(false);
    await waitFor(() => mock.server.reachable, 3000);
    const again = await reconnect(mock);
    expect(await again.call('interface.websocket_local_ip')).toBe('192.168.1.20');
  });
});
