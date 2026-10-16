import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { getCatalogApp, listCatalog, listInstalled, startGpuChange, startInstall, startStop, startUninstall, startUpgrade, startUpgradeAll } from '../services/apps.ts';
import { oldAppDataHousekeeping, previewAppsPool, startAppsPoolChange } from '../services/apps-pool.ts';

const HOUR = 3600_000;
const nameParam = z.object({ name: z.string().min(1) });

export async function appRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/apps', async () => listInstalled(ctx));

  app.get('/api/apps/pool', async (req) => {
    const { pool } = z.object({ pool: z.string().min(1) }).parse(req.query);
    return previewAppsPool(ctx, pool);
  });

  app.put('/api/apps/pool', async (req) => {
    const body = z.object({ pool: z.string().min(1), eraseOldAppData: z.boolean().default(false) }).parse(req.body);
    return { task: await startAppsPoolChange(ctx, body.pool, body.eraseOldAppData) };
  });

  app.get('/api/apps/catalog', async (req) => {
    const q = z.object({ search: z.string().optional(), category: z.string().optional() }).parse(req.query);
    return listCatalog(ctx, q);
  });

  app.get('/api/apps/catalog/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { train } = z.object({ train: z.string().optional() }).parse(req.query);
    return getCatalogApp(ctx, id, train);
  });

  app.post('/api/apps/install', async (req) => {
    const body = z
      .object({
        catalogApp: z.string().min(1),
        train: z.string().min(1),
        appName: z.string().optional(),
        answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
        useGpu: z.boolean().optional(),
      })
      .parse(req.body);
    return { task: await startInstall(ctx, body) };
  });

  app.post('/api/apps/upgrade-all', async () => ({ task: await startUpgradeAll(ctx) }));
  app.post('/api/apps/:name/start', async (req) => ({ task: await startStop(ctx, nameParam.parse(req.params).name, 'start') }));
  app.post('/api/apps/:name/stop', async (req) => ({ task: await startStop(ctx, nameParam.parse(req.params).name, 'stop') }));
  app.post('/api/apps/:name/upgrade', async (req) => ({ task: await startUpgrade(ctx, nameParam.parse(req.params).name) }));
  app.post('/api/apps/:name/gpu', async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    return { task: await startGpuChange(ctx, nameParam.parse(req.params).name, enabled) };
  });
  app.delete('/api/apps/:name', async (req) => {
    const { removeData } = z.object({ removeData: z.boolean().default(false) }).parse(req.body ?? {});
    return { task: await startUninstall(ctx, nameParam.parse(req.params).name, removeData) };
  });

  // Every hour, and whenever TrueNAS becomes reachable, remove app data left on old pools whose time is up.
  const run = () => void oldAppDataHousekeeping(ctx).catch(() => undefined);
  const onStatus = (connected: boolean) => connected && run();
  ctx.truenas.on('status', onStatus);
  setImmediate(run);
  const hourly = setInterval(run, HOUR);
  hourly.unref();
  app.addHook('onClose', async () => {
    clearInterval(hourly);
    ctx.truenas.off('status', onStatus);
  });
}
