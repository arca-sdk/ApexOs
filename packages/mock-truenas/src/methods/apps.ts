import { syncAppAlerts } from '../alerts.ts';
import type { Mock } from '../context.ts';
import { callError, queryFilter, validationError, validationErrors, type JobControl } from '../rpc.ts';
import { CATALOG, catalogApp, type AppState, type CatalogApp } from '../state.ts';
import { addDataset, datasetAvailable, getDataset, pathKind, removeDatasetTree, renderDataset } from '../storage.ts';
import { $date, argObj, compareVersions, deepMerge, isObj, MiB, nameArg, randomHex, type Obj } from '../util.ts';
import { setServiceState } from './services.ts';

const APP_NAME_RE = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const POPULARITY = [
  'plex',
  'jellyfin',
  'immich',
  'nextcloud',
  'home-assistant',
  'qbittorrent',
  'sonarr',
  'radarr',
  'prowlarr',
  'vaultwarden',
  'pihole',
  'syncthing',
  'tailscale',
  'emby',
  'adguard-home',
  'audiobookshelf',
  'paperless-ngx',
  'uptime-kuma',
  'lidarr',
  'bazarr',
  'seerr',
  'navidrome',
  'homepage',
  'filebrowser',
  'gitea',
  'photoprism',
  'actual-budget',
  'aistor',
];
const WEB_PORT_KEYS = ['web_port', 'http_port', 'console_port', 'webui_port'];
const SERVICE_NAMES: Record<string, string> = {
  ml_image: 'machine-learning',
  redis_image: 'redis',
  nginx_image: 'nginx',
  tika_image: 'tika',
  gotenberg_image: 'gotenberg',
  imaginary_image: 'imaginary',
  opds_image: 'opds',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function visibleApps(mock: Mock): AppState[] {
  const pool = mock.state.docker.pool;
  return pool ? mock.state.apps.filter((a) => a.pool === pool) : [];
}

function findApp(mock: Mock, name: unknown): AppState {
  const app = visibleApps(mock).find((a) => a.name === name);
  if (!app) throw callError('ENOENT', `App ${String(name)} does not exist`);
  return app;
}

function catalogOf(app: AppState): CatalogApp | undefined {
  return app.catalog_app ? catalogApp(app.catalog_app, app.train) : undefined;
}

interface PublishedPort {
  key: string;
  port: number;
  protocol: 'tcp' | 'udp';
  hostIps: string[];
}

/** Ports published on the host according to the app's values (or compose file for custom apps). */
export function publishedPorts(app: Pick<AppState, 'config' | 'custom_app' | 'custom_compose'>): PublishedPort[] {
  if (app.custom_app) return parseCompose(app.custom_compose ?? '', app.config).ports;
  const net = isObj(app.config.network) ? app.config.network : {};
  const hostNetwork = net.host_network === true;
  const out: PublishedPort[] = [];
  for (const [key, v] of Object.entries(net)) {
    if (!isObj(v) || typeof v.port_number !== 'number') continue;
    if (!hostNetwork && v.bind_mode !== 'published') continue;
    const hostIps = Array.isArray(v.host_ips) && v.host_ips.length ? (v.host_ips as string[]) : ['0.0.0.0', '::'];
    const udpOnly = /udp/.test(key);
    out.push({ key, port: v.port_number, protocol: udpOnly ? 'udp' : 'tcp', hostIps });
    if (/dns/.test(key)) out.push({ key, port: v.port_number, protocol: 'udp', hostIps });
  }
  return out;
}

function webPort(app: AppState): number | null {
  const ports = publishedPorts(app).filter((p) => p.protocol === 'tcp');
  for (const k of WEB_PORT_KEYS) {
    const p = ports.find((x) => x.key === k);
    if (p) return p.port;
  }
  if (app.custom_app) return ports[0]?.port ?? null;
  return ports.find((p) => !/dns|bt_|udp|tcp_port|ssh/.test(p.key))?.port ?? null;
}

interface ComposeInfo {
  services: Array<{ name: string; image: string }>;
  ports: PublishedPort[];
}

/** Very small docker-compose reader: service names, images and published ports. */
export function parseCompose(text: string, dict?: Obj): ComposeInfo {
  const services: ComposeInfo['services'] = [];
  const ports: PublishedPort[] = [];
  const addPort = (spec: string) => {
    const m = /^(?:[\d.]+:)?(\d+):(\d+)(?:\/(tcp|udp))?$/.exec(spec.trim().replace(/^["']|["']$/g, ''));
    if (m) ports.push({ key: `port_${m[1]}`, port: Number(m[1]), protocol: (m[3] as 'tcp' | 'udp') ?? 'tcp', hostIps: ['0.0.0.0', '::'] });
  };
  if (dict && isObj(dict.services)) {
    for (const [name, svc] of Object.entries(dict.services)) {
      const image = isObj(svc) && typeof svc.image === 'string' ? svc.image : 'unknown';
      services.push({ name, image });
      if (isObj(svc) && Array.isArray(svc.ports)) for (const p of svc.ports) if (typeof p === 'string' || typeof p === 'number') addPort(String(p));
    }
    return { services, ports };
  }
  let inServices = false;
  let current: { name: string; image: string } | null = null;
  for (const line of text.split('\n')) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (/^\S/.test(line)) inServices = false;
    if (!inServices) continue;
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (svc) {
      current = { name: svc[1]!, image: 'unknown' };
      services.push(current);
      continue;
    }
    const img = /^\s+image:\s*["']?([^\s"']+)["']?/.exec(line);
    if (img && current) current.image = img[1]!;
    const port = /^\s+-\s*["']?([\d.:]+(?:\/(?:tcp|udp))?)["']?\s*$/.exec(line);
    if (port && port[1]!.includes(':')) addPort(port[1]!);
  }
  return { services, ports };
}

function containerServices(app: AppState): Array<{ name: string; image: string; main: boolean }> {
  if (app.custom_app) {
    const info = parseCompose(app.custom_compose ?? '', app.config);
    return info.services.map((s, i) => ({ ...s, main: i === 0 }));
  }
  const cat = catalogOf(app);
  const images = cat?.images ?? {};
  const main = images.image ?? `ghcr.io/${app.catalog_app}/${app.catalog_app}:${app.app_version}`;
  const out = [{ name: app.catalog_app ?? app.name, image: main, main: true }];
  for (const [key, image] of Object.entries(images)) {
    if (key === 'image') continue;
    const name = SERVICE_NAMES[key] ?? (key.startsWith('postgres') ? 'postgres' : key.startsWith('vectorchord') ? 'pgvecto' : key.replace(/_image$/, ''));
    out.push({ name, image, main: false });
  }
  return out;
}

function volumeMounts(app: AppState): Obj[] {
  const storage = isObj(app.config.storage) ? app.config.storage : {};
  const out: Obj[] = [];
  for (const [key, v] of Object.entries(storage)) {
    if (key === 'additional_storage' && Array.isArray(v)) {
      for (const extra of v) {
        if (isObj(extra) && extra.type === 'host_path' && isObj(extra.host_path_config)) {
          out.push({ source: extra.host_path_config.path, destination: extra.mount_path ?? '/data', mode: extra.read_only ? 'ro' : 'rw', type: 'bind' });
        } else if (isObj(extra) && extra.type === 'ix_volume' && isObj(extra.ix_volume_config)) {
          out.push({ source: `/mnt/.ix-apps/app_mounts/${app.name}/${String(extra.ix_volume_config.dataset_name)}`, destination: extra.mount_path ?? '/data', mode: 'rw', type: 'bind' });
        }
      }
      continue;
    }
    if (!isObj(v)) continue;
    if (v.type === 'ix_volume' && isObj(v.ix_volume_config)) {
      out.push({ source: `/mnt/.ix-apps/app_mounts/${app.name}/${String(v.ix_volume_config.dataset_name ?? key)}`, destination: `/${key}`, mode: 'rw', type: 'bind' });
    } else if (v.type === 'host_path' && isObj(v.host_path_config) && typeof v.host_path_config.path === 'string') {
      out.push({ source: v.host_path_config.path, destination: `/${key}`, mode: 'rw', type: 'bind' });
    }
  }
  return out;
}

function notes(title: string, home: string): string {
  return `# Welcome to TrueNAS SCALE

Thank you for installing ${title}!

## Documentation
Documentation for ${title} can be found at ${home}.

## Bug reports
If you find a bug in this app, please file an issue at
https://github.com/truenas/apps

## Feature requests or improvements
If you find a feature request for this app, please file an issue at
https://github.com/truenas/apps
`;
}

export function renderApp(mock: Mock, app: AppState, extra: Obj = {}): Obj {
  const cat = catalogOf(app);
  const running = app.state === 'RUNNING' || app.state === 'DEPLOYING';
  const ports = running ? publishedPorts(app) : [];
  const usedPorts = ports.map((p) => ({ container_port: p.port, protocol: p.protocol, host_ports: p.hostIps.map((ip) => ({ host_port: p.port, host_ip: ip })) }));
  const services = containerServices(app);
  const mounts = volumeMounts(app);
  const containerState = app.state === 'RUNNING' ? 'running' : app.state === 'DEPLOYING' ? 'starting' : app.state === 'CRASHED' ? 'crashed' : 'exited';
  const hostIp = typeof extra.host_ip === 'string' ? extra.host_ip : mock.lanIp;
  const port = webPort(app);
  const metadata = cat
    ? { ...cat.app_metadata, version: app.version, app_version: app.app_version }
    : { name: 'ix-app', title: 'Custom App', train: 'stable', version: app.version, app_version: app.app_version, icon: 'https://media.sys.truenas.net/apps/ix-app/icons/icon.png', categories: ['custom'], description: 'Custom app' };
  return {
    name: app.name,
    id: app.name,
    state: app.state,
    upgrade_available: !!cat && compareVersions(app.version, cat.latest_version) < 0,
    latest_version: cat?.latest_version ?? null,
    image_updates_available: false,
    custom_app: app.custom_app,
    migrated: false,
    human_version: `${app.app_version}_${app.version}`,
    version: app.version,
    metadata,
    active_workloads: {
      containers: running ? services.length : 0,
      used_ports: usedPorts,
      used_host_ips: [],
      container_details: services.map((s) => ({
        id: app.containers[s.name] ?? '',
        service_name: s.name,
        image: s.image,
        port_config: s.main ? usedPorts : [],
        state: containerState,
        volume_mounts: s.main ? mounts : [],
      })),
      volumes: mounts,
      images: [...new Set(services.map((s) => s.image))],
      networks: [
        {
          Name: `ix-${app.name}_default`,
          Id: app.containers.__network ?? '',
          Labels: { 'com.docker.compose.network': 'default', 'com.docker.compose.project': `ix-${app.name}`, 'com.docker.compose.version': '2.39.1' },
        },
      ],
    },
    notes: cat ? notes(cat.title, cat.home) : null,
    portals: port ? { 'Web UI': `http://${hostIp}:${port}/` } : {},
    version_details: extra.include_app_schema === true && cat ? catalogVersionDetails(cat) : null,
    config: extra.retrieve_config === true ? structuredClone(app.custom_app ? (app.config.__compose ?? app.config) : app.config) : null,
  };
}

function emitApp(mock: Mock, app: AppState, msg: 'added' | 'changed' = 'changed'): void {
  mock.emit('app.query', msg, app.name, renderApp(mock, app));
}

function catalogVersionDetails(cat: CatalogApp): Obj {
  return {
    healthy: cat.healthy,
    supported: true,
    healthy_error: null,
    location: `/mnt/.ix-apps/truenas_catalog/trains/${cat.train}/${cat.name}/${cat.latest_version}`,
    last_update: cat.last_update,
    required_features: [],
    human_version: cat.latest_human_version,
    version: cat.latest_version,
    app_metadata: cat.app_metadata,
    schema: cat.schema,
    readme: cat.app_readme,
    changelog: cat.changelog,
    values: cat.default_values,
  };
}

function availableItem(mock: Mock, cat: CatalogApp): Obj {
  return {
    app_readme: cat.app_readme,
    categories: cat.categories,
    description: cat.description,
    healthy: cat.healthy,
    healthy_error: cat.healthy_error,
    home: cat.home,
    location: `/mnt/.ix-apps/truenas_catalog/trains/${cat.train}/${cat.name}`,
    latest_version: cat.latest_version,
    latest_app_version: cat.latest_app_version,
    latest_human_version: cat.latest_human_version,
    last_update: $date(Date.parse(`${cat.last_update.replace(' ', 'T')}Z`)),
    name: cat.name,
    recommended: cat.recommended,
    title: cat.title,
    maintainers: cat.maintainers,
    tags: cat.tags,
    screenshots: cat.screenshots,
    sources: cat.sources,
    icon_url: cat.icon_url,
    capabilities: cat.capabilities,
    run_as_context: cat.run_as_context,
    catalog: 'TRUENAS',
    installed: visibleApps(mock).some((a) => a.catalog_app === cat.name && a.train === cat.train),
    train: cat.train,
    popularity_rank: POPULARITY.indexOf(cat.name) === -1 ? null : POPULARITY.indexOf(cat.name) + 1,
  };
}

function preferredCatalog(mock: Mock): CatalogApp[] {
  return CATALOG.filter((c) => mock.state.catalog.preferred_trains.includes(c.train));
}

function requireDocker(mock: Mock): string {
  const d = mock.state.docker;
  if (!d.pool || d.status !== 'RUNNING') throw callError('EFAULT', 'Docker service is not running');
  return d.pool;
}

/** Image bytes stored in `<pool>/ix-apps/docker` per installed app (rough). */
function imageBytes(app: AppState): number {
  return containerServices(app).length * 380 * MiB;
}

function ensureIxVolumes(mock: Mock, app: AppState, emit: boolean): void {
  const base = `${app.pool}/ix-apps/app_mounts`;
  const names: string[] = [];
  const storage = isObj(app.config.storage) ? app.config.storage : {};
  for (const [key, v] of Object.entries(storage)) {
    if (isObj(v) && v.type === 'ix_volume' && isObj(v.ix_volume_config)) names.push(String(v.ix_volume_config.dataset_name ?? key));
  }
  if (!names.length) return;
  for (const id of [base, `${base}/${app.name}`]) if (!getDataset(mock.state, id)) addDataset(mock, { id }, emit);
  for (const n of names) {
    const id = `${base}/${app.name}/${n}`;
    if (!getDataset(mock.state, id)) addDataset(mock, { id, usedBytes: n.includes('postgres') ? 72 * MiB : 24 * MiB }, emit);
  }
}

function adjustDockerUsage(mock: Mock, pool: string, delta: number): void {
  const ds = getDataset(mock.state, `${pool}/ix-apps/docker`);
  if (!ds) return;
  ds.usedBytes = Math.max(64 * MiB, ds.usedBytes + delta);
  mock.emit('pool.dataset.query', 'changed', ds.id, renderDataset(mock.state, ds));
}

function newContainers(app: AppState): Record<string, string> {
  const out: Record<string, string> = { __network: randomHex(32) };
  for (const s of containerServices(app)) out[s.name] = randomHex(32);
  return out;
}

/** Required schema fields without a default (ignoring conditionally shown ones) that are missing from the values. */
function missingRequired(cat: CatalogApp, config: Obj, attr: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  /** `show_if: [[sibling, op, value], ...]` evaluated against the sibling values. */
  const shown = (showIf: unknown, siblings: Obj): boolean => {
    if (!Array.isArray(showIf)) return true;
    return showIf.every((cond) => {
      if (!Array.isArray(cond)) return true;
      const [field, op, expected] = cond as [string, string, unknown];
      const actual = siblings[field];
      if (op === '=') return actual === expected;
      if (op === '!=') return actual !== expected;
      if (op === 'in') return Array.isArray(expected) && expected.includes(actual);
      if (op === 'nin') return Array.isArray(expected) && !expected.includes(actual);
      return true;
    });
  };
  const walk = (q: unknown, siblings: Obj, path: string) => {
    if (!isObj(q) || !isObj(q.schema)) return;
    const s = q.schema;
    const name = String(q.variable);
    if (s.hidden || !shown(s.show_if, siblings)) return;
    const value = siblings[name];
    const here = `${path}.${name}`;
    if (s.type === 'dict') {
      const inner = isObj(value) ? value : {};
      for (const a of Array.isArray(s.attrs) ? s.attrs : []) walk(a, inner, here);
      return;
    }
    if (s.required === true && !('default' in s) && (value === undefined || value === null || value === '')) out.push([here, 'Field required']);
  };
  for (const q of cat.schema.questions) walk(q, config, attr);
  return out;
}

/** Port conflicts and host path checks for an app's values. */
function validateValues(mock: Mock, app: Pick<AppState, 'name' | 'config' | 'custom_app' | 'custom_compose' | 'catalog_app' | 'train'>, attr: string): void {
  const errors: Array<[string, string]> = [];
  const cat = app.catalog_app ? catalogApp(app.catalog_app, app.train) : undefined;
  if (cat) errors.push(...missingRequired(cat, app.config, attr));
  const taken = new Map<number, string>();
  for (const other of visibleApps(mock)) {
    if (other.name === app.name) continue;
    for (const p of publishedPorts({ ...other, config: other.config })) taken.set(p.port, `"${other.name}" application`);
  }
  taken.set(mock.state.system.ui_port, 'TrueNAS web interface (HTTP)');
  taken.set(mock.state.system.ui_httpsport, 'TrueNAS web interface (HTTPS)');
  for (const p of publishedPorts(app)) {
    if (p.port < 1 || p.port > 65535) errors.push([`${attr}.network.${p.key}.port_number`, 'Port must be between 1 and 65535']);
    const owner = taken.get(p.port);
    if (owner) errors.push([`${attr}.network.${p.key}.port_number`, `The port is being used by following services: 1) ${owner}`]);
  }
  const storage = isObj(app.config.storage) ? app.config.storage : {};
  for (const [key, v] of Object.entries(storage)) {
    const check = (entry: unknown, path: string) => {
      if (!isObj(entry) || entry.type !== 'host_path') return;
      const hp = isObj(entry.host_path_config) ? entry.host_path_config.path : undefined;
      if (typeof hp !== 'string' || !hp) errors.push([`${path}.host_path_config.path`, 'Field required']);
      else if (!hp.startsWith('/mnt/') || pathKind(mock.state, hp) !== 'DIRECTORY') errors.push([`${path}.host_path_config.path`, 'This path does not exist.']);
      else if (hp.startsWith('/mnt/.ix-apps')) errors.push([`${path}.host_path_config.path`, 'Paths inside the ix-apps dataset cannot be used.']);
    };
    if (key === 'additional_storage' && Array.isArray(v)) v.forEach((e, i) => check(e, `${attr}.storage.additional_storage.${i}`));
    else check(v, `${attr}.storage.${key}`);
  }
  if (errors.length) throw validationErrors(errors);
}

async function deploy(mock: Mock, app: AppState, job: JobControl, steps: Array<[number, string]>): Promise<void> {
  app.state = 'DEPLOYING';
  emitApp(mock, app);
  for (const [pct, desc] of steps) {
    job.progress(pct, desc);
    await job.sleep();
  }
  if (!mock.state.apps.includes(app)) return;
  app.state = 'RUNNING';
  emitApp(mock, app);
}

export interface InstallInput {
  name: string;
  catalogApp: string;
  train: string;
  version?: string;
  values?: Obj;
}

/** Installs a catalog app immediately (scenario seeding). */
export function installAppInternal(mock: Mock, input: InstallInput, emit = false): AppState {
  const cat = catalogApp(input.catalogApp, input.train);
  if (!cat) throw new Error(`Unknown catalog app ${input.catalogApp}`);
  const pool = mock.state.docker.pool;
  if (!pool) throw new Error('Docker is not configured');
  const app: AppState = {
    name: input.name,
    pool,
    catalog_app: cat.name,
    train: cat.train,
    version: input.version ?? cat.latest_version,
    app_version: cat.latest_app_version,
    custom_app: false,
    state: 'RUNNING',
    config: deepMerge(structuredClone(cat.default_values), { TZ: mock.state.system.timezone, ...(input.values ?? {}) }),
    custom_compose: null,
    createdAt: Date.now() - 12 * 86400_000,
    history: [],
    containers: {},
  };
  app.containers = newContainers(app);
  mock.state.apps.push(app);
  ensureIxVolumes(mock, app, emit);
  adjustDockerUsage(mock, pool, imageBytes(app));
  return app;
}

/** Creates `<pool>/ix-apps` and its children (mounted at /mnt/.ix-apps) if missing. */
export function createIxAppsDatasets(mock: Mock, pool: string, emit = true): void {
  const base = `${pool}/ix-apps`;
  const children: Array<[string, number]> = [
    [base, 160 * 1024],
    [`${base}/app_configs`, 96 * 1024],
    [`${base}/app_mounts`, 96 * 1024],
    [`${base}/docker`, 290 * MiB],
    [`${base}/truenas_catalog`, 52 * MiB],
  ];
  for (const [id, used] of children) {
    if (!getDataset(mock.state, id)) addDataset(mock, { id, usedBytes: used, props: id === base ? { aclmode: 'DISCARD', acltype: 'POSIX' } : {} }, emit);
  }
}

async function setupDockerPool(mock: Mock, pool: string, job: JobControl): Promise<void> {
  createIxAppsDatasets(mock, pool);
  job.progress(50, 'Starting docker');
  await job.sleep();
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export function registerApps(mock: Mock): void {
  const { server } = mock;
  const dockerConfig = () => {
    const d = mock.state.docker;
    return {
      id: 1,
      enable_image_updates: d.enable_image_updates,
      dataset: d.pool ? `${d.pool}/ix-apps` : null,
      pool: d.pool,
      nvidia: d.nvidia,
      address_pools: d.address_pools,
      cidr_v6: d.cidr_v6,
      secure_registry_mirrors: d.secure_registry_mirrors,
      insecure_registry_mirrors: d.insecure_registry_mirrors,
    };
  };
  const emitDocker = () => mock.emit('docker.state', 'changed', null, { status: mock.state.docker.status, description: mock.state.docker.description });

  server.method('docker.config', dockerConfig);
  server.method('docker.status', () => ({ status: mock.state.docker.status, description: mock.state.docker.description }));
  server.method('docker.nvidia_present', () => false);
  server.method('docker.list_backups', () => ({}));
  server.job('docker.update', async (p, job) => {
    const { state } = mock;
    const data = argObj(p[0], 'docker_update');
    const d = state.docker;
    const errors: Array<[string, string]> = [];
    if ('pool' in data && data.pool !== null) {
      if (typeof data.pool !== 'string' || !state.pools.some((x) => x.name === data.pool)) errors.push(['docker_update.pool', 'Pool not found.']);
    }
    if (data.migrate_applications === true && (!d.pool || data.pool === d.pool || !data.pool)) {
      errors.push(['docker_update.migrate_applications', 'Migration is only possible when changing from one pool to another.']);
    }
    if (data.nvidia === true) errors.push(['docker_update.nvidia', 'No NVIDIA GPU is present on this system.']);
    if (errors.length) throw validationErrors(errors);
    if (typeof data.enable_image_updates === 'boolean') d.enable_image_updates = data.enable_image_updates;
    if (Array.isArray(data.address_pools)) d.address_pools = data.address_pools as typeof d.address_pools;
    if (typeof data.cidr_v6 === 'string') d.cidr_v6 = data.cidr_v6;
    if (!('pool' in data) || data.pool === d.pool) return dockerConfig();

    const oldVisible = visibleApps(mock);
    if (data.pool === null) {
      job.progress(30, 'Stopping docker');
      d.status = 'STOPPING';
      emitDocker();
      await job.sleep();
      for (const a of oldVisible) mock.emit('app.query', 'removed', a.name);
      d.pool = null;
      d.status = 'UNCONFIGURED';
      emitDocker();
      setServiceState(mock, 'docker', 'STOPPED', false);
      syncAppAlerts(mock);
      return dockerConfig();
    }
    const newPool = data.pool as string;
    const oldPool = d.pool;
    if (oldPool) for (const a of oldVisible) mock.emit('app.query', 'removed', a.name);
    if (data.migrate_applications === true && oldPool) {
      job.progress(10, 'Migrating applications');
      for (const a of state.apps) if (a.pool === oldPool) a.pool = newPool;
      await job.sleep(2);
    }
    d.pool = newPool;
    d.status = 'INITIALIZING';
    d.description = '';
    emitDocker();
    job.progress(20, 'Creating ix-apps dataset');
    await setupDockerPool(mock, newPool, job);
    if (d.pool !== newPool) return dockerConfig();
    d.status = 'RUNNING';
    emitDocker();
    setServiceState(mock, 'docker', 'RUNNING', true);
    for (const a of visibleApps(mock)) {
      if (a.state === 'DEPLOYING' || a.state === 'STOPPING') a.state = 'STOPPED';
      emitApp(mock, a, 'added');
    }
    syncAppAlerts(mock);
    job.progress(90, 'Docker is running');
    return dockerConfig();
  });

  // Catalog
  const catalogConfig = () => ({ id: 'TRUENAS', label: 'TRUENAS', preferred_trains: mock.state.catalog.preferred_trains, location: '/mnt/.ix-apps/truenas_catalog' });
  server.method('catalog.config', catalogConfig);
  server.method('catalog.update', (p) => {
    const data = argObj(p[0], 'catalog_update');
    const trains = data.preferred_trains;
    if (!Array.isArray(trains) || !trains.length || trains.some((t) => typeof t !== 'string')) {
      throw validationError('catalog_update.preferred_trains', 'At least one train must be selected');
    }
    const known = new Set(CATALOG.map((c) => c.train));
    const unknown = (trains as string[]).filter((t) => !known.has(t) && t !== 'enterprise');
    if (unknown.length) throw validationError('catalog_update.preferred_trains', `${unknown.join(', ')} trains were not found in catalog.`);
    mock.state.catalog.preferred_trains = trains as string[];
    return catalogConfig();
  });
  server.method('catalog.trains', () => [...new Set(CATALOG.map((c) => c.train))].sort());
  server.job('catalog.sync', async (_p, job) => {
    job.progress(5, 'Syncing TRUENAS catalog');
    await job.sleep();
    job.progress(50, 'Updating catalog repository');
    await job.sleep();
    job.progress(80, 'Caching TRUENAS catalog');
    await job.sleep();
    mock.state.catalog.synced = true;
    return null;
  });
  server.method('catalog.apps', (p) => {
    const opts = argObj(p[0], 'catalog_apps_options');
    const trains = Array.isArray(opts.trains) && opts.trains.length ? (opts.trains as string[]) : null;
    const out: Record<string, Obj> = {};
    for (const cat of CATALOG) {
      if (trains ? !trains.includes(cat.train) : opts.retrieve_all_trains === false && !mock.state.catalog.preferred_trains.includes(cat.train)) continue;
      out[cat.train] ??= {};
      const { installed: _i, catalog: _c, popularity_rank: _r, train: _t, ...info } = availableItem(mock, cat);
      out[cat.train]![cat.name] = info;
    }
    return out;
  });
  server.method('catalog.get_app_details', (p) => {
    const name = nameArg(p[0], 'app_name');
    const train = String(argObj(p[1], 'app_version_details').train ?? 'stable');
    const cat = catalogApp(name, train);
    if (!cat) throw callError('ENOENT', `Unable to locate "${name}" catalog app in "${train}" train`);
    const { installed: _i, catalog: _c, popularity_rank: _r, train: _t, ...info } = availableItem(mock, cat);
    return { ...info, versions: { [cat.latest_version]: catalogVersionDetails(cat) } };
  });

  // Available apps
  const available = () => {
    mock.state.catalog.synced = true;
    return preferredCatalog(mock).map((c) => availableItem(mock, c));
  };
  server.method('app.available', (p) => queryFilter(available(), p[0], p[1]));
  server.method('app.latest', (p) =>
    queryFilter(
      [...available()].sort((a, b) => ((b.last_update as { $date: number }).$date ?? 0) - ((a.last_update as { $date: number }).$date ?? 0)),
      p[0],
      p[1],
    ),
  );
  server.method('app.categories', () => [...new Set(preferredCatalog(mock).flatMap((c) => c.categories))].sort());
  server.method('app.similar', (p) => {
    const cat = catalogApp(String(p[0]), String(p[1]));
    if (!cat) throw callError('ENOENT', `Unable to locate "${String(p[0])}" catalog app in "${String(p[1])}" train`);
    return preferredCatalog(mock)
      .filter((c) => c !== cat && c.categories.some((x) => cat.categories.includes(x)))
      .slice(0, 6)
      .map((c) => availableItem(mock, c));
  });

  // Installed apps
  const extraOf = (o: unknown): Obj => (isObj(o) && isObj(o.extra) ? o.extra : {});
  server.method('app.query', (p) => queryFilter(visibleApps(mock).map((a) => renderApp(mock, a, extraOf(p[1]))), p[0], p[1]));
  server.method('app.get_instance', (p) => queryFilter(visibleApps(mock).map((a) => renderApp(mock, a, extraOf(p[1]))), [['id', '=', p[0]]], { get: true }));
  server.method('app.config', (p) => {
    const app = findApp(mock, p[0]);
    return structuredClone(app.custom_app ? (app.config.__compose ?? app.config) : app.config);
  });
  server.method('app.used_ports', () => [...new Set(visibleApps(mock).flatMap((a) => publishedPorts(a).map((x) => x.port)))].sort((a, b) => a - b));
  server.method('app.used_host_ips', () => ({}));
  server.method('app.ip_choices', () => ({ '0.0.0.0': '0.0.0.0', '::': '::', [mock.lanIp]: mock.lanIp }));
  server.method('app.certificate_choices', () => [{ id: 1, name: 'truenas_default' }]);
  server.method('app.gpu_choices', () => ({
    '0000:30:00.0': {
      vendor: 'AMD',
      description: 'Advanced Micro Devices, Inc. [AMD/ATI] Cezanne [Radeon Vega Series / Radeon Vega Mobile Series]',
      error: null,
      vendor_specific_config: {},
      gpu_details: { addr: { pci_slot: '0000:30:00.0', domain: '0000', bus: '30', slot: '00' }, available_to_host: true, vendor: 'AMD', uses_system_critical_devices: false },
      pci_slot: '0000:30:00.0',
    },
  }));
  server.method('app.available_space', () => {
    const pool = mock.state.docker.pool;
    const ds = pool ? getDataset(mock.state, `${pool}/ix-apps`) : undefined;
    if (!ds) throw callError('EFAULT', 'Docker service is not running');
    return datasetAvailable(mock.state, ds);
  });
  server.method('app.container_ids', (p) => {
    const app = findApp(mock, p[0]);
    const alive = argObj(p[1], 'options').alive_only !== false;
    if (alive && app.state !== 'RUNNING') return {};
    const out: Obj = {};
    for (const s of containerServices(app)) {
      const id = app.containers[s.name] ?? '';
      out[id] = { id, service_name: s.name, image: s.image, state: app.state === 'RUNNING' ? 'running' : 'exited' };
    }
    return out;
  });
  server.method('app.container_console_choices', (p) => {
    const app = findApp(mock, p[0]);
    const out: Obj = {};
    if (app.state !== 'RUNNING') return out;
    for (const s of containerServices(app)) {
      const id = app.containers[s.name] ?? '';
      out[id] = { id, service_name: s.name, image: s.image, state: 'running' };
    }
    return out;
  });
  server.method('app.outdated_docker_images', (p) => (findApp(mock, p[0]), []));
  server.method('app.rollback_versions', (p) => findApp(mock, p[0]).history.map((h) => h.version));

  server.job(
    'app.create',
    async (p, job) => {
      const { state } = mock;
      const data = argObj(p[0], 'app_create');
      const pool = requireDocker(mock);
      const name = String(data.app_name);
      if (state.apps.some((a) => a.name === name && a.pool === pool)) throw validationError('app_create.app_name', `Application with name "${name}" already exists`);
      let app: AppState;
      if (data.custom_app === true) {
        const compose = typeof data.custom_compose_config_string === 'string' && data.custom_compose_config_string ? data.custom_compose_config_string : null;
        const dict = isObj(data.custom_compose_config) && Object.keys(data.custom_compose_config).length ? data.custom_compose_config : null;
        const info = parseCompose(compose ?? '', dict ?? undefined);
        if (!info.services.length) throw validationError(`app_create.${compose ? 'custom_compose_config_string' : 'custom_compose_config'}`, 'Invalid compose configuration: no services defined');
        app = {
          name,
          pool,
          catalog_app: null,
          train: 'stable',
          version: '1.0.0',
          app_version: '1.0.0',
          custom_app: true,
          state: 'DEPLOYING',
          config: dict ? { __compose: dict } : {},
          custom_compose: compose,
          createdAt: Date.now(),
          history: [],
          containers: {},
        };
      } else {
        const train = String(data.train ?? 'stable');
        const cat = catalogApp(String(data.catalog_app), train);
        if (!cat) throw validationError('app_create.catalog_app', `Unable to locate "${String(data.catalog_app)}" catalog app in "${train}" train`);
        const version = String(data.version ?? 'latest');
        if (version !== 'latest' && version !== cat.latest_version) throw validationError('app_create.version', `Version ${version} not found for "${cat.name}" app`);
        const values = isObj(data.values) ? data.values : {};
        app = {
          name,
          pool,
          catalog_app: cat.name,
          train,
          version: cat.latest_version,
          app_version: cat.latest_app_version,
          custom_app: false,
          state: 'DEPLOYING',
          config: deepMerge(structuredClone(cat.default_values), values),
          custom_compose: null,
          createdAt: Date.now(),
          history: [],
          containers: {},
        };
      }
      validateValues(mock, app, 'app_create.values');
      app.containers = newContainers(app);
      state.apps.push(app);
      emitApp(mock, app, 'added');
      job.progress(10, 'Setting up App directory');
      await job.sleep();
      job.progress(25, 'Creating ix-volumes');
      ensureIxVolumes(mock, app, true);
      await deploy(mock, app, job, [
        [40, 'Rendering Docker Compose file'],
        [60, 'Pulling Docker images'],
        [80, 'Starting App'],
      ]);
      adjustDockerUsage(mock, pool, imageBytes(app));
      syncAppAlerts(mock);
      return renderApp(mock, app);
    },
    (p) => {
      const data = argObj(p[0], 'app_create');
      const name = data.app_name;
      if (typeof name !== 'string' || !name) throw validationError('app_create.app_name', 'Field required');
      if (name.length > 40) throw validationError('app_create.app_name', 'String should have at most 40 characters');
      if (!APP_NAME_RE.test(name)) throw validationError('app_create.app_name', "String should match pattern '^[a-z]([-a-z0-9]*[a-z0-9])?$'");
      if (data.custom_app === true) {
        const hasString = typeof data.custom_compose_config_string === 'string' && data.custom_compose_config_string.length > 0;
        const hasDict = isObj(data.custom_compose_config) && Object.keys(data.custom_compose_config).length > 0;
        if (hasString === hasDict) throw validationError('app_create.custom_compose_config', 'Exactly one of custom_compose_config or custom_compose_config_string must be provided');
      } else if (typeof data.catalog_app !== 'string' || !data.catalog_app) {
        throw validationError('app_create.catalog_app', 'This field is required when custom_app is not set');
      }
      if (data.values !== undefined && !isObj(data.values)) throw validationError('app_create.values', 'Input should be a valid dictionary');
    },
  );

  server.job('app.update', async (p, job) => {
    requireDocker(mock);
    const app = findApp(mock, p[0]);
    const data = argObj(p[1], 'app_update');
    const next = structuredClone(app);
    if (app.custom_app) {
      if (typeof data.custom_compose_config_string === 'string' && data.custom_compose_config_string) next.custom_compose = data.custom_compose_config_string;
      else if (isObj(data.custom_compose_config) && Object.keys(data.custom_compose_config).length) next.config = { __compose: data.custom_compose_config };
    } else if (isObj(data.values)) next.config = deepMerge(app.config, data.values);
    validateValues(mock, next, 'app_update.values');
    app.config = next.config;
    app.custom_compose = next.custom_compose;
    ensureIxVolumes(mock, app, true);
    await deploy(mock, app, job, [
      [30, 'Updating App configuration'],
      [70, 'Redeploying App'],
    ]);
    return renderApp(mock, app);
  });

  const upgradeTarget = (app: AppState, requested: unknown) => {
    const cat = catalogOf(app);
    if (app.custom_app || !cat) throw callError('EINVAL', 'Upgrades are not supported for custom apps');
    if (compareVersions(app.version, cat.latest_version) >= 0) throw callError('EINVAL', `No upgrade available for "${app.name}"`);
    const v = requested === undefined || requested === 'latest' ? cat.latest_version : String(requested);
    if (v !== cat.latest_version) throw validationError('options.app_version', `Version ${v} not found for "${cat.name}" app`);
    return cat;
  };
  server.method('app.upgrade_summary', (p) => {
    const app = findApp(mock, p[0]);
    const cat = upgradeTarget(app, argObj(p[1], 'options').app_version);
    return {
      latest_version: cat.latest_version,
      latest_human_version: cat.latest_human_version,
      upgrade_version: cat.latest_version,
      upgrade_human_version: cat.latest_human_version,
      available_versions_for_upgrade: [{ version: cat.latest_version, human_version: cat.latest_human_version }],
      changelog: cat.changelog,
    };
  });
  server.job('app.upgrade', async (p, job) => {
    requireDocker(mock);
    const app = findApp(mock, p[0]);
    const opts = argObj(p[1], 'options');
    const cat = upgradeTarget(app, opts.app_version);
    job.progress(10, 'Fetching upgrade details');
    await job.sleep();
    app.history.push({ version: app.version, app_version: app.app_version });
    app.version = cat.latest_version;
    app.app_version = cat.latest_app_version;
    if (isObj(opts.values)) app.config = deepMerge(app.config, opts.values);
    await deploy(mock, app, job, [
      [30, 'Pulling Docker images'],
      [60, 'Upgrading App'],
      [85, 'Starting App'],
    ]);
    syncAppAlerts(mock);
    return renderApp(mock, app);
  });
  server.job('app.rollback', async (p, job) => {
    requireDocker(mock);
    const app = findApp(mock, p[0]);
    const opts = argObj(p[1], 'options');
    const target = app.history.find((h) => h.version === opts.app_version);
    if (!target) throw validationError('options.app_version', 'No rollback version available');
    app.history = app.history.filter((h) => h !== target);
    app.version = target.version;
    app.app_version = target.app_version;
    await deploy(mock, app, job, [
      [40, 'Rolling back App'],
      [80, 'Starting App'],
    ]);
    syncAppAlerts(mock);
    return renderApp(mock, app);
  });
  server.job('app.delete', async (p, job) => {
    requireDocker(mock);
    const app = findApp(mock, p[0]);
    const opts = argObj(p[1], 'options');
    app.state = 'STOPPING';
    emitApp(mock, app);
    job.progress(20, 'Stopping App');
    await job.sleep();
    job.progress(50, 'Removing App');
    mock.state.apps = mock.state.apps.filter((a) => a !== app);
    mock.emit('app.query', 'removed', app.name);
    if (opts.remove_images !== false) adjustDockerUsage(mock, app.pool, -imageBytes(app));
    if (opts.remove_ix_volumes === true) removeDatasetTree(mock, `${app.pool}/ix-apps/app_mounts/${app.name}`);
    await job.sleep();
    syncAppAlerts(mock);
    return true;
  });
  server.job('app.start', async (p, job) => {
    requireDocker(mock);
    const app = findApp(mock, p[0]);
    if (app.state === 'RUNNING') return null;
    app.containers = newContainers(app);
    await deploy(mock, app, job, [
      [30, 'Starting App'],
      [70, 'Waiting for containers'],
    ]);
    return null;
  });
  server.job('app.redeploy', async (p, job) => {
    requireDocker(mock);
    const app = findApp(mock, p[0]);
    app.containers = newContainers(app);
    await deploy(mock, app, job, [[50, 'Redeploying App']]);
    return renderApp(mock, app);
  });
  server.job('app.stop', async (p, job) => {
    requireDocker(mock);
    const app = findApp(mock, p[0]);
    if (app.state === 'STOPPED') return null;
    app.state = 'STOPPING';
    emitApp(mock, app);
    job.progress(50, 'Stopping App');
    await job.sleep();
    if (!mock.state.apps.includes(app)) return null;
    app.state = 'STOPPED';
    emitApp(mock, app);
    return null;
  });
  server.job('app.pull_images', async (p, job) => {
    const app = findApp(mock, p[0]);
    job.progress(50, 'Pulling images');
    await job.sleep();
    if (argObj(p[1], 'options').redeploy !== false) {
      app.containers = newContainers(app);
      emitApp(mock, app);
    }
    return null;
  });
  server.job('app.convert_to_custom', async (p, job) => {
    const app = findApp(mock, p[0]);
    job.progress(50, 'Converting to custom app');
    await job.sleep();
    const services = containerServices(app);
    const compose = `services:\n${services.map((s) => `  ${s.name}:\n    image: ${s.image}\n    restart: unless-stopped\n`).join('')}`;
    const ports = publishedPorts(app);
    app.custom_compose = ports.length
      ? compose.replace(/(restart: unless-stopped\n)/, `$1    ports:\n${ports.map((x) => `      - "${x.port}:${x.port}"`).join('\n')}\n`)
      : compose;
    app.custom_app = true;
    app.catalog_app = null;
    emitApp(mock, app);
    return renderApp(mock, app);
  });

  // Images
  const images = () => {
    const seen = new Map<string, Obj>();
    for (const app of visibleApps(mock)) {
      for (const s of containerServices(app)) {
        if (seen.has(s.image)) continue;
        const colon = s.image.lastIndexOf(':');
        const repo = colon > 0 ? s.image.slice(0, colon) : s.image;
        const tag = colon > 0 ? s.image.slice(colon + 1) : 'latest';
        seen.set(s.image, {
          id: `sha256:${randomHex(32)}`,
          repo_tags: [s.image],
          repo_digests: [`${repo}@sha256:${randomHex(32)}`],
          size: 180 * MiB + Math.round(Math.random() * 600 * MiB),
          dangling: false,
          update_available: false,
          created: $date(app.createdAt - 5 * 86400_000),
          author: '',
          comment: '',
          parsed_repo_tags: [{ image: repo, tag, registry: repo.includes('.') ? repo.split('/')[0] : 'registry-1.docker.io', complete_tag: s.image, reference: tag }],
        });
      }
    }
    return [...seen.values()];
  };
  server.method('app.image.query', (p) => queryFilter(images(), p[0], p[1]));
  server.job('app.image.pull', async (_p, job) => {
    requireDocker(mock);
    job.progress(50, 'Pulling image');
    await job.sleep(2);
    return null;
  });
  server.method('app.image.delete', () => true);
  server.method('app.image.dockerhub_rate_limit', () => ({
    total_pull_limit: 100,
    total_time_limit_in_secs: 21600,
    remaining_pull_limit: 97,
    remaining_time_limit_in_secs: 21600,
    error: null,
  }));
}
