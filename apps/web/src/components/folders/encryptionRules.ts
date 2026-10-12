/**
 * Wording and client-side checks for folder encryption. The server repeats every check; passphrases only
 * live in component state until they are sent, and are cleared afterwards.
 */
import type { ConversionDuration, EncryptionMode, Folder } from '@apexos/api-types';

export const MIN_PASSPHRASE = 8;
export const MAX_PASSPHRASE = 512;

export function passphraseProblem(passphrase: string, again: string): { passphrase?: string; again?: string } {
  if (passphrase.length < MIN_PASSPHRASE) return { passphrase: `Use at least ${MIN_PASSPHRASE} characters.` };
  if (passphrase.length > MAX_PASSPHRASE) return { passphrase: `Use ${MAX_PASSPHRASE} characters or fewer.` };
  if (passphrase !== again) return { again: 'The two passphrases don’t match.' };
  return {};
}

export const MODE_LABELS: Record<EncryptionMode, string> = {
  key: 'Automatic key',
  passphrase: 'Passphrase',
  none: 'Not encrypted',
};

export const DURATION_LABELS: Record<ConversionDuration, string> = {
  minutes: 'a few minutes',
  'up-to-an-hour': 'up to an hour',
  'a-few-hours': 'a few hours',
  'a-day-or-more': 'a day or more',
};

/** True when the folder's own encryption can be managed here (not inherited from a dataset above it). */
export function ownsKey(folder: Folder): boolean {
  return !!folder.encryption && folder.encryption.mode !== 'none' && !folder.encryption.inherited;
}

export function isConverting(folder: Folder): boolean {
  const c = folder.conversion;
  return !!c && c.state !== 'done';
}

/**
 * Finds this folder's key in a recovery file (TrueNAS key-file format: `{"pool/Folder": "<64 hex>"}`).
 * Returns a message when the file can't be used.
 */
export function keyFromRecoveryFile(text: string, dataset: string): { key: string } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: 'That file isn’t a recovery file. Choose the .json file you downloaded from Settings → Recovery key.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { problem: 'That file isn’t a recovery file.' };
  const key = (parsed as Record<string, unknown>)[dataset];
  if (typeof key !== 'string') {
    return { problem: 'This recovery file doesn’t contain the key for this folder. It may be older than the folder, or from another server.' };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return { problem: 'The key for this folder in that file looks damaged.' };
  return { key };
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
