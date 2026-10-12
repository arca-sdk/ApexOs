import { randomUUID } from 'node:crypto';
import type { Notice, NoticeLevel } from '@apexos/api-types';
import type { AppContext } from '../app.ts';
import type { ApexOsNotice } from '../lib/store.ts';
import type { Task } from '../lib/tasks.ts';
import { dateToIso } from '../truenas/helpers.ts';
import type { TnAlert } from '../truenas/types.ts';

const MAX_APEXOS_NOTICES = 100;

/** Plain-language titles for common TrueNAS alert classes. */
const ALERT_TITLES: Record<string, { title: string; link: string | null }> = {
  VolumeStatus: { title: 'A storage pool needs attention', link: '/storage' },
  ZpoolCapacityWarning: { title: 'A storage pool is getting full', link: '/storage' },
  ZpoolCapacityCritical: { title: 'A storage pool is almost full', link: '/storage' },
  ZpoolCapacityNotice: { title: 'A storage pool is filling up', link: '/storage' },
  SMARTFailedSelfTest: { title: 'A drive failed its self-test', link: '/storage' },
  SMARTUncorrectedErrors: { title: 'A drive reported read errors', link: '/storage' },
  SMARTSpareBlockCount: { title: 'An SSD is wearing out', link: '/storage' },
  SMARTEraseCycleCount: { title: 'An SSD is wearing out', link: '/storage' },
  ScrubPaused: { title: 'A pool check is paused', link: '/storage' },
  PoolUpgraded: { title: 'A pool can be upgraded', link: '/storage' },
  AppUpdate: { title: 'App update available', link: '/apps' },
  HasUpdate: { title: 'TrueNAS update available', link: '/settings' },
  QuotaWarning: { title: 'A folder is near its storage limit', link: '/folders' },
  QuotaCritical: { title: 'A folder reached its storage limit', link: '/folders' },
  ApiKeyRevoked: { title: 'An API key was revoked', link: '/settings' },
  NTPHealthCheck: { title: 'The server clock may be wrong', link: '/settings' },
  DockerImageUpdate: { title: 'App image update available', link: '/apps' },
  FailoverUnavailable: { title: 'Failover is unavailable', link: null },
  MemoryErrors: { title: 'The server reported memory errors', link: null },
};

function levelOf(level: TnAlert['level']): NoticeLevel {
  switch (level) {
    case 'INFO':
    case 'NOTICE':
      return 'info';
    case 'WARNING':
      return 'warning';
    case 'ERROR':
      return 'error';
    default:
      return 'critical';
  }
}

function humanize(klass: string): string {
  const words = klass.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fromAlert(alert: TnAlert): Notice {
  const known = ALERT_TITLES[alert.klass];
  return {
    id: `truenas:${alert.uuid}`,
    source: 'truenas',
    level: levelOf(alert.level),
    title: known?.title ?? humanize(alert.klass),
    message: alert.formatted ?? alert.text,
    time: dateToIso(alert.last_occurrence ?? alert.datetime) ?? new Date().toISOString(),
    dismissed: alert.dismissed,
    link: known?.link ?? null,
  };
}

export async function listNotices(ctx: AppContext): Promise<Notice[]> {
  const alerts = ctx.truenas.connected ? await ctx.truenas.client().call<TnAlert[]>('alert.list').catch(() => [] as TnAlert[]) : [];
  const own: Notice[] = ctx.store.get().notices.map((n) => ({ ...n, source: 'apexos' as const }));
  return [...alerts.map(fromAlert), ...own].sort((a, b) => b.time.localeCompare(a.time));
}

export async function addNotice(ctx: AppContext, notice: Omit<ApexOsNotice, 'id' | 'time' | 'dismissed'>): Promise<void> {
  await ctx.store.update((s) => {
    s.notices.unshift({ ...notice, id: `apexos:${randomUUID()}`, time: new Date().toISOString(), dismissed: false });
    s.notices = s.notices.slice(0, MAX_APEXOS_NOTICES);
  });
  ctx.bus.changed('alerts');
}

export async function dismissNotice(ctx: AppContext, id: string): Promise<void> {
  if (id.startsWith('truenas:')) {
    await ctx.truenas.client().call('alert.dismiss', [id.slice('truenas:'.length)]);
  } else {
    await ctx.store.update((s) => {
      const n = s.notices.find((x) => x.id === id);
      if (n) n.dismissed = true;
    });
  }
  ctx.bus.changed('alerts');
}

export async function dismissAll(ctx: AppContext): Promise<void> {
  for (const n of await listNotices(ctx)) if (!n.dismissed) await dismissNotice(ctx, n.id).catch(() => undefined);
}

const TASK_NOTICES: Record<string, { done: (ref: string) => string; link: string }> = {
  'app-install': { done: (r) => `${r} installed`, link: '/apps' },
  'app-uninstall': { done: (r) => `${r} uninstalled`, link: '/apps' },
  'app-upgrade': { done: (r) => `${r} updated`, link: '/apps' },
  'app-upgrade-all': { done: () => 'Apps updated', link: '/apps' },
  'folder-create': { done: (r) => `Folder ${r} created`, link: '/folders' },
  'folder-update': { done: (r) => `Folder ${r} updated`, link: '/folders' },
  'folder-delete': { done: (r) => `Folder ${r} deleted`, link: '/folders' },
  'pool-create': { done: (r) => `Pool ${r} created`, link: '/storage' },
  'pool-delete': { done: (r) => `Pool ${r} erased`, link: '/storage' },
  'pool-expand': { done: (r) => `A drive was added to ${r}`, link: '/storage' },
  'pool-replace': { done: (r) => `Drive replaced in ${r}`, link: '/storage' },
  'pool-spare': { done: (r) => `Spare added to ${r}`, link: '/storage' },
  'pool-import': { done: (r) => `Pool ${r} imported`, link: '/storage' },
  'pool-repair': { done: (r) => `${r} repaired`, link: '/storage' },
  setup: { done: () => 'Your server is ready', link: '/' },
  'system-update': { done: () => 'TrueNAS update installed', link: '/settings' },
  'remote-enable': { done: (r) => `${r} is on`, link: '/remote' },
  'remote-disable': { done: (r) => `${r} is off`, link: '/remote' },
};

/** Records a notice whenever a task finishes, so results are visible after the toast is gone. */
export function recordTaskNotices(ctx: AppContext): void {
  ctx.tasks.on('task', (task: Task) => {
    if (task.status === 'running') return;
    const kind = TASK_NOTICES[task.type];
    if (!kind) return;
    const failed = task.status === 'failed';
    void addNotice(ctx, {
      level: failed ? 'error' : 'info',
      title: failed ? `${task.title} failed` : kind.done(task.ref ?? ''),
      message: failed ? (task.error ?? 'Something went wrong.') : 'Finished successfully.',
      link: kind.link,
    }).catch(() => undefined);
  });
}
