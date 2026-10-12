/**
 * Client-side helpers for drives and pool layouts. These mirror the server rules closely enough to
 * guide the user (which layouts to offer, which drives fit); the server stays the authority.
 */
import type { Drive, Pool, PoolLayout } from '@apexos/api-types';
import { DRIVE_KIND_LABELS, formatBytes } from '../../lib/format.ts';

export const MIN_DRIVES: Record<PoolLayout, number> = { STRIPE: 1, MIRROR: 2, RAIDZ1: 3, RAIDZ2: 4, RAIDZ3: 5 };
/** New pools start with at most this many drives (more can be added later). */
export const MAX_NEW_POOL_DRIVES = 8;
/** Drives within this fraction of each other count as "similar size". */
export const SIZE_TOLERANCE = 0.2;

/** A drive offered in the Add pool dialog. */
export interface PickerDrive {
  drive: Drive;
  /** Shown instead of a checkbox when the drive can't be picked. */
  disabledReason?: string | null;
  /** Extra context, e.g. "From a pool you let go; it will be erased". */
  note?: string | null;
}

const LAYOUT_ORDER: PoolLayout[] = ['MIRROR', 'RAIDZ1', 'RAIDZ2', 'RAIDZ3', 'STRIPE'];

/** Layouts that can be built from `count` drives, best-protected first and stripe last. */
export function validLayouts(count: number): PoolLayout[] {
  if (count < 1) return [];
  return LAYOUT_ORDER.filter((l) => count >= MIN_DRIVES[l] && (l !== 'STRIPE' || count <= MAX_NEW_POOL_DRIVES));
}

/** A sensible starting layout for `count` similar drives. */
export function defaultLayout(count: number): PoolLayout {
  if (count <= 1) return 'STRIPE';
  if (count === 2) return 'MIRROR';
  if (count <= 5) return 'RAIDZ1';
  return 'RAIDZ2';
}

export function layoutTitle(layout: PoolLayout, count: number): string {
  switch (layout) {
    case 'STRIPE':
      return count === 1 ? 'Single drive' : 'Stripe';
    case 'MIRROR':
      return count > 2 ? `Mirror (${count} copies)` : 'Mirror';
    default:
      return layout;
  }
}

export function layoutDescription(layout: PoolLayout, count: number): string {
  switch (layout) {
    case 'STRIPE':
      return count === 1
        ? 'Just this drive, with no protection. If it fails, everything on it is lost. Fine for testing or data you can re-download.'
        : 'Adds up the space of every drive, with no protection. If any one drive fails, the whole pool is lost.';
    case 'MIRROR':
      return 'Every drive keeps a full copy of your data. You get the space of one drive, and all but one drive can fail.';
    case 'RAIDZ1':
      return 'Spreads your data across the drives and uses one drive’s worth of space for recovery information. Any one drive can fail.';
    case 'RAIDZ2':
      return 'Uses two drives’ worth of space for recovery information. Any two drives can fail at the same time.';
    case 'RAIDZ3':
      return 'Uses three drives’ worth of space for recovery information. Any three drives can fail at the same time.';
  }
}

export function isWeakLayout(layout: PoolLayout): boolean {
  return layout === 'STRIPE';
}

/** HDDs are "capacity" drives; SATA SSDs and NVMe are "performance" drives. */
export function speedClass(drive: Pick<Drive, 'kind'>): 'hdd' | 'ssd' {
  return drive.kind === 'HDD' ? 'hdd' : 'ssd';
}

export function speedClassLabel(cls: 'hdd' | 'ssd'): string {
  return cls === 'hdd' ? 'Hard drives' : 'SSDs';
}

export function driveTitle(drive: Drive): string {
  return drive.model || DRIVE_KIND_LABELS[drive.kind] || 'Drive';
}

export function driveSummary(drive: Drive): string {
  return `${formatBytes(drive.sizeBytes)} ${DRIVE_KIND_LABELS[drive.kind] ?? drive.kind}`;
}

const BASE_NAMES = { HDD: 'HDDs', SSD: 'SSDs', NVME: 'NVMEs', USB: 'USBs' } as const;

/** Suggests a pool name in the same style the server uses: `HDDs`, `SSDs2`, … */
export function suggestPoolName(drives: Drive[], taken: string[]): string {
  const kinds = new Set(drives.map((d) => d.kind));
  let base: string;
  if (kinds.size === 1) base = BASE_NAMES[[...kinds][0]!];
  else if (kinds.size > 1 && !kinds.has('HDD')) base = 'SSDs';
  else base = 'Pool';
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

const POOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,49}$/;
const RESERVED_RE = /^(boot-pool|mirror|raidz|spare|log|draid)/i;

/** Returns a message when `name` can't be used as a new pool name. */
export function poolNameProblem(name: string, taken: string[]): string | null {
  const n = name.trim();
  if (!n) return 'Give the pool a name.';
  if (!POOL_NAME_RE.test(n)) return 'Start with a letter, then use letters, numbers, dots, dashes or underscores (up to 50).';
  if (RESERVED_RE.test(n)) return 'That name is reserved by the storage system. Pick another one.';
  if (taken.some((t) => t.toLowerCase() === n.toLowerCase())) return 'Another pool already uses this name.';
  return null;
}

/** Smallest present data drive of a pool (replacement and new drives must be at least this big). */
export function smallestMember(pool: Pool, exclude?: string): number {
  const sizes = pool.drives.filter((d) => !d.missing && d.identifier !== exclude).map((d) => d.sizeBytes);
  return sizes.length ? Math.min(...sizes) : 0;
}

/**
 * Why `drive` can't join `pool` (as a replacement, new member or spare), or null if it can.
 * Mirrors the server's checks so the dialog can explain refusals up front.
 */
export function joinProblem(pool: Pool, drive: Drive, opts: { exclude?: string; spare?: boolean } = {}): string | null {
  if (!drive.available) return drive.unavailableReason ?? 'This drive can’t be used.';
  if (opts.spare && drive.errors.read + drive.errors.write + drive.errors.checksum > 0) return 'This drive has reported errors.';
  if (pool.kind === 'capacity' && drive.kind !== 'HDD') return 'The pool is made of hard drives; use a hard drive.';
  if (pool.kind === 'performance' && drive.kind === 'HDD') return 'The pool is made of SSDs; use an SSD.';
  const smallest = smallestMember(pool, opts.exclude);
  if (drive.sizeBytes < smallest) return `Too small: it needs at least ${formatBytes(smallest)}.`;
  return null;
}

/** A note when a drive is noticeably larger than the pool's drives (the extra space is unused for now). */
export function largerNote(pool: Pool, drive: Drive, exclude?: string): string | null {
  const smallest = smallestMember(pool, exclude);
  if (smallest > 0 && drive.sizeBytes > smallest * (1 + SIZE_TOLERANCE)) {
    return `Larger than the other drives. Only ${formatBytes(smallest)} of it is used until every drive in the pool is at least this big.`;
  }
  return null;
}

/** Is any pool in a state where touching drives is risky? */
export function poolAtRisk(pools: Pool[]): Pool | undefined {
  return pools.find((p) => p.health === 'degraded' || p.health === 'rebuilding' || p.health === 'offline');
}
