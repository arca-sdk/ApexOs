import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { checkLocationMove, folderMoveHousekeeping, listFolderMoves, startLocationMove, startOldCopyRemoval } from '../services/folder-move.ts';
import { listLocations, setLocation } from '../services/locations.ts';

const HOUR = 3600_000;
const idParam = z.object({ id: z.string() });

export async function locationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/locations', async () => listLocations(ctx));
  app.get('/api/locations/moves', async () => listFolderMoves(ctx));
  app.delete('/api/locations/moves/:id/old-copy', async (req) => ({ task: await startOldCopyRemoval(ctx, idParam.parse(req.params).id) }));
  app.get('/api/locations/:id/move', async (req) => checkLocationMove(ctx, idParam.parse(req.params).id));
  app.post('/api/locations/:id/move', async (req) => {
    const { pool } = z.object({ pool: z.string().min(1) }).parse(req.body);
    return { task: await startLocationMove(ctx, idParam.parse(req.params).id, pool) };
  });
  app.put('/api/locations/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { path } = z.object({ path: z.string().min(1) }).parse(req.body);
    return setLocation(ctx, id, path);
  });

  // Every hour, and whenever TrueNAS becomes reachable: finish or clean up interrupted moves, remove old copies.
  const run = () => void folderMoveHousekeeping(ctx).catch(() => undefined);
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
