import { describe, expect, it } from 'vitest';
import type { Drive, Pool, SetupRequest, StorageOverview } from '@apexos/api-types';
import { review } from '../src/services/setup.ts';

const TB = 1000 ** 4;
function drive(id: string, kind: Drive['kind'] = 'HDD', extra: Partial<Drive> = {}): Drive {
  return {
    identifier: id,
    name: id,
    serial: id,
    model: 'Disk',
    sizeBytes: 8 * TB,
    kind,
    rotationRate: null,
    temperatureC: null,
    pool: null,
    role: null,
    status: null,
    errors: { read: 0, write: 0, checksum: 0 },
    warnings: [],
    exportedPool: null,
    available: true,
    unavailableReason: null,
    missing: false,
    ...extra,
  };
}
function pool(name: string, drives: Drive[]): Pool {
  const members = drives.map((d) => ({ ...d, pool: name, role: 'data' as const, available: false, unavailableReason: `Part of the ${name} pool.` }));
  return {
    id: name.length,
    name,
    displayName: name,
    path: `/mnt/${name}`,
    kind: 'capacity',
    health: 'healthy',
    healthDetail: null,
    zfsStatus: 'ONLINE',
    sizeBytes: 1,
    usedBytes: 0,
    freeBytes: 1,
    usedPercent: 0,
    layout: { label: 'Mirror', recognized: true, vdevs: [], faultTolerance: 1, expandable: false },
    drives: members,
    spares: [],
    scan: null,
    scrubScheduled: true,
    isAppsPool: false,
    errors: { read: 0, write: 0, checksum: 0 },
  };
}

const storage: StorageOverview = {
  pools: [pool('Old', [drive('a'), drive('b')]), pool('Media', [drive('c'), drive('d')])],
  unassigned: [drive('n1', 'NVME'), drive('n2', 'NVME'), drive('x', 'HDD', { exportedPool: 'foreign', warnings: ['EXISTING_DATA'] })],
  bootDrives: [],
};
const base: SetupRequest = { serverName: 'nas', timezone: 'UTC', keepPools: [], importPools: [], newPools: [], consentErase: true, consentKeep: true };
const rc = { storage, importable: [{ guid: '1', name: 'foreign', status: 'ONLINE', hostname: null }], timezones: ['UTC'] };

describe('setup review (start-fresh rules)', () => {
  it('erases a let-go pool only when a new pool reuses its drives', () => {
    const r = review({ ...base, newPools: [{ name: 'HDDs', layout: 'MIRROR', drives: ['a', 'b'] }] }, rc);
    expect(r).toMatchObject({ ok: true, erasePools: ['Old'], untouchedPools: ['Media'] });
  });

  it('treats the names of untouched pools as taken', () => {
    const r = review({ ...base, newPools: [{ name: 'Media', layout: 'MIRROR', drives: ['n1', 'n2'] }] }, rc);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/Media already exists/);
  });

  it('lets a new pool reuse the name of a pool it erases', () => {
    const r = review({ ...base, newPools: [{ name: 'Old', layout: 'MIRROR', drives: ['a', 'b'] }] }, rc);
    expect(r.ok).toBe(true);
  });

  it('refuses drives of kept pools and of pools being imported', () => {
    const kept = review({ ...base, keepPools: ['Old'], newPools: [{ name: 'X', layout: 'MIRROR', drives: ['a', 'n1'] }] }, rc);
    expect(kept.problems.join(' ')).toMatch(/keeping/);
    const importing = review({ ...base, importPools: ['1'], newPools: [{ name: 'X', layout: 'STRIPE', drives: ['x'] }] }, rc);
    expect(importing.problems.join(' ')).toMatch(/importing/);
  });

  it('wipes a foreign pool whose drive is reused and needs consent', () => {
    const r = review({ ...base, keepPools: ['Old', 'Media'], newPools: [{ name: 'X', layout: 'STRIPE', drives: ['x'] }] }, rc);
    expect(r).toMatchObject({ ok: true, erasePools: ['foreign (from another system)'], needsEraseConsent: true, needsKeepConsent: true });
  });

  it('puts apps on the first new SSD pool', () => {
    const r = review({ ...base, newPools: [{ name: 'HDDs', layout: 'MIRROR', drives: ['a', 'b'] }, { name: 'NVMEs', layout: 'MIRROR', drives: ['n1', 'n2'] }] }, rc);
    expect(r.appsPool).toBe('NVMEs');
  });

  it('puts apps where the user chose, among the pools in the plan', () => {
    const newPools: SetupRequest['newPools'] = [{ name: 'HDDs', layout: 'MIRROR', drives: ['a', 'b'] }, { name: 'NVMEs', layout: 'MIRROR', drives: ['n1', 'n2'] }];
    const chosen = review({ ...base, keepPools: ['Media'], newPools, appsPool: 'Media' }, rc);
    expect(chosen).toMatchObject({ appsPool: 'Media', appsPoolOptions: ['HDDs', 'NVMEs', 'Media'] });
    // A pool that's no longer in the plan falls back to the automatic choice.
    expect(review({ ...base, newPools, appsPool: 'Media' }, rc).appsPool).toBe('NVMEs');
  });

  it('keeps apps on a kept pool they already run on', () => {
    const apps = { ...pool('Apps', [drive('e'), drive('f')]), isAppsPool: true };
    const r = review({ ...base, keepPools: ['Apps'], newPools: [{ name: 'NVMEs', layout: 'MIRROR', drives: ['n1', 'n2'] }], appsPool: 'NVMEs' }, {
      ...rc,
      storage: { ...storage, pools: [...storage.pools, apps] },
    });
    expect(r).toMatchObject({ appsPool: 'Apps', appsPoolOptions: [] });
  });
});
