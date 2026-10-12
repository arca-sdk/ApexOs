import type { DriveKind } from '@hearth/api-types';
import type { TnDataset, TnDate, TnDisk, TnProperty } from './types.ts';

export function dateToIso(d: TnDate | null | undefined): string | null {
  return d && typeof d.$date === 'number' ? new Date(d.$date).toISOString() : null;
}

export function propNumber(p: TnProperty<number | null> | undefined): number {
  if (!p) return 0;
  if (typeof p.parsed === 'number') return p.parsed;
  const n = Number(p.rawvalue);
  return Number.isFinite(n) ? n : 0;
}

/** Reads a ZFS user property regardless of whether the middleware returned `{value}` or a bare string. */
export function userProp(ds: TnDataset, key: string): string | undefined {
  const raw = ds.user_properties?.[key];
  if (raw === undefined) return undefined;
  return typeof raw === 'string' ? raw : (raw.value ?? undefined);
}

export function driveKind(disk: Pick<TnDisk, 'type' | 'bus' | 'subsystem' | 'name'>): DriveKind {
  if (disk.bus?.toUpperCase() === 'USB') return 'USB';
  if (disk.subsystem?.toLowerCase() === 'nvme' || disk.bus?.toUpperCase() === 'NVME' || disk.name?.startsWith('nvme')) return 'NVME';
  return disk.type === 'SSD' ? 'SSD' : 'HDD';
}

/**
 * Shingled (SMR) hard-drive models that perform badly in ZFS pools, especially while rebuilding.
 * Not exhaustive; based on manufacturer disclosures.
 */
const SMR_MODELS = [
  /WD[2-6]0EFAX/i, // WD Red (2–6 TB, EFAX)
  /WD[2-8]0EDAZ/i,
  /WD[1-6]0EZAZ/i,
  /WD\d{2}SPZX/i,
  /WD\d{2}NPZZ/i,
  /ST8000DM004/i,
  /ST6000DM003/i,
  /ST4000DM004/i,
  /ST3000DM007/i,
  /ST2000DM008/i,
  /ST[2-5]000LM0(00|07|15|24)/i,
  /DT02ABA\d{3}/i,
  /MQ04ABF100/i,
  /MQ04ABD200/i,
];

export function isSmr(model: string): boolean {
  return SMR_MODELS.some((re) => re.test(model));
}

export const GiB = 1024 ** 3;

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let n = bytes;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}
