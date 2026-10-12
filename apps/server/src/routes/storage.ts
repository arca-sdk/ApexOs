import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Drive, StorageOverview } from '@apexos/api-types';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { estimateLayout, planPools } from '../lib/layout.ts';
import { importablePools, invalidateImportable } from '../services/setup.ts';
import {
  addDriveToPool,
  assertDriveFits,
  addSpare,
  deletePool,
  findPool,
  getStorage,
  importPool,
  replaceDrive,
  startScrub,
  validateNewPool,
  createPool,
} from '../services/storage.ts';
import { assertRiskAcknowledged } from '../services/system.ts';

const layoutSchema = z.enum(['STRIPE', 'MIRROR', 'RAIDZ1', 'RAIDZ2', 'RAIDZ3']);
const idParam = z.object({ id: z.coerce.number().int() });

function unassignedDrive(overview: StorageOverview, identifier: string): Drive {
  const drive = overview.unassigned.find((d) => d.identifier === identifier);
  if (!drive) throw new UserError('That drive is not available', 404, 'NOT_FOUND');
  return drive;
}

export async function storageRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/storage', async () => getStorage(ctx));

  app.get('/api/storage/importable', async (req) => {
    const { fresh } = z.object({ fresh: z.string().optional() }).parse(req.query);
    return importablePools(ctx, fresh === '1');
  });

  app.post('/api/storage/plan', async (req) => {
    const body = z.object({ priority: z.enum(['space', 'balanced', 'protection']), drives: z.array(z.string()).optional(), takenNames: z.array(z.string()).optional() }).parse(req.body);
    const storage = await getStorage(ctx);
    const all = [...storage.unassigned, ...storage.pools.flatMap((p) => [...p.drives, ...p.spares])];
    const candidates = body.drives ? all.filter((d) => body.drives!.includes(d.identifier)) : storage.unassigned.filter((d) => d.available);
    return planPools(candidates, body.priority, body.takenNames ?? storage.pools.map((p) => p.name));
  });

  app.post('/api/storage/estimate', async (req) => {
    const body = z.object({ layout: layoutSchema, drives: z.array(z.string()) }).parse(req.body);
    const storage = await getStorage(ctx);
    const all = [...storage.unassigned, ...storage.pools.flatMap((p) => [...p.drives, ...p.spares])];
    const drives = body.drives.map((id) => all.find((d) => d.identifier === id)).filter((d) => d !== undefined);
    return estimateLayout(body.layout, drives);
  });

  app.post('/api/storage/pools', async (req) => {
    const spec = z.object({ name: z.string().trim(), layout: layoutSchema, drives: z.array(z.string()).min(1) }).parse(req.body);
    validateNewPool(await getStorage(ctx), spec);
    const task = ctx.tasks.start({ type: 'pool-create', title: `Creating pool ${spec.name}`, ref: spec.name }, async (t) => {
      await createPool(ctx, spec, (p, m) => t.progress(p, m));
      invalidateImportable(); // reused drives may have held an exported pool
      ctx.bus.changed('storage');
    });
    return { task };
  });

  app.patch('/api/storage/pools/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { displayName } = z.object({ displayName: z.string().trim().min(1).max(40) }).parse(req.body);
    const pool = findPool(await getStorage(ctx), id);
    await ctx.store.update((s) => {
      s.poolNames[pool.name] = displayName;
    });
    ctx.bus.changed('storage');
    return findPool(await getStorage(ctx), id);
  });

  app.delete('/api/storage/pools/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body ?? {});
    const pool = findPool(await getStorage(ctx), id);
    if (confirmName.trim() !== pool.name && confirmName.trim() !== pool.displayName) {
      throw new UserError('Type the pool name exactly to confirm.', 400, 'VALIDATION', { confirmName: 'Does not match' });
    }
    if (pool.isAppsPool && Object.keys(ctx.store.get().apps).length) {
      throw new UserError('Your apps run from this pool. Uninstall them first.', 409, 'IN_USE');
    }
    const task = ctx.tasks.start({ type: 'pool-delete', title: `Erasing pool ${pool.displayName}`, ref: pool.displayName }, async () => {
      await deletePool(ctx, pool);
      invalidateImportable();
      ctx.bus.changed('storage');
      ctx.bus.changed('folders');
    });
    return { task };
  });

  app.post('/api/storage/pools/:id/scrub', async (req) => {
    const { id } = idParam.parse(req.params);
    await startScrub(ctx, findPool(await getStorage(ctx), id));
    ctx.bus.changed('storage');
    return { ok: true };
  });

  app.post('/api/storage/pools/:id/drives', async (req) => {
    const { id } = idParam.parse(req.params);
    const { drive } = z.object({ drive: z.string() }).parse(req.body);
    const overview = await getStorage(ctx);
    const pool = findPool(overview, id);
    if (!pool.layout.expandable) throw new UserError('This pool can’t grow one drive at a time.', 400, 'NOT_EXPANDABLE');
    assertDriveFits(pool, unassignedDrive(overview, drive));
    const task = ctx.tasks.start({ type: 'pool-expand', title: `Adding a drive to ${pool.displayName}`, ref: pool.displayName }, async (t) => {
      await addDriveToPool(ctx, pool, drive, overview, (p, m) => t.progress(p, m));
      ctx.bus.changed('storage');
    });
    return { task };
  });

  app.post('/api/storage/pools/:id/replace', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ oldDrive: z.string(), newDrive: z.string(), acknowledgeRisk: z.boolean().optional() }).parse(req.body);
    const overview = await getStorage(ctx);
    const pool = findPool(overview, id);
    assertDriveFits({ ...pool, drives: pool.drives.filter((d) => d.identifier !== body.oldDrive) }, unassignedDrive(overview, body.newDrive));
    // Replacing a failed drive in a degraded pool is the fix, so only other pools' risk needs acknowledging.
    const failing = pool.drives.find((d) => d.identifier === body.oldDrive);
    if (!(failing && (failing.missing || failing.status !== 'ONLINE'))) await assertRiskAcknowledged(ctx, body.acknowledgeRisk);
    const task = ctx.tasks.start({ type: 'pool-replace', title: `Replacing a drive in ${pool.displayName}`, ref: pool.displayName }, async (t) => {
      await replaceDrive(ctx, pool, body.oldDrive, body.newDrive, overview, (p, m) => t.progress(p, m));
      ctx.bus.changed('storage');
    });
    return { task };
  });

  app.post('/api/storage/pools/:id/spares', async (req) => {
    const { id } = idParam.parse(req.params);
    const { drive } = z.object({ drive: z.string() }).parse(req.body);
    const overview = await getStorage(ctx);
    const pool = findPool(overview, id);
    assertDriveFits(pool, unassignedDrive(overview, drive));
    const task = ctx.tasks.start({ type: 'pool-spare', title: `Adding a spare to ${pool.displayName}`, ref: pool.displayName }, async () => {
      await addSpare(ctx, pool, drive, overview);
      ctx.bus.changed('storage');
    });
    return { task };
  });

  app.post('/api/storage/import', async (req) => {
    const { guid } = z.object({ guid: z.string() }).parse(req.body);
    const found = (await importablePools(ctx)).find((p) => p.guid === guid);
    if (!found) throw new UserError('That pool is no longer available to import.', 404, 'NOT_FOUND');
    const task = ctx.tasks.start({ type: 'pool-import', title: `Importing pool ${found.name}`, ref: found.name }, async (t) => {
      await importPool(ctx, guid, (p, m) => t.progress(p, m));
      invalidateImportable();
      ctx.bus.changed('storage');
      ctx.bus.changed('folders');
    });
    return { task };
  });
}
