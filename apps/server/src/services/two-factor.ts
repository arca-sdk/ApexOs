/**
 * Two-factor sign-in (TOTP) for the ApexOs admin account, the two-step login, failed-attempt
 * limiting and session controls ("Sign out everywhere").
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AccountSecurity, LoginResponse, LoginVerifyResponse, RecoveryCodesResponse, TwoFactorSetup } from '@apexos/api-types';
import type { AppContext } from '../app.ts';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createChallengeToken,
  createSessionToken,
  hashPassword,
  readChallengeToken,
  verifyCredentials,
  verifyPassword,
} from '../lib/auth.ts';
import { UserError } from '../lib/errors.ts';
import { encodeQr, qrSvgPath } from '../lib/qr.ts';
import { AttemptLimiter } from '../lib/rate-limit.ts';
import type { StateStore } from '../lib/store.ts';
import { base32Decode, generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from '../lib/totp.ts';

const ISSUER = 'ApexOs';
const RECOVERY_CODE_COUNT = 10;
/** Wrong codes allowed per password entry before the password must be entered again. */
const CHALLENGE_MAX_ATTEMPTS = 5;
/** An unconfirmed enrollment expires after this long. */
const SETUP_TTL_MS = 30 * 60 * 1000;

interface SecurityRuntime {
  /** Clock for codes, challenges and the attempt limiter (tests move it). */
  now: () => number;
  limiter: AttemptLimiter;
  /** Outstanding sign-in challenges by nonce. */
  challenges: Map<string, { attempts: number; expiresAt: number }>;
  /** Serializes code checks so a code can't be accepted twice by concurrent requests. */
  queue: Promise<unknown>;
}

const runtimes = new WeakMap<StateStore, SecurityRuntime>();

/** In-memory security state for this ApexOs instance (one per state store). */
export function securityRuntime(ctx: AppContext): SecurityRuntime {
  let rt = runtimes.get(ctx.store);
  if (!rt) {
    const created: SecurityRuntime = { now: Date.now, limiter: new AttemptLimiter(), challenges: new Map(), queue: Promise.resolve() };
    created.limiter.now = () => created.now();
    runtimes.set(ctx.store, created);
    rt = created;
  }
  return rt;
}


function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** Refuses the request while its address has to wait after too many failures. */
function checkLimit(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): void {
  const wait = securityRuntime(ctx).limiter.retryAfterMs(req.ip);
  if (wait <= 0) return;
  void reply.header('retry-after', String(Math.ceil(wait / 1000)));
  throw new UserError(`Too many failed attempts. Try again in ${waitText(wait)}.`, 429, 'RATE_LIMITED');
}

/**
 * Runs a credential check (password, authenticator or recovery code) after the attempt-limit check,
 * one at a time. Parallel guesses therefore can't all pass the limit before the first failure is
 * counted, and concurrent requests can't both use the same code.
 */
export function guarded<T>(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>): Promise<T> {
  const rt = securityRuntime(ctx);
  const run = rt.queue.then(() => {
    checkLimit(ctx, req, reply);
    return fn();
  });
  rt.queue = run.catch(() => undefined);
  return run;
}

/** Records a failure and returns a sentence to append when the address now has to wait. */
export function recordFailure(ctx: AppContext, req: FastifyRequest): string {
  const wait = securityRuntime(ctx).limiter.fail(req.ip);
  return wait > 0 ? ` Wait ${waitText(wait)} before trying again.` : '';
}

/** True when the request reached ApexOs over HTTPS (directly or via a proxy that says so). */
export function isHttps(req: FastifyRequest): boolean {
  if (req.protocol === 'https') return true;
  const forwarded = req.headers['x-forwarded-proto'];
  return String(Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? '')).split(',')[0]!.trim().toLowerCase() === 'https';
}

/**
 * Sets the session cookie for the current session generation. The cookie is marked Secure when
 * APEXOS_SECURE_COOKIES=1, and also whenever the request itself came over HTTPS.
 */
export function issueSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, username: string): void {
  const state = ctx.store.get();
  reply.setCookie(SESSION_COOKIE, createSessionToken(username, state.sessionSecret, Date.now(), state.security.sessionGeneration), {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: Boolean(ctx.secureCookies) || isHttps(req),
    maxAge: SESSION_TTL_MS / 1000,
  });
}

/** Ends every other session (bumps the generation) and keeps this browser signed in. */
export async function rotateSessions(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, username: string): Promise<void> {
  await ctx.store.update((s) => {
    s.security.sessionGeneration += 1;
  });
  issueSession(ctx, req, reply, username);
}

/** "Sign out everywhere": every session ends, including the current one. */
export async function signOutEverywhere(ctx: AppContext, reply: FastifyReply): Promise<void> {
  await ctx.store.update((s) => {
    s.security.sessionGeneration += 1;
  });
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/** Step 1: username and password. Signs in directly, or hands out a challenge for the code step. */
export async function passwordStep(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  body: { username: string; password: string },
): Promise<LoginResponse> {
  return guarded(ctx, req, reply, async () => {
    const admin = ctx.store.get().admin;
    if (!admin || !(await verifyCredentials(admin, body.username, body.password))) {
      throw new UserError(`Incorrect username or password.${recordFailure(ctx, req)}`, 401, 'INVALID_CREDENTIALS');
    }
    const state = ctx.store.get();
    const rt = securityRuntime(ctx);
    if (!state.security.twoFactor) {
      rt.limiter.succeed(req.ip);
      issueSession(ctx, req, reply, admin.username);
      return { ok: true };
    }
    // The failure count is only cleared once the code is right too, so password + code guesses add up.
    const now = rt.now();
    const { token, claims } = createChallengeToken(admin.username, state.security.sessionGeneration, state.sessionSecret, now);
    for (const [nonce, c] of rt.challenges) if (c.expiresAt < now) rt.challenges.delete(nonce);
    rt.challenges.set(claims.nonce, { attempts: 0, expiresAt: claims.expiresAt });
    return { ok: false, twoFactorRequired: true, challenge: token, expiresAt: new Date(claims.expiresAt).toISOString() };
  });
}

type SecondFactorResult = { ok: true; recovery: boolean } | { ok: false; reused: boolean };

/** Checks an authenticator code (or, when allowed, a recovery code) and consumes it. Call inside `guarded`. */
async function checkSecondFactor(ctx: AppContext, input: string, allowRecovery: boolean): Promise<SecondFactorResult> {
  const tf = ctx.store.get().security.twoFactor;
  if (!tf) return { ok: false, reused: false };
  const digits = input.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    const check = verifyTotp(base32Decode(tf.secret), digits, { now: securityRuntime(ctx).now(), lastUsedStep: tf.lastUsedStep });
    if (!check.ok) return check;
    await ctx.store.update((s) => {
      if (s.security.twoFactor) s.security.twoFactor.lastUsedStep = check.step;
    });
    return { ok: true, recovery: false };
  }
  const normalized = allowRecovery ? normalizeRecoveryCode(input) : null;
  if (!normalized) return { ok: false, reused: false };
  // Check every stored hash (no early exit), then remove the one that matched.
  const matches = await Promise.all(tf.recoveryCodes.map((hash) => verifyPassword(normalized, hash)));
  const used = tf.recoveryCodes[matches.indexOf(true)];
  if (!used) return { ok: false, reused: false };
  await ctx.store.update((s) => {
    if (s.security.twoFactor) s.security.twoFactor.recoveryCodes = s.security.twoFactor.recoveryCodes.filter((h) => h !== used);
  });
  return { ok: true, recovery: true };
}

function codeError(result: { reused: boolean }, extra: string, recoveryAllowed = true): string {
  if (result.reused) return `That code was already used. Wait for the next code in your authenticator app.${extra}`;
  return `That code isn’t right. Use the newest code from your authenticator app${recoveryAllowed ? ', or a recovery code' : ''}.${extra}`;
}

/** Step 2: the challenge from step 1 plus an authenticator or recovery code. */
export async function codeStep(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  body: { challenge: string; code: string },
): Promise<LoginVerifyResponse> {
  return guarded(ctx, req, reply, async () => {
    const rt = securityRuntime(ctx);
    const state = ctx.store.get();
    const claims = readChallengeToken(body.challenge, state.sessionSecret, rt.now());
    const pending = claims ? rt.challenges.get(claims.nonce) : undefined;
    const valid =
      claims && pending && pending.expiresAt >= rt.now() && state.admin && state.security.twoFactor && claims.username === state.admin.username && claims.generation === state.security.sessionGeneration;
    if (!valid) {
      if (claims) rt.challenges.delete(claims.nonce);
      throw new UserError('This sign-in has expired. Enter your password again.', 401, 'CHALLENGE_EXPIRED');
    }
    const result = await checkSecondFactor(ctx, body.code, true);
    if (!result.ok) {
      const extra = recordFailure(ctx, req);
      pending.attempts += 1;
      if (pending.attempts >= CHALLENGE_MAX_ATTEMPTS) {
        rt.challenges.delete(claims.nonce);
        throw new UserError(`Too many incorrect codes. Enter your password again.${extra}`, 401, 'CHALLENGE_EXPIRED');
      }
      throw new UserError(codeError(result, extra), 401, 'INVALID_CODE');
    }
    rt.challenges.delete(claims.nonce);
    rt.limiter.succeed(req.ip);
    issueSession(ctx, req, reply, claims.username);
    return { ok: true, recoveryCodeUsed: result.recovery, recoveryCodesLeft: ctx.store.get().security.twoFactor?.recoveryCodes.length ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Settings → Your account
// ---------------------------------------------------------------------------

export function getAccountSecurity(ctx: AppContext, req: FastifyRequest): AccountSecurity {
  const { security } = ctx.store.get();
  return {
    twoFactor: {
      enabled: Boolean(security.twoFactor),
      enabledAt: security.twoFactor?.enabledAt ?? null,
      recoveryCodesLeft: security.twoFactor?.recoveryCodes.length ?? 0,
    },
    strongPassword: security.strongPassword,
    secureCookies: Boolean(ctx.secureCookies),
    https: isHttps(req),
  };
}

function accountLabel(ctx: AppContext): string {
  const state = ctx.store.get();
  const user = state.admin?.username ?? 'admin';
  return state.server.name ? `${user}@${state.server.name}` : user;
}

/** Starts enrollment: a fresh secret (replacing any unfinished one) shown as text and QR code. */
export async function beginSetup(ctx: AppContext): Promise<TwoFactorSetup> {
  if (ctx.store.get().security.twoFactor) throw new UserError('Two-factor sign-in is already on.', 409, 'ALREADY_ENABLED');
  const secret = generateTotpSecret();
  await ctx.store.update((s) => {
    s.security.pendingTwoFactor = { secret, createdAt: new Date(securityRuntime(ctx).now()).toISOString() };
  });
  const account = accountLabel(ctx);
  const uri = otpauthUri({ secret, issuer: ISSUER, account });
  const qr = encodeQr(uri);
  return { secret, otpauthUri: uri, issuer: ISSUER, account, qr: { size: qr.size, path: qrSvgPath(qr) } };
}

export async function cancelSetup(ctx: AppContext): Promise<void> {
  if (!ctx.store.get().security.pendingTwoFactor) return;
  await ctx.store.update((s) => {
    s.security.pendingTwoFactor = null;
  });
}

async function newRecoveryCodes(): Promise<{ codes: string[]; hashes: string[] }> {
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const hashes = await Promise.all(codes.map((c) => hashPassword(normalizeRecoveryCode(c)!)));
  return { codes, hashes };
}

/** Confirms enrollment with a code from the new authenticator entry; returns the recovery codes (shown once). */
export function confirmSetup(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, code: string): Promise<RecoveryCodesResponse> {
  return guarded(ctx, req, reply, async () => {
    const { security, admin } = ctx.store.get();
    if (security.twoFactor) throw new UserError('Two-factor sign-in is already on.', 409, 'ALREADY_ENABLED');
    const pending = security.pendingTwoFactor;
    const now = securityRuntime(ctx).now();
    if (!pending || Date.parse(pending.createdAt) + SETUP_TTL_MS < now) {
      throw new UserError('This setup has expired. Start again to get a new QR code.', 409, 'SETUP_EXPIRED');
    }
    const check = verifyTotp(base32Decode(pending.secret), code, { now });
    if (!check.ok) {
      const extra = recordFailure(ctx, req);
      throw new UserError(`That code isn’t right. Check that your phone’s clock is set automatically, then try the newest code.${extra}`, 400, 'INVALID_CODE', {
        code: 'Incorrect code',
      });
    }
    const { codes, hashes } = await newRecoveryCodes();
    await ctx.store.update((s) => {
      s.security.twoFactor = { secret: pending.secret, enabledAt: new Date().toISOString(), lastUsedStep: check.step, recoveryCodes: hashes };
      s.security.pendingTwoFactor = null;
    });
    // Sessions that were opened with only a password end now; this browser stays signed in.
    await rotateSessions(ctx, req, reply, admin!.username);
    return { recoveryCodes: codes };
  });
}

/** Turns two-factor sign-in off; needs the password and a current code (or a recovery code). */
export function disableTwoFactor(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, body: { password: string; code: string }): Promise<void> {
  return guarded(ctx, req, reply, async () => {
    const { security, admin, remoteAccess } = ctx.store.get();
    if (!security.twoFactor || !admin) throw new UserError('Two-factor sign-in is already off.', 409, 'NOT_ENABLED');
    if (remoteAccess.cloudflare) {
      throw new UserError(
        'Turn off Cloudflare Tunnel first. It puts your sign-in page on the internet, so two-factor sign-in has to stay on while it runs.',
        409,
        'REMOTE_ACCESS_ON',
      );
    }
    // The password is checked first so a wrong password never uses up the code.
    if (!(await verifyPassword(body.password, admin.passwordHash))) {
      throw new UserError(`Your password is incorrect.${recordFailure(ctx, req)}`, 400, 'INVALID_CREDENTIALS', { password: 'Incorrect password' });
    }
    const result = await checkSecondFactor(ctx, body.code, true);
    if (!result.ok) throw new UserError(codeError(result, recordFailure(ctx, req)), 400, 'INVALID_CODE', { code: 'Incorrect code' });
    await ctx.store.update((s) => {
      s.security.twoFactor = null;
      s.security.pendingTwoFactor = null;
    });
  });
}

/** Replaces all recovery codes; needs a current authenticator code. */
export function regenerateRecoveryCodes(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, code: string): Promise<RecoveryCodesResponse> {
  return guarded(ctx, req, reply, async () => {
    if (!ctx.store.get().security.twoFactor) throw new UserError('Two-factor sign-in is off.', 409, 'NOT_ENABLED');
    const result = await checkSecondFactor(ctx, code, false);
    if (!result.ok) throw new UserError(codeError(result, recordFailure(ctx, req), false), 400, 'INVALID_CODE', { code: 'Incorrect code' });
    const { codes, hashes } = await newRecoveryCodes();
    await ctx.store.update((s) => {
      if (s.security.twoFactor) s.security.twoFactor.recoveryCodes = hashes;
    });
    return { recoveryCodes: codes };
  });
}
