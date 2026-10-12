import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { appRoutes } from './apps.ts';
import { driveHealthRoutes } from './drive-health.ts';
import { encryptionRoutes } from './encryption.ts';
import { folderRoutes } from './folders.ts';
import { locationRoutes } from './locations.ts';
import { networkRoutes } from './network.ts';
import { notificationRoutes } from './notifications.ts';
import { poolErrorRoutes } from './pool-errors.ts';
import { remoteAccessRoutes } from './remote-access.ts';
import { settingsRoutes } from './settings.ts';
import { setupRoutes } from './setup.ts';
import { storageRoutes } from './storage.ts';
import { systemRoutes } from './system.ts';
import { userRoutes } from './users.ts';

export async function registerFeatureRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await settingsRoutes(app, ctx);
  await systemRoutes(app, ctx);
  await setupRoutes(app, ctx);
  await storageRoutes(app, ctx);
  await poolErrorRoutes(app, ctx);
  await folderRoutes(app, ctx);
  await encryptionRoutes(app, ctx);
  await userRoutes(app, ctx);
  await locationRoutes(app, ctx);
  await appRoutes(app, ctx);
  await notificationRoutes(app, ctx);
  await driveHealthRoutes(app, ctx);
  await networkRoutes(app, ctx);
  await remoteAccessRoutes(app, ctx);
}
