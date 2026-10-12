import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { createUser, deleteUser, listUsers, updateUser } from '../services/users.ts';

const idParam = z.object({ id: z.coerce.number().int() });

export async function userRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/users', async () => listUsers(ctx));
  app.post('/api/users', async (req) => {
    const body = z.object({ username: z.string().trim(), password: z.string() }).parse(req.body);
    return createUser(ctx, body.username, body.password);
  });
  app.put('/api/users/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ username: z.string().trim().optional(), password: z.string().optional() }).parse(req.body);
    return updateUser(ctx, id, body);
  });
  app.delete('/api/users/:id', async (req) => {
    await deleteUser(ctx, idParam.parse(req.params).id);
    return { ok: true };
  });
}
