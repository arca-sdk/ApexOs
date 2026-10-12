import { reactive } from 'vue';
import type { InstalledApp, Task, TaskStarted } from '@hearth/api-types';
import { ApiError, api, runTask } from '../../lib/api.ts';
import { live } from '../../lib/events.ts';

const CATEGORY_LABELS: Record<string, string> = {
  media: 'Media',
  productivity: 'Productivity',
  storage: 'Files & sync',
  networking: 'Networking',
  security: 'Security',
  monitoring: 'Monitoring',
  financial: 'Finance',
  'home-automation': 'Smart home',
  games: 'Games',
  development: 'Development',
  ai: 'AI',
};

/** Friendly label for a TrueNAS catalog category slug. */
export function categoryLabel(slug: string): string {
  if (CATEGORY_LABELS[slug]) return CATEGORY_LABELS[slug];
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const APP_TASK_LABELS: Record<string, string> = {
  'app-start': 'Starting…',
  'app-stop': 'Stopping…',
  'app-upgrade': 'Updating…',
  'app-uninstall': 'Uninstalling…',
  'app-upgrade-all': 'Updating…',
};

/** The running server task acting on this app, if any (start/stop/update/uninstall, or "update all"). */
export function appTask(app: Pick<InstalledApp, 'name' | 'upgradeAvailable'>): { task: Task; label: string } | null {
  for (const t of Object.values(live.tasks)) {
    if (t.status !== 'running') continue;
    if (t.ref === app.name && t.type in APP_TASK_LABELS && t.type !== 'app-upgrade-all') return { task: t, label: APP_TASK_LABELS[t.type]! };
    if (t.type === 'app-upgrade-all' && app.upgradeAvailable) return { task: t, label: APP_TASK_LABELS[t.type]! };
  }
  return null;
}

/**
 * The app's own version for display. TrueNAS reports a combined "<app>_<package>" version
 * (e.g. "10.10.7_1.3.16"); the package part is dropped when it matches.
 */
export function displayVersion(app: Pick<InstalledApp, 'appVersion' | 'version'>): string {
  const suffix = `_${app.version}`;
  return app.appVersion.endsWith(suffix) && app.appVersion.length > suffix.length ? app.appVersion.slice(0, -suffix.length) : app.appVersion;
}

/** "10.10.6 → 10.10.7" when the app's own version changes, else the TrueNAS catalog versions. */
export function updateLabel(app: Pick<InstalledApp, 'appVersion' | 'version' | 'latestVersion' | 'latestAppVersion'>): string {
  const current = displayVersion(app);
  if (app.latestAppVersion && app.latestAppVersion !== current) return `${current} → ${app.latestAppVersion}`;
  return `${app.version} → ${app.latestVersion ?? 'latest'}`;
}

export function upgradeAllRunning(): boolean {
  return Object.values(live.tasks).some((t) => t.status === 'running' && t.type === 'app-upgrade-all');
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Lifecycle actions for installed apps. Errors are kept per app name ('*' for "update all"). */
export function useAppActions() {
  const errors = reactive<Record<string, string>>({});

  async function run(key: string, start: () => Promise<TaskStarted>): Promise<boolean> {
    delete errors[key];
    try {
      await runTask(start());
      return true;
    } catch (e) {
      errors[key] = errorText(e);
      return false;
    }
  }

  const path = (name: string) => `/apps/${encodeURIComponent(name)}`;

  return {
    errors,
    start: (name: string) => run(name, () => api.post<TaskStarted>(`${path(name)}/start`)),
    stop: (name: string) => run(name, () => api.post<TaskStarted>(`${path(name)}/stop`)),
    upgrade: (name: string) => run(name, () => api.post<TaskStarted>(`${path(name)}/upgrade`)),
    upgradeAll: () => run('*', () => api.post<TaskStarted>('/apps/upgrade-all')),
    uninstall: (name: string, removeData: boolean) => run(name, () => api.del<TaskStarted>(path(name), { removeData })),
    clearError: (key: string) => delete errors[key],
  };
}
