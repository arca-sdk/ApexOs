import { describe, expect, it } from 'vitest';
import { createPool, failure, setup, sleep, type Any } from './helpers.ts';

const TB8 = 8001563222016;

describe('disks', () => {
  it('reports used and unused disks, including the exported pool on sdf', async () => {
    const { client } = await setup();
    const both = await client.call<Any>('disk.details', [{ type: 'BOTH' }]);
    const used = Object.fromEntries(both.used.map((d: Any) => [d.name, d]));
    expect(Object.keys(used).sort()).toEqual(['sda', 'sdf']);
    expect(used.sdf).toMatchObject({ exported_zpool: 'oldtank', imported_zpool: null, model: 'WDC WD40EFAX-68JH4N1', rotationrate: 5400 });
    expect(used.sdf.partitions).toEqual([]);
    const joined = await client.call<Any[]>('disk.details', [{ type: 'USED', join_partitions: true }]);
    expect(joined.find((d) => d.name === 'sdf').partitions).toEqual([expect.objectContaining({ name: 'sdf1', partition_type: '6a898cc3-1dd2-11b2-99a6-080020736631' })]);
    expect(joined.find((d) => d.name === 'sda').partitions.map((p: Any) => p.name)).toEqual(['sda1', 'sda2', 'sda3']);
    expect(used.sda).toMatchObject({ imported_zpool: 'boot-pool' });
    const unused = await client.call<Any[]>('disk.details', [{ type: 'UNUSED' }]);
    expect(unused.map((d) => d.name).sort()).toEqual(['nvme0n1', 'nvme1n1', 'sdb', 'sdc', 'sdd', 'sde', 'sdg']);
    expect(unused.find((d) => d.name === 'sdg')).toMatchObject({ bus: 'USB', exported_zpool: null });

    const disks = await client.call<Any[]>('disk.query', [[], { extra: { pools: true }, order_by: ['name'] }]);
    const sda = disks.find((d) => d.name === 'sda');
    expect(sda).toMatchObject({ pool: 'boot-pool', type: 'SSD', bus: 'ATA', model: 'Crucial MX500' });
    const nvme = disks.find((d) => d.name === 'nvme0n1');
    expect(nvme).toMatchObject({ type: 'SSD', rotationrate: null, subsystem: 'nvme', bus: 'NVME', size: 1000204886016 });
    const sdb = disks.find((d) => d.name === 'sdb');
    expect(sdb).toMatchObject({ type: 'HDD', rotationrate: 7200, size: TB8, model: 'ST8000VN004-2M2101', pool: null, devname: 'sdb' });
    expect(sdb.identifier).toMatch(/^\{serial_lunid\}ZR16N8KQ_5000c500/);
    expect(disks.find((d) => d.name === 'sdg').identifier).toMatch(/^\{serial\}/);
    // Without extra.pools, `pool` stays null.
    expect((await client.call<Any[]>('disk.query', [[['name', '=', 'sda']]]))[0].pool).toBeNull();

    expect(await client.call('boot.get_disks')).toEqual(['sda']);
    expect(await client.call<Any>('boot.get_state')).toMatchObject({ name: 'boot-pool', status: 'ONLINE', healthy: true });
    const temps = await client.call<Record<string, number | null>>('disk.temperatures', [[], false]);
    expect(temps.sdb).toBeGreaterThanOrEqual(33);
    expect(temps.sdb).toBeLessThanOrEqual(41);
    expect(temps.nvme0n1).toBeGreaterThanOrEqual(42);
    expect(temps.sdg).toBeNull();
    const withThresholds = await client.call<Record<string, Any>>('disk.temperatures', [['sdb'], true]);
    expect(withThresholds.sdb).toHaveLength(2);
  });

  it('wipes a disk with an exported pool so it becomes unused', async () => {
    const { client } = await setup();
    await expect(client.job('disk.wipe', ['sda', 'QUICK', true])).rejects.toThrow(/in use by pool boot-pool/);
    await client.job('disk.wipe', ['sdf', 'QUICK', true]);
    const unused = await client.call<Any[]>('disk.details', [{ type: 'UNUSED' }]);
    expect(unused.map((d) => d.name)).toContain('sdf');
    expect(await client.job('pool.import_find')).toEqual([]);
  });
});

describe('pools', () => {
  it('creates a RAIDZ1 pool through a job and reports topology and size', async () => {
    const { client } = await setup();
    const progress: string[] = [];
    const result = await client.job<Any>('pool.create', [{ name: 'tank', topology: { data: [{ type: 'RAIDZ1', disks: ['sdb', 'sdc', 'sdd'] }] } }], (j) =>
      progress.push(String(j.progress.description)),
    );
    expect(result.name).toBe('tank');
    expect(progress).toContain('Formatting disks');

    const pool = await client.call<Any>('pool.query', [[['name', '=', 'tank']], { get: true }]);
    expect(pool).toMatchObject({ id: 1, name: 'tank', status: 'ONLINE', healthy: true, path: '/mnt/tank', status_code: 'OK', expand: null });
    expect(pool.scan.function).toBeNull();
    expect(pool.autotrim).toMatchObject({ value: 'off', source: 'DEFAULT' });
    const vdev = pool.topology.data[0];
    expect(vdev).toMatchObject({ type: 'RAIDZ1', name: 'raidz1-0', status: 'ONLINE' });
    expect(vdev.children.map((c: Any) => c.disk)).toEqual(['sdb', 'sdc', 'sdd']);
    expect(vdev.children[0]).toMatchObject({ type: 'DISK', device: 'sdb1', status: 'ONLINE', stats: { read_errors: 0, write_errors: 0, checksum_errors: 0 } });
    expect(pool.topology).toMatchObject({ log: [], cache: [], spare: [], special: [], dedup: [] });

    expect(pool.size).toBe(Math.floor(2 * TB8 * 0.97));
    expect(pool.allocated).toBeGreaterThan(0);
    expect(pool.free).toBe(pool.size - pool.allocated);

    const disks = await client.call<Any[]>('disk.query', [[['name', 'in', ['sdb', 'sdc', 'sdd']]], { extra: { pools: true } }]);
    for (const d of disks) {
      expect(d.pool).toBe('tank');
      expect(vdev.children.find((c: Any) => c.disk === d.name).guid).toBe(d.zfs_guid);
    }
    const root = await client.call<Any>('pool.dataset.get_instance', ['tank']);
    expect(root).toMatchObject({ id: 'tank', pool: 'tank', mountpoint: '/mnt/tank' });
    expect(root.compression.value).toBe('LZ4');
    const unused = await client.call<Any[]>('disk.details', [{ type: 'UNUSED' }]);
    expect(unused.map((d) => d.name)).not.toContain('sdb');
    const tasks = await client.call<Any[]>('pool.scrub.query');
    expect(tasks).toEqual([expect.objectContaining({ pool: 1, pool_name: 'tank', threshold: 35, enabled: true })]);
  });

  it('computes MIRROR and STRIPE capacity and attaches spares', async () => {
    const { client } = await setup();
    const mirror = await createPool(client, 'SSDs', 'MIRROR', ['nvme0n1', 'nvme1n1']);
    expect(mirror.size).toBe(1000204886016);
    expect(mirror.topology.data[0].name).toBe('mirror-0');
    const stripe = await createPool(client, 'scratch', 'STRIPE', ['sdb', 'sdc']);
    expect(stripe.size).toBe(2 * TB8);
    expect(stripe.topology.data.map((v: Any) => v.type)).toEqual(['DISK', 'DISK']);
    const updated = await client.job<Any>('pool.update', [mirror.id, { topology: { spares: ['sdd'] } }]);
    expect(updated.topology.spare).toEqual([expect.objectContaining({ disk: 'sdd', status: 'AVAIL' })]);
    await client.job('pool.remove', [mirror.id, { label: updated.topology.spare[0].guid }]);
    expect((await client.call<Any>('pool.get_instance', [mirror.id])).topology.spare).toEqual([]);
  });

  it('rejects invalid layouts with field errors', async () => {
    const { client } = await setup();
    const tooFew = await failure(createPool(client, 'tank', 'RAIDZ1', ['sdb', 'sdc']));
    expect(tooFew.validationErrors['pool_create.topology.data.0.disks']).toMatch(/at least 3 disk/);
    const boot = await failure(createPool(client, 'tank', 'MIRROR', ['sda', 'sdb']));
    expect(boot.validationErrors['pool_create.topology']).toBe('The following disks are already in use: sda.');
    const missing = await failure(createPool(client, 'tank', 'MIRROR', ['sdb', 'sdz']));
    expect(missing.validationErrors['pool_create.topology']).toMatch(/not found in system: sdz/);
    const badName = await failure(createPool(client, 'my tank', 'MIRROR', ['sdb', 'sdc']));
    expect(badName.code).toBe(-32602);
    expect(badName.validationErrors['pool_create.name']).toMatch(/whitespace/);
    const badType = await failure(client.call('pool.create', [{ name: 'tank', topology: { data: [{ type: 'RAID5', disks: ['sdb'] }] } }]));
    expect(badType.validationErrors['pool_create.topology.data.0.type']).toBeDefined();
    await expect(client.call('pool.validate_name', ['boot-pool'])).rejects.toThrow(/reserved/);
    expect(await client.call('pool.validate_name', ['tank'])).toBe(true);
    await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    const dup = await failure(createPool(client, 'tank', 'MIRROR', ['sdd', 'sde']));
    expect(dup.validationErrors['pool_create.name']).toMatch(/already exists/);
  });

  it('replaces a failed drive with a simulated resilver', async () => {
    const { mock, client } = await setup();
    const created = await createPool(client, 'tank', 'RAIDZ1', ['sdb', 'sdc', 'sdd']);
    mock.failDrive('sdc');
    const degraded = await client.call<Any>('pool.get_instance', [created.id]);
    expect(degraded).toMatchObject({ status: 'DEGRADED', healthy: false, status_code: 'FAULTED_DEV_R' });
    const bad = degraded.topology.data[0].children.find((c: Any) => c.disk === 'sdc');
    expect(bad).toMatchObject({ status: 'FAULTED', stats: { write_errors: 117 } });
    const alerts = await client.call<Any[]>('alert.list');
    expect(alerts).toContainEqual(expect.objectContaining({ klass: 'VolumeStatus', level: 'CRITICAL', formatted: expect.stringContaining('Pool tank state is DEGRADED') }));

    const scans: Any[] = [];
    await client.subscribe('zfs.pool.scan', (u) => scans.push(u.fields));
    const tooSmall = await failure(client.job('pool.replace', [created.id, { label: bad.guid, disk: 'sdg' }]));
    expect(tooSmall.validationErrors['options.disk']).toMatch(/too small/);
    expect(await client.job('pool.replace', [created.id, { label: bad.guid, disk: 'sde' }])).toBe(true);
    expect(scans.some((s) => s.name === 'tank' && s.scan.function === 'RESILVER' && s.scan.state === 'SCANNING')).toBe(true);

    const healed = await client.call<Any>('pool.get_instance', [created.id]);
    expect(healed).toMatchObject({ status: 'ONLINE', healthy: true });
    expect(healed.scan).toMatchObject({ function: 'RESILVER', state: 'FINISHED', percentage: 100 });
    expect(healed.topology.data[0].children.map((c: Any) => c.disk)).toEqual(['sdb', 'sde', 'sdd']);
    expect((await client.call<Any[]>('alert.list')).some((a) => a.klass === 'VolumeStatus')).toBe(false);
    const unused = await client.call<Any[]>('disk.details', [{ type: 'UNUSED' }]);
    expect(unused.map((d) => d.name)).toContain('sdc');
  });

  it('shows a REPLACING vdev while the resilver runs and handles pulled drives', async () => {
    const { mock, client } = await setup({ jobDelayMs: 40 });
    const created = await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    mock.failDrive('sdc', 'REMOVED');
    const pool = await client.call<Any>('pool.get_instance', [created.id]);
    const missing = pool.topology.data[0].children[1];
    expect(missing).toMatchObject({ status: 'REMOVED', disk: null, device: null });
    expect(missing.unavail_disk).toMatchObject({ serial: 'ZR16N9F3' });
    expect((await client.call<Any[]>('disk.query')).map((d) => d.name)).not.toContain('sdc');

    const jobId = await client.call<number>('pool.replace', [created.id, { label: missing.guid, disk: 'sdd' }]);
    await sleep(120);
    const during = await client.call<Any>('pool.get_instance', [created.id]);
    const replacing = during.topology.data[0].children[1];
    expect(replacing.type).toBe('REPLACING');
    expect(replacing.children.map((c: Any) => c.status)).toEqual(['REMOVED', 'ONLINE']);
    expect(during.status_code).toBe('RESILVERING');
    await client.waitForJob(jobId);
    const after = await client.call<Any>('pool.get_instance', [created.id]);
    expect(after.topology.data[0].children.map((c: Any) => c.disk)).toEqual(['sdb', 'sdd']);
    expect(after.status).toBe('ONLINE');
  });

  it('expands a RAIDZ vdev with pool.attach', async () => {
    const { client } = await setup();
    const created = await createPool(client, 'tank', 'RAIDZ1', ['sdb', 'sdc', 'sdd']);
    await client.job('pool.attach', [created.id, { target_vdev: created.topology.data[0].guid, new_disk: 'sde' }]);
    const pool = await client.call<Any>('pool.get_instance', [created.id]);
    expect(pool.topology.data[0].children).toHaveLength(4);
    expect(pool.expand).toMatchObject({ state: 'FINISHED', percentage: 100, expanding_vdev: 0 });
    expect(pool.size).toBe(Math.floor(3 * TB8 * 0.97));
    // Widening a mirror
    const mirror = await createPool(client, 'fast', 'MIRROR', ['nvme0n1', 'nvme1n1']);
    const bad = await failure(client.job('pool.attach', [mirror.id, { target_vdev: mirror.topology.data[0].guid, new_disk: 'sdg' }]));
    expect(bad.validationErrors['pool_attach.new_disk']).toMatch(/too small/);
  });

  it('scrubs a pool and emits zfs.pool.scan progress', async () => {
    const { client } = await setup();
    const created = await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    const scans: Any[] = [];
    await client.subscribe('zfs.pool.scan', (u) => scans.push(u.fields));
    await client.job('pool.scrub', [created.id, 'START']);
    expect(scans.filter((s) => s.scan.function === 'SCRUB').length).toBeGreaterThanOrEqual(3);
    const pool = await client.call<Any>('pool.get_instance', [created.id]);
    expect(pool.scan).toMatchObject({ function: 'SCRUB', state: 'FINISHED', percentage: 100, errors: 0 });
    expect(pool.scan.end_time).toHaveProperty('$date');
    expect((await client.call<Any[]>('alert.list')).some((a) => a.klass === 'ScrubFinished')).toBe(true);
    await expect(client.job('pool.scrub', [created.id, 'STOP'])).rejects.toThrow(/no active scrub/);
    await expect(client.call('pool.scrub', [created.id, 'GO'])).rejects.toThrow();
  });

  it('stops a running scrub', async () => {
    const { client } = await setup({ jobDelayMs: 30 });
    const created = await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    const running = client.job('pool.scrub.scrub', ['tank', 'START']);
    await sleep(50);
    await client.job('pool.scrub', [created.id, 'STOP']);
    await running;
    const pool = await client.call<Any>('pool.get_instance', [created.id]);
    expect(pool.scan).toMatchObject({ function: 'SCRUB', state: 'CANCELED' });
  });

  it('finds and imports the exported pool from the old NAS', async () => {
    const { client } = await setup();
    const found = await client.job<Any[]>('pool.import_find');
    expect(found).toEqual([{ name: 'oldtank', guid: expect.any(String), status: 'ONLINE', hostname: 'old-nas' }]);
    expect(await client.job('pool.import_pool', [{ guid: found[0].guid }])).toBe(true);
    const pool = await client.call<Any>('pool.query', [[['name', '=', 'oldtank']], { get: true }]);
    expect(pool).toMatchObject({ id: 1, status: 'ONLINE', guid: found[0].guid });
    expect(pool.topology.data).toEqual([expect.objectContaining({ type: 'DISK', disk: 'sdf' })]);
    expect(pool.allocated).toBeGreaterThan(1000 * 1024 ** 3);
    const datasets = await client.call<Any[]>('pool.dataset.query', [[['pool', '=', 'oldtank']]]);
    expect(datasets.map((d) => d.id)).toEqual(['oldtank', 'oldtank/Backups', 'oldtank/Old-Photos']);
    const photos = await client.call<Any[]>('filesystem.listdir', ['/mnt/oldtank/Old-Photos']);
    expect(photos.map((e) => e.name)).toContain('2019');
    const used = await client.call<Any[]>('disk.details', [{ type: 'USED' }]);
    expect(used.find((d) => d.name === 'sdf')).toMatchObject({ imported_zpool: 'oldtank', exported_zpool: null });
    expect(await client.job('pool.import_find')).toEqual([]);
  });

  it('exports with destroy and frees the disks', async () => {
    const { client } = await setup();
    const created = await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    await client.call('pool.dataset.create', [{ name: 'tank/Stuff', share_type: 'SMB' }]);
    await client.call('sharing.smb.create', [{ name: 'Stuff', path: '/mnt/tank/Stuff' }]);
    const removed: Any[] = [];
    await client.subscribe('pool.query', (u) => removed.push(u));
    await client.job('pool.export', [created.id, { destroy: true, cascade: true }]);
    expect(await client.call('pool.query')).toEqual([]);
    expect(await client.call('pool.dataset.query', [[['pool', '=', 'tank']]])).toEqual([]);
    expect(await client.call('sharing.smb.query')).toEqual([]);
    expect(removed).toContainEqual(expect.objectContaining({ msg: 'removed', id: created.id }));
    const disks = await client.call<Any[]>('disk.query', [[['name', 'in', ['sdb', 'sdc']]], { extra: { pools: true } }]);
    expect(disks.every((d) => d.zfs_guid === null && d.pool === null)).toBe(true);
    const unused = await client.call<Any[]>('disk.details', [{ type: 'UNUSED' }]);
    expect(unused.map((d) => d.name)).toEqual(expect.arrayContaining(['sdb', 'sdc']));
    expect((await client.job<Any[]>('pool.import_find')).map((p) => p.name)).toEqual(['oldtank']);
  });

  it('exports without destroy and imports the pool again with its data', async () => {
    const { client } = await setup();
    const created = await createPool(client, 'tank', 'MIRROR', ['sdb', 'sdc']);
    await client.call('pool.dataset.create', [{ name: 'tank/Keep', quota: 2 * 1024 ** 3 }]);
    await client.job('pool.export', [created.id, {}]);
    const used = await client.call<Any[]>('disk.details', [{ type: 'USED' }]);
    expect(used.find((d) => d.name === 'sdb')).toMatchObject({ exported_zpool: 'tank' });
    const found = await client.job<Any[]>('pool.import_find');
    const tank = found.find((p) => p.name === 'tank');
    expect(tank).toMatchObject({ hostname: 'truenas', status: 'ONLINE' });
    await client.job('pool.import_pool', [{ guid: tank.guid, name: 'tank2' }]);
    const keep = await client.call<Any>('pool.dataset.get_instance', ['tank2/Keep']);
    expect(keep.quota.parsed).toBe(2 * 1024 ** 3);
    expect((await client.call<Any>('pool.query', [[['name', '=', 'tank2']], { get: true }])).id).toBe(2);
  });
});
