import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { getDriveHealthDetail, readSmartNow } from '../services/drive-health.ts';

const params = z.object({ identifier: z.string().min(1).max(256) });

/** Drive diagnosis: error history and actions per drive, and reading SMART on request. */
export async function driveHealthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/storage/drives/:identifier/health', async (req) => getDriveHealthDetail(ctx, params.parse(req.params).identifier));

  app.post('/api/storage/drives/:identifier/smart', async (req) => readSmartNow(ctx, params.parse(req.params).identifier));
}
