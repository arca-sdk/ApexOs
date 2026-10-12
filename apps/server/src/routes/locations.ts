import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { listLocations, setLocation } from '../services/locations.ts';

export async function locationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/locations', async () => listLocations(ctx));
  app.put('/api/locations/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { path } = z.object({ path: z.string().min(1) }).parse(req.body);
    return setLocation(ctx, id, path);
  });
}
