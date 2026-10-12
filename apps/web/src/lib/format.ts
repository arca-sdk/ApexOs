/** Decimal units (GB/TB) like drive labels; TrueNAS itself shows binary units. */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let n = Math.abs(bytes);
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  const value = n >= 100 || i === 0 ? Math.round(n).toString() : n.toFixed(digits).replace(/\.0+$/, '');
  return `${bytes < 0 ? '-' : ''}${value} ${units[i]}`;
}

/** Memory (RAM) sizes use binary units, which is how memory is sold and labelled (32 GB = 32 GiB). */
export function formatMemory(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = Math.abs(bytes);
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const value = n >= 100 || i === 0 ? Math.round(n).toString() : n.toFixed(digits).replace(/\.0+$/, '');
  return `${value} ${units[i]}`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatPercent(n: number, digits = 0): string {
  return `${n.toFixed(digits)}%`;
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(m, 0)}m`;
}

export function formatRelative(iso: string): string {
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatTemperature(c: number | null | undefined): string {
  if (c === null || c === undefined) return '—';
  return preferences.temperatureUnit === 'F' ? `${Math.round((c * 9) / 5 + 32)} °F` : `${Math.round(c)} °C`;
}

/** Per-browser display preferences (stored locally). */
export const preferences = {
  get temperatureUnit(): 'C' | 'F' {
    return localStorage.getItem('apexos.temperatureUnit') === 'F' ? 'F' : 'C';
  },
  set temperatureUnit(v: 'C' | 'F') {
    localStorage.setItem('apexos.temperatureUnit', v);
  },
};

export const LAYOUT_NAMES: Record<string, string> = {
  STRIPE: 'Stripe (no protection)',
  MIRROR: 'Mirror',
  RAIDZ1: 'RAIDZ1',
  RAIDZ2: 'RAIDZ2',
  RAIDZ3: 'RAIDZ3',
};

export function toleranceText(n: number | null): string {
  if (n === null) return 'Protection unknown';
  if (n === 0) return 'No drive can fail';
  return n === 1 ? '1 drive can fail' : `${n} drives can fail`;
}

export const DRIVE_KIND_LABELS: Record<string, string> = {
  HDD: 'Hard drive',
  SSD: 'SSD',
  NVME: 'NVMe SSD',
  USB: 'USB drive',
};
