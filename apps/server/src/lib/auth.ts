import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEY_LENGTH = 64;
export const SESSION_COOKIE = 'apexos_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long the second sign-in step (two-factor code) may take. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Constant-time string comparison (lengths may differ). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

let dummyHash: Promise<string> | undefined;

/**
 * Checks a username and password against the admin account. The password hash is always computed,
 * even for an unknown username, so response times don't reveal which part was wrong.
 */
export async function verifyCredentials(admin: { username: string; passwordHash: string } | undefined, username: string, password: string): Promise<boolean> {
  const hash = admin?.passwordHash ?? (await (dummyHash ??= hashPassword(randomBytes(16).toString('hex'))));
  const passwordOk = await verifyPassword(password, hash);
  const usernameOk = admin ? safeEqual(username, admin.username) : false;
  return passwordOk && usernameOk;
}

/** Rough strength check used for the security checklist: long, or reasonably long and varied. */
export function isStrongPassword(password: string): boolean {
  if (new Set(password).size < 6) return false;
  if (password.length >= 16) return true;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((re) => re.test(password)).length;
  return password.length >= 12 && classes >= 3;
}

function sign(payload: string, secret: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signatureMatches(payload: string, signature: string, secret: string | Buffer): boolean {
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface SessionClaims {
  username: string;
  /** Sessions issued before the account's session generation was bumped ("Sign out everywhere") are void. */
  generation: number;
}

/** Stateless signed session token: base64url(username|expiresAt|generation).signature */
export function createSessionToken(username: string, secret: string, now = Date.now(), generation = 0): string {
  const payload = Buffer.from(`${username}|${now + SESSION_TTL_MS}|${generation}`).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function readSessionToken(token: string | undefined, secret: string, now = Date.now()): SessionClaims | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || !signatureMatches(payload, signature, secret)) return null;
  // Tokens from before session generations existed have no third field and count as generation 0.
  const [username, expiresAt, generation = '0'] = Buffer.from(payload, 'base64url').toString().split('|');
  const expires = Number(expiresAt);
  const gen = Number(generation);
  if (!username || !Number.isFinite(expires) || expires < now || !Number.isSafeInteger(gen) || gen < 0) return null;
  return { username, generation: gen };
}

export interface ChallengeClaims {
  username: string;
  generation: number;
  /** Identifies the challenge server-side (attempt counting, single use). */
  nonce: string;
  expiresAt: number;
}

/** Challenge tokens are signed with their own key so they can never pass as a session token (or the reverse). */
function challengeKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('apexos:sign-in-challenge:v1').digest();
}

/** Short-lived signed token handed out after a correct password when a two-factor code is still needed. */
export function createChallengeToken(username: string, generation: number, secret: string, now = Date.now()): { token: string; claims: ChallengeClaims } {
  const claims: ChallengeClaims = { username, generation, nonce: randomBytes(16).toString('base64url'), expiresAt: now + CHALLENGE_TTL_MS };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { token: `c1.${payload}.${sign(payload, challengeKey(secret))}`, claims };
}

export function readChallengeToken(token: string, secret: string, now = Date.now()): ChallengeClaims | null {
  const [version, payload, signature, extra] = token.split('.');
  if (version !== 'c1' || !payload || !signature || extra !== undefined || !signatureMatches(payload, signature, challengeKey(secret))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ChallengeClaims;
    if (typeof claims.username !== 'string' || typeof claims.nonce !== 'string' || !Number.isSafeInteger(claims.generation)) return null;
    if (!Number.isFinite(claims.expiresAt) || claims.expiresAt < now) return null;
    return claims;
  } catch {
    return null;
  }
}
