import type {
  AppRequirementsInfo,
  AppsResponse,
  AppState,
  CatalogApp,
  CatalogAppDetail,
  CatalogResponse,
  InstalledApp,
  InstallRequest,
  LocationPreferenceId,
} from '@apexos/api-types';
import type { TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { SharedCall } from '../lib/shared-call.ts';
import { expandString, expandValue, parseSpec, presentQuestions, resolveAnswers, ScriptError, type InstallScript, type MacroContext } from '../lib/install-script.ts';
import type { TaskContext } from '../lib/tasks.ts';
import type { InstalledAppRecord } from '../lib/store.ts';
import type { TnApp, TnCatalogApp, TnDataset, TnDockerConfig, TnDockerStatus, TnSystemInfo } from '../truenas/types.ts';
import { ensureLocation, listLocations, locationDef } from './locations.ts';
import { lanIp } from './system.ts';

const APP_NAME_RE = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
/**
 * TrueNAS downloads its app catalog from GitHub. Without internet access, listing it takes minutes to fail,
 * so a failure is remembered for a few minutes.
 */
const catalogCall = new SharedCall<TnCatalogApp[]>({ okMs: 60_000, failedMs: 5 * 60_000 });

/** Installed apps only use the catalog for fallbacks (title, icon, newest version), so they wait this long at most. */
export const appTimings = { catalogWaitMs: 2_000 };

export function invalidateCatalog(): void {
  catalogCall.invalidate();
}

export async function getEngine(client: TrueNasClient): Promise<AppsResponse['engine']> {
  const [status, config] = await Promise.all([
    client.call<TnDockerStatus>('docker.status').catch(() => ({ status: 'UNKNOWN', description: null })),
    client.call<TnDockerConfig>('docker.config').catch(() => ({ pool: null, dataset: null })),
  ]);
  return { status: status.status, pool: config.pool, description: status.description || null };
}

function availableApps(client: TrueNasClient): Promise<TnCatalogApp[]> {
  return catalogCall.get(() => client.call<TnCatalogApp[]>('app.available')).catch((err: Error) => {
    throw new UserError(
      `TrueNAS couldn’t load its app catalog. It downloads the catalog from GitHub, so the server needs internet access. (${err.message})`,
      503,
      'CATALOG_UNAVAILABLE',
    );
  });
}

function scriptFor(ctx: AppContext, app: Pick<TnCatalogApp, 'name' | 'train'>): InstallScript | undefined {
  const script = ctx.scripts.get(app.name);
  if (!script) return undefined;
  return (script.train ?? 'community') === app.train ? script : undefined;
}

function toCatalogApp(ctx: AppContext, app: TnCatalogApp): CatalogApp {
  return {
    id: app.name,
    title: app.title || app.name,
    description: app.description ?? '',
    icon: app.icon_url ?? null,
    categories: app.categories ?? [],
    train: app.train,
    version: app.latest_version,
    appVersion: app.latest_app_version,
    homepage: app.home ?? null,
    tier: scriptFor(ctx, app) ? 'curated' : 'catalog',
    installed: app.installed,
  };
}

export async function listCatalog(ctx: AppContext, query: { search?: string; category?: string }): Promise<CatalogResponse> {
  const client = ctx.truenas.client();
  const engine = await getEngine(client);
  if (!engine.pool) return { apps: [], categories: [], appsPool: null };
  const raw = await availableApps(client);
  let apps = raw.map((a) => toCatalogApp(ctx, a));
  const categories = [...new Set(apps.flatMap((a) => a.categories))].sort();
  const search = query.search?.trim().toLowerCase();
  if (search) apps = apps.filter((a) => `${a.title} ${a.id} ${a.description} ${a.categories.join(' ')}`.toLowerCase().includes(search));
  if (query.category === 'curated') apps = apps.filter((a) => a.tier === 'curated');
  else if (query.category) apps = apps.filter((a) => a.categories.includes(query.category!));
  const rank = new Map(raw.map((a) => [`${a.train}/${a.name}`, a.popularity_rank ?? Number.MAX_SAFE_INTEGER]));
  apps.sort(
    (a, b) =>
      Number(b.tier === 'curated') - Number(a.tier === 'curated') ||
      (rank.get(`${a.train}/${a.id}`) ?? 0) - (rank.get(`${b.train}/${b.id}`) ?? 0) ||
      a.title.localeCompare(b.title),
  );
  return { apps, categories, appsPool: engine.pool };
}

async function findCatalogApp(ctx: AppContext, id: string, train?: string): Promise<TnCatalogApp> {
  const apps = await availableApps(ctx.truenas.client());
  const matches = apps.filter((a) => a.name === id && (!train || a.train === train));
  const app = matches.find((a) => scriptFor(ctx, a)) ?? matches[0];
  if (!app) throw new UserError('That app is not in the catalog.', 404, 'NOT_FOUND');
  return app;
}

export async function uniqueAppName(client: TrueNasClient, base: string): Promise<string> {
  const names = new Set((await client.call<TnApp[]>('app.query', [[], { select: ['name'] }])).map((a) => a.name));
  const clean = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'app';
  if (!names.has(clean)) return clean;
  for (let i = 2; ; i++) if (!names.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

export async function checkRequirements(ctx: AppContext, script: InstallScript): Promise<AppRequirementsInfo> {
  const client = ctx.truenas.client();
  const [info, usedPorts, locations] = await Promise.all([
    client.call<TnSystemInfo>('system.info'),
    client.call<number[]>('app.used_ports').catch(() => [] as number[]),
    listLocations(ctx),
  ]);
  const locs = script.requirements.locations.map((id) => {
    const loc = locations.find((l) => l.id === id);
    const path = loc?.path ?? loc?.suggestedPath ?? null;
    return { id, name: locationDef(id).name, met: Boolean(path), path };
  });
  const specs = script.requirements.specifications.map((s) => {
    const spec = parseSpec(s);
    const met = spec.kind === 'cores' ? info.cores >= spec.value : spec.kind === 'ram' ? info.physmem >= spec.value * 0.95 : true;
    return { label: spec.label, met };
  });
  const ports = script.requirements.ports ?? [];
  const portConflicts = ports.filter((p) => usedPorts.includes(p));
  return {
    locations: locs,
    specs,
    ports,
    portConflicts,
    ok: locs.every((l) => l.met) && specs.every((s) => s.met) && portConflicts.length === 0,
  };
}

export async function getCatalogApp(ctx: AppContext, id: string, train?: string): Promise<CatalogAppDetail> {
  const app = await findCatalogApp(ctx, id, train);
  const script = scriptFor(ctx, app);
  return {
    ...toCatalogApp(ctx, app),
    screenshots: app.screenshots ?? [],
    sources: app.sources ?? [],
    questions: script ? presentQuestions(script) : [],
    requirements: script ? await checkRequirements(ctx, script) : null,
    suggestedName: await uniqueAppName(ctx.truenas.client(), app.name),
  };
}

async function macroContext(ctx: AppContext, answers: MacroContext['answers']): Promise<MacroContext> {
  const client = ctx.truenas.client();
  const [info, apps, ip] = await Promise.all([
    client.call<TnSystemInfo>('system.info'),
    client.call<TnApp[]>('app.query'),
    lanIp(client),
  ]);
  return {
    locations: { ...ctx.store.get().preferences.locations },
    answers,
    memoryBytes: info.physmem,
    cpus: info.cores,
    installedApps: new Set(apps.map((a) => (a.metadata?.name ?? a.name).toLowerCase())),
    lanIp: ip ?? '127.0.0.1',
    timezone: info.timezone,
  };
}

async function datasetExists(client: TrueNasClient, id: string): Promise<boolean> {
  const found = await client.call<TnDataset[]>('pool.dataset.query', [[['id', '=', id]], { extra: { retrieve_children: false } }]);
  return found.length > 0;
}

export async function startInstall(ctx: AppContext, req: InstallRequest) {
  const appName = req.appName?.trim().toLowerCase();
  if (appName !== undefined && (!APP_NAME_RE.test(appName) || appName.length > 40)) {
    throw new UserError('App names use lowercase letters, numbers and dashes (max 40).', 400, 'VALIDATION', { appName: 'Invalid name' });
  }
  const curated = ctx.scripts.has(req.catalogApp);
  const entry = await findCatalogApp(ctx, req.catalogApp, req.train);
  const title = entry.title || entry.name;
  if (ctx.tasks.findRunning('app-install', title)) throw new UserError('This app is already being installed.', 409, 'BUSY');
  return ctx.tasks.start(
    {
      type: 'app-install',
      title: `Installing ${title}`,
      ref: title,
      steps: curated ? ['Checking requirements', 'Preparing folders', 'Installing the app'] : ['Installing the app'],
    },
    (task) => runInstall(ctx, req, appName, task),
  );
}

async function runInstall(ctx: AppContext, req: InstallRequest, requestedName: string | undefined, task: TaskContext): Promise<void> {
  const client = ctx.truenas.client();
  const engine = await getEngine(client);
  if (!engine.pool) throw new UserError('Apps need a storage pool. Finish server setup first.', 409, 'NO_APPS_POOL');
  const app = await findCatalogApp(ctx, req.catalogApp, req.train);
  const script = scriptFor(ctx, app);
  const name = requestedName ?? (await uniqueAppName(client, app.name));
  const record: InstalledAppRecord = {
    catalogApp: app.name,
    train: app.train,
    scriptVersion: script?.script.version ?? null,
    locations: [],
    directories: [],
    installedAt: new Date().toISOString(),
  };

  let values: Record<string, unknown> = {};
  if (script) {
    const answers = await task.step('Checking requirements', async () => {
      const check = await checkRequirements(ctx, script);
      if (check.portConflicts.length) throw new UserError(`Port ${check.portConflicts.join(', ')} is already used by another app.`, 409, 'PORT_IN_USE');
      const unmet = [...check.specs.filter((s) => !s.met).map((s) => s.label), ...check.locations.filter((l) => !l.met).map((l) => l.name)];
      if (unmet.length) throw new UserError(`This server doesn't meet the app's requirements: ${unmet.join(', ')}.`, 409, 'REQUIREMENTS');
      try {
        return resolveAnswers(script, req.answers ?? {});
      } catch (err) {
        throw err instanceof ScriptError ? new UserError(err.message, 400, 'VALIDATION') : err;
      }
    });

    await task.step('Preparing folders', async (report) => {
      const ids = script.requirements.locations;
      for (const [i, id] of ids.entries()) {
        await ensureLocation(ctx, id);
        report(((i + 1) / (ids.length + 1)) * 60);
      }
      const mctx = await macroContext(ctx, answers);
      for (const dir of script.ensure_directories_exists ?? []) {
        const path = String(expandString(dir.path, mctx));
        const dataset = path.replace(/^\/mnt\//, '');
        if (!(await datasetExists(client, dataset))) {
          await client.call('pool.dataset.create', [{ name: dataset, type: 'FILESYSTEM', share_type: 'APPS', create_ancestors: true }]);
        }
        const owner = dir.owner;
        if (owner && owner.user !== 'apps') {
          await client.job('filesystem.chown', [{ path, user: owner.user, group: owner.group ?? owner.user, options: { recursive: false } }]);
        }
        record.directories.push({ dataset, path, snapshotId: dir.snapshot?.id });
      }
      record.locations = [...ids];
      try {
        values = expandValue(script.app_values, mctx) as Record<string, unknown>;
      } catch (err) {
        throw err instanceof ScriptError ? new UserError(err.message, 400, 'SCRIPT_ERROR') : err;
      }
    });
  }

  await createCatalogApp(ctx, task, 'Installing the app', { name, catalogApp: app.name, train: app.train, values });
  await ctx.store.update((s) => {
    s.apps[name] = record;
  });
  ctx.bus.changed('locations');
}

/**
 * `app.create` for a catalog app with explicit values, run as a task step. `train` must be given:
 * TrueNAS defaults to `stable`, and many apps live in `community`.
 */
export async function createCatalogApp(
  ctx: AppContext,
  task: TaskContext,
  stepName: string,
  app: { name: string; catalogApp: string; train: string; values: Record<string, unknown> },
): Promise<void> {
  await task.step(stepName, (report) =>
    ctx.truenas
      .client()
      .job('app.create', [{ app_name: app.name, catalog_app: app.catalogApp, train: app.train, version: 'latest', values: app.values }], (job) =>
        report(job.progress.percent ?? 0, job.progress.description ?? undefined),
      ),
  );
  invalidateCatalog();
  ctx.bus.changed('apps');
}

/** `app.delete` as a task step; `removeVolumes` also deletes the app's ixVolumes (data TrueNAS created for it). */
export async function deleteApp(ctx: AppContext, task: TaskContext, stepName: string, name: string, removeVolumes: boolean): Promise<void> {
  await task.step(stepName, (report) =>
    ctx.truenas
      .client()
      .job('app.delete', [name, { remove_images: true, remove_ix_volumes: removeVolumes }], (job) =>
        report(job.progress.percent ?? 0, job.progress.description ?? undefined),
      ),
  );
  invalidateCatalog();
  ctx.bus.changed('apps');
}

export function appState(state: string): AppState {
  const map: Record<string, AppState> = { RUNNING: 'running', STOPPED: 'stopped', DEPLOYING: 'deploying', CRASHED: 'crashed', STOPPING: 'stopping' };
  return map[state] ?? 'unknown';
}

function webUrl(app: TnApp, ip: string | null): string | null {
  const portal = app.portals ? (app.portals['Web UI'] ?? Object.values(app.portals)[0]) : undefined;
  if (!portal) return null;
  try {
    const url = new URL(portal);
    if (ip && ['0.0.0.0', 'localhost', '127.0.0.1', '[::]'].includes(url.hostname)) url.hostname = ip;
    return url.toString();
  } catch {
    return null;
  }
}

export async function listInstalled(ctx: AppContext): Promise<AppsResponse> {
  const client = ctx.truenas.client();
  const engine = await getEngine(client);
  if (!engine.pool) return { apps: [], engine };
  const [apps, ip, catalog] = await Promise.all([
    client.call<TnApp[]>('app.query'),
    lanIp(client),
    catalogCall.quick(() => client.call<TnCatalogApp[]>('app.available'), appTimings.catalogWaitMs, [] as TnCatalogApp[]),
  ]);
  const records = ctx.store.get().apps;
  const result: InstalledApp[] = apps.map((a) => {
    const record = records[a.name];
    const catalogName = a.metadata?.name ?? record?.catalogApp ?? null;
    const train = a.metadata?.train ?? record?.train ?? null;
    const entry = catalog.find((c) => c.name === catalogName && (!train || c.train === train));
    return {
      name: a.name,
      title: a.metadata?.title ?? entry?.title ?? a.name,
      icon: a.metadata?.icon ?? entry?.icon_url ?? null,
      state: appState(a.state),
      version: a.version,
      // human_version is "<app version>_<catalog version>"
      appVersion: a.metadata?.app_version ?? a.human_version?.split('_')[0] ?? a.version,
      upgradeAvailable: a.upgrade_available,
      latestVersion: a.latest_version,
      latestAppVersion: a.upgrade_available ? (entry?.latest_app_version ?? null) : null,
      webUrl: webUrl(a, ip),
      tier: a.custom_app ? 'custom' : record?.scriptVersion ? 'curated' : 'catalog',
      catalogApp: a.custom_app ? null : catalogName,
      train,
      locations: (record?.locations ?? []) as LocationPreferenceId[],
    };
  });
  result.sort((a, b) => a.title.localeCompare(b.title));
  return { apps: result, engine };
}

async function requireApp(ctx: AppContext, name: string): Promise<TnApp> {
  const [app] = await ctx.truenas.client().call<TnApp[]>('app.query', [[['name', '=', name]]]);
  if (!app) throw new UserError('App not found', 404, 'NOT_FOUND');
  return app;
}

/** Name to show for an installed app: its catalog title, plus the instance name when they differ. */
function displayName(app: TnApp): string {
  const title = app.metadata?.title;
  if (!title) return app.name;
  return title.toLowerCase() === app.name.toLowerCase() ? title : `${title} (${app.name})`;
}

export async function startStop(ctx: AppContext, name: string, action: 'start' | 'stop') {
  const app = await requireApp(ctx, name);
  return ctx.tasks.start(
    { type: `app-${action}`, title: `${action === 'start' ? 'Starting' : 'Stopping'} ${displayName(app)}`, ref: name },
    async (task) => {
      await ctx.truenas.client().job(`app.${action}`, [name], (job) => task.progress(job.progress.percent ?? 0, job.progress.description ?? undefined));
      ctx.bus.changed('apps');
    },
  );
}

const KEEP_SNAPSHOTS = 3;

/** Snapshots every directory the curation marked for it, keeping the newest few per app and dataset. */
async function snapshotBeforeUpgrade(ctx: AppContext, name: string): Promise<void> {
  const record = ctx.store.get().apps[name];
  if (!record) return;
  const client = ctx.truenas.client();
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  for (const dir of record.directories.filter((d) => d.snapshotId)) {
    if (!(await datasetExists(client, dir.dataset))) continue;
    const prefix = `apexos-app-${name}-${dir.snapshotId}-`;
    await client.call('pool.snapshot.create', [{ dataset: dir.dataset, name: `${prefix}${stamp}` }]);
    const snaps = await client.call<{ id: string; snapshot_name: string }[]>('pool.snapshot.query', [[['dataset', '=', dir.dataset]]]);
    const ours = snaps.filter((s) => s.snapshot_name.startsWith(prefix)).sort((a, b) => b.snapshot_name.localeCompare(a.snapshot_name));
    for (const old of ours.slice(KEEP_SNAPSHOTS)) await client.call('pool.snapshot.delete', [old.id]);
  }
}

async function upgradeOne(ctx: AppContext, name: string, task: TaskContext): Promise<void> {
  const app = await requireApp(ctx, name);
  if (!app.upgrade_available) return;
  await task.step(`Saving a restore point for ${displayName(app)}`, () => snapshotBeforeUpgrade(ctx, name));
  await task.step(`Updating ${displayName(app)}`, (report) =>
    ctx.truenas.client().job('app.upgrade', [name, { app_version: 'latest', snapshot_hostpaths: false }], (job) =>
      report(job.progress.percent ?? 0, job.progress.description ?? undefined),
    ),
  );
}

export async function startUpgrade(ctx: AppContext, name: string) {
  const app = await requireApp(ctx, name);
  if (!app.upgrade_available) throw new UserError('This app is already up to date.', 409, 'UP_TO_DATE');
  return ctx.tasks.start({ type: 'app-upgrade', title: `Updating ${displayName(app)}`, ref: displayName(app) }, async (task) => {
    await upgradeOne(ctx, name, task);
    ctx.bus.changed('apps');
  });
}

export async function startUpgradeAll(ctx: AppContext) {
  const apps = await ctx.truenas.client().call<TnApp[]>('app.query', [[['upgrade_available', '=', true]]]);
  if (!apps.length) throw new UserError('All apps are up to date.', 409, 'UP_TO_DATE');
  return ctx.tasks.start({ type: 'app-upgrade-all', title: `Updating ${apps.length} app${apps.length === 1 ? '' : 's'}` }, async (task) => {
    const failures: string[] = [];
    for (const app of apps) {
      try {
        await upgradeOne(ctx, app.name, task);
      } catch (err) {
        failures.push(`${app.name}: ${(err as Error).message}`);
      }
    }
    ctx.bus.changed('apps');
    if (failures.length) throw new Error(`Some apps could not be updated. ${failures.join('; ')}`);
  });
}

export async function startUninstall(ctx: AppContext, name: string, removeData: boolean) {
  const app = await requireApp(ctx, name);
  return ctx.tasks.start(
    { type: 'app-uninstall', title: `Uninstalling ${displayName(app)}`, ref: displayName(app), steps: removeData ? ['Removing the app', 'Removing app data'] : ['Removing the app'] },
    async (task) => {
      const client = ctx.truenas.client();
      await deleteApp(ctx, task, 'Removing the app', name, removeData);
      const record = ctx.store.get().apps[name];
      if (removeData && record) {
        await task.step('Removing app data', async () => {
          const others = Object.entries(ctx.store.get().apps).filter(([n]) => n !== name);
          // Only app-specific folders are removed, never shared folders or locations: a directory like
          // /mnt/<pool>/<location>/<app>/config is removed together with its <app> parent folder.
          const roots = new Set<string>();
          for (const dir of record.directories) {
            const parts = dir.dataset.split('/');
            if (parts.length < 3) continue;
            roots.add(parts.slice(0, 3).join('/'));
          }
          for (const root of roots) {
            const usedByOther = others.some(([, r]) => r.directories.some((d) => d.dataset === root || d.dataset.startsWith(`${root}/`)));
            const isLocation = Object.values(ctx.store.get().preferences.locations).some((p) => p === `/mnt/${root}` || p?.startsWith(`/mnt/${root}/`));
            if (usedByOther || isLocation) continue;
            if (await datasetExists(client, root)) await client.call('pool.dataset.delete', [root, { recursive: true, force: true }]);
          }
        });
      }
      await ctx.store.update((s) => {
        delete s.apps[name];
      });
      invalidateCatalog();
      ctx.bus.changed('apps');
      ctx.bus.changed('locations');
    },
  );
}
