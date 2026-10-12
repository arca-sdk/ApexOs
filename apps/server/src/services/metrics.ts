import type { MetricsSample } from '@hearth/api-types';
import type { CollectionUpdate } from '@hearth/truenas-client';
import type { AppContext } from '../app.ts';
import type { TnAppStats, TnRealtime } from '../truenas/types.ts';

export function toSample(rt: TnRealtime, apps: TnAppStats[]): MetricsSample {
  const cpu = rt.cpu ?? {};
  const cores = Object.keys(cpu)
    .filter((k) => /^cpu\d+$/.test(k))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
    .map((k) => ({ usage: round(cpu[k]?.usage ?? 0), temperatureC: cpu[k]?.temp ?? null }));
  const total = rt.memory?.physical_memory_total ?? 0;
  const available = rt.memory?.physical_memory_available ?? 0;
  return {
    time: new Date().toISOString(),
    cpu: { usage: round(cpu.cpu?.usage ?? 0), temperatureC: cpu.cpu?.temp ?? null, cores },
    memory: { totalBytes: total, usedBytes: Math.max(0, total - available), cacheBytes: rt.memory?.arc_size ?? 0, availableBytes: available },
    network: Object.entries(rt.interfaces ?? {}).map(([name, i]) => ({
      name,
      up: i.link_state === 'LINK_STATE_UP',
      speedMbps: i.speed || null,
      rxBytesPerSec: Math.round(i.received_bytes_rate ?? 0),
      txBytesPerSec: Math.round(i.sent_bytes_rate ?? 0),
    })),
    disks: {
      readBytesPerSec: Math.round(rt.disks?.read_bytes ?? 0),
      writeBytesPerSec: Math.round(rt.disks?.write_bytes ?? 0),
      busyPercent: round(rt.disks?.busy ?? 0),
    },
    apps: Object.fromEntries(apps.map((a) => [a.app_name, { cpuPercent: round(a.cpu_usage), memoryBytes: a.memory }])),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Turns TrueNAS realtime reporting events into `metrics` samples on the bus. */
export function startMetrics(ctx: AppContext): void {
  let apps: TnAppStats[] = [];
  ctx.truenas.on('update', (update: CollectionUpdate) => {
    if (update.collection.startsWith('app.stats')) {
      apps = Array.isArray(update.fields) ? (update.fields as TnAppStats[]) : apps;
      return;
    }
    if (update.collection.startsWith('reporting.realtime') && update.fields) {
      ctx.bus.emit('metrics', toSample(update.fields as TnRealtime, apps));
    }
  });
}
