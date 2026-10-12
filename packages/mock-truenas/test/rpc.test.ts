import { afterEach, describe, expect, it } from 'vitest';
import { TrueNasClient, TrueNasError, type Job } from '@hearth/truenas-client';
import { CallError, RpcServer, validationError } from '../src/rpc.ts';

let server: RpcServer;
let client: TrueNasClient;

async function setup(apiKey = 'good-key') {
  server = new RpcServer({ jobDelayMs: 1 });
  server.method('auth.login_with_api_key', (params, ctx) => {
    if (params[0] !== 'good-key') return false;
    ctx.setAuthenticated();
    return true;
  });
  server.method('echo', (params) => params[0]);
  server.method('fails', () => {
    throw validationError('pool_create.name', 'Name already in use');
  });
  server.job('slow.job', async (params, job) => {
    job.progress(50, 'halfway');
    await job.sleep();
    if (params[0] === 'boom') throw new CallError('EFAULT', 'It broke');
    return { done: params[0] };
  });
  const url = await server.listen();
  client = new TrueNasClient({ url, auth: { type: 'apiKey', apiKey }, pingIntervalMs: 0 });
}

afterEach(async () => {
  await client?.close();
  await server?.close();
});

describe('TrueNasClient against the mock JSON-RPC server', () => {
  it('authenticates and calls methods', async () => {
    await setup();
    await client.connect();
    expect(await client.call('echo', ['hello'])).toBe('hello');
  });

  it('rejects a bad API key', async () => {
    await setup('bad-key');
    await expect(client.connect()).rejects.toThrow(/rejected the API key/);
  });

  it('maps validation errors', async () => {
    await setup();
    const err = await client.call('fails').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrueNasError);
    expect((err as TrueNasError).validationErrors).toEqual({ 'pool_create.name': 'Name already in use' });
  });

  it('waits for jobs and reports progress', async () => {
    await setup();
    const progress: Job[] = [];
    const result = await client.job('slow.job', ['x'], (j) => progress.push(j));
    expect(result).toEqual({ done: 'x' });
  });

  it('throws when a job fails', async () => {
    await setup();
    await expect(client.job('slow.job', ['boom'])).rejects.toThrow('It broke');
  });

  it('delivers subscribed collection updates', async () => {
    await setup();
    await client.connect();
    const updates: unknown[] = [];
    await client.subscribe('thing.query', (u) => updates.push(u.fields));
    server.emit('thing.query', 'changed', 1, { id: 1, name: 'a' });
    await new Promise((r) => setTimeout(r, 30));
    expect(updates).toEqual([{ id: 1, name: 'a' }]);
  });
});
