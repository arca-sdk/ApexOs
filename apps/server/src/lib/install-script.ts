import { randomInt } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstallQuestion, LocationPreferenceId } from '@apexos/api-types';
import { LocationPreferenceId as L } from '@apexos/shared/eshtek/preferences';

/** Install-script format v4 (see docs/install-scripts.md). */
export interface InstallScript {
  version: 4;
  train?: string;
  script: { version: string; changeLog?: string };
  requirements: {
    locations: LocationPreferenceId[];
    specifications: string[];
    permissions: string[];
    ports: number[];
  };
  installation_questions?: (InstallQuestion & { default?: string | number | boolean })[];
  ensure_directories_exists?: { path: string; owner?: { user: string; group?: string }; snapshot?: { id: string } }[];
  app_values: Record<string, unknown>;
}

export const SCRIPT_LOCATIONS: LocationPreferenceId[] = [
  L.APPLICATIONS_PERFORMANCE,
  L.APPLICATIONS_CAPACITY,
  L.DOWNLOADS,
  L.DOCUMENTS,
  L.MEDIA,
  L.PHOTOS,
  L.MUSIC,
  L.MOVIES,
  L.SHOWS,
  L.VIDEOS,
];

const KNOWN_MACROS = new Set([
  'LOCATION',
  'QUESTION',
  'RANDOM_STRING',
  'MEMORY',
  'CPUS',
  'HOST_PATH',
  'MOUNTED_HOST_PATH',
  'IF',
  'APP_INSTALLED',
  'SERVER_LAN_IP',
  'TIMEZONE',
]);

export interface MacroContext {
  locations: Partial<Record<LocationPreferenceId, string>>;
  answers: Record<string, string | number | boolean>;
  memoryBytes: number;
  cpus: number;
  installedApps: Set<string>;
  lanIp: string;
  timezone: string;
}

export class ScriptError extends Error {}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomString(length: number): string {
  if (!Number.isInteger(length) || length < 1 || length > 256) throw new ScriptError(`Invalid $RANDOM_STRING length ${length}`);
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[randomInt(ALNUM.length)];
  return out;
}

type MacroValue = string | number | boolean | Record<string, unknown>;

interface Token {
  name: string;
  args: string[] | null;
  start: number;
  end: number;
}

/** Finds the next `$NAME` or `$NAME(args)` macro at or after `from`. Nested parentheses are respected. */
function nextMacro(input: string, from: number): Token | null {
  const re = /\$([A-Z_]+)/g;
  re.lastIndex = from;
  const m = re.exec(input);
  if (!m) return null;
  const start = m.index;
  let pos = start + m[0].length;
  if (input[pos] !== '(') return { name: m[1]!, args: null, start, end: pos };
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (pos = pos + 1; pos < input.length; pos++) {
    const ch = input[pos]!;
    if (ch === '(') depth++;
    if (ch === ')') {
      if (depth === 0) {
        args.push(current.trim());
        return { name: m[1]!, args: args.length === 1 && args[0] === '' ? [] : args, start, end: pos + 1 };
      }
      depth--;
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  throw new ScriptError(`Unclosed parenthesis in "${input}"`);
}

function asText(v: MacroValue): string {
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function truthy(v: string): boolean {
  const s = v.trim().toLowerCase();
  return !(s === '' || s === 'false' || s === '0' || s === 'no');
}

/** Evaluates `$IF` conditions: `a == b`, `a != b`, `!x`, `x`, joined by `&&` / `||`. */
export function evaluateCondition(expr: string): boolean {
  const or = expr.split('||');
  if (or.length > 1) return or.some(evaluateCondition);
  const and = expr.split('&&');
  if (and.length > 1) return and.every(evaluateCondition);
  const e = expr.trim();
  const ne = e.split('!=');
  if (ne.length === 2) return ne[0]!.trim().toLowerCase() !== ne[1]!.trim().toLowerCase();
  const eq = e.split('==');
  if (eq.length === 2) return eq[0]!.trim().toLowerCase() === eq[1]!.trim().toLowerCase();
  if (e.startsWith('!')) return !truthy(e.slice(1));
  return truthy(e);
}

function expandMacro(token: Token, ctx: MacroContext): MacroValue {
  const args = (token.args ?? []).map((a) => expandString(a, ctx));
  const textArgs = args.map(asText);
  switch (token.name) {
    case 'LOCATION': {
      const id = textArgs[0] as LocationPreferenceId;
      const path = ctx.locations[id];
      if (!path) throw new ScriptError(`Location ${id} is not set up`);
      return path;
    }
    case 'QUESTION': {
      const v = ctx.answers[textArgs[0]!];
      return v === undefined || v === null ? '' : v;
    }
    case 'RANDOM_STRING':
      return randomString(Number(textArgs[0]));
    case 'MEMORY': {
      const pct = Number(textArgs[0]);
      const min = Number(textArgs[1] ?? 0);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new ScriptError(`Invalid $MEMORY percentage ${textArgs[0]}`);
      return Math.max(Math.floor(((ctx.memoryBytes / 1024 ** 2) * pct) / 100), Number.isFinite(min) ? min : 0);
    }
    case 'CPUS':
      return Math.max(1, Math.min(Number(textArgs[0]) || 1, ctx.cpus));
    case 'HOST_PATH':
      return { type: 'host_path', host_path_config: { path: textArgs[0], acl_enable: false } };
    case 'MOUNTED_HOST_PATH':
      return { type: 'host_path', host_path_config: { path: textArgs[0], acl_enable: false }, mount_path: textArgs[1], read_only: false };
    case 'IF':
      return evaluateCondition(textArgs[0] ?? '') ? (args[1] ?? '') : (args[2] ?? '');
    case 'APP_INSTALLED':
      return ctx.installedApps.has((textArgs[0] ?? '').toLowerCase()) ? 'true' : 'false';
    case 'SERVER_LAN_IP':
      return ctx.lanIp;
    case 'TIMEZONE':
      return ctx.timezone;
    default:
      return `$${token.name}${token.args ? `(${token.args.join(', ')})` : ''}`;
  }
}

/** Expands macros in a string. A string that is exactly one macro keeps the macro's type (number/object). */
export function expandString(input: string, ctx: MacroContext): MacroValue {
  const first = nextMacro(input, 0);
  if (!first) return input;
  if (first.start === 0 && first.end === input.length) return expandMacro(first, ctx);
  let out = '';
  let pos = 0;
  for (let token: Token | null = first; token; token = nextMacro(input, pos)) {
    out += input.slice(pos, token.start) + asText(expandMacro(token, ctx));
    pos = token.end;
  }
  return out + input.slice(pos);
}

/** Expands macros throughout a JSON value. Empty strings produced inside arrays (false `$IF`s) are dropped. */
export function expandValue(value: unknown, ctx: MacroContext): unknown {
  if (typeof value === 'string') return expandString(value, ctx);
  if (Array.isArray(value)) {
    return value.map((v) => ({ raw: v, out: expandValue(v, ctx) })).filter(({ raw, out }) => !(typeof raw === 'string' && out === '')).map(({ out }) => out);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandValue(v, ctx)]));
  }
  return value;
}

export interface ParsedSpec {
  kind: 'cores' | 'ram' | 'size' | 'gpu';
  /** cores, or bytes for ram/size */
  value: number;
  label: string;
}

export function parseSpec(spec: string): ParsedSpec {
  if (spec === 'GPU') return { kind: 'gpu', value: 1, label: 'Graphics card (GPU)' };
  const m = /^(\d+(?:\.\d+)?)(CORE|GBRAM|MBRAM|GB|MB)$/.exec(spec);
  if (!m) throw new ScriptError(`Invalid specification "${spec}"`);
  const n = Number(m[1]);
  switch (m[2]) {
    case 'CORE':
      return { kind: 'cores', value: n, label: `${n} CPU ${n === 1 ? 'thread' : 'threads'}` };
    case 'GBRAM':
      return { kind: 'ram', value: n * 1024 ** 3, label: `${n} GB memory` };
    case 'MBRAM':
      return { kind: 'ram', value: n * 1024 ** 2, label: `${n} MB memory` };
    case 'GB':
      return { kind: 'size', value: n * 1000 ** 3, label: `About ${n} GB to install` };
    default:
      return { kind: 'size', value: n * 1000 ** 2, label: `About ${n} MB to install` };
  }
}

/** Static checks for a script; returns a list of problems (empty when valid). */
export function validateScript(script: unknown): string[] {
  const problems: string[] = [];
  const s = script as Partial<InstallScript>;
  if (!s || typeof s !== 'object') return ['Script is not a JSON object'];
  if (s.version !== 4) problems.push(`Unsupported version ${String(s.version)} (expected 4)`);
  if (!s.script?.version || !/^\d+\.\d+\.\d+/.test(s.script.version)) problems.push('script.version must be a semver string');
  if (!s.requirements) problems.push('requirements is required');
  if (!s.app_values || typeof s.app_values !== 'object') problems.push('app_values is required');
  const req = s.requirements;
  for (const loc of req?.locations ?? []) if (!SCRIPT_LOCATIONS.includes(loc)) problems.push(`Unknown location ${loc}`);
  for (const spec of req?.specifications ?? []) {
    try {
      parseSpec(spec);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  for (const port of req?.ports ?? []) if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`Invalid port ${port}`);

  const questionKeys = new Set((s.installation_questions ?? []).map((q) => q.key));
  for (const q of s.installation_questions ?? []) {
    if (!q.key || !q.question) problems.push('Every question needs a key and a question');
    if (!['text', 'number', 'select', 'boolean', 'password'].includes(q.type)) problems.push(`Question ${q.key}: invalid type ${q.type}`);
    if (q.type === 'select' && !q.options?.length) problems.push(`Question ${q.key}: select needs options`);
  }

  const body = JSON.stringify([s.ensure_directories_exists ?? [], s.app_values ?? {}, (s.installation_questions ?? []).map((q) => q.default)]);
  for (const m of body.matchAll(/\$([A-Z_]+)(?:\(([^()]*)\))?/g)) {
    const [, name, arg] = m;
    if (!KNOWN_MACROS.has(name!)) problems.push(`Unknown macro $${name}`);
    if (name === 'QUESTION' && arg && !questionKeys.has(arg.trim())) problems.push(`$QUESTION(${arg}) has no matching question`);
    if (name === 'LOCATION' && arg && !(req?.locations ?? []).includes(arg.trim() as LocationPreferenceId)) {
      problems.push(`$LOCATION(${arg}) is not listed in requirements.locations`);
    }
  }
  for (const dir of s.ensure_directories_exists ?? []) {
    if (!/^\$LOCATION\([A-Za-z]+\)\/.+/.test(dir.path)) problems.push(`Directory ${dir.path} must be a subfolder of a $LOCATION(...)`);
  }
  return [...new Set(problems)];
}

/** Questions as shown to the user, with `$RANDOM_STRING` defaults generated. */
export function presentQuestions(script: InstallScript): InstallQuestion[] {
  return (script.installation_questions ?? []).map((q) => {
    const def = q.default;
    const generated = typeof def === 'string' && /^\$RANDOM_STRING\(\d+\)$/.test(def) ? randomString(Number(def.match(/\d+/)![0])) : def;
    return { ...q, default: generated, ...(generated !== def ? { generated: true } : {}) };
  });
}

/** Fills defaults, enforces required answers and coerces types. */
export function resolveAnswers(script: InstallScript, given: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const answers: Record<string, string | number | boolean> = {};
  for (const q of presentQuestions(script)) {
    let v = given[q.key];
    if (v === undefined || v === '') v = q.default ?? '';
    if (q.type === 'number' && v !== '') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new ScriptError(`"${q.question}" must be a number`);
      v = n;
    }
    if (q.type === 'boolean') v = v === true || v === 'true';
    if (q.type === 'select' && v !== '' && !q.options?.some((o) => String(o.value) === String(v))) {
      throw new ScriptError(`"${q.question}" must be one of the listed options`);
    }
    if (q.required && (v === '' || v === undefined)) throw new ScriptError(`"${q.question}" is required`);
    answers[q.key] = v;
  }
  return answers;
}

/** Loads every `<app>.json` script in a directory, skipping (and reporting) invalid ones. */
export async function loadScripts(dir: string): Promise<{ scripts: Map<string, InstallScript>; errors: Record<string, string[]> }> {
  const scripts = new Map<string, InstallScript>();
  const errors: Record<string, string[]> = {};
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    return { scripts, errors };
  }
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    try {
      const parsed = JSON.parse(await readFile(join(dir, file), 'utf8'));
      const problems = validateScript(parsed);
      if (problems.length) errors[id] = problems;
      else scripts.set(id, parsed as InstallScript);
    } catch (err) {
      errors[id] = [`Invalid JSON: ${(err as Error).message}`];
    }
  }
  return { scripts, errors };
}
