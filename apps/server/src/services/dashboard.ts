import type { DashboardResponse } from '@hearth/api-types';
import type { AppContext } from '../app.ts';
import { listInstalled } from './apps.ts';
import { listNotices } from './notifications.ts';
import { getStorage } from './storage.ts';
import { getSystemSummary, getUpdateInfo } from './system.ts';

export async function getDashboard(ctx: AppContext): Promise<DashboardResponse> {
  const storage = await getStorage(ctx);
  const [system, apps, update, notices] = await Promise.all([
    getSystemSummary(ctx),
    listInstalled(ctx).catch(() => ({ apps: [] })),
    getUpdateInfo(ctx, storage).catch(() => null),
    listNotices(ctx),
  ]);
  return {
    system,
    pools: storage.pools,
    apps: apps.apps,
    update,
    unreadNotifications: notices.filter((n) => !n.dismissed).length,
  };
}
