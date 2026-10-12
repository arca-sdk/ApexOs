import { clearAlert, raiseAlert } from '../alerts.ts';
import type { Mock } from '../context.ts';
import { callError, queryFilter, validationError } from '../rpc.ts';
import type { DiskState, MockState } from '../state.ts';
import { diskById, diskByName, diskDetails, diskInUse, exportedPoolOf, poolLeaves, renderBootPool, renderDisk } from '../storage.ts';
import { argObj, isObj, round, seeded, type Obj } from '../util.ts';

/** Current temperature: override, or the base temperature with a little jitter (plus load from scrubs). */
export function diskTemperature(state: MockState, d: DiskState): number | null {
  if (d.tempOverride !== null) return d.tempOverride;
  if (d.baseTemp === null) return null;
  const busy = state.pools.some((p) => p.scan?.state === 'SCANNING' && [...poolLeaves(p)].some((r) => r.leaf.disk === d.identifier));
  const wobble = Math.sin(Date.now() / 60_000 + seeded(d.serial) * 10) * 0.8;
  return Math.round(d.baseTemp + wobble + (busy ? 4 : 0));
}

export function checkTemperatureAlert(mock: Mock, d: DiskState): void {
  const t = diskTemperature(mock.state, d);
  if (t !== null && d.criticalTemp !== null && t >= d.criticalTemp) {
    raiseAlert(mock, 'DiskTemperatureTooHot', { disk: d.name, temperature: t, critical: d.criticalTemp }, [d.identifier]);
  } else {
    clearAlert(mock, 'DiskTemperatureTooHot', [d.identifier]);
  }
}

function presentDisks(state: MockState, includeExpired = false): DiskState[] {
  return state.disks.filter((d) => includeExpired || d.present);
}

export function registerDisks(mock: Mock): void {
  const { server } = mock;
  const list = (opts: unknown) => {
    const extra = (isObj(opts) && isObj(opts.extra) ? opts.extra : {}) as Obj;
    return presentDisks(mock.state, extra.include_expired === true).map((d) => renderDisk(mock.state, d, extra.pools === true));
  };

  server.method('disk.query', (p) => queryFilter(list(p[1]), p[0], p[1]));
  server.method('disk.get_instance', (p) => queryFilter(list(p[1]), [['identifier', '=', p[0]]], { get: true }));

  server.method('disk.details', (p) => {
    const opts = argObj(p[0], 'disk_details');
    const type = opts.type ?? 'BOTH';
    if (!['BOTH', 'USED', 'UNUSED'].includes(String(type))) throw validationError('disk_details.type', "Input should be 'USED', 'UNUSED' or 'BOTH'");
    const used: Obj[] = [];
    const unused: Obj[] = [];
    for (const d of presentDisks(mock.state)) {
      const entry = diskDetails(mock.state, d, opts.join_partitions === true);
      if (entry.imported_zpool || entry.exported_zpool) used.push(entry);
      else unused.push(entry);
    }
    if (type === 'USED') return used;
    if (type === 'UNUSED') return unused;
    return { used, unused };
  });

  server.method('disk.get_used', (p) =>
    presentDisks(mock.state)
      .map((d) => diskDetails(mock.state, d, p[0] === true))
      .filter((e) => e.imported_zpool || e.exported_zpool),
  );

  server.method('disk.temperatures', (p) => {
    const names = Array.isArray(p[0]) && p[0].length ? (p[0] as unknown[]).map(String) : null;
    const thresholds = p[1] === true;
    const out: Obj = {};
    for (const d of presentDisks(mock.state)) {
      if (names && !names.includes(d.name)) continue;
      const t = diskTemperature(mock.state, d);
      out[d.name] = thresholds ? (t === null ? null : [t, d.criticalTemp]) : t;
    }
    return out;
  });

  server.method('disk.temperature_agg', (p) => {
    const names = Array.isArray(p[0]) ? (p[0] as unknown[]).map(String) : [];
    const out: Obj = {};
    for (const name of names) {
      const d = diskByName(mock.state, name);
      const t = d ? diskTemperature(mock.state, d) : null;
      if (d && t !== null) out[name] = { min: t - 3, max: t + 4, avg: round(t + 0.4, 1) };
    }
    return out;
  });

  server.method('disk.temperature_alerts', (p) => {
    const names = Array.isArray(p[0]) ? (p[0] as unknown[]).map(String) : [];
    return mock.state.alerts
      .filter((a) => a.klass === 'DiskTemperatureTooHot' && names.includes(String((a.args as Obj).disk)))
      .map((a) => ({ uuid: a.uuid, klass: a.klass, level: a.level, formatted: a.formatted, args: a.args }));
  });

  server.method('disk.update', (p) => {
    const d = typeof p[0] === 'string' ? diskById(mock.state, p[0]) : undefined;
    if (!d) throw callError('ENOENT', `Disk ${String(p[0])} not found`);
    const data = argObj(p[1], 'disk_update');
    if (typeof data.description === 'string') d.description = data.description;
    if (typeof data.hddstandby === 'string') d.hddstandby = data.hddstandby;
    if (typeof data.advpowermgmt === 'string') d.advpowermgmt = data.advpowermgmt;
    const entry = renderDisk(mock.state, d, false);
    mock.emit('disk.query', 'changed', d.identifier, entry);
    return entry;
  });

  server.job(
    'disk.wipe',
    async (p, job) => {
      const d = diskByName(mock.state, String(p[0]));
      if (!d) throw callError('ENOENT', `Disk ${String(p[0])} not found`);
      const pool = diskInUse(mock.state, d);
      if (pool) throw callError('EBUSY', `Disk ${d.name} is in use by pool ${pool}`);
      const mode = String(p[1]);
      const steps = mode === 'QUICK' ? 2 : 6;
      for (let i = 1; i <= steps; i++) {
        job.progress(Math.round((i / steps) * 95), mode === 'QUICK' ? 'Wiping partition table' : `Writing ${mode === 'FULL' ? 'zeros' : 'random data'} to ${d.name}`);
        await job.sleep();
      }
      const exported = exportedPoolOf(mock.state, d);
      if (exported) mock.state.exportedPools = mock.state.exportedPools.filter((e) => e !== exported);
      d.zfs_guid = null;
      d.foreignPartitions = [];
      mock.emit('disk.query', 'changed', d.identifier, renderDisk(mock.state, d, false));
      return null;
    },
    (p) => {
      if (typeof p[0] !== 'string') throw validationError('disk_wipe.dev', 'Field required');
      if (!['QUICK', 'FULL', 'FULL_RANDOM'].includes(String(p[1]))) throw validationError('disk_wipe.mode', "Input should be 'QUICK', 'FULL' or 'FULL_RANDOM'");
    },
  );

  // Boot pool
  server.method('boot.get_disks', () => mock.state.disks.filter((d) => d.boot && d.present).map((d) => d.name));
  server.method('boot.get_state', () => renderBootPool(mock.state, mock.bootTime));
  server.method('boot.get_scrub_interval', () => 7);
  server.method('boot.set_scrub_interval', (p) => p[0]);
  server.job('boot.scrub', async (_p, job) => {
    for (let i = 1; i <= 3; i++) {
      job.progress(i * 33, 'Scrubbing boot pool');
      await job.sleep();
    }
    return null;
  });
  server.method('boot.environment.query', (p) =>
    queryFilter(
      [
        {
          id: mock.state.system.version,
          dataset: `boot-pool/ROOT/${mock.state.system.version}`,
          active: true,
          activated: true,
          created: { $date: mock.state.system.buildtime },
          used_bytes: Math.round(2.9 * 1024 ** 3),
          used: '2.9G',
          keep: false,
          can_activate: true,
        },
      ],
      p[0],
      p[1],
    ),
  );
}
