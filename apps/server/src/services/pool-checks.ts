/**
 * Remembers the pool checks (scrubs) that ApexOs itself started, so features can tell whether "the last
 * check ApexOs ran finished clean" (needed before resetting error counters or clearing a drive).
 *
 * Kept in memory on purpose: a restart of ApexOs or a reboot of TrueNAS (detected through the boot id)
 * invalidates the result, as the errors may have come back meanwhile.
 */
import type { Pool } from '@apexos/api-types';
import type { AppContext } from '../app.ts';

interface CheckRecord {
  startedAt: number;
  bootId: string | null;
}

const checks = new Map<string, CheckRecord>();

async function bootId(ctx: AppContext): Promise<string | null> {
  return ctx.truenas
    .client()
    .call<string>('system.boot_id')
    .catch(() => null);
}

export async function recordCheckStarted(ctx: AppContext, poolName: string): Promise<void> {
  checks.set(poolName, { startedAt: Date.now(), bootId: await bootId(ctx) });
}

export type CheckOutcome = 'none' | 'running' | 'clean' | 'errors' | 'stale';

/** Outcome of the last check ApexOs started on this pool, judged from the pool's scan state. */
export async function lastCheckOutcome(ctx: AppContext, pool: Pool): Promise<CheckOutcome> {
  const record = checks.get(pool.name);
  if (!record) return 'none';
  if (record.bootId && record.bootId !== (await bootId(ctx))) return 'stale';
  const scan = pool.scan;
  if (!scan || scan.kind !== 'scrub') return 'none';
  if (scan.state === 'running' || scan.state === 'paused') return 'running';
  const finishedAt = scan.finishedAt ? Date.parse(scan.finishedAt) : 0;
  // A check that finished before ApexOs started its own (e.g. the scheduled one) doesn't count.
  if (scan.state !== 'finished' || finishedAt < record.startedAt - 1_000) return 'none';
  return scan.errors === 0 ? 'clean' : 'errors';
}

/** For tests. */
export function forgetChecks(): void {
  checks.clear();
}
