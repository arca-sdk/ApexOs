/**
 * Time-based one-time passwords for two-factor sign-in, implemented with node:crypto only:
 *
 * - HOTP (RFC 4226): HMAC over an 8-byte big-endian counter, dynamic truncation, `mod 10^digits`.
 * - TOTP (RFC 6238): the counter is the number of `period`-second steps since the Unix epoch.
 * - Base32 (RFC 4648 §6) for secrets, as authenticator apps expect them.
 * - `otpauth://` URIs (the de-facto Key URI format) for QR codes.
 * - Single-use recovery codes.
 *
 * Defaults are what every authenticator app supports: HMAC-SHA1, 30-second steps, 6 digits.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  /** Step length in seconds (RFC 6238 "X"). Default 30. */
  period?: number;
  /** Code length. Default 6. */
  digits?: number;
  /** Default `sha1`. */
  algorithm?: TotpAlgorithm;
}

const DEFAULTS: Required<TotpOptions> = { period: 30, digits: 6, algorithm: 'sha1' };

// ---------------------------------------------------------------------------
// Base32 (RFC 4648 §6)
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 without `=` padding (authenticator apps don't want it). */
export function base32Encode(data: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Decodes base32, ignoring case, spaces, dashes and trailing padding. Throws on other characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = BASE32_ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`Invalid base32 character "${ch}"`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// HOTP / TOTP
// ---------------------------------------------------------------------------

/** RFC 4226 HOTP value for `counter` as a zero-padded decimal string. */
export function hotp(key: Uint8Array, counter: number, digits = DEFAULTS.digits, algorithm: TotpAlgorithm = DEFAULTS.algorithm): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError('HOTP counter must be a non-negative integer');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP step number (RFC 6238 "T") for a moment in time. */
export function totpStep(timeMs: number, period = DEFAULTS.period): number {
  return Math.floor(timeMs / 1000 / period);
}

/** RFC 6238 TOTP value at `timeMs`. */
export function totp(key: Uint8Array, timeMs: number, opts: TotpOptions = {}): string {
  const { period, digits, algorithm } = { ...DEFAULTS, ...opts };
  return hotp(key, totpStep(timeMs, period), digits, algorithm);
}

export type TotpCheck = { ok: true; step: number } | { ok: false; reused: boolean };

/**
 * Checks a code against the current step and `window` steps either side (clock drift). Codes from
 * steps at or before `lastUsedStep` are refused, so a code (or an earlier one) can't be used twice.
 * Every candidate is compared in constant time and none is skipped early.
 */
export function verifyTotp(
  key: Uint8Array,
  code: string,
  opts: TotpOptions & { now?: number; window?: number; lastUsedStep?: number | null } = {},
): TotpCheck {
  const { period, digits, algorithm } = { ...DEFAULTS, ...opts };
  const window = opts.window ?? 1;
  const lastUsed = opts.lastUsedStep ?? -1;
  const given = Buffer.from(code.replace(/\s/g, ''));
  if (given.length !== digits || !/^\d+$/.test(given.toString())) return { ok: false, reused: false };
  const current = totpStep(opts.now ?? Date.now(), period);
  let matched: number | null = null;
  let reused = false;
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    const equal = timingSafeEqual(Buffer.from(hotp(key, step, digits, algorithm)), given);
    if (!equal) continue;
    if (step > lastUsed) matched ??= step;
    else reused = true;
  }
  return matched !== null ? { ok: true, step: matched } : { ok: false, reused };
}

/** A new random secret (160 bits, the RFC 4226 recommendation), base32-encoded. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** `otpauth://totp/Issuer:account?secret=…` for authenticator apps (usually shown as a QR code). */
export function otpauthUri(params: { secret: string; issuer: string; account: string } & TotpOptions): string {
  const { period, digits, algorithm } = { ...DEFAULTS, ...params };
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: algorithm.toUpperCase(),
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** Lowercase letters and digits without look-alikes (0/o, 1/l/i). 31^10 ≈ 2^49.5 per code. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RECOVERY_LENGTH = 10;

/** `count` random codes formatted `xxxxx-xxxxx`. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    let code = '';
    for (let i = 0; i < RECOVERY_LENGTH; i++) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** Canonical form used for hashing (no dashes or spaces, lowercase); null when it can't be a recovery code. */
export function normalizeRecoveryCode(input: string): string | null {
  const clean = input.replace(/[\s-]/g, '').toLowerCase();
  if (clean.length !== RECOVERY_LENGTH) return null;
  for (const ch of clean) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return clean;
}
