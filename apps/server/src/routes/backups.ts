import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import {
  addDestination,
  checkDestination,
  createBackups,
  forgetCleanup,
  getRestoreInfo,
  listBackups,
  prepareBackups,
  prepareRestore,
  prepareRun,
  removeDestination,
  startFreshCopy,
  startRemoveBackup,
  startRestore,
  startRun,
  updateBackup,
  updateDestinationSpace,
  validateAddRequest,
} from '../services/backups.ts';

const credentials = z.discriminatedUnion('method', [
  z.object({ method: z.literal('password'), address: z.string().trim().min(1).max(300), username: z.string().trim().min(1).max(64), password: z.string().min(1).max(512) }),
  z.object({ method: z.literal('apiKey'), address: z.string().trim().min(1).max(300), apiKey: z.string().trim().min(10, 'That API key looks too short').max(512) }),
]);

const schedule = z.object({
  frequency: z.enum(['hourly', 'daily', 'weekly']),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
  weekday: z.number().int().min(0).max(6),
});
const options = z.object({
  schedule,
  keepDays: z.number().int().min(1).max(365),
  speedLimitMbps: z.number().min(1).max(100_000).nullable(),
});
const idParam = z.object({ id: z.string().min(1).max(64) });

/** Backups between the user's own servers (see services/backups.ts). */
export async function backupRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/backups', async (req) => {
    const { fresh } = z.object({ fresh: z.string().optional() }).parse(req.query);
    return listBackups(ctx, { fresh: fresh === '1' });
  });

  app.post('/api/backups/destinations/check', async (req) => checkDestination(ctx, credentials.parse(req.body)));

  app.post('/api/backups/destinations', async (req) => {
    const body = z.intersection(credentials, z.object({ pool: z.string().min(1).max(200), spaceBytes: z.number().int().positive() })).parse(req.body);
    validateAddRequest(ctx, body);
    if (ctx.tasks.findRunning('backup-destination-add')) throw new UserError('Another destination is being added. Wait for it to finish.', 409, 'BUSY');
    const task = ctx.tasks.start({ type: 'backup-destination-add', title: 'Adding a backup destination', ref: body.address }, async (t) => {
      await addDestination(ctx, body, (name, fn) => t.step(name, fn));
    });
    return { task };
  });

  app.put('/api/backups/destinations/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { spaceBytes } = z.object({ spaceBytes: z.number().int().positive() }).parse(req.body);
    await updateDestinationSpace(ctx, id, spaceBytes);
    return { ok: true };
  });

  app.delete('/api/backups/destinations/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const dest = ctx.store.get().backups.destinations.find((d) => d.id === id);
    if (!dest) throw new UserError('Backup destination not found', 404, 'NOT_FOUND');
    if (ctx.tasks.findRunning('backup-destination-remove', id)) throw new UserError('This destination is already being removed.', 409, 'BUSY');
    const task = ctx.tasks.start({ type: 'backup-destination-remove', title: `Removing ${dest.name} as a backup destination`, ref: id }, (t) =>
      removeDestination(ctx, id, (name, fn) => t.step(name, fn)),
    );
    return { task };
  });

  app.delete('/api/backups/cleanups/:id', async (req) => {
    await forgetCleanup(ctx, idParam.parse(req.params).id);
    return { ok: true };
  });

  app.post('/api/backups', async (req) => {
    const body = options.extend({ destinationId: z.string().min(1), folders: z.array(z.string().min(1).max(200)).min(1).max(100) }).parse(req.body);
    const plan = await prepareBackups(ctx, body);
    const names = plan.folders.map((f) => f.name);
    const task = ctx.tasks.start(
      { type: 'backup-create', title: `Setting up backups to ${plan.destination.name}`, ref: plan.destination.id, steps: names.map((n) => `Setting up ${n}`) },
      async (t) => {
        const created = await createBackups(ctx, plan, (name, fn) => t.step(name, fn));
        // The first full copy of each folder starts right away, as its own task.
        for (const rec of created) startRun(ctx, rec, plan.destination);
      },
    );
    return { task };
  });

  app.put('/api/backups/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = options.partial().extend({ paused: z.boolean().optional() }).parse(req.body);
    return updateBackup(ctx, id, body);
  });

  app.post('/api/backups/:id/run', async (req) => {
    const { rec, dest } = await prepareRun(ctx, idParam.parse(req.params).id);
    return { task: startRun(ctx, rec, dest) };
  });

  app.post('/api/backups/:id/fresh-copy', async (req) => {
    const { rec, dest } = await prepareRun(ctx, idParam.parse(req.params).id);
    return { task: startFreshCopy(ctx, rec, dest) };
  });

  app.delete('/api/backups/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const rec = ctx.store.get().backups.jobs.find((j) => j.id === id);
    const dest = rec && ctx.store.get().backups.destinations.find((d) => d.id === rec.destinationId);
    if (!rec || !dest) throw new UserError('Backup not found', 404, 'NOT_FOUND');
    if (ctx.tasks.findRunning('backup-restore', id)) throw new UserError('A restore from this backup is running. Wait for it to finish first.', 409, 'BUSY');
    return { task: startRemoveBackup(ctx, rec, dest) };
  });

  app.get('/api/backups/:id/restore', async (req) => getRestoreInfo(ctx, idParam.parse(req.params).id));

  app.post('/api/backups/:id/restore', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        restorePoint: z.string().min(1).max(200).nullable(),
        name: z.string().trim().min(1).max(80),
        pool: z.string().min(1).max(200),
        secret: z.string().max(1024).nullable().optional(),
      })
      .parse(req.body);
    if (ctx.tasks.findRunning('backup-restore', id)) throw new UserError('A restore from this backup is already running.', 409, 'BUSY');
    const prepared = await prepareRestore(ctx, id, body);
    return { task: startRestore(ctx, prepared, body) };
  });
}
