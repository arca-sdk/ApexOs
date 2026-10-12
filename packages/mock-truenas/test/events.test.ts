import { describe, expect, it } from 'vitest';
import { createPool, setup, waitFor, type Any } from './helpers.ts';

describe('events', () => {
  it('streams reporting.realtime samples shaped like the middleware', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const updates: Any[] = [];
    await client.subscribe<Any>('reporting.realtime', (u) => updates.push(u));
    await waitFor(() => updates.length > 0);
    const { msg, collection, fields } = updates[0];
    expect(msg).toBe('added');
    expect(collection).toBe('reporting.realtime');
    expect(fields.cpu.cpu).toEqual({ usage: expect.any(Number), temp: expect.any(Number) });
    expect(Object.keys(fields.cpu)).toHaveLength(13);
    expect(fields.cpu.cpu11).toBeDefined();
    expect(fields.memory).toMatchObject({ physical_memory_total: 32 * 1024 ** 3, arc_size: expect.any(Number), physical_memory_available: expect.any(Number) });
    expect(fields.memory.physical_memory_available).toBeLessThan(fields.memory.physical_memory_total);
    expect(fields.disks).toEqual({ read_ops: expect.any(Number), read_bytes: expect.any(Number), write_ops: expect.any(Number), write_bytes: expect.any(Number), busy: expect.any(Number) });
    expect(fields.interfaces.enp5s0).toMatchObject({ link_state: 'LINK_STATE_UP', speed: 1000, received_bytes_rate: expect.any(Number), sent_bytes_rate: expect.any(Number) });
    expect(fields.interfaces.enp6s0).toMatchObject({ link_state: 'LINK_STATE_DOWN', received_bytes_rate: 0 });
    expect(fields.zfs.demand_data_hit_percentage).toBeGreaterThan(90);
    expect(Object.keys(fields.pools).sort()).toEqual(['HDDs', 'SSDs']);
  });

  it('accepts event source arguments and rejects invalid intervals', async () => {
    const { client } = await setup();
    const name = 'reporting.realtime:{"interval":2}';
    const updates: Any[] = [];
    await client.subscribe<Any>(name, (u) => updates.push(u));
    await waitFor(() => updates.length > 0);
    expect(updates[0].collection).toBe(name);
    await expect(client.call('core.subscribe', ['reporting.realtime:{"interval":1}'])).rejects.toThrow(/greater than or equal to 2/);
  });

  it('emits CRUD, alert and job events', async () => {
    const { mock, client } = await setup();
    const pools: Any[] = [];
    const datasets: Any[] = [];
    const alerts: Any[] = [];
    const jobs: Any[] = [];
    await client.subscribe<Any>('pool.query', (u) => pools.push(u));
    await client.subscribe<Any>('pool.dataset.query', (u) => datasets.push(u));
    await client.subscribe<Any>('alert.list', (u) => alerts.push(u));
    client.on('job', (j) => jobs.push(j));

    const pool = await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    expect(pools).toContainEqual(expect.objectContaining({ msg: 'added', id: pool.id, fields: expect.objectContaining({ name: 'tank' }) }));
    expect(datasets).toContainEqual(expect.objectContaining({ msg: 'added', id: 'tank' }));
    expect(jobs.some((j) => j.method === 'pool.create' && j.state === 'RUNNING')).toBe(true);

    mock.failDrive('sdc');
    await waitFor(() => alerts.length > 0 && pools.some((u) => u.msg === 'changed'));
    expect(pools.find((u) => u.msg === 'changed').fields.status).toBe('DEGRADED');
    const alert = alerts.find((u) => u.msg === 'added').fields;
    expect(alert).toMatchObject({ klass: 'VolumeStatus', level: 'CRITICAL', dismissed: false, args: { volume: 'tank', state: 'DEGRADED' } });
    await client.call('alert.dismiss', [alert.uuid]);
    expect((await client.call<Any[]>('alert.list')).find((a) => a.uuid === alert.uuid).dismissed).toBe(true);
    await client.call('alert.restore', [alert.uuid]);
    mock.restoreDrive('sdc');
    await waitFor(() => alerts.some((u) => u.msg === 'removed' && u.id === alert.uuid));
    expect((await client.call<Any>('pool.get_instance', [pool.id])).status).toBe('ONLINE');

    mock.setDiskTemperature('sdb', 72);
    expect((await client.call<Any>('disk.temperatures', [['sdb']])).sdb).toBe(72);
    expect((await client.call<Any[]>('alert.list')).some((a) => a.klass === 'DiskTemperatureTooHot')).toBe(true);
    mock.setDiskTemperature('sdb', null);
    expect((await client.call<Any[]>('alert.list')).some((a) => a.klass === 'DiskTemperatureTooHot')).toBe(false);
  });

  it('runs updates and reports the new version', async () => {
    const { client } = await setup();
    const status = await client.call<Any>('update.status');
    expect(status).toMatchObject({ code: 'NORMAL', status: { new_version: { version: '25.10.8', release_notes_url: expect.stringContaining('truenas.com') } } });
    const events: Any[] = [];
    await client.subscribe<Any>('update.status', (u) => events.push(u.fields));
    expect(await client.job('update.run', [{ reboot: false }])).toBe(true);
    expect(events.some((e) => e.status.update_download_progress?.percent > 0)).toBe(true);
    expect(await client.call('system.version_short')).toBe('25.10.8');
    expect((await client.call<Any>('update.status')).status.new_version).toBeNull();
    expect((await client.call<Any[]>('alert.list')).some((a) => a.klass === 'HasUpdate')).toBe(false);
    await expect(client.call('system.reboot', [''])).rejects.toThrow(/reason/);
    expect(await client.job('system.reboot', ['Applying update from ApexOs', { delay: null }])).toBeNull();
  });

  it('serves network and general settings', async () => {
    const { client } = await setup();
    expect(await client.call('interface.websocket_local_ip')).toBe('192.168.1.20');
    const ifaces = await client.call<Any[]>('interface.query');
    expect(ifaces.map((i) => [i.name, i.type, i.state.link_state])).toEqual([
      ['enp5s0', 'PHYSICAL', 'LINK_STATE_UP'],
      ['enp6s0', 'PHYSICAL', 'LINK_STATE_DOWN'],
    ]);
    expect(ifaces[0].state.aliases).toContainEqual(expect.objectContaining({ type: 'INET', address: '192.168.1.20', netmask: 24 }));
    expect(await client.call('network.general.summary')).toMatchObject({ ips: { enp5s0: { IPV4: ['192.168.1.20/24'] } }, default_routes: ['192.168.1.1'], nameservers: ['192.168.1.1'] });
    const net = await client.call<Any>('network.configuration.update', [{ hostname: 'homebase' }]);
    expect(net.hostname).toBe('homebase');
    expect((await client.call<Any>('system.info')).hostname).toBe('homebase');
    await expect(client.call('network.configuration.update', [{ hostname: 'bad host' }])).rejects.toThrow(/Invalid hostname/);
    const tz = await client.call<Record<string, string>>('system.general.timezone_choices');
    expect(Object.keys(tz).length).toBeGreaterThanOrEqual(40);
    expect((await client.call<Any>('system.general.update', [{ timezone: 'Europe/Berlin' }])).timezone).toBe('Europe/Berlin');
    await expect(client.call('system.general.update', [{ timezone: 'Mars/Olympus' }])).rejects.toThrow(/Timezone/);
    expect((await client.call<Any>('smb.config')).netbiosname).toBe('truenas');
  });
});
