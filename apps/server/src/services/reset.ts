/**
 * "Erase everything and start over": removes what ApexOs set up on TrueNAS (backups, apps, the traffic
 * forwarding Tailscale needed, network-share users, every data pool) and resets ApexOs's own state so the
 * setup wizard runs again. The ApexOs account, its sign-in security and the TrueNAS connection stay.
 */
import { hostname } from 'node:os';
import type { ResetPreview } from '@apexos/api-types';
import type { TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { errorMessage, type Task } from '../lib/tasks.ts';
import type { TnApp, TnUser } from '../truenas/types.ts';
import { invalidateCatalog } from './apps.ts';
import { forgetProbes, removeDestination } from './backups.ts';
import { forgetPoolDataLoss } from './drive-health.ts';
import { addNotice } from './notifications.ts';
import { forgetChecks } from './pool-checks.ts';
import { forgetPoolErrorState } from './pool-errors.ts';
import { undoIpForwarding } from './remote-access.ts';
import { invalidateImportable } from './setup.ts';
import { getStorage } from './storage.ts';
import { isShareUser, readUsers } from './users.ts';

const STEPS = ['Removing backups', 'Removing apps', 'Turning off traffic forwarding', 'Removing users', 'Erasing pools', 'Resetting ApexOs'];
/** Accounts other ApexOs servers use to send their backups here. */
const BACKUP_RECEIVER_PREFIX = 'apexosbk_';

function confirmText(ctx: AppContext): string {
  return ctx.store.get().server.name ?? 'erase everything';
}

/**
 * The TrueNAS app ApexOs itself runs in, if any. Docker names a container's host after the container's ID, so
 * a hostname that starts one of an app's container IDs means erasing apps (and pools) would erase ApexOs.
 */
async function ownApp(client: TrueNasClient, apps: TnApp[]): Promise<TnApp | null> {
  const host = hostname();
  if (!/^[0-9a-f]{12,64}$/.test(host)) return null;
  for (const app of apps) {
    const ids = await client.call<Record<string, unknown>>('app.container_ids', [app.name, { alive_only: false }]).catch(() => ({}));
    if (Object.keys(ids).some((id) => id.startsWith(host))) return app;
  }
  return null;
}

function usersToRemove(users: TnUser[], dir: Awaited<ReturnType<typeof readUsers>>): TnUser[] {
  return users.filter((u) => isShareUser(u, dir) || u.username.startsWith(BACKUP_RECEIVER_PREFIX));
}

export async function previewReset(ctx: AppContext): Promise<ResetPreview> {
  const client = ctx.truenas.client();
  const [storage, apps, dir] = await Promise.all([getStorage(ctx), client.call<TnApp[]>('app.query').catch(() => [] as TnApp[]), readUsers(client)]);
  const blockers: ResetPreview['blockers'] = [];
  const running = ctx.tasks.list().find((t) => t.status === 'running');
  if (running) blockers.push({ code: 'BUSY', message: `Wait until “${running.title}” has finished.` });
  if ((ctx.store.get().folderMoves ?? []).some((m) => m.status !== 'done')) {
    blockers.push({ code: 'BUSY', message: 'A folder move hasn’t finished. Wait for it (see Settings → Locations).' });
  }
  const self = await ownApp(client, apps);
  if (self) {
    blockers.push({
      code: 'SELF',
      message: `ApexOs itself runs as the app “${self.metadata?.title ?? self.name}” on this server, so erasing everything would erase ApexOs too. Run ApexOs on another computer first, or reset the server from TrueNAS.`,
    });
  }
  const remove = usersToRemove(dir.users, dir);
  return {
    confirmText: confirmText(ctx),
    needsCode: Boolean(ctx.store.get().security.twoFactor),
    pools: storage.pools.map((p) => ({ name: p.name, displayName: p.displayName, usedBytes: p.usedBytes })),
    apps: apps.map((a) => a.metadata?.title ?? a.name).sort((a, b) => a.localeCompare(b)),
    users: remove.filter((u) => !u.username.startsWith(BACKUP_RECEIVER_PREFIX)).map((u) => u.username),
    backups: ctx.store.get().backups.destinations.map((d) => d.name),
    hostsBackups: remove.some((u) => u.username.startsWith(BACKUP_RECEIVER_PREFIX)),
    blockers,
  };
}

/** Checked before the password, so a typo here doesn't count as a failed sign-in attempt. */
export function checkResetConfirm(ctx: AppContext, confirm: string): void {
  if (confirm.trim() !== confirmText(ctx)) {
    throw new UserError(`Type ${confirmText(ctx)} exactly to confirm.`, 400, 'VALIDATION', { confirm: 'Does not match' });
  }
}

/** Starts the reset; the owner was confirmed (password and code) by the caller. */
export async function startReset(ctx: AppContext, confirm: string): Promise<Task> {
  checkResetConfirm(ctx, confirm);
  const preview = await previewReset(ctx);
  if (preview.blockers.length) throw new UserError(preview.blockers.map((b) => b.message).join(' '), 409, 'CANNOT_RESET');
  if (ctx.tasks.list().some((t) => t.status === 'running')) throw new UserError('Something else just started. Wait until it has finished.', 409, 'BUSY');

  return ctx.tasks.start({ type: 'factory-reset', title: 'Erasing everything', steps: STEPS }, async (t) => {
    const client = ctx.truenas.client();
    // A reset goes on past problems: what's left over is reported at the end.
    const warnings: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        warnings.push(`${what}: ${errorMessage(err)}`);
      }
    };

    await t.step('Removing backups', async () => {
      for (const d of [...ctx.store.get().backups.destinations]) {
        await attempt(`Backups to ${d.name}`, () => removeDestination(ctx, d.id, (_name, fn) => fn(() => undefined)));
      }
    });

    await t.step('Removing apps', async (report) => {
      const apps = await client.call<TnApp[]>('app.query').catch(() => [] as TnApp[]);
      for (const [i, app] of apps.entries()) {
        await attempt(app.metadata?.title ?? app.name, () => client.job('app.delete', [app.name, { remove_images: true, remove_ix_volumes: true }]));
        report(((i + 1) / apps.length) * 100);
      }
      invalidateCatalog();
    });

    const forwarding = ctx.store.get().remoteAccess.tailscale?.ipForwarding;
    if (forwarding) await t.step('Turning off traffic forwarding', () => attempt('Traffic forwarding', () => undoIpForwarding(client, forwarding)));
    else t.skip('Turning off traffic forwarding', 'Not turned on');

    await t.step('Removing users', async () => {
      const dir = await readUsers(client);
      for (const u of usersToRemove(dir.users, dir)) await attempt(`User ${u.username}`, () => client.call('user.delete', [u.id, { delete_group: true }]));
    });

    await t.step('Erasing pools', async (report) => {
      const pools = (await getStorage(ctx)).pools;
      for (const [i, pool] of pools.entries()) {
        await attempt(`Pool ${pool.displayName}`, () => client.job('pool.export', [pool.id, { cascade: true, restart_services: true, destroy: true }]));
        report(((i + 1) / pools.length) * 100);
      }
      invalidateImportable();
    });

    await t.step('Resetting ApexOs', async () => {
      await ctx.store.update((s) => {
        // Kept: the account, sign-in security, the TrueNAS connection, the server's name, drive history,
        // and backup clean-ups still owed to servers that were offline.
        delete s.server.setupCompletedAt;
        s.preferences = { locations: {} };
        s.poolNames = {};
        s.apps = {};
        s.notices = [];
        s.remoteAccess = { tailscale: null, cloudflare: null };
        delete s.encryption;
        delete s.oldAppData;
        delete s.folderMoves;
        s.backups = { ...s.backups, destinations: [], jobs: [] };
      });
      await forgetPoolDataLoss(ctx);
      forgetProbes();
      forgetChecks();
      forgetPoolErrorState();
    });

    if (warnings.length) {
      await addNotice(ctx, {
        level: 'warning',
        title: 'Some things couldn’t be removed',
        message: `${warnings.join('; ')}. You can remove them in TrueNAS.`,
        link: null,
      }).catch(() => undefined);
    }
    for (const topic of ['storage', 'folders', 'users', 'apps', 'backups', 'locations', 'alerts'] as const) ctx.bus.changed(topic);
  });
}
