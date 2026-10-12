import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.ts';
import { appRoutes } from './apps.ts';
import { folderRoutes } from './folders.ts';
import { locationRoutes } from './locations.ts';
import { notificationRoutes } from './notifications.ts';
import { poolErrorRoutes } from './pool-errors.ts';
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
  await userRoutes(app, ctx);
  await locationRoutes(app, ctx);
  await appRoutes(app, ctx);
  await notificationRoutes(app, ctx);
}
