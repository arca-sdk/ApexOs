/** Shared wording and formatting for the backup screens. */
import type { BackupOptions, BackupSchedule, BackupState, DestinationHealth } from '@apexos/api-types';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Choices for how long restore points are kept (days). */
export const KEEP_CHOICES = [
  { days: 3, label: '3 days' },
  { days: 7, label: '1 week' },
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
  { days: 60, label: '2 months' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
];

export function defaultOptions(): BackupOptions {
  return { schedule: { frequency: 'daily', time: '02:00', weekday: 0 }, keepDays: 14, speedLimitMbps: null };
}

export function scheduleText(s: BackupSchedule): string {
  if (s.frequency === 'hourly') {
    const m = Number(s.time.split(':')[1] ?? 0);
    return m ? `Every hour, ${m} minutes past` : 'Every hour, on the hour';
  }
  if (s.frequency === 'weekly') return `Every ${WEEKDAYS[s.weekday]} at ${s.time}`;
  return `Every day at ${s.time}`;
}

export function keepText(days: number): string {
  const choice = KEEP_CHOICES.find((c) => c.days === days);
  if (choice) return choice.label;
  return days === 1 ? '1 day' : `${days} days`;
}

export function speedText(mbps: number | null): string {
  return mbps === null ? 'Full speed' : `Up to ${mbps} Mbit/s`;
}

export const STATE_BADGE: Record<BackupState, string> = {
  ok: 'ok',
  running: 'info',
  waiting: '',
  paused: '',
  failed: 'err',
  overdue: 'warn',
  'needs-fresh-copy': 'warn',
};

export const HEALTH_LABEL: Record<DestinationHealth, string> = {
  online: 'Online',
  unreachable: 'Can’t be reached',
  'nearly-full': 'Almost full',
  full: 'Full',
};

export const HEALTH_BADGE: Record<DestinationHealth, string> = {
  online: 'ok',
  unreachable: 'err',
  'nearly-full': 'warn',
  full: 'err',
};

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago", or a date. */
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    return h === 1 ? '1 hour ago' : `${h} hours ago`;
  }
  if (s < 7 * 86400) {
    const d = Math.floor(s / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A time in the server's time zone, e.g. "Tue 13 Oct, 02:30". */
export function serverTime(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Splits bytes into a friendly number + unit (decimal units, like the rest of the UI). */
export function splitSize(bytes: number): { value: number; unit: 'GB' | 'TB' } {
  if (bytes >= 1e12) return { value: Math.round((bytes / 1e12) * 10) / 10, unit: 'TB' };
  return { value: Math.max(1, Math.round(bytes / 1e9)), unit: 'GB' };
}

export function sizeToBytes(value: number, unit: 'GB' | 'TB'): number {
  return Math.round(value * (unit === 'TB' ? 1e12 : 1e9));
}

/** The servers must reach each other directly: shown wherever destinations are added. */
export const NETWORK_NOTE =
  'Both servers must be able to reach each other directly: on the same home network, or connected through your own VPN, such as Tailscale. Copies travel straight from one server to the other over an encrypted SSH connection; nothing goes through a cloud service.';
