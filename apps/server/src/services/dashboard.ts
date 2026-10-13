import type { DashboardResponse } from '@apexos/api-types';
import type { AppContext } from '../app.ts';
import { listInstalled } from './apps.ts';
import { listNotices } from './notifications.ts';
import { withDataErrors } from './pool-errors.ts';
import { getStorage } from './storage.ts';
import { getSystemSummary, getUpdateInfo } from './system.ts';

/** The update banner is optional: the dashboard doesn't wait longer than this for TrueNAS's update check. */
export const dashboardTimings = { updateWaitMs: 2_000 };

export async function getDashboard(ctx: AppContext): Promise<DashboardResponse> {
  const storage = await withDataErrors(ctx, await getStorage(ctx));
  const [system, apps, update, notices] = await Promise.all([
    getSystemSummary(ctx),
    listInstalled(ctx).catch(() => ({ apps: [] })),
    getUpdateInfo(ctx, storage, { waitMs: dashboardTimings.updateWaitMs }).catch(() => null),
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
