import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { dismissAll, dismissNotice, listNotices } from '../services/notifications.ts';

export async function notificationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/notifications', async () => ({ notices: await listNotices(ctx) }));
  app.post('/api/notifications/dismiss-all', async () => {
    await dismissAll(ctx);
    return { ok: true };
  });
  app.post('/api/notifications/:id/dismiss', async (req) => {
    await dismissNotice(ctx, z.object({ id: z.string() }).parse(req.params).id);
    return { ok: true };
  });
}
