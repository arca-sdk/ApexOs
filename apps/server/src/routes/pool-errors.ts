import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { getPoolDataErrors, resetErrorCounts, startRepair } from '../services/pool-errors.ts';
import { findPool, getStorage } from '../services/storage.ts';

const idParam = z.object({ id: z.coerce.number().int() });

/** Damaged files on a pool: the classified list, Repair, and Reset error count. */
export async function poolErrorRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/storage/pools/:id/errors', async (req) => {
    const { id } = idParam.parse(req.params);
    const { fresh } = z.object({ fresh: z.string().optional() }).parse(req.query);
    const pool = findPool(await getStorage(ctx), id);
    return getPoolDataErrors(ctx, pool, { fresh: fresh === '1' });
  });

  app.post('/api/storage/pools/:id/repair', async (req) => {
    const { id } = idParam.parse(req.params);
    const { fingerprint } = z.object({ fingerprint: z.string().min(1).max(128) }).parse(req.body);
    const pool = findPool(await getStorage(ctx), id);
    return { task: await startRepair(ctx, pool, fingerprint) };
  });

  app.post('/api/storage/pools/:id/reset-errors', async (req) => {
    const { id } = idParam.parse(req.params);
    await resetErrorCounts(ctx, findPool(await getStorage(ctx), id));
    return { ok: true };
  });
}
