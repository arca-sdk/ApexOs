import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startMockTrueNas } from '../src/index.ts';
import { connect, createPool, type Any } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'mock-truenas-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('state persistence', () => {
  it('saves to the state file and restores on the next start', async () => {
    const stateFile = join(dir, 'nested', 'state.json');
    const first = await startMockTrueNas({ jobDelayMs: 0, stateFile });
    const c1 = connect(first);
    await createPool(c1, 'tank', 'RAIDZ1', ['sdb', 'sdc', 'sdd']);
    await c1.call('pool.dataset.create', [{ name: 'tank/Photos', share_type: 'SMB' }]);
    await c1.call('sharing.smb.create', [{ name: 'Photos', path: '/mnt/tank/Photos' }]);
    await c1.call('user.create', [{ username: 'alice', full_name: 'Alice', password: 'pw', group_create: true, smb: true }]);
    const key = await c1.call<Any>('api_key.create', [{ name: 'later', username: 'truenas_admin' }]);
    await c1.call('system.general.update', [{ timezone: 'Europe/Berlin' }]);
    await c1.close();
    await first.close();

    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.pools.map((p: Any) => p.name)).toEqual(['tank']);

    // The scenario option is ignored when saved state exists.
    const second = await startMockTrueNas({ jobDelayMs: 0, stateFile, scenario: 'configured' });
    try {
      const c2 = connect(second, { type: 'apiKey', apiKey: key.key });
      await c2.connect();
      const pool = await c2.call<Any>('pool.query', [[['name', '=', 'tank']], { get: true }]);
      expect(pool).toMatchObject({ id: 1, status: 'ONLINE' });
      expect(pool.topology.data[0].children.map((c: Any) => c.disk)).toEqual(['sdb', 'sdc', 'sdd']);
      expect((await c2.call<Any>('pool.dataset.get_instance', ['tank/Photos'])).casesensitivity.value).toBe('INSENSITIVE');
      expect((await c2.call<Any[]>('sharing.smb.query')).map((s) => s.name)).toEqual(['Photos']);
      expect((await c2.call<Any[]>('user.query', [[['username', '=', 'alice']]]))[0].uid).toBe(3000);
      expect((await c2.call<Any>('system.info')).timezone).toBe('Europe/Berlin');
      expect((await c2.job<Any[]>('pool.import_find')).map((p) => p.name)).toEqual(['oldtank']);
      expect(await c2.call('app.query')).toEqual([]);
      // New ids continue after the restored ones.
      const next = await createPool(c2, 'fast', 'MIRROR', ['nvme0n1', 'nvme1n1']);
      expect(next.id).toBe(2);
      await c2.close();
    } finally {
      await second.close();
    }

    // The default API key keeps working against restored state.
    const third = await startMockTrueNas({ jobDelayMs: 0, stateFile });
    try {
      const c3 = connect(third);
      await c3.connect();
      expect((await c3.call<Any[]>('pool.query')).map((p) => p.name)).toEqual(['tank', 'fast']);
      await c3.close();
    } finally {
      await third.close();
    }
  });

  it('settles in-flight operations when loading', async () => {
    const stateFile = join(dir, 'inflight.json');
    const first = await startMockTrueNas({ jobDelayMs: 200, stateFile, scenario: 'configured' });
    const c1 = connect(first);
    const hdds = await c1.call<Any>('pool.query', [[['name', '=', 'HDDs']], { get: true }]);
    await c1.call('pool.scrub', [hdds.id, 'START']);
    await new Promise((r) => setTimeout(r, 50));
    first.save();
    await c1.close();
    await first.close();

    const second = await startMockTrueNas({ jobDelayMs: 0, stateFile });
    try {
      const c2 = connect(second);
      const pool = await c2.call<Any>('pool.query', [[['name', '=', 'HDDs']], { get: true }]);
      expect(pool.scan).toMatchObject({ function: 'SCRUB', state: 'CANCELED' });
      expect((await c2.call<Any>('app.get_instance', ['jellyfin'])).state).toBe('RUNNING');
      await c2.close();
    } finally {
      await second.close();
    }
  });
});
