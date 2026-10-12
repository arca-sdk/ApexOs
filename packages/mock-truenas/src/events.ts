/**
 * Periodic event sources: `reporting.realtime` and `app.stats` (both accept `:{"interval": n}`, n >= 2 s).
 * One timer per subscription; timers are unref'd and stopped on unsubscribe, disconnect and server close.
 */
import type { Mock } from './context.ts';
import { validationError, type EventSourceContext } from './rpc.ts';
import type { AppState } from './state.ts';
import { poolAllocated, poolSize } from './storage.ts';
import { GiB, MiB, round, seeded, type Obj } from './util.ts';
import { visibleApps } from './methods/apps.ts';

const PHYSMEM = 32 * GiB;
const CORES = 12;
const BASE_SERVICES_MEMORY = 3.1 * GiB;

/** Typical resident memory per catalog app, in MiB. */
const APP_MEMORY_MIB: Record<string, number> = {
  jellyfin: 420,
  plex: 380,
  emby: 350,
  immich: 1450,
  nextcloud: 520,
  syncthing: 90,
  'home-assistant': 380,
  qbittorrent: 160,
  sonarr: 210,
  radarr: 200,
  prowlarr: 140,
  lidarr: 180,
  bazarr: 150,
  seerr: 230,
  navidrome: 70,
  'paperless-ngx': 780,
  'actual-budget': 110,
  vaultwarden: 45,
  pihole: 95,
  'adguard-home': 60,
  'uptime-kuma': 120,
  audiobookshelf: 130,
  aistor: 260,
  gitea: 210,
  homepage: 85,
  filebrowser: 30,
  tailscale: 55,
  photoprism: 650,
};

function runningApps(mock: Mock): AppState[] {
  return visibleApps(mock).filter((a) => a.state === 'RUNNING');
}

export function appMemory(app: AppState): number {
  const base = APP_MEMORY_MIB[app.catalog_app ?? ''] ?? 150;
  const wobble = 1 + Math.sin(Date.now() / 45_000 + seeded(app.name) * 6) * 0.06;
  return Math.round(base * MiB * wobble);
}

/** Smooth random walk in [min, max]. */
class Walk {
  constructor(
    private value: number,
    private readonly min: number,
    private readonly max: number,
    private readonly step: number,
  ) {}
  get current(): number {
    return this.value;
  }
  next(bias = 0): number {
    this.value = Math.min(this.max, Math.max(this.min, this.value + (Math.random() * 2 - 1) * this.step + bias));
    return this.value;
  }
}

function realtimeSampler(mock: Mock): () => Obj {
  const cpuWalk = new Walk(4, 1, 90, 1.5);
  const coreWalks = Array.from({ length: CORES }, () => new Walk(4, 0, 100, 4));
  const rx = new Walk(60_000, 4_000, 4_000_000, 40_000);
  const tx = new Walk(25_000, 2_000, 2_000_000, 20_000);
  const readOps = new Walk(40, 2, 2000, 20);
  const writeOps = new Walk(30, 2, 2000, 15);
  let rxTotal = 48_301_772_288;
  let txTotal = 9_877_123_456;
  let last = Date.now();
  return () => {
    const { state } = mock;
    const now = Date.now();
    const dt = Math.max(0.5, (now - last) / 1000);
    last = now;
    const apps = runningApps(mock);
    const scanning = state.pools.filter((p) => p.scan?.state === 'SCANNING' && !p.scan.pause);
    const appLoad = Math.min(40, apps.length * 1.8);
    const scanLoad = scanning.length * 9;
    const target = 2.5 + appLoad + scanLoad;
    const usage = cpuWalk.next((target - cpuWalk.current) * 0.3);
    const temp = 38 + usage * 0.42;
    const cpu: Obj = { cpu: { usage: round(usage, 2), temp: round(temp, 1) } };
    coreWalks.forEach((w, i) => {
      const u = w.next((usage - w.current) * 0.5);
      cpu[`cpu${i}`] = { usage: round(u, 2), temp: round(temp + (i % 6) * 0.3, 1) };
    });

    const appMem = apps.reduce((a, app) => a + appMemory(app), 0);
    const dataBytes = state.pools.reduce((a, p) => a + poolAllocated(state, p), 0);
    const arc = Math.round(Math.min(PHYSMEM - BASE_SERVICES_MEMORY - appMem - 2 * GiB, 1.5 * GiB + dataBytes * 0.004));
    const available = Math.max(512 * MiB, PHYSMEM - BASE_SERVICES_MEMORY - appMem - arc);
    const memory = {
      arc_size: arc,
      arc_free_memory: available,
      arc_available_memory: Math.max(0, available - GiB),
      physical_memory_total: PHYSMEM,
      physical_memory_available: available,
    };

    const scrubBytes = scanning.length * 450 * MiB;
    const ro = readOps.next();
    const wo = writeOps.next();
    const disks = {
      read_ops: round(ro + scanning.length * 3600, 1),
      read_bytes: round(ro * 64 * 1024 + scrubBytes, 1),
      write_ops: round(wo, 1),
      write_bytes: round(wo * 32 * 1024 + scanning.filter((p) => p.scan?.function === 'RESILVER').length * 180 * MiB, 1),
      busy: round(Math.min(100, 1.5 + ro / 40 + scanning.length * 55), 2),
    };

    const rxRate = Math.round(rx.next(apps.length * 2_000));
    const txRate = Math.round(tx.next(apps.length * 1_000));
    rxTotal += Math.round(rxRate * dt);
    txTotal += Math.round(txRate * dt);
    const interfaces: Obj = {};
    for (const i of state.network.interfaces) {
      interfaces[i.name] = i.linkUp
        ? { link_state: 'LINK_STATE_UP', speed: i.speed, received_bytes: rxTotal, sent_bytes: txTotal, received_bytes_rate: rxRate, sent_bytes_rate: txRate }
        : { link_state: 'LINK_STATE_DOWN', speed: 0, received_bytes: 0, sent_bytes: 0, received_bytes_rate: 0, sent_bytes_rate: 0 };
    }

    const accesses = Math.round(800 + ro * 12);
    const hitPct = Math.round(97 + Math.random() * 2.5);
    const zfs = {
      demand_accesses_per_second: accesses,
      demand_data_accesses_per_second: Math.round(accesses * 0.6),
      demand_metadata_accesses_per_second: Math.round(accesses * 0.4),
      demand_data_hits_per_second: Math.round(accesses * 0.6 * (hitPct / 100)),
      demand_data_io_hits_per_second: Math.round(accesses * 0.01),
      demand_data_misses_per_second: Math.round(accesses * 0.6 * (1 - hitPct / 100)),
      demand_data_hit_percentage: hitPct,
      demand_data_io_hit_percentage: 1,
      demand_data_miss_percentage: 100 - hitPct,
      demand_metadata_hits_per_second: Math.round(accesses * 0.4 * 0.995),
      demand_metadata_io_hits_per_second: 0,
      demand_metadata_misses_per_second: Math.round(accesses * 0.4 * 0.005),
      demand_metadata_hit_percentage: 99,
      demand_metadata_io_hit_percentage: 0,
      demand_metadata_miss_percentage: 1,
      l2arc_hits_per_second: 0,
      l2arc_misses_per_second: 0,
      total_l2arc_accesses_per_second: 0,
      l2arc_access_hit_percentage: 0,
      l2arc_miss_percentage: 0,
      bytes_read_per_second_from_the_l2arc: 0,
      bytes_written_per_second_to_the_l2arc: 0,
    };

    const pools: Obj = {};
    for (const p of state.pools) {
      const size = poolSize(state, p);
      const used = poolAllocated(state, p);
      pools[p.name] = { total: size, used, available: Math.max(0, size - used) };
    }
    return { cpu, memory, disks, interfaces, zfs, pools };
  };
}

function appStatsSampler(mock: Mock): () => Obj[] {
  const walks = new Map<string, Walk>();
  return () =>
    runningApps(mock).map((app) => {
      let w = walks.get(app.name);
      if (!w) {
        w = new Walk(0.8 + seeded(app.name) * 2, 0.05, 60, 0.6);
        walks.set(app.name, w);
      }
      const cpu = w.next();
      return {
        app_name: app.name,
        cpu_usage: round(cpu, 2),
        memory: appMemory(app),
        networks: [{ interface_name: 'eth0', rx_bytes: Math.round(800 + Math.random() * 40_000), tx_bytes: Math.round(400 + Math.random() * 25_000) }],
        blkio: { read: Math.round(Math.random() * 512 * 1024), write: Math.round(Math.random() * 256 * 1024) },
      };
    });
}

function periodic(ctx: EventSourceContext, sample: () => unknown): () => void {
  const raw = ctx.args.interval ?? 2;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 2) throw validationError(`${ctx.name}.interval`, 'Input should be greater than or equal to 2');
  const send = () => ctx.send(sample(), 'added');
  const first = setTimeout(send, 50);
  const timer = setInterval(send, raw * 1000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export function registerEvents(mock: Mock): void {
  mock.server.eventSource('reporting.realtime', (ctx) => periodic(ctx, realtimeSampler(mock)));
  mock.server.eventSource('app.stats', (ctx) => periodic(ctx, appStatsSampler(mock)));
}
