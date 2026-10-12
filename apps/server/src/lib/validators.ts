// Validation rules adapted from eshtek/hexos-shared `eshtek/common.ts` (GPL-3.0, Eshtek, Inc.).
// Re-implemented here because the upstream module depends on browser/Nuxt globals.

/** NetBIOS-compatible server name: 2–15 chars, starts with a letter, letters/digits/dashes, no trailing dash. */
export const servernameFormat = (hostname: string): boolean => /^[a-zA-Z][a-zA-Z0-9-]{0,13}[a-zA-Z0-9]$/.test(hostname);

/** Usernames: 3–30 chars, starts with a letter, then letters, digits, `_` or `-`. */
export const usernameFormat = (username: string): boolean => /^[a-zA-Z][a-zA-Z0-9_-]{2,29}$/.test(username);

/** Folder names: letters, digits, spaces, `_`, `-`; no leading/trailing or doubled separators. */
export const foldernameFormat = (folderName: string): boolean =>
  /^(?![_\-\s])(?!.*[_\-\s]$)(?!.*[_\-\s]{2})[a-zA-Z0-9_\-\s]{1,255}$/.test(folderName);
