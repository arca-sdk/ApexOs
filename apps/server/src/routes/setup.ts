import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { getSetupInfo, reviewSetup, startSetup } from '../services/setup.ts';

const setupSchema = z.object({
  serverName: z.string().trim(),
  timezone: z.string(),
  keepPools: z.array(z.string()),
  importPools: z.array(z.string()),
  newPools: z.array(
    z.object({ name: z.string().trim(), layout: z.enum(['STRIPE', 'MIRROR', 'RAIDZ1', 'RAIDZ2', 'RAIDZ3']), drives: z.array(z.string()).min(1) }),
  ),
  appsPool: z.string().nullish(),
  consentErase: z.boolean(),
  consentKeep: z.boolean(),
});

export async function setupRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/setup', async () => getSetupInfo(ctx));
  app.post('/api/setup/review', async (req) => reviewSetup(ctx, setupSchema.parse(req.body)));
  app.post('/api/setup/finish', async (req) => ({ task: await startSetup(ctx, setupSchema.parse(req.body)) }));
}
