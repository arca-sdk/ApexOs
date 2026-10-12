/**
 * Wording for automatic drive-error handling: the small health badge on drive tiles and rows, and the
 * plain-language guidance for each diagnosis shown in the drive's health panel.
 */
import type { DriveDiagnosis, DriveHealth, DriveHealthEventKind } from '@apexos/api-types';

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatPowerOn(hours: number): string {
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = hours / 24;
  if (days < 365) return `${Math.round(days)} days`;
  const years = days / 365;
  return `${years.toFixed(1).replace(/\.0$/, '')} years`;
}

export interface DiagnosisGuide {
  /** Short badge text. */
  badge: string;
  cls: 'warn' | 'err';
  title: string;
  /** General description (tile detail; panel text when there is no specific note). */
  summary: string;
  /** Why this is the likely cause; follows the server's specific note in the panel. */
  why: string;
  steps: string[];
}

export const DIAGNOSIS_GUIDE: Record<DriveDiagnosis, DiagnosisGuide> = {
  'check-cable': {
    badge: 'Check cable',
    cls: 'warn',
    title: 'Check the cable',
    summary: 'Errors came back, but the drive itself reports no damage. A loose or worn cable is the usual cause.',
    why: 'A loose or worn cable is the usual cause of errors like these.',
    steps: [
      'Shut the server down and unplug it.',
      'Find this drive by its serial number and firmly reseat its data and power cables at both ends.',
      'If you have spare cables, swap them in, or use a different port.',
      'Start the server again. ApexOs keeps watching the drive and tells you if errors return.',
    ],
  },
  'check-controller': {
    badge: 'Check controller',
    cls: 'warn',
    title: 'Check the controller',
    summary:
      'Several drives connected the same way reported errors at the same time, while the drives themselves look healthy. The part they share is the likely cause.',
    why: 'The drives look healthy, so the part they share (controller card, drive enclosure or backplane) is the likely cause.',
    steps: [
      'Shut the server down and unplug it.',
      'Reseat the controller card, drive enclosure or backplane, and its cables.',
      'Make sure it gets enough airflow and power. An overheating card or a weak power supply causes errors like these.',
      'If errors return, connect the drives to different ports or another controller.',
    ],
  },
  'check-memory': {
    badge: 'Check memory',
    cls: 'warn',
    title: 'Check the memory',
    summary:
      'Several drives reported errors at the same time while looking healthy. Data is probably being damaged in the server’s memory (RAM) before it reaches them.',
    why: 'The drives look healthy, so data is probably being damaged in the server’s memory (RAM) before it reaches them.',
    steps: [
      'Run a memory test, for example MemTest86 from a USB stick, for a few passes.',
      'If it finds errors, replace the faulty memory module, or reseat all modules and test again.',
      'Avoid copying important data onto the server until the memory is fixed.',
    ],
  },
  'replace-drive': {
    badge: 'Replace soon',
    cls: 'err',
    title: 'Replace this drive',
    summary: 'The drive reports damaged areas, rates itself as failing, or stopped working. It won’t get better on its own.',
    why: 'This won’t get better on its own, and drives in this state usually get worse.',
    steps: [
      'Get a replacement drive of the same kind that is at least as large as this one.',
      'Connect it, then use Replace on this drive. Your data is copied over while the pool stays usable.',
      'If this pool keeps only one copy of your data, copy anything important elsewhere first.',
    ],
  },
  unclear: {
    badge: 'Errors again',
    cls: 'warn',
    title: 'Errors keep coming back',
    summary: 'This drive keeps reporting errors and the cause isn’t clear yet.',
    why: 'The cause isn’t clear yet, so start with the simplest fix.',
    steps: [
      'First check the cable: reseat it or swap it, and try another port or bay.',
      'If errors still come back after that, replace the drive.',
    ],
  },
};

export interface HealthBadge {
  text: string;
  cls: 'ok' | 'warn' | 'err' | 'info';
  detail: string;
}

/** The badge for a pool member's automatic error handling, or null when there is nothing to show. */
export function healthBadge(health: DriveHealth | undefined): HealthBadge | null {
  if (!health) return null;
  switch (health.state) {
    case 'checking':
      return { text: 'Checking', cls: 'info', detail: 'This drive reported errors. ApexOs is checking the pool to find and repair any damaged data.' };
    case 'watching':
      return {
        text: health.watchUntil ? `Watching until ${formatDay(health.watchUntil)}` : 'Watching',
        cls: 'info',
        detail: 'A few errors were repaired. ApexOs is keeping an eye on this drive and will tell you if they come back.',
      };
    case 'attention': {
      const guide = DIAGNOSIS_GUIDE[health.diagnosis ?? 'unclear'];
      return { text: guide.badge, cls: guide.cls, detail: guide.summary };
    }
    default:
      return null;
  }
}

/** Colour of a history entry's marker. */
export function eventTone(kind: DriveHealthEventKind): 'ok' | 'warn' | 'err' | 'info' {
  switch (kind) {
    case 'errors':
    case 'diagnosis':
    case 'kept':
      return 'warn';
    case 'failed':
      return 'err';
    case 'cleared':
    case 'recovered':
    case 'watch':
      return 'ok';
    default:
      return 'info';
  }
}
