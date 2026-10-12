import type { DriveKind, LayoutEstimate, PlanPriority, PlannedPool, PoolKind, PoolLayout, PoolLayoutInfo, PoolPlan } from '@hearth/api-types';

/** Minimal drive facts the planner needs. */
export interface PlanDrive {
  identifier: string;
  sizeBytes: number;
  kind: DriveKind;
}

export const MIN_DRIVES: Record<PoolLayout, number> = { STRIPE: 1, MIRROR: 2, RAIDZ1: 3, RAIDZ2: 4, RAIDZ3: 5 };
/** New pools start with at most this many drives. */
export const MAX_INITIAL_DRIVES = 8;
/** Pools can grow (one drive at a time) up to this many drives. */
export const MAX_EXPANDED_DRIVES = 12;
/** Drives smaller than this are ignored. */
export const MIN_DRIVE_BYTES = 1024 ** 3;
/** Drives count as "similar size" when they are within this fraction of the largest in the group. */
const SIZE_TOLERANCE = 0.2;

const RAIDZ_PADDING = 0.03;
const SLOP_CAP = 128 * 1024 ** 3;

export const LAYOUT_LABELS: Record<PoolLayout, string> = {
  STRIPE: 'Stripe',
  MIRROR: 'Mirror',
  RAIDZ1: 'RAIDZ1',
  RAIDZ2: 'RAIDZ2',
  RAIDZ3: 'RAIDZ3',
};

export function faultTolerance(layout: PoolLayout, drives: number): number {
  switch (layout) {
    case 'STRIPE':
      return 0;
    case 'MIRROR':
      return Math.max(0, drives - 1);
    case 'RAIDZ1':
      return 1;
    case 'RAIDZ2':
      return 2;
    case 'RAIDZ3':
      return 3;
  }
}

/** Approximate usable bytes for a single-vdev pool (decimal-agnostic; bytes in, bytes out). */
export function usableBytes(layout: PoolLayout, sizes: number[]): number {
  if (!sizes.length) return 0;
  const smallest = Math.min(...sizes);
  let raw: number;
  switch (layout) {
    case 'STRIPE':
      raw = sizes.reduce((a, b) => a + b, 0);
      break;
    case 'MIRROR':
      raw = smallest;
      break;
    default: {
      const parity = faultTolerance(layout, sizes.length);
      raw = Math.max(0, sizes.length - parity) * smallest * (1 - RAIDZ_PADDING);
    }
  }
  return Math.max(0, Math.floor(raw - Math.min(raw / 32, SLOP_CAP)));
}

export function poolKindFor(kinds: DriveKind[]): PoolKind {
  const set = new Set(kinds.map((k) => (k === 'HDD' ? 'capacity' : 'performance')));
  return set.size === 1 ? ([...set][0] as PoolKind) : 'mixed';
}

export function validLayoutsFor(count: number): PoolLayout[] {
  return (Object.keys(MIN_DRIVES) as PoolLayout[]).filter((l) => count >= MIN_DRIVES[l] && (l !== 'STRIPE' || count <= MAX_INITIAL_DRIVES));
}

/** Validates a user-chosen layout and estimates its capacity. */
export function estimateLayout(layout: PoolLayout, drives: PlanDrive[]): LayoutEstimate {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (drives.length < MIN_DRIVES[layout]) {
    problems.push(`${LAYOUT_LABELS[layout]} needs at least ${MIN_DRIVES[layout]} drives.`);
  }
  if (drives.length > MAX_INITIAL_DRIVES) {
    problems.push(`A new pool can have at most ${MAX_INITIAL_DRIVES} drives. You can add more drives later.`);
  }
  if (layout === 'STRIPE') {
    warnings.push(
      drives.length === 1
        ? 'A single drive has no protection: if it fails, everything on it is lost.'
        : 'A stripe has no protection: if any one drive fails, everything on the pool is lost.',
    );
  }
  if (poolKindFor(drives.map((d) => d.kind)) === 'mixed') {
    warnings.push('Mixing hard drives and SSDs slows the whole pool down to hard-drive speed.');
  }
  if (drives.length > 1 && layout !== 'STRIPE') {
    const sizes = drives.map((d) => d.sizeBytes);
    const smallest = Math.min(...sizes);
    const largest = Math.max(...sizes);
    if (largest > smallest * (1 + SIZE_TOLERANCE)) {
      warnings.push('The drives have different sizes. Every drive only counts as large as the smallest one, so some space goes unused.');
    }
  }
  return {
    valid: problems.length === 0,
    usableBytes: usableBytes(layout, drives.map((d) => d.sizeBytes)),
    faultTolerance: faultTolerance(layout, drives.length),
    problems,
    warnings,
  };
}

/** Layout recommended for `count` similar drives given what the user cares about most. */
export function recommendLayout(count: number, priority: PlanPriority): PoolLayout {
  if (count <= 1) return 'STRIPE';
  if (count === 2) return priority === 'space' ? 'STRIPE' : 'MIRROR';
  if (count === 3) return priority === 'protection' ? 'MIRROR' : 'RAIDZ1';
  if (count <= 5) return priority === 'protection' ? 'RAIDZ2' : 'RAIDZ1';
  if (priority === 'space') return 'RAIDZ1';
  if (priority === 'protection' && count >= 8) return 'RAIDZ3';
  return 'RAIDZ2';
}

function layoutReason(layout: PoolLayout, count: number, priority: PlanPriority): string {
  const tolerance = faultTolerance(layout, count);
  const survive = tolerance === 0 ? 'no drive can fail' : tolerance === 1 ? 'one drive can fail' : `${tolerance} drives can fail`;
  if (count === 1) return 'Only one drive of this kind is free, so it becomes a single-drive pool. Add a second drive later for protection.';
  const why: Record<PlanPriority, string> = {
    space: 'you chose the most space',
    balanced: 'it balances space and protection',
    protection: 'you chose the most protection',
  };
  return `${LAYOUT_LABELS[layout]} across ${count} drives because ${why[priority]}: ${survive} without losing data.`;
}

const POOL_BASE_NAMES: Record<DriveKind, string> = { HDD: 'HDDs', SSD: 'SSDs', NVME: 'NVMEs', USB: 'USBs' };

/** Unique ZFS pool name like `HDDs`, `HDDs2`, … */
export function uniquePoolName(kind: DriveKind, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  const base = POOL_BASE_NAMES[kind];
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

/** Splits drives (largest first) into groups of similar size. */
function sizeGroups(drives: PlanDrive[]): PlanDrive[][] {
  const sorted = [...drives].sort((a, b) => b.sizeBytes - a.sizeBytes);
  const groups: PlanDrive[][] = [];
  for (const drive of sorted) {
    const group = groups.find((g) => drive.sizeBytes >= g[0]!.sizeBytes * (1 - SIZE_TOLERANCE));
    if (group) group.push(drive);
    else groups.push([drive]);
  }
  return groups;
}

/**
 * Recommended plan: one pool per drive kind (HDD / SATA SSD / NVMe never mix), built from
 * the largest group of similar-size drives. Leftovers are reported with a reason.
 */
export function planPools(drives: PlanDrive[], priority: PlanPriority, takenNames: Iterable<string> = []): PoolPlan {
  const taken = new Set(takenNames);
  const pools: PlannedPool[] = [];
  const unassigned: PoolPlan['unassigned'] = [];

  const eligible: PlanDrive[] = [];
  for (const d of drives) {
    if (d.kind === 'USB') unassigned.push({ identifier: d.identifier, reason: 'USB drives are not used for storage pools.' });
    else if (d.sizeBytes < MIN_DRIVE_BYTES) unassigned.push({ identifier: d.identifier, reason: 'Too small to be useful (under 1 GiB).' });
    else eligible.push(d);
  }

  const kinds: DriveKind[] = ['NVME', 'SSD', 'HDD'];
  for (const kind of kinds) {
    const ofKind = eligible.filter((d) => d.kind === kind);
    if (!ofKind.length) continue;
    const groups = sizeGroups(ofKind).sort(
      (a, b) => b.length - a.length || b.reduce((s, d) => s + d.sizeBytes, 0) - a.reduce((s, d) => s + d.sizeBytes, 0),
    );
    groups.forEach((group, index) => {
      // Extra groups only become pools if they can be protected; single odd-sized drives are left over.
      if (index > 0 && group.length < 2) {
        for (const d of group) {
          unassigned.push({
            identifier: d.identifier,
            reason: `Its size is too different from the other ${POOL_BASE_NAMES[kind]}; adding it would waste space. You can still use it in a custom pool.`,
          });
        }
        return;
      }
      const members = group.slice(0, MAX_INITIAL_DRIVES);
      for (const d of group.slice(MAX_INITIAL_DRIVES)) {
        unassigned.push({ identifier: d.identifier, reason: `New pools start with at most ${MAX_INITIAL_DRIVES} drives; add it to the pool later.` });
      }
      const layout = recommendLayout(members.length, priority);
      const name = uniquePoolName(kind, taken);
      taken.add(name);
      const estimate = estimateLayout(layout, members);
      pools.push({
        name,
        layout,
        drives: members.map((d) => d.identifier),
        kind: kind === 'HDD' ? 'capacity' : 'performance',
        usableBytes: estimate.usableBytes,
        faultTolerance: estimate.faultTolerance,
        reason: layoutReason(layout, members.length, priority),
        warnings: estimate.warnings,
      });
    });
  }
  return { pools, unassigned };
}

/** Minimal shape of a `pool.query` topology vdev. */
export interface TopologyVdev {
  type: string;
  children?: TopologyVdev[];
}

/** Describes an existing pool from its real vdev topology (never guessed from drive counts). */
export function describeTopology(data: TopologyVdev[]): PoolLayoutInfo {
  const vdevs = data.map((v) => ({ type: v.type, drives: v.type === 'DISK' ? 1 : (v.children?.length ?? 0) }));
  const tolerances = data.map((v) => {
    const n = v.children?.length ?? 0;
    switch (v.type) {
      case 'DISK':
        return 0;
      case 'MIRROR':
        return Math.max(0, n - 1);
      case 'RAIDZ1':
      case 'DRAID1':
        return 1;
      case 'RAIDZ2':
      case 'DRAID2':
        return 2;
      case 'RAIDZ3':
      case 'DRAID3':
        return 3;
      default:
        return null;
    }
  });
  const recognized = data.length > 0 && tolerances.every((t) => t !== null);
  if (!recognized) {
    return { label: 'Layout not recognized', recognized: false, vdevs, faultTolerance: null, expandable: false };
  }
  const total = vdevs.reduce((s, v) => s + v.drives, 0);
  const types = new Set(data.map((v) => v.type));
  let label: string;
  if (types.size === 1 && types.has('DISK')) {
    label = total === 1 ? 'Single drive' : `Stripe · ${total} drives`;
  } else if (types.size === 1) {
    const type = [...types][0]!;
    const name = type === 'MIRROR' ? 'Mirror' : type;
    label = data.length === 1 ? `${name} · ${total} drives` : `${data.length} × ${name} · ${total} drives`;
  } else {
    label = `Mixed layout · ${total} drives`;
  }
  // Losing any one vdev loses the pool, so the guaranteed tolerance is that of the weakest vdev.
  const tolerance = Math.min(...(tolerances as number[]));
  const single = data.length === 1 ? data[0]! : null;
  const expandable = Boolean(single && /^RAIDZ[123]$/.test(single.type) && total < MAX_EXPANDED_DRIVES);
  return { label, recognized: true, vdevs, faultTolerance: tolerance, expandable };
}
