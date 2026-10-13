import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { getDashboard } from '../services/dashboard.ts';
import { assertRiskAcknowledged, getTimezone, getUpdateInfo, invalidateUpdateCheck, power, scanHardware, setTimezone } from '../services/system.ts';

export async function systemRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/dashboard', async () => getDashboard(ctx));
  app.get('/api/system/scan', async () => scanHardware(ctx));
  app.get('/api/system/timezone', async () => getTimezone(ctx));
  app.put('/api/system/timezone', async (req) => {
    const { timezone } = z.object({ timezone: z.string().min(1) }).parse(req.body);
    await setTimezone(ctx, timezone);
    return { ok: true };
  });

  app.get('/api/system/update', async () => getUpdateInfo(ctx));
  app.post('/api/system/update', async (req) => {
    const { acknowledgeRisk } = z.object({ acknowledgeRisk: z.boolean().optional() }).parse(req.body ?? {});
    const info = await getUpdateInfo(ctx);
    if (!info.available) throw new UserError('No update is available.', 409, 'NO_UPDATE');
    await assertRiskAcknowledged(ctx, acknowledgeRisk);
    if (ctx.tasks.findRunning('system-update')) throw new UserError('An update is already running.', 409, 'BUSY');
    const task = ctx.tasks.start(
      { type: 'system-update', title: `Updating TrueNAS to ${info.available.version}`, steps: ['Downloading and installing', 'Restarting'] },
      async (t) => {
        await t.step('Downloading and installing', (report) =>
          ctx.truenas.client().job('update.run', [{ reboot: false }], (job) => report(job.progress.percent ?? 0, job.progress.description ?? undefined)),
        );
        invalidateUpdateCheck();
        await t.step('Restarting', () => power(ctx, 'restart'));
      },
    );
    return { task };
  });

  app.post('/api/system/power', async (req) => {
    const body = z.object({ action: z.enum(['restart', 'shutdown']), acknowledgeRisk: z.boolean().optional() }).parse(req.body);
    await assertRiskAcknowledged(ctx, body.acknowledgeRisk);
    await power(ctx, body.action);
    return { ok: true };
  });

  app.get('/api/system/truenas-ui', async () => {
    const url = ctx.store.get().truenas?.url;
    if (ctx.demo || !url) return { url: null };
    const parsed = new URL(url);
    return { url: `https://${parsed.host}/` };
  });
}
