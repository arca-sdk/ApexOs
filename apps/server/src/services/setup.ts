import type { ExistingPoolSummary, ImportablePool, NewPoolSpec, SetupInfo, SetupRequest, SetupReview, StorageOverview } from '@hearth/api-types';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { estimateLayout } from '../lib/layout.ts';
import { servernameFormat } from '../lib/validators.ts';
import type { TnApp, TnDataset, TnDockerConfig } from '../truenas/types.ts';
import { ensureSmbService } from './folders.ts';
import {
  createPool,
  deletePool,
  ensureScrubSchedule,
  findImportable,
  getStorage,
  importPool,
  resolveDiskNames,
  validateNewPool,
} from './storage.ts';
import { getTimezone, scanHardware, setServerName } from './system.ts';
import { listUsers } from './users.ts';

let importableCache: { at: number; pools: ImportablePool[] } | null = null;

export function invalidateImportable(): void {
  importableCache = null;
}

/** Pools that can be imported (cached briefly because finding them is slow). */
export async function importablePools(ctx: AppContext, fresh = false): Promise<ImportablePool[]> {
  if (!fresh && importableCache && Date.now() - importableCache.at < 120_000) return importableCache.pools;
  const pools = await findImportable(ctx);
  importableCache = { at: Date.now(), pools };
  return pools;
}

export async function getSetupInfo(ctx: AppContext): Promise<SetupInfo> {
  const client = ctx.truenas.client();
  const storage = await getStorage(ctx);
  const [scan, tz, users, datasets, apps, docker] = await Promise.all([
    scanHardware(ctx, storage),
    getTimezone(ctx),
    listUsers(ctx).catch(() => []),
    client.call<TnDataset[]>('pool.dataset.query', [[['type', '=', 'FILESYSTEM']], { extra: { retrieve_children: false, properties: [] } }]),
    client.call<TnApp[]>('app.query').catch(() => [] as TnApp[]),
    client.call<TnDockerConfig>('docker.config').catch(() => null),
  ]);
  const existingPools: ExistingPoolSummary[] = storage.pools.map((p) => ({
    id: p.id,
    name: p.name,
    displayName: p.displayName,
    health: p.health,
    sizeBytes: p.sizeBytes,
    usedBytes: p.usedBytes,
    layoutLabel: p.layout.label,
    faultTolerance: p.layout.faultTolerance,
    drives: p.drives.map((d) => d.identifier),
    folders: datasets
      .filter((d) => d.id.startsWith(`${p.name}/`) && d.id.split('/').length === 2 && !d.id.split('/')[1]!.startsWith('ix-') && !d.id.split('/')[1]!.startsWith('.'))
      .map((d) => d.id.split('/')[1]!),
    apps: docker?.pool === p.name ? apps.map((a) => a.name) : [],
  }));
  const hostname = scan.system.hostname;
  return {
    scan,
    drives: [...storage.unassigned, ...storage.pools.flatMap((p) => p.drives), ...storage.pools.flatMap((p) => p.spares)],
    existingPools,
    serverUsers: users.map((u) => u.username),
    timezone: tz.timezone,
    timezones: tz.choices,
    suggestedName: ctx.store.get().server.name ?? (servernameFormat(hostname) && hostname !== 'truenas' ? hostname : 'homeserver'),
  };
}

interface ReviewContext {
  storage: StorageOverview;
  importable: ImportablePool[];
  timezones: string[];
}

export function review(req: SetupRequest, rc: ReviewContext): SetupReview {
  const problems: string[] = [];
  const { storage } = rc;
  if (!servernameFormat(req.serverName)) problems.push('The server name must be 2–15 letters, numbers or dashes, starting with a letter.');
  if (!rc.timezones.includes(req.timezone)) problems.push('Pick a time zone.');

  const unknownKeep = req.keepPools.filter((n) => !storage.pools.some((p) => p.name === n));
  if (unknownKeep.length) problems.push(`These pools are no longer on the server: ${unknownKeep.join(', ')}. Go back and check again.`);
  const kept = storage.pools.filter((p) => req.keepPools.includes(p.name));
  const letGo = storage.pools.filter((p) => !req.keepPools.includes(p.name));
  const importing = req.importPools.map((guid) => rc.importable.find((p) => p.guid === guid));
  if (importing.some((p) => !p)) problems.push('A pool to import is no longer available. Go back and check again.');
  const importNames = importing.filter((p): p is ImportablePool => Boolean(p)).map((p) => p.name);

  const keptDrives = new Set(kept.flatMap((p) => [...p.drives, ...p.spares].map((d) => d.identifier)));
  const letGoDrives = new Map(letGo.flatMap((p) => [...p.drives, ...p.spares].map((d) => [d.identifier, p.name] as const)));
  const allDrives = [...storage.unassigned, ...storage.pools.flatMap((p) => [...p.drives, ...p.spares])];
  const usedByNew = new Set<string>();
  const newPools: SetupReview['newPools'] = [];

  // Drive checks first: which drives each new pool takes decides which let-go pools get erased.
  const driveProblems = new Map<NewPoolSpec, string>();
  for (const spec of req.newPools) {
    for (const id of spec.drives) {
      const drive = allDrives.find((d) => d.identifier === id);
      let problem: string | null = null;
      if (keptDrives.has(id)) problem = `Pool ${spec.name} uses a drive from a pool you're keeping.`;
      else if (drive?.exportedPool && importNames.includes(drive.exportedPool)) problem = `Pool ${spec.name} uses a drive of ${drive.exportedPool}, which you're importing.`;
      else if (usedByNew.has(id)) problem = 'A drive is used by more than one new pool.';
      if (problem) {
        if (!driveProblems.has(spec)) driveProblems.set(spec, problem);
      } else usedByNew.add(id);
    }
  }

  // Start-fresh rule: a let-go pool is erased (entirely) only if a new pool reuses one of its drives.
  const erase = new Set<string>();
  for (const id of usedByNew) {
    const pool = letGoDrives.get(id);
    if (pool) erase.add(pool);
    const exported = allDrives.find((d) => d.identifier === id)?.exportedPool;
    if (exported) erase.add(`${exported} (from another system)`);
  }
  // Pools that stay on the server (kept, imported, or let go but untouched) keep their names.
  const staying = [...kept.map((p) => p.name), ...importNames, ...letGo.map((p) => p.name).filter((n) => !erase.has(n))];

  for (const spec of req.newPools) {
    try {
      const driveProblem = driveProblems.get(spec);
      if (driveProblem) throw new UserError(driveProblem);
      const otherNames = [...staying, ...req.newPools.filter((p) => p !== spec).map((p) => p.name)];
      const drives = validateNewPool(storage, spec, { reusableDrives: new Set(letGoDrives.keys()), takenNames: otherNames });
      const estimate = estimateLayout(spec.layout, drives);
      newPools.push({ ...spec, usableBytes: estimate.usableBytes, faultTolerance: estimate.faultTolerance });
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  const erasePools = [...erase];
  const untouchedPools = letGo.map((p) => p.name).filter((n) => !erase.has(n));

  if (!kept.length && !importNames.length && !newPools.length && !req.newPools.length) {
    problems.push('Your server needs at least one storage pool. Keep, import or create one.');
  }

  // Apps go on the existing apps pool if it's kept, else the first new SSD pool, else the first pool available.
  const currentAppsPool = kept.find((p) => p.isAppsPool)?.name;
  const firstPerf = newPools.find((p) => allDrives.find((d) => d.identifier === p.drives[0])?.kind !== 'HDD');
  const appsPool = currentAppsPool ?? firstPerf?.name ?? newPools[0]?.name ?? kept[0]?.name ?? importNames[0] ?? null;

  const needsEraseConsent = newPools.length > 0 || erasePools.length > 0;
  const needsKeepConsent = kept.length > 0 || importNames.length > 0;
  return {
    ok: problems.length === 0,
    problems,
    erasePools,
    untouchedPools,
    newPools,
    appsPool,
    needsEraseConsent,
    needsKeepConsent,
  };
}

async function reviewContext(ctx: AppContext, req: SetupRequest, freshImportable = false): Promise<ReviewContext> {
  const [storage, tz, importable] = await Promise.all([
    getStorage(ctx),
    getTimezone(ctx),
    req.importPools.length ? importablePools(ctx, freshImportable) : Promise.resolve([] as ImportablePool[]),
  ]);
  return { storage, importable, timezones: tz.choices };
}

export async function reviewSetup(ctx: AppContext, req: SetupRequest): Promise<SetupReview> {
  return review(req, await reviewContext(ctx, req));
}

export async function startSetup(ctx: AppContext, req: SetupRequest) {
  if (ctx.store.get().server.setupCompletedAt) throw new UserError('This server is already set up.', 409, 'ALREADY_SETUP');
  if (ctx.tasks.findRunning('setup')) throw new UserError('Setup is already running.', 409, 'BUSY');
  // Validate synchronously so obvious mistakes come back as a form error rather than a failed task.
  const initial = review(req, await reviewContext(ctx, req));
  if (!initial.ok) throw new UserError(initial.problems.join(' '), 400, 'SETUP_INVALID');
  if (initial.needsEraseConsent && !req.consentErase) throw new UserError('Confirm that the selected drives may be erased.', 400, 'CONSENT_REQUIRED');
  if (initial.needsKeepConsent && !req.consentKeep) throw new UserError('Confirm what you are keeping.', 400, 'CONSENT_REQUIRED');

  return ctx.tasks.start(
    {
      type: 'setup',
      title: 'Setting up your server',
      steps: [
        'Checking drives',
        'Importing pools',
        'Erasing old pools',
        'Creating pools',
        'Scheduling health checks',
        'Preparing apps',
        'Naming your server',
        'Setting the time zone',
        'Turning on file sharing',
      ],
    },
    async (task) => {
      const client = ctx.truenas.client();
      // Pre-erase safety re-check: everything must still look exactly like it did at review.
      const final = await task.step('Checking drives', async () => {
        const rc = await reviewContext(ctx, req, true);
        const again = review(req, rc);
        const same = JSON.stringify(again.erasePools) === JSON.stringify(initial.erasePools) && again.ok;
        if (!same) throw new UserError('Your drives or pools changed since you reviewed the plan. Nothing was changed; please plan again.', 409, 'PLAN_STALE');
        return { review: again, rc };
      });

      if (req.importPools.length) {
        await task.step('Importing pools', async (report) => {
          for (const [i, guid] of req.importPools.entries()) {
            await importPool(ctx, guid);
            report(((i + 1) / req.importPools.length) * 100);
          }
          invalidateImportable();
        });
      } else task.skip('Importing pools');

      if (final.review.erasePools.length) {
        await task.step('Erasing old pools', async () => {
          const { storage } = final.rc;
          for (const pool of storage.pools.filter((p) => final.review.erasePools.includes(p.name))) {
            await deletePool(ctx, pool);
          }
          // Drives holding a pool from another system are wiped so they can be reused.
          const newDriveIds = new Set(req.newPools.flatMap((p) => p.drives));
          const foreign = storage.unassigned.filter((d) => d.exportedPool && newDriveIds.has(d.identifier));
          if (foreign.length) {
            const names = await resolveDiskNames(client, foreign.map((d) => d.identifier));
            for (const name of names) await client.job('disk.wipe', [name, 'QUICK', true]);
          }
          invalidateImportable();
        });
      } else task.skip('Erasing old pools');

      if (req.newPools.length) {
        await task.step('Creating pools', async (report) => {
          for (const [i, spec] of req.newPools.entries()) {
            await createPool(ctx, spec, (p) => report(((i + p / 100) / req.newPools.length) * 100, `Creating ${spec.name}`));
          }
        });
      } else task.skip('Creating pools');

      await task.step('Scheduling health checks', async () => {
        const storage = await getStorage(ctx);
        for (const pool of storage.pools) await ensureScrubSchedule(client, pool.id, pool.name);
      });

      await task.step('Preparing apps', async (report) => {
        const appsPool = final.review.appsPool;
        const docker = await client.call<TnDockerConfig>('docker.config');
        if (appsPool && docker.pool !== appsPool && !(docker.pool && req.keepPools.includes(docker.pool))) {
          await client.job('docker.update', [{ pool: appsPool }], (job) => report(job.progress.percent ?? 0, job.progress.description ?? undefined));
        }
      });

      await task.step('Naming your server', () => setServerName(ctx, req.serverName));
      await task.step('Setting the time zone', () => client.call('system.general.update', [{ timezone: req.timezone }]));
      await task.step('Turning on file sharing', async () => {
        // Encryption "desired" keeps Windows 11 24H2 clients happy; Apple extensions enable Time Machine.
        await client.call('smb.update', [{ encryption: 'DESIRED', aapl_extensions: true }]);
        await ensureSmbService(client);
      });

      await ctx.store.update((s) => {
        s.server.setupCompletedAt = new Date().toISOString();
        s.server.name = req.serverName;
      });
      ctx.bus.changed('storage');
      ctx.bus.changed('system');
    },
  );
}
