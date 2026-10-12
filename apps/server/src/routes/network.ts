import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.ts';
import {
  discardPendingChanges,
  getNetworkSettings,
  startDnsChange,
  startInterfaceChange,
  startVlanCreate,
  startVlanDelete,
} from '../services/network.ts';

const address = z.string().trim().max(64);
const prefix = z
  .number({ invalid_type_error: 'Choose the subnet mask' })
  .int('Choose the subnet mask')
  .min(1, 'Choose a subnet mask between /1 and /32')
  .max(32, 'Choose a subnet mask between /1 and /32');
const nameservers = z.array(z.string().trim().max(64)).max(3, 'Enter up to three DNS servers');
const mode = z.enum(['dhcp', 'static'], { errorMap: () => ({ message: 'Choose automatic or fixed' }) });

const interfaceBody = z.object({
  mode,
  address: address.optional(),
  prefix: prefix.optional(),
  gateway: address.optional(),
  nameservers: nameservers.optional(),
  acknowledgeConnectionRisk: z.boolean().optional(),
});

const dnsBody = z.object({ nameservers, gateway: address });

const vlanBody = z.object({
  parent: z.string().trim().min(1, 'Choose the network port the VLAN runs on'),
  tag: z
    .number({ invalid_type_error: 'Use a VLAN number from 1 to 4094' })
    .int('Use a VLAN number from 1 to 4094')
    .min(1, 'Use a VLAN number from 1 to 4094')
    .max(4094, 'Use a VLAN number from 1 to 4094'),
  mode,
  address: address.optional(),
  prefix: prefix.optional(),
  description: z.string().max(200).optional(),
});

const nameParam = z.object({ name: z.string().min(1).max(32) });

export async function networkRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/system/network', async () => getNetworkSettings(ctx));

  app.put('/api/system/network/interfaces/:name', async (req) => {
    const { name } = nameParam.parse(req.params);
    return { task: await startInterfaceChange(ctx, name, interfaceBody.parse(req.body)) };
  });

  app.put('/api/system/network/dns', async (req) => ({ task: await startDnsChange(ctx, dnsBody.parse(req.body)) }));

  app.post('/api/system/network/vlans', async (req) => ({ task: await startVlanCreate(ctx, vlanBody.parse(req.body)) }));

  app.delete('/api/system/network/vlans/:name', async (req) => {
    const { name } = nameParam.parse(req.params);
    return { task: await startVlanDelete(ctx, name) };
  });

  app.post('/api/system/network/discard', async () => {
    await discardPendingChanges(ctx);
    return { ok: true };
  });
}
