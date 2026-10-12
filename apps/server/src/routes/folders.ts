import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { createFolder, deleteFolder, getFolder, listFolders, prepareFolder, updateFolder } from '../services/folders.ts';

const access = z.object({
  access: z.enum(['public', 'private']),
  users: z.array(z.object({ username: z.string(), level: z.enum(['read', 'full']) })),
  quotaBytes: z.number().nullable(),
  timeMachine: z.boolean(),
});
const nameParam = z.object({ name: z.string().min(1) });

export async function folderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/folders', async () => listFolders(ctx));
  app.get('/api/folders/:name', async (req) => getFolder(ctx, nameParam.parse(req.params).name));

  app.post('/api/folders', async (req) => {
    const body = access.extend({ name: z.string().trim().min(1), pool: z.string().min(1) }).parse(req.body);
    if (ctx.tasks.findRunning('folder-create', body.name)) throw new UserError('This folder is already being created.', 409, 'BUSY');
    await prepareFolder(ctx, body);
    const task = ctx.tasks.start(
      { type: 'folder-create', title: `Creating folder ${body.name}`, ref: body.name },
      (t) => createFolder(ctx, body, {}, (name, fn) => t.step(name, fn)),
    );
    return { task };
  });

  app.put('/api/folders/:name', async (req) => {
    const { name } = nameParam.parse(req.params);
    const body = access.parse(req.body);
    await getFolder(ctx, name);
    if (body.access === 'public' && body.timeMachine) {
      throw new UserError('Time Machine folders must be private.', 400, 'VALIDATION', { timeMachine: 'Make the folder private first' });
    }
    const task = ctx.tasks.start({ type: 'folder-update', title: `Updating folder ${name}`, ref: name }, (t) =>
      updateFolder(ctx, name, body, (step, fn) => t.step(step, fn)),
    );
    return { task };
  });

  app.delete('/api/folders/:name', async (req) => {
    const { name } = nameParam.parse(req.params);
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body ?? {});
    const folder = await getFolder(ctx, name);
    if (confirmName.trim() !== folder.name) throw new UserError('Type the folder name exactly to confirm.', 400, 'VALIDATION', { confirmName: 'Does not match' });
    if (folder.usedBy.length) throw new UserError(`This folder is in use by ${folder.usedBy.map((u) => u.name).join(', ')}.`, 409, 'IN_USE');
    const task = ctx.tasks.start({ type: 'folder-delete', title: `Deleting folder ${name}`, ref: name }, () => deleteFolder(ctx, name, confirmName));
    return { task };
  });
}
