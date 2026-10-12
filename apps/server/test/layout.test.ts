import { describe, expect, it } from 'vitest';
import { describeTopology, estimateLayout, planPools, recommendLayout, uniquePoolName, usableBytes, type PlanDrive } from '../src/lib/layout.ts';

const TB = 1000 ** 4;
const hdd = (id: string, tb = 8): PlanDrive => ({ identifier: id, sizeBytes: tb * TB, kind: 'HDD' });
const nvme = (id: string, tb = 1): PlanDrive => ({ identifier: id, sizeBytes: tb * TB, kind: 'NVME' });

describe('recommendLayout', () => {
  it.each([
    [1, 'balanced', 'STRIPE'],
    [2, 'space', 'STRIPE'],
    [2, 'protection', 'MIRROR'],
    [3, 'balanced', 'RAIDZ1'],
    [3, 'protection', 'MIRROR'],
    [4, 'protection', 'RAIDZ2'],
    [5, 'space', 'RAIDZ1'],
    [6, 'balanced', 'RAIDZ2'],
    [8, 'protection', 'RAIDZ3'],
  ] as const)('%i drives, %s → %s', (count, priority, layout) => {
    expect(recommendLayout(count, priority)).toBe(layout);
  });
});

describe('planPools', () => {
  it('never mixes drive kinds and names pools by kind', () => {
    const plan = planPools([hdd('a'), hdd('b'), hdd('c'), hdd('d'), nvme('n1'), nvme('n2')], 'balanced');
    expect(plan.pools.map((p) => [p.name, p.layout, p.drives.length])).toEqual([
      ['NVMEs', 'MIRROR', 2],
      ['HDDs', 'RAIDZ1', 4],
    ]);
    expect(plan.unassigned).toEqual([]);
  });

  it('leaves an odd-sized drive unassigned with a reason', () => {
    const plan = planPools([hdd('a'), hdd('b'), hdd('c'), hdd('small', 4)], 'balanced');
    expect(plan.pools).toHaveLength(1);
    expect(plan.pools[0]!.drives).toEqual(['a', 'b', 'c']);
    expect(plan.unassigned.map((u) => u.identifier)).toEqual(['small']);
  });

  it('ignores USB drives and avoids taken names', () => {
    const plan = planPools([hdd('a'), { identifier: 'usb', sizeBytes: 32e9, kind: 'USB' }], 'balanced', ['HDDs']);
    expect(plan.pools[0]!.name).toBe('HDDs2');
    expect(plan.pools[0]!.layout).toBe('STRIPE');
    expect(plan.unassigned[0]!.identifier).toBe('usb');
  });

  it('caps new pools at 8 drives', () => {
    const drives = Array.from({ length: 10 }, (_, i) => hdd(`d${i}`));
    const plan = planPools(drives, 'balanced');
    expect(plan.pools[0]!.drives).toHaveLength(8);
    expect(plan.unassigned).toHaveLength(2);
  });
});

describe('estimateLayout', () => {
  it('rejects too few drives', () => {
    expect(estimateLayout('RAIDZ2', [hdd('a'), hdd('b'), hdd('c')]).valid).toBe(false);
  });
  it('warns about mixing kinds and stripes', () => {
    const est = estimateLayout('STRIPE', [hdd('a'), nvme('b')]);
    expect(est.valid).toBe(true);
    expect(est.warnings.length).toBe(2);
  });
  it('estimates RAIDZ1 capacity below raw parity math', () => {
    const usable = usableBytes('RAIDZ1', [8 * TB, 8 * TB, 8 * TB, 8 * TB]);
    expect(usable).toBeLessThan(24 * TB);
    expect(usable).toBeGreaterThan(22 * TB);
  });
});

describe('describeTopology', () => {
  const disk = { type: 'DISK' };
  it('describes RAIDZ1 and marks it expandable', () => {
    const info = describeTopology([{ type: 'RAIDZ1', children: [disk, disk, disk, disk] }]);
    expect(info).toMatchObject({ label: 'RAIDZ1 · 4 drives', faultTolerance: 1, expandable: true, recognized: true });
  });
  it('describes striped mirrors', () => {
    const info = describeTopology([
      { type: 'MIRROR', children: [disk, disk] },
      { type: 'MIRROR', children: [disk, disk] },
    ]);
    expect(info).toMatchObject({ label: '2 × Mirror · 4 drives', faultTolerance: 1, expandable: false });
  });
  it('never calls an unknown layout unprotected', () => {
    const info = describeTopology([{ type: 'SOMETHING_NEW', children: [disk] }]);
    expect(info).toMatchObject({ label: 'Layout not recognized', faultTolerance: null });
  });
});

describe('uniquePoolName', () => {
  it('is case-insensitive', () => {
    expect(uniquePoolName('SSD', ['ssds', 'SSDs2'])).toBe('SSDs3');
  });
});
