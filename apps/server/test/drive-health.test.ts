/**
 * Automatic drive-error handling against the simulated TrueNAS ("configured" scenario: HDDs is RAIDZ1 on
 * sdb–sde, SSDs is a mirror of two NVMe drives). The monitor runs with an injected clock.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveHealthDetail, SmartSummary } from '@apexos/api-types';
import { startMockTrueNas, type MockTrueNas } from '@apexos/mock-truenas';
import { buildApp, type AppContext } from '../src/app.ts';
import { Bus } from '../src/lib/bus.ts';
import { HostCommands } from '../src/lib/host.ts';
import { StateStore } from '../src/lib/store.ts';
import { TaskManager } from '../src/lib/tasks.ts';
import { TrueNasManager } from '../src/lib/truenas.ts';
import { DriveHealthMonitor, getDriveHealthDetail, parseSmart, readSmartNow, WATCH_MS } from '../src/services/drive-health.ts';
import { dismissNotice } from '../src/services/notifications.ts';
import { forgetChecks } from '../src/services/pool-checks.ts';
import { getStorage } from '../src/services/storage.ts';

const DAY = 86_400_000;

describe('parseSmart', () => {
  const at = '2026-10-12T00:00:00.000Z';
  it('reads ATA attributes 5, 197 and 198', () => {
    const out = JSON.stringify({
      smart_status: { passed: true },
      power_on_time: { hours: 1200 },
      temperature: { current: 34 },
      ata_smart_attributes: {
        table: [
          { id: 5, raw: { value: 0 } },
          { id: 197, raw: { value: 2 } },
          { id: 198, raw: { value: 0 } },
        ],
      },
    });
    expect(parseSmart(out, 0, at)).toEqual({
      readAt: at,
      passed: true,
      reallocatedSectors: 0,
      pendingSectors: 2,
      offlineUncorrectable: 0,
      mediaErrors: null,
      powerOnHours: 1200,
      temperatureC: 34,
      damaged: true,
    });
  });
  it('reads NVMe media errors and keeps parsing when the "failing" bit is set', () => {
    const out = JSON.stringify({ smart_status: { passed: false }, nvme_smart_health_information_log: { media_errors: 0 } });
    expect(parseSmart(out, 8, at)).toMatchObject({ passed: false, mediaErrors: 0, damaged: false, reallocatedSectors: null });
  });
  it('fails when the device could not be opened', () => {
    const out = JSON.stringify({ smartctl: { exit_status: 2, messages: [{ string: '/dev/sdz: No such device' }] } });
    expect(() => parseSmart(out, 2, at)).toThrow(/No such device/);
    expect(() => parseSmart('not json', 0, at)).toThrow(/readable/);
  });
});

describe('drive health monitor', () => {
  let mock: MockTrueNas;
  let ctx: AppContext;
  let dataDir: string;
  let clock: number;
  let monitor: DriveHealthMonitor;
  let failures: unknown[];
  let clears: string[][];

  beforeEach(async () => {
    forgetChecks();
    mock = await startMockTrueNas({ jobDelayMs: 0, scenario: 'configured' });
    dataDir = await mkdtemp(join(tmpdir(), 'apexos-drive-health-'));
    const store = new StateStore(dataDir);
    await store.load();
    const truenas = new TrueNasManager();
    await truenas.configure({ url: mock.url, auth: { type: 'apiKey', apiKey: 'demo-api-key' } });
    ctx = { store, truenas, tasks: new TaskManager(), bus: new Bus(), host: new HostCommands(truenas), scripts: new Map(), demo: true };
    clock = Date.now();
    failures = [];
    monitor = new DriveHealthMonitor(ctx, { now: () => clock, onError: (err) => failures.push(err) });
    clears = [];
    const runChecked = ctx.host.runChecked.bind(ctx.host);
    vi.spyOn(ctx.host, 'runChecked').mockImplementation((binary, args, opts) => {
      if (binary === 'zpool' && args[0] === 'clear') clears.push(args);
      return runChecked(binary, args, opts);
    });
  });

  afterEach(async () => {
    await monitor.stop();
    await ctx.truenas.close();
    await mock.close();
    await rm(dataDir, { recursive: true, force: true });
    expect(failures).toEqual([]);
  });

  const identifierOf = (name: string) => mock.state.disks.find((d) => d.name === name)!.identifier;
  const record = (name: string) => ctx.store.get().driveHealth.drives[identifierOf(name)]!;
  const notices = (title?: RegExp) => ctx.store.get().notices.filter((n) => !title || title.test(n.title));
  const counters = (name: string) => {
    for (const pool of mock.state.pools) {
      for (const v of pool.topology.data) for (const leaf of v.children) if (leaf.disk === identifierOf(name)) return leaf.errors;
    }
    throw new Error(`${name} is not in a pool`);
  };

  /** Runs passes until no pool check ApexOs waits for is left. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      await monitor.check();
      if (!Object.values(ctx.store.get().driveHealth.drives).some((r) => r.phase === 'checking')) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('The drive checks did not settle');
  }

  /** A first episode on `names`: repaired by a clean check, counters reset, drives watched. */
  async function repairedEpisode(...names: string[]): Promise<void> {
    for (const name of names) mock.addDriveErrors(name, { checksum: 2 });
    await settle();
    for (const name of names) expect(record(name).phase).toBe('watching');
  }

  it('checks the pool, resets the counters once and watches the drive after a first episode', async () => {
    mock.addDriveErrors('sdc', { checksum: 3 });
    await monitor.check();
    expect(record('sdc')).toMatchObject({ phase: 'checking', check: { pool: 'HDDs', attempts: 1 } });
    expect(record('sdc').check?.startedAt).toBeTruthy();
    expect(mock.state.pools.find((p) => p.name === 'HDDs')!.scan?.start_time).toBeGreaterThan(clock - 60_000);

    await settle();
    const rec = record('sdc');
    expect(rec.phase).toBe('watching');
    expect(Date.parse(rec.watchUntil!)).toBe(clock + WATCH_MS);
    expect(rec.lastClearedAt).toBe(new Date(clock).toISOString());
    expect(counters('sdc')).toEqual({ read: 0, write: 0, checksum: 0 });
    expect(clears).toEqual([['clear', 'HDDs', expect.stringMatching(/^\d+$/)]]);
    expect(rec.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['errors', 'smart', 'check', 'cleared', 'watch']));

    // Errors that redundancy repaired don't alarm: one informational notice only.
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ level: 'info', title: 'Drive errors in HDDs were fixed', link: '/storage' });
    expect(notices()[0]!.message).toMatch(/watching this drive until/);

    const sdc = (await getStorage(ctx)).pools.find((p) => p.name === 'HDDs')!.drives.find((d) => d.name === 'sdc')!;
    expect(sdc.health).toEqual({ state: 'watching', watchUntil: rec.watchUntil, lastErrorAt: rec.lastErrorAt, diagnosis: null });

    // Nothing new: further passes change nothing.
    await settle();
    expect(clears).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it('raises exactly one "check a cable" notice when errors come back within the month', async () => {
    await repairedEpisode('sdc');
    clock += 5 * DAY;
    mock.addDriveErrors('sdc', { read: 2 });
    await settle();
    expect(record('sdc')).toMatchObject({ phase: 'attention', diagnosis: 'check-cable' });
    expect(notices(/Check a drive cable/)).toHaveLength(1);
    expect(notices(/Check a drive cable/)[0]).toMatchObject({ level: 'warning', link: '/storage' });
    // Never the same fix twice within a month: the counters stay.
    expect(clears).toHaveLength(1);
    expect(counters('sdc')).toEqual({ read: 2, write: 0, checksum: 0 });

    // More errors in the same episode, and dismissing the notice, don't produce another one...
    await dismissNotice(ctx, notices(/Check a drive cable/)[0]!.id);
    clock += DAY;
    mock.addDriveErrors('sdc', { read: 1 });
    await settle();
    expect(notices(/Check a drive cable/)).toHaveLength(1);
    // ...but monitoring goes on.
    expect(record('sdc').events.filter((e) => e.kind === 'errors')).toHaveLength(3);
    expect(record('sdc').lastErrorAt).toBe(new Date(clock).toISOString());
    const health = (await getDriveHealthDetail(ctx, identifierOf('sdc'))).health;
    expect(health).toMatchObject({ state: 'attention', diagnosis: 'check-cable' });
  });

  it('says "errors again (unclear)" when errors return after the cable advice', async () => {
    await repairedEpisode('sdc');
    mock.addDriveErrors('sdc', { read: 2 });
    await settle();
    expect(record('sdc').diagnosis).toBe('check-cable');
    // The user reseats the cable and resets the counters in TrueNAS: ApexOs watches again.
    clock += DAY;
    await ctx.host.run('zpool', ['clear', 'HDDs']);
    await settle();
    expect(record('sdc')).toMatchObject({ phase: 'watching', previousDiagnosis: 'check-cable' });
    mock.addDriveErrors('sdc', { write: 1 });
    await settle();
    expect(record('sdc')).toMatchObject({ phase: 'attention', diagnosis: 'unclear' });
    expect(notices(/Errors again on a drive in HDDs/)).toHaveLength(1);
    expect(clears).toHaveLength(1);
  });

  it('asks to replace a drive with damaged areas right away and never resets it', async () => {
    mock.setSmart('sdd', { reallocatedSectors: 8, pendingSectors: 1 });
    mock.addDriveErrors('sdd', { read: 4 });
    const scanBefore = structuredClone(mock.state.pools.find((p) => p.name === 'HDDs')!.scan);
    await monitor.check();
    expect(record('sdd')).toMatchObject({ phase: 'attention', diagnosis: 'replace-drive' });
    expect(record('sdd').smart).toMatchObject({ reallocatedSectors: 8, pendingSectors: 1, damaged: true });
    expect(notices(/Replace a drive in HDDs/)).toHaveLength(1);
    expect(notices(/Replace a drive in HDDs/)[0]).toMatchObject({ level: 'error', link: '/storage' });
    expect(notices(/Replace a drive/)[0]!.message).toMatch(/8 replaced \(reallocated\) sectors/);
    // No check, no reset.
    expect(mock.state.pools.find((p) => p.name === 'HDDs')!.scan).toEqual(scanBefore);
    expect(clears).toEqual([]);
    expect(counters('sdd')).toEqual({ read: 4, write: 0, checksum: 0 });

    // A month later the drive still isn't reset, and still only one notice.
    clock += 40 * DAY;
    mock.addDriveErrors('sdd', { read: 1 });
    await settle();
    expect(await monitor.clearErrorsOnce(identifierOf('sdd'))).toBe(false);
    expect(clears).toEqual([]);
    expect(notices(/Replace a drive/)).toHaveLength(1);
    expect(record('sdd').diagnosis).toBe('replace-drive');
  });

  it('does not reset a drive that reports bad sectors by the time the check finishes', async () => {
    mock.addDriveErrors('sdb', { checksum: 1 });
    await monitor.check();
    expect(record('sdb').phase).toBe('checking');
    mock.setSmart('sdb', { pendingSectors: 3 });
    await settle();
    expect(record('sdb')).toMatchObject({ phase: 'attention', diagnosis: 'replace-drive' });
    expect(clears).toEqual([]);
    expect(counters('sdb')).toEqual({ read: 0, write: 0, checksum: 1 });
  });

  it('asks to replace a drive that failed and did not come back, and watches it if it does', async () => {
    mock.failDrive('sde', 'REMOVED');
    await settle();
    expect(record('sde')).toMatchObject({ phase: 'attention', diagnosis: 'replace-drive', failed: true });
    expect(notices(/Replace a drive in HDDs/)[0]!.message).toMatch(/stopped working and hasn't come back/);
    mock.restoreDrive('sde');
    await settle();
    expect(record('sde')).toMatchObject({ phase: 'watching', failed: false, diagnosis: null });
    expect(notices(/Replace a drive/)).toHaveLength(1);
  });

  it('points at the controller when several drives on it have errors again together', async () => {
    await repairedEpisode('sdb', 'sdc');
    expect(notices()).toHaveLength(1); // one "fixed" notice for both drives
    expect(notices()[0]!.message).toMatch(/these drives/);
    clock += 3 * DAY;
    mock.addDriveErrors('sdb', { read: 3, checksum: 1 });
    mock.addDriveErrors('sdc', { write: 2 });
    await settle();
    expect(record('sdb')).toMatchObject({ phase: 'attention', diagnosis: 'check-controller' });
    expect(record('sdc')).toMatchObject({ phase: 'attention', diagnosis: 'check-controller' });
    expect(notices(/Check the drive controller in HDDs/)).toHaveLength(1);
    expect(notices(/Check a drive cable/)).toHaveLength(0);
  });

  it('points at memory for checksum-only errors on several drives, or when TrueNAS reports memory errors', async () => {
    await repairedEpisode('sdb', 'sdc', 'nvme0n1');
    mock.addDriveErrors('sdb', { checksum: 2 });
    mock.addDriveErrors('nvme0n1', { checksum: 5 });
    await settle();
    expect(record('sdb').diagnosis).toBe('check-memory');
    expect(record('nvme0n1').diagnosis).toBe('check-memory');
    expect(notices(/Check the server's memory/)).toHaveLength(1);
    expect(notices(/Check the server's memory/)[0]!.message).not.toMatch(/TrueNAS also reported/);

    // Read errors normally point elsewhere, but not when TrueNAS reports faulty memory.
    mock.setMemoryErrors(4);
    mock.addDriveErrors('sdc', { read: 1 });
    mock.addDriveErrors('sdd', { read: 1 });
    await settle(); // sdd: first episode, repaired and watched
    expect(record('sdd').phase).toBe('watching');
    expect(record('sdc').diagnosis).toBe('check-cable'); // alone in that pass
    clock += DAY;
    await ctx.host.run('zpool', ['clear', 'HDDs']); // the user resets everything after a check
    await settle();
    mock.addDriveErrors('sdc', { read: 1 });
    mock.addDriveErrors('sdd', { read: 2 });
    await settle();
    expect(record('sdd').diagnosis).toBe('check-memory');
    const memory = notices(/Check the server's memory/);
    expect(memory).toHaveLength(2);
    expect(memory[0]!.message).toMatch(/TrueNAS also reported memory errors/);
  });

  it('refuses a second reset within a month', async () => {
    await repairedEpisode('sdc');
    mock.addDriveErrors('sdc', { checksum: 1 });
    clock += 10 * DAY;
    expect(await monitor.clearErrorsOnce(identifierOf('sdc'))).toBe(false);
    expect(clears).toHaveLength(1);
    expect(counters('sdc')).toEqual({ read: 0, write: 0, checksum: 1 });
    expect(record('sdc').events[0]).toMatchObject({ kind: 'kept', message: expect.stringMatching(/at most once a month/) });
    clock += 25 * DAY;
    expect(await monitor.clearErrorsOnce(identifierOf('sdc'))).toBe(true);
    expect(clears).toHaveLength(2);
    expect(counters('sdc')).toEqual({ read: 0, write: 0, checksum: 0 });
  });

  it('treats errors a month later as a new episode', async () => {
    await repairedEpisode('sdc');
    clock += WATCH_MS + DAY;
    await settle();
    expect(record('sdc')).toMatchObject({ phase: 'ok', watchUntil: null });
    expect(record('sdc').events[0]).toMatchObject({ kind: 'watch', message: expect.stringMatching(/stopped watching/) });
    mock.addDriveErrors('sdc', { checksum: 1 });
    await settle();
    expect(record('sdc').phase).toBe('watching');
    expect(Date.parse(record('sdc').watchUntil!)).toBe(clock + WATCH_MS);
    expect(clears).toHaveLength(2);
    expect(notices(/were fixed/)).toHaveLength(2);
    expect(notices().filter((n) => n.level !== 'info')).toEqual([]);
  });

  it('reports unreadable data on a pool without redundancy immediately', async () => {
    const name = mock.addDisk();
    await ctx.truenas.client().job('pool.create', [{ name: 'Scratch', encryption: false, topology: { data: [{ type: 'STRIPE', disks: [name] }] } }]);
    mock.setDataErrors('Scratch', ['/mnt/Scratch/videos/holiday.mp4']);
    mock.addDriveErrors(name, { checksum: 2 });
    await settle();
    const loss = notices(/Some data on Scratch can't be read/);
    expect(loss).toHaveLength(1);
    expect(loss[0]).toMatchObject({ level: 'critical', link: '/storage' });
    expect(loss[0]!.message).toMatch(/only one copy/);
    // The drive keeps its counters and gets a diagnosis, without a second notice.
    expect(clears).toEqual([]);
    expect(record(name)).toMatchObject({ phase: 'attention', diagnosis: 'unclear' });
    expect(notices()).toHaveLength(1);
    await settle();
    expect(notices()).toHaveLength(1);
  });

  it('lets the running check cover errors that arrive meanwhile', async () => {
    mock.addDriveErrors('sdc', { checksum: 1 });
    await monitor.check();
    mock.addDriveErrors('sdc', { checksum: 2 });
    await settle();
    const started = record('sdc').events.filter((e) => /started a check/.test(e.message));
    expect(started).toHaveLength(1);
    expect(record('sdc').phase).toBe('watching');
    expect(clears).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it('waits for a check that is already running before starting its own', async () => {
    const hdds = mock.state.pools.find((p) => p.name === 'HDDs')!;
    hdds.scan = { ...hdds.scan!, state: 'SCANNING', end_time: null, percentage: 40, pause: Date.now() };
    mock.addDriveErrors('sdc', { checksum: 1 });
    await monitor.check();
    expect(record('sdc')).toMatchObject({ phase: 'checking', check: { startedAt: null } });
    expect(record('sdc').events[0]!.message).toMatch(/already running/);
    hdds.scan = { ...hdds.scan!, state: 'FINISHED', end_time: Date.now(), percentage: 100, pause: null };
    await settle();
    expect(record('sdc').phase).toBe('watching');
    expect(clears).toHaveLength(1);
  });

  it('reacts to pool change events when started', async () => {
    await monitor.stop();
    monitor = new DriveHealthMonitor(ctx, { now: () => clock, debounceMs: 5, minGapMs: 0, intervalMs: 3_600_000, onError: (e) => failures.push(e) }).start();
    await monitor.check();
    mock.addDriveErrors('sdb', { checksum: 1 });
    for (let i = 0; i < 300 && ctx.store.get().driveHealth.drives[identifierOf('sdb')]?.phase !== 'watching'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(record('sdb').phase).toBe('watching');
  });

  it('serves the history and reads SMART on request over HTTP', async () => {
    await repairedEpisode('sdc');
    const app = await buildApp(ctx);
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'correct-horse' } });
      const cookie = String(res.headers['set-cookie']).split(';')[0]!;
      const url = `/api/storage/drives/${encodeURIComponent(identifierOf('sdc'))}`;
      const detail = (await app.inject({ method: 'GET', url: `${url}/health`, headers: { cookie } })).json() as DriveHealthDetail;
      expect(detail).toMatchObject({ name: 'sdc', pool: 'HDDs', health: { state: 'watching' }, checkIntervalMinutes: 10 });
      expect(detail.events[0]!.kind).toBe('watch');
      expect(detail.smart).toMatchObject({ passed: true, damaged: false });

      mock.setSmart('sdc', { reallocatedSectors: 2 });
      const smart = await app.inject({ method: 'POST', url: `${url}/smart`, headers: { cookie } });
      expect(smart.statusCode).toBe(200);
      expect((smart.json() as SmartSummary).reallocatedSectors).toBe(2);
      // Damaged areas found by a manual check are acted on by the monitor.
      await settle();
      expect(record('sdc')).toMatchObject({ phase: 'attention', diagnosis: 'replace-drive' });
      expect(notices(/Replace a drive/)).toHaveLength(1);

      const missing = await app.inject({ method: 'GET', url: '/api/storage/drives/nope/health', headers: { cookie } });
      expect(missing.statusCode).toBe(404);
      const unused = await readSmartNow(ctx, identifierOf('sdg'));
      expect(unused.passed).toBe(true);
    } finally {
      await app.close();
    }
  });
});
