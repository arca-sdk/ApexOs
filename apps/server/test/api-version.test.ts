/**
 * ApexOs uses the newest 25.10 API version a server offers: older versions go through TrueNAS's reply
 * converter, which fails for some replies on 25.10.7 (simulated by the mock).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { pickApiVersion } from '@apexos/truenas-client';
import { TrueNasManager } from '../src/lib/truenas.ts';

describe('pickApiVersion', () => {
  it('picks the newest 25.10 version', () => {
    expect(pickApiVersion(['v25.04.0', 'v25.04.2', 'v25.10.0', 'v25.10.10', 'v25.10.5'])).toBe('v25.10.10');
    expect(pickApiVersion(['v25.10.0', 'v25.10.5', 'v26.04.0'])).toBe('v25.10.5');
  });

  it('finds nothing on older releases or in odd lists', () => {
    expect(pickApiVersion(['v25.04.0', 'v25.04.2'])).toBeNull();
    expect(pickApiVersion(['v25.10', 'current', 'v25.100.1'])).toBeNull();
  });
});

describe('TrueNasManager', () => {
  let mock: MockTrueNas | undefined;
  let manager: TrueNasManager | undefined;

  afterEach(async () => {
    await manager?.close();
    await mock?.close();
  });

  it('moves a connection saved with an older version to the newest one', async () => {
    mock = await startMockTrueNas({ apiKey: 'test-key', jobDelayMs: 0 });
    manager = new TrueNasManager();
    // Installs before this change saved `/api/v25.10.0`.
    await manager.configureLazy({ url: mock.url.replace('/api/current', '/api/v25.10.0'), auth: { type: 'apiKey', apiKey: 'test-key' } });
    expect(manager.connected).toBe(true);
    expect(manager.url).toMatch(/\/api\/v25\.10\.5$/);
    await expect(manager.client().call('network.configuration.config')).resolves.toMatchObject({ hostname: expect.any(String) });
  });
});
