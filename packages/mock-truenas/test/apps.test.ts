import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/index.ts';
import { createPool, failure, setup, waitFor, type Any } from './helpers.ts';

const REQUIRED_APPS = [
  'jellyfin',
  'plex',
  'emby',
  'immich',
  'nextcloud',
  'syncthing',
  'home-assistant',
  'qbittorrent',
  'sonarr',
  'radarr',
  'prowlarr',
  'lidarr',
  'bazarr',
  'seerr',
  'navidrome',
  'paperless-ngx',
  'actual-budget',
  'vaultwarden',
  'pihole',
  'adguard-home',
  'uptime-kuma',
  'audiobookshelf',
  'aistor',
  'gitea',
  'homepage',
  'filebrowser',
];

describe('catalog', () => {
  it('ships real catalog metadata', async () => {
    expect(CATALOG.map((a) => a.name)).toEqual(expect.arrayContaining(REQUIRED_APPS));
    const { client } = await setup();
    const apps = await client.call<Any[]>('app.available');
    expect(apps.length).toBeGreaterThanOrEqual(25);
    const jellyfin = apps.find((a) => a.name === 'jellyfin');
    expect(jellyfin).toMatchObject({ train: 'community', catalog: 'TRUENAS', installed: false, title: 'Jellyfin', categories: ['media'], home: 'https://jellyfin.org/' });
    expect(jellyfin.icon_url).toMatch(/^https:\/\/media\.sys\.truenas\.net\//);
    expect(jellyfin.last_update).toHaveProperty('$date');
    expect(apps.find((a) => a.name === 'plex').train).toBe('stable');
    expect(await client.call('app.categories')).toEqual(expect.arrayContaining(['media', 'productivity', 'networking']));
    const selected = await client.call<Any[]>('app.available', [[['name', '=', 'immich']], { select: ['name', 'title', 'train', 'latest_version', 'installed'] }]);
    expect(Object.keys(selected[0]).sort()).toEqual(['installed', 'latest_version', 'name', 'title', 'train']);
    const details = await client.call<Any>('catalog.get_app_details', ['jellyfin', { train: 'community' }]);
    const version = details.versions[jellyfin.latest_version];
    expect(version.schema.questions.map((q: Any) => q.variable)).toEqual(expect.arrayContaining(['network', 'storage']));
    expect(await client.call<Any>('catalog.config')).toMatchObject({ id: 'TRUENAS', preferred_trains: ['stable', 'community'] });
    await client.call('catalog.update', [{ preferred_trains: ['stable'] }]);
    expect((await client.call<Any[]>('app.available')).every((a) => a.train === 'stable')).toBe(true);
  });
});

describe('apps', () => {
  it('refuses to install apps before an apps pool is configured', async () => {
    const { client } = await setup();
    expect(await client.call('docker.status')).toEqual({ status: 'UNCONFIGURED', description: '' });
    expect(await client.call<Any>('docker.config')).toMatchObject({ pool: null, dataset: null });
    expect(await client.call('app.query')).toEqual([]);
    await expect(client.job('app.create', [{ app_name: 'jellyfin', catalog_app: 'jellyfin', train: 'community' }])).rejects.toThrow('Docker service is not running');
  });

  it('configures docker, installs an app and reports portals', async () => {
    const { client } = await setup();
    await createPool(client, 'SSDs', 'MIRROR', ['nvme0n1', 'nvme1n1']);
    const dockerStates: string[] = [];
    await client.subscribe<Any>('docker.state', (u) => dockerStates.push(u.fields.status));
    const config = await client.job<Any>('docker.update', [{ pool: 'SSDs' }]);
    expect(config).toMatchObject({ pool: 'SSDs', dataset: 'SSDs/ix-apps' });
    expect(dockerStates).toEqual(['INITIALIZING', 'RUNNING']);
    expect(await client.call('docker.status')).toEqual({ status: 'RUNNING', description: '' });
    const ixApps = await client.call<Any>('pool.dataset.get_instance', ['SSDs/ix-apps']);
    expect(ixApps.mountpoint).toBe('/mnt/.ix-apps');
    expect(await client.call('service.query', [[['service', '=', 'docker']], { get: true }])).toMatchObject({ enable: true, state: 'RUNNING' });

    const appEvents: Any[] = [];
    await client.subscribe<Any>('app.query', (u) => appEvents.push(u));
    const progress: string[] = [];
    const created = await client.job<Any>(
      'app.create',
      [{ app_name: 'jellyfin', catalog_app: 'jellyfin', train: 'community', values: { TZ: 'America/Los_Angeles' } }],
      (j) => progress.push(String(j.progress.description)),
    );
    expect(progress).toContain('Pulling Docker images');
    expect(created).toMatchObject({ name: 'jellyfin', id: 'jellyfin', state: 'RUNNING', custom_app: false, upgrade_available: false });
    expect(appEvents.map((e) => [e.msg, e.fields?.state])).toEqual(expect.arrayContaining([['added', 'DEPLOYING'], ['changed', 'RUNNING']]));

    const app = await client.call<Any>('app.query', [[['name', '=', 'jellyfin']], { get: true, extra: { retrieve_config: true } }]);
    const cat = CATALOG.find((c) => c.name === 'jellyfin')!;
    expect(app).toMatchObject({
      state: 'RUNNING',
      version: cat.latest_version,
      latest_version: cat.latest_version,
      human_version: `${cat.latest_app_version}_${cat.latest_version}`,
      portals: { 'Web UI': 'http://192.168.1.20:30013/' },
      metadata: { name: 'jellyfin', title: 'Jellyfin', train: 'community' },
    });
    expect(app.config.TZ).toBe('America/Los_Angeles');
    expect(app.config.network.web_port.port_number).toBe(30013);
    expect(app.active_workloads.containers).toBeGreaterThanOrEqual(1);
    expect(app.active_workloads.used_ports).toContainEqual(expect.objectContaining({ container_port: 30013, protocol: 'tcp' }));
    expect(app.active_workloads.images).toContain(cat.images.image);
    expect(app.notes).toMatch(/Thank you for installing Jellyfin/);
    const hostOverride = await client.call<Any>('app.query', [[['name', '=', 'jellyfin']], { get: true, extra: { host_ip: 'nas.local' } }]);
    expect(hostOverride.portals['Web UI']).toBe('http://nas.local:30013/');
    expect(await client.call('app.used_ports')).toEqual(expect.arrayContaining([30013]));
    expect((await client.call<Any[]>('app.available', [[['name', '=', 'jellyfin']]]))[0].installed).toBe(true);
    const volumes = await client.call<Any[]>('pool.dataset.query', [[['id', '^', 'SSDs/ix-apps/app_mounts/jellyfin']]]);
    expect(volumes.map((d) => d.id)).toEqual(expect.arrayContaining(['SSDs/ix-apps/app_mounts/jellyfin/config', 'SSDs/ix-apps/app_mounts/jellyfin/cache']));

    // Validation: duplicate name, port conflict, bad name, missing host path.
    const dup = await failure(client.job('app.create', [{ app_name: 'jellyfin', catalog_app: 'jellyfin', train: 'community' }]));
    expect(dup.validationErrors['app_create.app_name']).toMatch(/already exists/);
    const conflict = await failure(
      client.job('app.create', [{ app_name: 'jelly2', catalog_app: 'jellyfin', train: 'community', values: { network: { https_port: { port_number: 30114 } } } }]),
    );
    expect(conflict.validationErrors['app_create.values.network.web_port.port_number']).toMatch(/"jellyfin" application/);
    const badName = await failure(client.call('app.create', [{ app_name: 'Jelly_Fin', catalog_app: 'jellyfin', train: 'community' }]));
    expect(badName.code).toBe(-32602);
    expect(badName.validationErrors['app_create.app_name']).toMatch(/pattern/);
    const unknown = await failure(client.job('app.create', [{ app_name: 'x', catalog_app: 'not-an-app', train: 'community' }]));
    expect(unknown.validationErrors['app_create.catalog_app']).toBeDefined();
    const hostPath = await failure(
      client.job('app.create', [
        {
          app_name: 'navidrome',
          catalog_app: 'navidrome',
          train: 'community',
          values: { storage: { music: { type: 'host_path', host_path_config: { path: '/mnt/SSDs/Music' } } } },
        },
      ]),
    );
    expect(hostPath.validationErrors['app_create.values.storage.music.host_path_config.path']).toMatch(/does not exist/);

    // Lifecycle
    await client.job('app.stop', ['jellyfin']);
    const stopped = await client.call<Any>('app.get_instance', ['jellyfin']);
    expect(stopped).toMatchObject({ state: 'STOPPED', active_workloads: { containers: 0, used_ports: [] } });
    await client.job('app.start', ['jellyfin']);
    expect((await client.call<Any>('app.get_instance', ['jellyfin'])).state).toBe('RUNNING');
    const updated = await client.job<Any>('app.update', ['jellyfin', { values: { network: { web_port: { port_number: 30096 } } } }]);
    expect(updated.portals['Web UI']).toBe('http://192.168.1.20:30096/');
    await expect(client.call('app.upgrade_summary', ['jellyfin'])).rejects.toThrow(/No upgrade available/);
    expect(await client.job('app.delete', ['jellyfin', { remove_images: true, remove_ix_volumes: true }])).toBe(true);
    expect(await client.call('app.query')).toEqual([]);
    expect(await client.call('pool.dataset.query', [[['id', '^', 'SSDs/ix-apps/app_mounts/jellyfin']]])).toEqual([]);
  });

  it('upgrades an outdated app in the configured scenario', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const cat = CATALOG.find((c) => c.name === 'jellyfin')!;
    const app = await client.call<Any>('app.get_instance', ['jellyfin']);
    expect(app).toMatchObject({ state: 'RUNNING', upgrade_available: true, latest_version: cat.latest_version });
    expect(app.version).not.toBe(cat.latest_version);
    expect(app.active_workloads.volumes).toContainEqual(expect.objectContaining({ source: '/mnt/HDDs/Media', destination: '/media' }));
    expect((await client.call<Any[]>('alert.list')).map((a) => a.klass)).toEqual(expect.arrayContaining(['AppUpdate', 'HasUpdate']));
    expect(await client.call('pool.dataset.attachments', ['HDDs/Media'])).toContainEqual({ type: 'Applications', service: 'docker', attachments: ['jellyfin'] });

    const summary = await client.call<Any>('app.upgrade_summary', ['jellyfin', { app_version: 'latest' }]);
    expect(summary).toMatchObject({ latest_version: cat.latest_version, upgrade_version: cat.latest_version, upgrade_human_version: cat.latest_human_version });
    const upgraded = await client.job<Any>('app.upgrade', ['jellyfin', { app_version: 'latest' }]);
    expect(upgraded).toMatchObject({ version: cat.latest_version, upgrade_available: false, state: 'RUNNING' });
    expect((await client.call<Any[]>('alert.list')).some((a) => a.klass === 'AppUpdate')).toBe(false);
    expect(await client.call('app.rollback_versions', ['jellyfin'])).toEqual([app.version]);
  });

  it('moves apps to another pool, keeping the old copy, and refuses to overwrite one', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const attr = 'docker_update.migrate_applications';
    expect((await failure(client.job('docker.update', [{ pool: 'SSDs', migrate_applications: true }]))).validationErrors[attr]).toMatch(/only happens when a new pool/);

    const progress: string[] = [];
    const config = await client.job<Any>('docker.update', [{ pool: 'HDDs', migrate_applications: true }], (j) => progress.push(String(j.progress.description)));
    expect(config).toMatchObject({ pool: 'HDDs', dataset: 'HDDs/ix-apps' });
    expect(progress).toEqual(expect.arrayContaining(["Replicating datasets from 'SSDs' to 'HDDs' pool", 'Migration completed successfully']));
    expect(await client.call('docker.status')).toEqual({ status: 'RUNNING', description: '' });
    expect(await client.call<Any>('app.get_instance', ['jellyfin'])).toMatchObject({ state: 'RUNNING' });
    const ids = (await client.call<Any[]>('pool.dataset.query', [[['id', '^', 'HDDs/ix-apps']]])).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['HDDs/ix-apps', 'HDDs/ix-apps/docker', 'HDDs/ix-apps/app_mounts']));
    expect(await client.call<Any[]>('pool.dataset.query', [[['id', '=', 'SSDs/ix-apps']]])).toHaveLength(1);

    // Moving back would overwrite the copy left on SSDs.
    const back = await failure(client.job('docker.update', [{ pool: 'SSDs', migrate_applications: true }]));
    expect(back.validationErrors[attr]).toBe("Migration of 'HDDs/ix-apps' to 'SSDs/ix-apps' not possible as SSDs/ix-apps already exists.");

    // A plain switch stops the apps and leaves them behind; the copy kept on SSDs comes back, stopped.
    await client.job('docker.update', [{ pool: 'SSDs' }]);
    expect(await client.call<Any>('app.get_instance', ['jellyfin'])).toMatchObject({ state: 'STOPPED' });
    await client.job('docker.update', [{ pool: 'HDDs' }]);
    expect(await client.call<Any>('app.get_instance', ['jellyfin'])).toMatchObject({ state: 'STOPPED' });

    // Erasing the copy on SSDs takes its apps along.
    await client.call('pool.dataset.delete', ['SSDs/ix-apps', { recursive: true }]);
    await client.job('docker.update', [{ pool: 'SSDs' }]);
    expect(await client.call('app.query')).toEqual([]);
  });

  it('updates apps like TrueNAS: sent keys replace stored ones, defaults fill the gaps', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const before = await client.call<Any>('app.config', ['jellyfin']);
    await client.job('app.update', ['jellyfin', { values: { resources: { ...before.resources, limits: { cpus: 4, memory: 8192 } } } }]);
    expect((await client.call<Any>('app.config', ['jellyfin'])).resources.limits).toEqual({ cpus: 4, memory: 8192 });

    // Sending only `resources.gpus` replaces all of `resources`: the limits fall back to their defaults.
    await client.job('app.update', ['jellyfin', { values: { resources: { gpus: { use_all_gpus: true, nvidia_gpu_selection: { '0000:30:00.0': { use_gpu: true } } } } } }]);
    const after = await client.call<Any>('app.config', ['jellyfin']);
    expect(after.resources.limits).toEqual(before.resources.limits);
    expect(after.resources.gpus).toEqual({ use_all_gpus: true, kfd_device_exists: false, nvidia_gpu_selection: {} }); // the card is AMD
    expect(after.storage).toEqual(before.storage);
  });

  it('can only migrate apps from a pool that was configured before', async () => {
    const { client } = await setup();
    await createPool(client, 'SSDs', 'MIRROR', ['nvme0n1', 'nvme1n1']);
    const err = await failure(client.job('docker.update', [{ pool: 'SSDs', migrate_applications: true }]));
    expect(err.validationErrors['docker_update.migrate_applications']).toBe('A pool must have been configured previously for ix-apps dataset migration.');
  });

  it('runs a custom compose app', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const compose = 'services:\n  whoami:\n    image: traefik/whoami:latest\n    ports:\n      - "8080:80"\n    restart: unless-stopped\n';
    const app = await client.job<Any>('app.create', [{ custom_app: true, app_name: 'whoami', custom_compose_config_string: compose }]);
    expect(app).toMatchObject({ custom_app: true, state: 'RUNNING', version: '1.0.0', portals: { 'Web UI': 'http://192.168.1.20:8080/' } });
    expect(app.active_workloads.images).toEqual(['traefik/whoami:latest']);
    const both = await failure(client.call('app.create', [{ custom_app: true, app_name: 'x', custom_compose_config_string: compose, custom_compose_config: { services: {} } }]));
    expect(both.validationErrors['app_create.custom_compose_config']).toBeDefined();
  });

  it('requires schema fields that have no default', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const missing = await failure(client.job('app.create', [{ app_name: 'photoprism', catalog_app: 'photoprism', train: 'stable' }]));
    expect(missing.validationErrors['app_create.values.photoprism.admin_password']).toBe('Field required');
    const ok = await client.job<Any>('app.create', [{ app_name: 'photoprism', catalog_app: 'photoprism', train: 'stable', values: { photoprism: { admin_password: 'correct-horse' } } }]);
    expect(ok.portals['Web UI']).toBe('http://192.168.1.20:20800/');
  });

  it('streams app.stats for running apps', async () => {
    const { client } = await setup({ scenario: 'configured' });
    const stats: Any[] = [];
    await client.subscribe<Any>('app.stats', (u) => stats.push(u.fields));
    await waitFor(() => stats.length > 0);
    expect(stats[0]).toEqual([
      expect.objectContaining({ app_name: 'jellyfin', cpu_usage: expect.any(Number), memory: expect.any(Number), blkio: { read: expect.any(Number), write: expect.any(Number) } }),
    ]);
    expect(stats[0][0].networks[0]).toMatchObject({ interface_name: 'eth0' });
  });
});
