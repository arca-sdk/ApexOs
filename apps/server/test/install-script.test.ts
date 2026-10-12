import { describe, expect, it } from 'vitest';
import {
  evaluateCondition,
  expandString,
  expandValue,
  parseSpec,
  resolveAnswers,
  validateScript,
  type InstallScript,
  type MacroContext,
} from '../src/lib/install-script.ts';

const ctx: MacroContext = {
  locations: { ApplicationsPerformance: '/mnt/SSDs/Applications', Movies: '/mnt/HDDs/Media/Movies' } as MacroContext['locations'],
  answers: { name: 'den', enable: true, port: 8096 },
  memoryBytes: 32 * 1024 ** 3,
  cpus: 12,
  installedApps: new Set(['jellyfin']),
  lanIp: '192.168.1.20',
  timezone: 'Europe/Madrid',
};

describe('macro expansion', () => {
  it('expands locations inside strings', () => {
    expect(expandString('$LOCATION(ApplicationsPerformance)/jellyfin/config', ctx)).toBe('/mnt/SSDs/Applications/jellyfin/config');
  });
  it('keeps types when the macro is the whole string', () => {
    expect(expandString('$QUESTION(port)', ctx)).toBe(8096);
    expect(expandString('$MEMORY(10, 4096)', ctx)).toBe(4096);
    expect(expandString('$MEMORY(25, 1024)', ctx)).toBe(8192);
    expect(expandString('$CPUS(32)', ctx)).toBe(12);
    expect(expandString('$HOST_PATH($LOCATION(Movies))', ctx)).toEqual({
      type: 'host_path',
      host_path_config: { path: '/mnt/HDDs/Media/Movies', acl_enable: false },
    });
  });
  it('builds mounted host paths with nested macros', () => {
    expect(expandString('$MOUNTED_HOST_PATH($LOCATION(Movies), /media/movies)', ctx)).toMatchObject({
      mount_path: '/media/movies',
      host_path_config: { path: '/mnt/HDDs/Media/Movies' },
    });
  });
  it('evaluates conditions', () => {
    expect(expandString('$IF($QUESTION(enable) == true, yes, no)', ctx)).toBe('yes');
    expect(expandString('$IF($APP_INSTALLED(plex), yes, no)', ctx)).toBe('no');
    expect(expandString('$IF($APP_INSTALLED(JELLYFIN), yes)', ctx)).toBe('yes');
    expect(evaluateCondition('a == b || x != y')).toBe(true);
    expect(evaluateCondition('!true && true')).toBe(false);
  });
  it('drops empty array items from false conditions', () => {
    expect(expandValue(['a', '$IF(false, b)', 'c'], ctx)).toEqual(['a', 'c']);
  });
  it('generates random strings and server facts', () => {
    expect(expandString('$RANDOM_STRING(24)', ctx)).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(expandString('http://$SERVER_LAN_IP:8096 $TIMEZONE', ctx)).toBe('http://192.168.1.20:8096 Europe/Madrid');
  });
  it('throws for unset locations', () => {
    expect(() => expandString('$LOCATION(Photos)', ctx)).toThrow(/not set up/);
  });
});

describe('specs', () => {
  it('parses the specification grammar', () => {
    expect(parseSpec('2CORE')).toMatchObject({ kind: 'cores', value: 2 });
    expect(parseSpec('4GBRAM')).toMatchObject({ kind: 'ram', value: 4 * 1024 ** 3 });
    expect(parseSpec('500MB')).toMatchObject({ kind: 'size' });
    expect(() => parseSpec('lots')).toThrow();
  });
});

const script: InstallScript = {
  version: 4,
  script: { version: '1.0.0' },
  requirements: { locations: ['ApplicationsPerformance'] as InstallScript['requirements']['locations'], specifications: ['1CORE'], permissions: [], ports: [8096] },
  installation_questions: [
    { key: 'pw', question: 'Password', type: 'password', required: true, default: '$RANDOM_STRING(12)' },
    { key: 'n', question: 'Number', type: 'number', default: 3 },
  ],
  ensure_directories_exists: [{ path: '$LOCATION(ApplicationsPerformance)/x/config' }],
  app_values: { a: '$QUESTION(pw)', b: '$QUESTION(n)' },
};

describe('validateScript', () => {
  it('accepts a valid script', () => {
    expect(validateScript(script)).toEqual([]);
  });
  it('reports unknown macros, questions and locations', () => {
    const bad = { ...script, app_values: { a: '$NOPE(1)', b: '$QUESTION(missing)', c: '$LOCATION(Photos)' } };
    expect(validateScript(bad)).toEqual([
      'Unknown macro $NOPE',
      '$QUESTION(missing) has no matching question',
      '$LOCATION(Photos) is not listed in requirements.locations',
    ]);
  });
});

describe('resolveAnswers', () => {
  it('fills defaults and coerces numbers', () => {
    const answers = resolveAnswers(script, { n: '7' });
    expect(answers.n).toBe(7);
    expect(String(answers.pw)).toMatch(/^[A-Za-z0-9]{12}$/);
  });
});
