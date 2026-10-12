import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { hashPassword, verifyPassword } from '../lib/auth.ts';
import { UserError } from '../lib/errors.ts';
import { serverNameSchema, setServerName } from '../services/system.ts';

export async function settingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/settings', async () => {
    let version: string | null = null;
    if (ctx.truenas.connected) {
      version = await ctx.truenas
        .client()
        .call<string>('system.version_short')
        .catch(() => null);
    }
    return {
      serverName: ctx.store.get().server.name ?? '',
      truenas: { url: ctx.demo ? 'Simulated (demo mode)' : (ctx.store.get().truenas?.url ?? null), connected: ctx.truenas.connected, version },
    };
  });

  app.put('/api/settings/server-name', async (req) => {
    const { name } = z.object({ name: serverNameSchema }).parse(req.body);
    await setServerName(ctx, name);
    return { ok: true };
  });

  app.put('/api/settings/password', async (req) => {
    const body = z.object({ current: z.string(), next: z.string().min(8, 'Use at least 8 characters').max(256) }).parse(req.body);
    const admin = ctx.store.get().admin;
    if (!admin || !(await verifyPassword(body.current, admin.passwordHash))) {
      throw new UserError('Your current password is incorrect', 400, 'INVALID_CREDENTIALS', { current: 'Incorrect password' });
    }
    const passwordHash = await hashPassword(body.next);
    await ctx.store.update((s) => {
      s.admin = { username: admin.username, passwordHash };
    });
    return { ok: true };
  });
}
