import { randomBytes, randomUUID } from 'node:crypto';
import { CallError, callError, validationError } from './rpc.ts';

export type Obj = Record<string, unknown>;

export const GiB = 1024 ** 3;
export const TiB = 1024 ** 4;
export const MiB = 1024 ** 2;

export function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The positional argument as an object (`{}` when omitted); raises a pydantic-like error otherwise. */
export function argObj(v: unknown, attr: string): Obj {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw validationError(attr, 'Input should be a valid dictionary');
  return v;
}

export function reqStr(o: Obj, key: string, attr: string): string {
  const v = o[key];
  if (v === undefined || v === null) throw validationError(`${attr}.${key}`, 'Field required');
  if (typeof v !== 'string') throw validationError(`${attr}.${key}`, 'Input should be a valid string');
  return v;
}

export function optStr(o: Obj, key: string, attr: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw validationError(`${attr}.${key}`, 'Input should be a valid string');
  return v;
}

export function optBool(o: Obj, key: string, attr: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw validationError(`${attr}.${key}`, 'Input should be a valid boolean');
  return v;
}

export function optInt(o: Obj, key: string, attr: string): number | null | undefined {
  const v = o[key];
  if (v === undefined || v === null) return v as null | undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw validationError(`${attr}.${key}`, 'Input should be a valid integer');
  return v;
}

export function nameArg(v: unknown, attr: string): string {
  if (typeof v !== 'string' || !v) throw validationError(attr, 'Input should be a valid string');
  return v;
}

export function notFound(what: string): CallError {
  return callError('ENOENT', what, 2);
}

/** `{"$date": ms}` as the middleware encodes datetimes. */
export function $date(ms: number): { $date: number } {
  return { $date: Math.round(ms) };
}

/** Random unsigned 64-bit integer as a decimal string, like ZFS GUIDs. */
export function randomGuid(): string {
  const n = randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn;
  return n.toString();
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function uuid(): string {
  return randomUUID();
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[bytes[i]! % ALNUM.length];
  return out;
}

/** ZFS-style human readable size (`zfs get` "value" column): 1024-based, up to 3 significant digits. */
export function zfsHuman(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T', 'P', 'E'];
  if (bytes < 1024) return `${bytes}B`;
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const unit = units[u]!;
  if (Number.isInteger(v)) return `${v}${unit}`;
  if (v < 10) return `${v.toFixed(2)}${unit}`;
  if (v < 100) return `${v.toFixed(1)}${unit}`;
  return `${Math.round(v)}${unit}`;
}

/** Python `str(timedelta)` style, e.g. "3 days, 4:05:11". */
export function timedeltaStr(seconds: number): string {
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const rest = s % 86400;
  const h = Math.floor(rest / 3600);
  const m = Math.floor((rest % 3600) / 60);
  const sec = rest % 60;
  const clock = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return days ? `${days} day${days === 1 ? '' : 's'}, ${clock}` : clock;
}

/** Recursive merge: plain objects merge, everything else (arrays included) is replaced. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : structuredClone(patch)) as T;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out as T;
}

/** Compares dotted version strings numerically where possible ("1.3.9" < "1.3.17"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-_]/);
  const pb = b.split(/[.\-_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** "1.3.17" -> "1.3.16" (used to seed apps that are one catalog version behind). */
export function previousVersion(v: string): string {
  const parts = v.split('.');
  const last = Number(parts[parts.length - 1]);
  if (Number.isNaN(last) || last === 0) return v;
  parts[parts.length - 1] = String(last - 1);
  return parts.join('.');
}

/** Deterministic pseudo-random in [0, 1) from a string seed (for stable fake values). */
export function seeded(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function jitter(base: number, amount: number): number {
  return base + (Math.random() * 2 - 1) * amount;
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
