import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type AppContext } from './app.ts';
import { Bus } from './lib/bus.ts';
import { HostCommands } from './lib/host.ts';
import { loadScripts } from './lib/install-script.ts';
import { StateStore } from './lib/store.ts';
import { TaskManager } from './lib/tasks.ts';
import { TrueNasManager } from './lib/truenas.ts';
import { startMetrics } from './services/metrics.ts';
import { recordTaskNotices } from './services/notifications.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const config = {
  port: Number(process.env.APEXOS_PORT ?? 8080),
  // Demo mode only listens on this computer unless told otherwise; the first visitor creates the admin account.
  host: process.env.APEXOS_HOST ?? (process.env.APEXOS_DEMO === '1' ? '127.0.0.1' : '0.0.0.0'),
  dataDir: resolve(process.env.APEXOS_DATA_DIR ?? '.data'),
  webDir: resolve(process.env.APEXOS_WEB_DIR ?? resolve(here, '../../web/dist')),
  catalogDir: resolve(process.env.APEXOS_CATALOG_DIR ?? resolve(here, '../catalog')),
  demo: process.env.APEXOS_DEMO === '1',
  secureCookies: process.env.APEXOS_SECURE_COOKIES === '1',
};

const dataDir = config.demo ? resolve(config.dataDir, 'demo') : config.dataDir;
const store = new StateStore(dataDir);
await store.load();
const truenas = new TrueNasManager();
const tasks = new TaskManager();
const bus = new Bus();
const { scripts, errors } = await loadScripts(config.catalogDir);
for (const [id, problems] of Object.entries(errors)) console.warn(`Skipping install script ${id}: ${problems.join('; ')}`);

const ctx: AppContext = {
  store,
  truenas,
  tasks,
  bus,
  host: new HostCommands(truenas),
  scripts,
  webDir: config.webDir,
  demo: config.demo,
  secureCookies: config.secureCookies,
  logger: true,
};
startMetrics(ctx);
recordTaskNotices(ctx);

let closeMock: (() => Promise<void>) | undefined;
if (config.demo) {
  // Demo mode runs an in-process simulated TrueNAS so ApexOs can be tried without a server.
  const { startMockTrueNas } = await import('@apexos/mock-truenas');
  // APEXOS_DEMO_SCENARIO=configured starts with pools, folders and an app already set up.
  const scenario = process.env.APEXOS_DEMO_SCENARIO === 'configured' ? 'configured' : 'fresh';
  const mock = await startMockTrueNas({ apiKey: 'demo-api-key', scenario, stateFile: resolve(dataDir, `mock-truenas-${scenario}.json`) });
  if (scenario === 'configured' && !store.get().server.setupCompletedAt) {
    await store.update((s) => {
      s.server.setupCompletedAt = new Date().toISOString();
      s.server.name ??= 'truenas';
      s.preferences.locations = {
        ApplicationsPerformance: '/mnt/SSDs/Applications',
        Media: '/mnt/HDDs/Media',
        Photos: '/mnt/HDDs/Photos',
        Documents: '/mnt/HDDs/Documents',
        ...s.preferences.locations,
      };
    });
  }
  closeMock = () => mock.close();
  await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'demo-api-key' } });
  console.log(`Demo mode: simulated TrueNAS at ${mock.url}`);
} else {
  const saved = store.get().truenas;
  const envUrl = process.env.APEXOS_TRUENAS_URL;
  const envKey = process.env.APEXOS_TRUENAS_API_KEY;
  if (envUrl && envKey) {
    await truenas.configureLazy({ url: envUrl, auth: { type: 'apiKey', apiKey: envKey } });
  } else if (saved) {
    await truenas.configureLazy({ url: saved.url, auth: { type: 'apiKey', apiKey: saved.apiKey } });
  }
}

const app = await buildApp(ctx);
await app.listen({ port: config.port, host: config.host });
console.log(`ApexOs ${config.demo ? '(demo) ' : ''}is running on http://localhost:${config.port}`);

const shutdown = async () => {
  await app.close();
  await truenas.close();
  await closeMock?.();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
