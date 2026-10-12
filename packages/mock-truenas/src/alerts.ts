import type { Mock } from './context.ts';
import { callError } from './rpc.ts';
import type { AlertState } from './state.ts';
import { catalogApp } from './state.ts';
import { diskById, poolHealth, poolLeaves } from './storage.ts';
import { $date, compareVersions, nameArg, uuid, type Obj } from './util.ts';

interface AlertClass {
  level: AlertState['level'];
  title: string;
  text: string;
  category: string;
  oneShot?: boolean;
}

export const ALERT_CLASSES: Record<string, AlertClass> = {
  VolumeStatus: { level: 'CRITICAL', title: 'Pool Status Is Not Healthy', text: 'Pool %(volume)s state is %(state)s: %(status)s', category: 'STORAGE' },
  PoolUSBDisks: {
    level: 'WARNING',
    title: 'Pool Consists of USB Disks',
    text: 'Pool %r consists of disks connected via USB (%s). USB-connected disks are not recommended for storage pools.',
    category: 'STORAGE',
  },
  ScrubStarted: { level: 'INFO', title: 'Scrub Started', text: 'Scrub of pool %r started.', category: 'STORAGE', oneShot: true },
  ScrubFinished: { level: 'INFO', title: 'Scrub Finished', text: 'Scrub of pool %r finished.', category: 'STORAGE', oneShot: true },
  DiskTemperatureTooHot: {
    level: 'CRITICAL',
    title: 'Disk Temperature Is Too Hot',
    text: 'Disk %(disk)s temperature is %(temperature)s°C which exceeds the critical threshold of %(critical)s°C.',
    category: 'HARDWARE',
  },
  MemoryErrors: {
    level: 'WARNING',
    title: 'Uncorrected Memory Errors Detected',
    text: '%(count)s total uncorrected errors detected for %(loc)s.',
    category: 'HARDWARE',
  },
  HasUpdate: {
    level: 'INFO',
    title: 'Update Available',
    text: 'A system update is available. Go to System Settings → Update to download and apply the update.',
    category: 'SYSTEM',
  },
  AppUpdate: { level: 'INFO', title: 'Application Update Available', text: 'An update is available for "%(name)s" application.', category: 'APPLICATIONS' },
  NTPHealthCheck: { level: 'WARNING', title: 'NTP Health Check Failed', text: 'NTP health check failed - %(reason)s', category: 'SYSTEM' },
};

function pyRepr(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

/** Renders Python %-style alert text (`%(name)s`, `%(name)r`, `%s`, `%r`). */
export function formatAlert(text: string, args: unknown): string {
  if (Array.isArray(args)) {
    let i = 0;
    return text.replace(/%([sr])/g, (_, k: string) => {
      const v = args[i++];
      return k === 'r' ? pyRepr(v) : String(v);
    });
  }
  const obj = (args ?? {}) as Obj;
  return text
    .replace(/%\((\w+)\)([sr])/g, (_, name: string, k: string) => (k === 'r' ? pyRepr(obj[name]) : String(obj[name])))
    .replace(/%([sr])/g, (_, k: string) => (k === 'r' ? pyRepr(args) : String(args)));
}

export function renderAlert(a: AlertState): Obj {
  return {
    uuid: a.uuid,
    source: a.source,
    klass: a.klass,
    args: a.args,
    node: 'Controller A',
    key: a.key,
    datetime: $date(a.datetime),
    last_occurrence: $date(a.last_occurrence),
    dismissed: a.dismissed,
    mail: null,
    text: a.text,
    id: a.uuid,
    level: a.level,
    formatted: a.formatted,
    one_shot: a.one_shot,
  };
}

export function raiseAlert(mock: Mock, klass: string, args: unknown, keyParts?: unknown): AlertState {
  const cls = ALERT_CLASSES[klass];
  if (!cls) throw new Error(`Unknown alert class ${klass}`);
  const key = JSON.stringify(keyParts ?? args);
  const formatted = formatAlert(cls.text, args);
  const now = Date.now();
  const existing = mock.state.alerts.find((a) => a.klass === klass && a.key === key);
  if (existing) {
    if (existing.formatted === formatted) return existing;
    existing.args = args;
    existing.formatted = formatted;
    existing.last_occurrence = now;
    mock.emit('alert.list', 'changed', existing.uuid, renderAlert(existing));
    return existing;
  }
  const alert: AlertState = {
    uuid: uuid(),
    klass,
    source: klass,
    level: cls.level,
    args,
    key,
    text: cls.text,
    formatted,
    datetime: now,
    last_occurrence: now,
    dismissed: false,
    one_shot: cls.oneShot ?? false,
  };
  mock.state.alerts.push(alert);
  mock.emit('alert.list', 'added', alert.uuid, renderAlert(alert));
  return alert;
}

/** Clears alerts of a class (optionally only the one with the given key parts). */
export function clearAlert(mock: Mock, klass: string, keyParts?: unknown): void {
  const key = keyParts === undefined ? undefined : JSON.stringify(keyParts);
  mock.state.alerts = mock.state.alerts.filter((a) => {
    if (a.klass !== klass || (key !== undefined && a.key !== key)) return true;
    mock.emit('alert.list', 'removed', a.uuid);
    return false;
  });
}

export function syncPoolAlerts(mock: Mock): void {
  const { state } = mock;
  const names = new Set(state.pools.map((p) => p.name));
  for (const a of [...state.alerts]) {
    if ((a.klass === 'VolumeStatus' || a.klass === 'PoolUSBDisks') && !names.has(JSON.parse(a.key)[0])) {
      clearAlert(mock, a.klass, JSON.parse(a.key));
    }
  }
  for (const pool of state.pools) {
    const h = poolHealth(pool);
    if (h.status === 'ONLINE') clearAlert(mock, 'VolumeStatus', [pool.name]);
    else raiseAlert(mock, 'VolumeStatus', { volume: pool.name, state: h.status, status: h.summary }, [pool.name]);
    const usb = [...poolLeaves(pool)]
      .map((r) => diskById(state, r.leaf.disk))
      .filter((d) => d?.bus === 'USB')
      .map((d) => d!.name);
    if (usb.length) raiseAlert(mock, 'PoolUSBDisks', [pool.name, usb.join(', ')], [pool.name]);
    else clearAlert(mock, 'PoolUSBDisks', [pool.name]);
  }
}

export function syncAppAlerts(mock: Mock): void {
  const { state } = mock;
  const outdated = new Set<string>();
  if (state.docker.pool) {
    for (const app of state.apps) {
      if (app.custom_app || app.pool !== state.docker.pool || !app.catalog_app) continue;
      const cat = catalogApp(app.catalog_app, app.train);
      if (cat && compareVersions(app.version, cat.latest_version) < 0) outdated.add(app.name);
    }
  }
  for (const a of [...state.alerts]) {
    if (a.klass === 'AppUpdate' && !outdated.has((a.args as Obj).name as string)) clearAlert(mock, 'AppUpdate', [(a.args as Obj).name]);
  }
  for (const name of outdated) raiseAlert(mock, 'AppUpdate', { name }, [name]);
}

export function syncUpdateAlert(mock: Mock): void {
  if (mock.state.system.update.available) raiseAlert(mock, 'HasUpdate', null, ['HasUpdate']);
  else clearAlert(mock, 'HasUpdate');
}

export function syncAllAlerts(mock: Mock): void {
  syncPoolAlerts(mock);
  syncAppAlerts(mock);
  syncUpdateAlert(mock);
}

export function registerAlerts(mock: Mock): void {
  const { server } = mock;
  server.method('alert.list', () => mock.state.alerts.map(renderAlert));
  const setDismissed = (uuidArg: unknown, dismissed: boolean) => {
    const id = nameArg(uuidArg, 'uuid');
    const alert = mock.state.alerts.find((a) => a.uuid === id);
    if (!alert) throw callError('ENOENT', `Alert ${id} not found`);
    if (dismissed && alert.one_shot) {
      mock.state.alerts = mock.state.alerts.filter((a) => a !== alert);
      mock.emit('alert.list', 'removed', alert.uuid);
      return null;
    }
    alert.dismissed = dismissed;
    mock.emit('alert.list', 'changed', alert.uuid, renderAlert(alert));
    return null;
  };
  server.method('alert.dismiss', (p) => setDismissed(p[0], true));
  server.method('alert.restore', (p) => setDismissed(p[0], false));
  server.method('alert.list_policies', () => ['IMMEDIATELY', 'HOURLY', 'DAILY', 'NEVER']);
  server.method('alert.list_categories', () => {
    const cats = new Map<string, Obj[]>();
    for (const [id, c] of Object.entries(ALERT_CLASSES)) {
      const list = cats.get(c.category) ?? [];
      list.push({ id, title: c.title, level: c.level, proactive_support: false });
      cats.set(c.category, list);
    }
    const titles: Record<string, string> = { STORAGE: 'Storage', HARDWARE: 'Hardware', SYSTEM: 'System', APPLICATIONS: 'Applications' };
    return [...cats].map(([id, classes]) => ({ id, title: titles[id] ?? id, classes }));
  });
  const classConfig = { id: 1, classes: {} as Obj };
  server.method('alertclasses.config', () => classConfig);
  server.method('alertclasses.update', (p) => {
    const data = (p[0] ?? {}) as Obj;
    if (data.classes && typeof data.classes === 'object') classConfig.classes = data.classes as Obj;
    return classConfig;
  });
}
