/**
 * Client-side mirrors of the server's folder/user rules, so the forms can explain problems
 * next to the right input before anything is sent. The server stays the source of truth.
 */
import type { AccessLevel, Folder } from '@hearth/api-types';

export const FOLDER_NAME_MAX = 80;
export const USERNAME_MAX = 30;
/** Smallest storage limit TrueNAS accepts (1 GiB). */
export const MIN_QUOTA_BYTES = 1024 ** 3;

const FOLDER_NAME = /^(?![_\-\s])(?!.*[_\-\s]$)(?!.*[_\-\s]{2})[a-zA-Z0-9_\-\s]+$/;
const USERNAME = /^[a-zA-Z][a-zA-Z0-9_-]{2,29}$/;

export function folderNameProblem(raw: string, reserved: string[], existing: string[]): string | null {
  const name = raw.trim();
  if (!name) return 'Give the folder a name.';
  if (name.length > FOLDER_NAME_MAX) return `Keep the name to ${FOLDER_NAME_MAX} characters or fewer.`;
  if (!FOLDER_NAME.test(name)) {
    return 'Use letters, numbers, spaces, dashes or underscores. The name can’t start or end with a space, dash or underscore, or repeat them.';
  }
  const lower = name.toLowerCase();
  if (reserved.some((r) => r.toLowerCase() === lower)) return `“${name}” is reserved for Hearth. Pick another name.`;
  if (existing.some((e) => e.toLowerCase() === lower)) return `You already have a folder called “${name}”.`;
  return null;
}

export function usernameProblem(raw: string, taken: string[] = []): string | null {
  const name = raw.trim();
  if (!name) return 'Enter a username.';
  if (name.length > USERNAME_MAX) return `Keep the username to ${USERNAME_MAX} characters or fewer.`;
  if (name.length < 3) return 'Use at least 3 characters.';
  if (!/^[a-zA-Z]/.test(name)) return 'Start the username with a letter.';
  if (!USERNAME.test(name)) return 'Use only letters, numbers, dashes or underscores.';
  if (name.toLowerCase().startsWith('hearth_')) return 'Names starting with “hearth_” are reserved.';
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return 'That username is already taken.';
  return null;
}

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters.';
  if (password.length > 128) return 'Use 128 characters or fewer.';
  return null;
}

export const LEVEL_LABELS: Record<AccessLevel, string> = {
  read: 'View only',
  full: 'Full access',
};

export type ConnectOs = 'mac' | 'windows';

const OS_KEY = 'hearth.connectOs';

/** The format the visitor picked last time, or a best guess from their OS. */
export function detectOs(): ConnectOs {
  const saved = localStorage.getItem(OS_KEY);
  if (saved === 'mac' || saved === 'windows') return saved;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? '';
  return /win/i.test(platform) ? 'windows' : 'mac';
}

export function rememberOs(os: ConnectOs): void {
  localStorage.setItem(OS_KEY, os);
}

export function folderAddress(folder: Pick<Folder, 'smbUrl' | 'uncPath'>, os: ConnectOs): string | null {
  if (os === 'windows') return folder.uncPath;
  return folder.smbUrl;
}

/** Copies text to the clipboard, falling back to a hidden textarea where the async API isn't allowed (plain HTTP). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Splits a byte count into a friendly number + unit for the storage-limit input (decimal units, like the rest of the UI). */
export function splitQuota(bytes: number): { value: number; unit: 'GB' | 'TB' } {
  if (bytes >= 1e12) return { value: Math.round((bytes / 1e12) * 100) / 100, unit: 'TB' };
  return { value: Math.round((bytes / 1e9) * 100) / 100, unit: 'GB' };
}

export function quotaToBytes(value: number, unit: 'GB' | 'TB'): number {
  return Math.round(value * (unit === 'TB' ? 1e12 : 1e9));
}

/** Where to go to manage the thing that is using a folder or location. */
export function useLink(use: { type: 'app' | 'location'; id: string }): string {
  return use.type === 'app' ? '/apps' : '/settings?section=locations';
}
