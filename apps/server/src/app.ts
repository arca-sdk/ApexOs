import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { CollectionUpdate } from '@hearth/truenas-client';
import type { ChangeTopic, MetricsSample } from '@hearth/api-types';
import type { Bus } from './lib/bus.ts';
import type { InstallScript } from './lib/install-script.ts';
import { SESSION_COOKIE, SESSION_TTL_MS, createSessionToken, hashPassword, readSessionToken, verifyPassword } from './lib/auth.ts';
import { UserError, toErrorResponse } from './lib/errors.ts';
import type { StateStore } from './lib/store.ts';
import type { TaskManager } from './lib/tasks.ts';
import { createApiKeyWithPassword, resolveApiUrl, toBaseUrl, type TrueNasManager } from './lib/truenas.ts';
import { registerFeatureRoutes } from './routes/index.ts';

export interface AppContext {
  store: StateStore;
  truenas: TrueNasManager;
  tasks: TaskManager;
  bus: Bus;
  /** Curated install scripts by catalog app id. */
  scripts: Map<string, InstallScript>;
  /** Serve the built web UI from this directory when set. */
  webDir?: string;
  demo: boolean;
  /** Mark cookies `Secure` (set when served over HTTPS). */
  secureCookies?: boolean;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    username?: string;
  }
}

const PUBLIC_ROUTES = new Set(['/api/status', '/api/auth/setup', '/api/auth/login', '/api/health']);

/** Maps middleware collections to the coarse topics the UI listens to. */
const TOPIC_BY_COLLECTION: Record<string, ChangeTopic> = {
  'pool.query': 'storage',
  'zfs.pool.scan': 'storage',
  'disk.query': 'storage',
  'docker.state': 'apps',
  'pool.dataset.query': 'folders',
  'sharing.smb.query': 'folders',
  'user.query': 'users',
  'app.query': 'apps',
  'alert.list': 'alerts',
};

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // Request logs are noisy for a home server; set HEARTH_LOG_LEVEL=info to see them.
    logger: ctx.logger ? { level: process.env.HEARTH_LOG_LEVEL ?? 'warn' } : false,
    bodyLimit: 1024 * 1024,
  });
  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) req.log.error(err);
    void reply.status(status).send(body);
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const secret = ctx.store.get().sessionSecret;
    req.username = readSessionToken(req.cookies[SESSION_COOKIE], secret) ?? undefined;
    const path = req.url.split('?')[0]!;
    if (!req.username && !PUBLIC_ROUTES.has(path)) {
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in' } });
    }
  });

  const setSession = (reply: FastifyReply, username: string) => {
    reply.setCookie(SESSION_COOKIE, createSessionToken(username, ctx.store.get().sessionSecret), {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.secureCookies ?? false,
      maxAge: SESSION_TTL_MS / 1000,
    });
  };

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/status', async (req) => {
    const state = ctx.store.get();
    return {
      authenticated: Boolean(req.username),
      needsAccount: !state.admin,
      truenasConfigured: ctx.truenas.configured,
      truenasConnected: ctx.truenas.connected,
      setupComplete: Boolean(state.server.setupCompletedAt),
      serverName: req.username ? (state.server.name ?? null) : null,
      demo: ctx.demo,
      username: req.username ?? null,
    };
  });

  const credentials = z.object({
    username: z
      .string()
      .trim()
      .regex(/^[a-z_][a-z0-9_.-]{0,31}$/i, 'Use letters, numbers, dots, dashes or underscores'),
    password: z.string().min(8, 'Use at least 8 characters').max(256),
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (ctx.store.get().admin) throw new UserError('An account already exists', 409, 'ALREADY_SETUP');
    const body = credentials.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    await ctx.store.update((s) => {
      s.admin = { username: body.username, passwordHash };
    });
    setSession(reply, body.username);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const admin = ctx.store.get().admin;
    const ok = admin && admin.username === body.username && (await verifyPassword(body.password, admin.passwordHash));
    if (!ok) throw new UserError('Incorrect username or password', 401, 'INVALID_CREDENTIALS');
    setSession(reply, body.username);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  const connectSchema = z.discriminatedUnion('method', [
    z.object({ method: z.literal('password'), host: z.string().trim().min(1), username: z.string().trim().min(1), password: z.string().min(1) }),
    z.object({ method: z.literal('apiKey'), host: z.string().trim().min(1), apiKey: z.string().trim().min(10, 'That API key looks too short') }),
  ]);

  app.post('/api/truenas/connect', async (req) => {
    if (ctx.demo) throw new UserError('Demo mode is connected to a simulated TrueNAS', 409, 'DEMO');
    const body = connectSchema.parse(req.body);
    let baseUrl: string;
    try {
      baseUrl = toBaseUrl(body.host);
    } catch (err) {
      throw new UserError((err as Error).message, 400, 'VALIDATION', { host: 'Enter an IP address or hostname' });
    }
    try {
      const url = await resolveApiUrl(baseUrl);
      const apiKey = body.method === 'apiKey' ? body.apiKey : await createApiKeyWithPassword(url, body.username, body.password);
      await ctx.truenas.configure({ url, auth: { type: 'apiKey', apiKey } });
      await ctx.store.update((s) => {
        s.truenas = { url, apiKey };
      });
    } catch (err) {
      throw new UserError(`Could not connect: ${(err as Error).message}`, 400, 'CONNECT_FAILED');
    }
    return { ok: true };
  });

  app.post('/api/truenas/reconnect', async () => ({ ok: await ctx.truenas.reconnect() }));

  app.get('/api/tasks', async () => ctx.tasks.list());

  app.get('/api/events', (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('tasks', ctx.tasks.list());

    const onTask = (task: unknown) => send('task', task);
    const onUpdate = (update: CollectionUpdate) => {
      const topic = TOPIC_BY_COLLECTION[update.collection];
      if (topic) throttled(topic);
    };
    const onStatus = (connected: boolean) => send('changed', { topic: connected ? 'truenas-connected' : 'truenas-disconnected' });
    const onTopic = (topic: ChangeTopic) => throttled(topic);
    const onMetrics = (sample: MetricsSample) => send('metrics', sample);
    // Coalesce bursts (e.g. scrub progress every 2 s, many dataset events) into one notification per topic.
    const pendingTopics = new Map<ChangeTopic, NodeJS.Timeout>();
    const throttled = (topic: ChangeTopic) => {
      if (pendingTopics.has(topic)) return;
      pendingTopics.set(
        topic,
        setTimeout(() => {
          pendingTopics.delete(topic);
          send('changed', { topic });
        }, 300),
      );
    };
    // A named event (not an SSE comment) so the browser can notice a silently dead connection.
    const heartbeat = setInterval(() => send('ping', {}), 15_000);

    ctx.tasks.on('task', onTask);
    ctx.bus.on('changed', onTopic);
    ctx.bus.on('metrics', onMetrics);
    ctx.truenas.on('update', onUpdate);
    ctx.truenas.on('status', onStatus);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      for (const t of pendingTopics.values()) clearTimeout(t);
      ctx.tasks.off('task', onTask);
      ctx.bus.off('changed', onTopic);
      ctx.bus.off('metrics', onMetrics);
      ctx.truenas.off('update', onUpdate);
      ctx.truenas.off('status', onStatus);
    });
  });

  await registerFeatureRoutes(app, ctx);

  if (ctx.webDir && existsSync(ctx.webDir)) {
    await app.register(fastifyStatic, { root: ctx.webDir, wildcard: false });
    // Single-page app: unknown non-API paths render index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
