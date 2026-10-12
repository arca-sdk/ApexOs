import { afterEach } from 'vitest';
import { TrueNasClient, TrueNasError, type TrueNasAuth } from '@apexos/truenas-client';
import { startMockTrueNas, type MockOptions, type MockTrueNas } from '../src/index.ts';

const open: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

export function connect(mock: MockTrueNas, auth: TrueNasAuth = { type: 'apiKey', apiKey: 'demo-api-key' }, url = mock.url): TrueNasClient {
  const client = new TrueNasClient({ url, auth, pingIntervalMs: 0, reconnect: false });
  open.push(client);
  return client;
}

export async function startMock(opts: MockOptions = {}): Promise<MockTrueNas> {
  const mock = await startMockTrueNas({ jobDelayMs: 0, ...opts });
  open.push(mock);
  return mock;
}

/** Starts a mock and an authenticated client. */
export async function setup(opts: MockOptions = {}): Promise<{ mock: MockTrueNas; client: TrueNasClient }> {
  const mock = await startMock(opts);
  const client = connect(mock);
  await client.connect();
  return { mock, client };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Resolves with the error a promise rejects with (fails if it resolves). */
export async function failure(p: Promise<unknown>): Promise<TrueNasError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof TrueNasError) return err;
    throw err;
  }
  throw new Error('Expected the call to fail');
}

// Loose shapes for assertions on middleware results.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Any = any;

export async function createPool(client: TrueNasClient, name: string, type: string, disks: string[]): Promise<Any> {
  return client.job('pool.create', [{ name, topology: { data: [{ type, disks }] } }]);
}
