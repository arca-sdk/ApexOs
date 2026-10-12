import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { getRemoteStatus, startCloudflare, startTailscale, stopCloudflare, stopTailscale } from '../services/remote-access.ts';
import {
  beginSetup,
  cancelSetup,
  codeStep,
  confirmSetup,
  disableTwoFactor,
  getAccountSecurity,
  regenerateRecoveryCodes,
  signOutEverywhere,
} from '../services/two-factor.ts';

const codeBody = z.object({ code: z.string().trim().min(1, 'Enter a code').max(64) });

/** Responses carrying secrets (TOTP secret, recovery codes) must not be cached anywhere. */
function noStore(reply: FastifyReply): void {
  void reply.header('cache-control', 'no-store');
}

export async function remoteAccessRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Second sign-in step (public; listed in PUBLIC_ROUTES in app.ts).
  app.post('/api/auth/login/verify', async (req, reply) => {
    const body = z.object({ challenge: z.string().min(1).max(2048), code: z.string().trim().min(1, 'Enter a code').max(64) }).parse(req.body);
    return codeStep(ctx, req, reply, body);
  });

  app.post('/api/auth/sign-out-everywhere', async (_req, reply) => {
    await signOutEverywhere(ctx, reply);
    return { ok: true };
  });

  app.get('/api/auth/security', async (req) => getAccountSecurity(ctx, req));

  app.post('/api/auth/2fa/setup', async (_req, reply) => {
    noStore(reply);
    return beginSetup(ctx);
  });

  app.delete('/api/auth/2fa/setup', async () => {
    await cancelSetup(ctx);
    return { ok: true };
  });

  app.post('/api/auth/2fa/enable', async (req, reply) => {
    noStore(reply);
    return confirmSetup(ctx, req, reply, codeBody.parse(req.body).code);
  });

  app.post('/api/auth/2fa/disable', async (req, reply) => {
    const body = z.object({ password: z.string().max(1024), code: z.string().trim().min(1, 'Enter a code').max(64) }).parse(req.body);
    await disableTwoFactor(ctx, req, reply, body);
    return { ok: true };
  });

  app.post('/api/auth/2fa/recovery-codes', async (req, reply) => {
    noStore(reply);
    return regenerateRecoveryCodes(ctx, req, reply, codeBody.parse(req.body).code);
  });

  app.get('/api/remote', async (req) => getRemoteStatus(ctx, req));
  app.post('/api/remote/tailscale', async (req) => ({ task: await startTailscale(ctx, req.body) }));
  app.delete('/api/remote/tailscale', async () => ({ task: await stopTailscale(ctx) }));
  app.post('/api/remote/cloudflare', async (req) => ({ task: await startCloudflare(ctx, req.body) }));
  app.delete('/api/remote/cloudflare', async () => ({ task: await stopCloudflare(ctx) }));
}
