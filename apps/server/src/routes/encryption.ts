import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import {
  buildRecoveryFile,
  changeKeyMode,
  checkConversion,
  discardConversion,
  encryptionHousekeeping,
  lockFolder,
  prepareKeyModeChange,
  prepareLock,
  prepareUnlock,
  recoveryStatus,
  removeSafetyCopy,
  retryConversion,
  startConversion,
  unlockFolder,
} from '../services/encryption.ts';

const nameParam = z.object({ name: z.string().min(1) });
const secret = z.string().max(512);
const HOUR = 3600_000;

export async function encryptionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/folders/:name/lock', async (req) => {
    const folder = await prepareLock(ctx, nameParam.parse(req.params).name);
    return { task: ctx.tasks.start({ type: 'folder-lock', title: `Locking folder ${folder.name}`, ref: folder.name }, (t) => lockFolder(ctx, folder, t)) };
  });

  app.post('/api/folders/:name/unlock', async (req) => {
    const body = z.object({ passphrase: secret.optional(), key: z.string().max(128).optional() }).parse(req.body ?? {});
    const folder = await prepareUnlock(ctx, nameParam.parse(req.params).name, body);
    return {
      task: ctx.tasks.start({ type: 'folder-unlock', title: `Unlocking folder ${folder.name}`, ref: folder.name }, (t) => unlockFolder(ctx, folder, body, t)),
    };
  });

  app.put('/api/folders/:name/encryption', async (req) => {
    const body = z
      .object({ mode: z.enum(['key', 'passphrase']), passphrase: secret.optional(), currentPassphrase: secret.optional() })
      .parse(req.body ?? {});
    const folder = await prepareKeyModeChange(ctx, nameParam.parse(req.params).name, body);
    const title = body.mode === 'passphrase' ? `Setting a passphrase for ${folder.name}` : `Switching ${folder.name} to an automatic key`;
    return { task: ctx.tasks.start({ type: 'folder-key-mode', title, ref: folder.name }, (t) => changeKeyMode(ctx, folder, body, t)) };
  });

  app.get('/api/folders/:name/encryption/convert', async (req) => {
    const { folder: _folder, temp: _temp, original: _original, ...check } = await checkConversion(ctx, nameParam.parse(req.params).name);
    return check;
  });

  app.post('/api/folders/:name/encryption/convert', async (req) => {
    const body = z.object({ mode: z.enum(['key', 'passphrase']), passphrase: secret.optional(), keepOriginal: z.boolean().optional() }).parse(req.body ?? {});
    return { task: await startConversion(ctx, nameParam.parse(req.params).name, body) };
  });

  app.post('/api/folders/:name/encryption/convert/retry', async (req) => {
    const { passphrase } = z.object({ passphrase: secret.optional() }).parse(req.body ?? {});
    return { task: await retryConversion(ctx, nameParam.parse(req.params).name, passphrase) };
  });

  app.post('/api/folders/:name/encryption/convert/discard', async (req) => ({ task: await discardConversion(ctx, nameParam.parse(req.params).name) }));

  app.delete('/api/folders/:name/encryption/safety-copy', async (req) => ({ task: await removeSafetyCopy(ctx, nameParam.parse(req.params).name) }));

  app.get('/api/encryption/recovery', async () => recoveryStatus(ctx));

  app.post('/api/encryption/recovery/file', async (_req, reply) => {
    const file = await buildRecoveryFile(ctx);
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
      .header('cache-control', 'no-store')
      .header('x-apexos-keys', String(file.count))
      .send(file.body);
  });

  // Housekeeping: once TrueNAS is reachable after start-up, resume or settle runs cut short by a restart;
  // every hour, remove safety copies whose time is up.
  const run = (startup: boolean) => void encryptionHousekeeping(ctx, { startup }).catch(() => undefined);
  let started = false;
  const startup = () => {
    if (started || !ctx.truenas.connected) return;
    started = true;
    run(true);
  };
  const onStatus = (connected: boolean) => connected && startup();
  ctx.truenas.on('status', onStatus);
  setImmediate(startup);
  const hourly = setInterval(() => run(false), HOUR);
  hourly.unref();
  app.addHook('onClose', async () => {
    clearInterval(hourly);
    ctx.truenas.off('status', onStatus);
  });
}
