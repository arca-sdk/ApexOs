import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { getCatalogApp, listCatalog, listInstalled, startInstall, startStop, startUninstall, startUpgrade, startUpgradeAll } from '../services/apps.ts';

const nameParam = z.object({ name: z.string().min(1) });

export async function appRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/apps', async () => listInstalled(ctx));

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
      })
      .parse(req.body);
    return { task: await startInstall(ctx, body) };
  });

  app.post('/api/apps/upgrade-all', async () => ({ task: await startUpgradeAll(ctx) }));
  app.post('/api/apps/:name/start', async (req) => ({ task: await startStop(ctx, nameParam.parse(req.params).name, 'start') }));
  app.post('/api/apps/:name/stop', async (req) => ({ task: await startStop(ctx, nameParam.parse(req.params).name, 'stop') }));
  app.post('/api/apps/:name/upgrade', async (req) => ({ task: await startUpgrade(ctx, nameParam.parse(req.params).name) }));
  app.delete('/api/apps/:name', async (req) => {
    const { removeData } = z.object({ removeData: z.boolean().default(false) }).parse(req.body ?? {});
    return { task: await startUninstall(ctx, nameParam.parse(req.params).name, removeData) };
  });
}
