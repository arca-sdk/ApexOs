import { z } from 'zod';
import type { HardwareScan, NetworkInfo, ScanCard, ScanCheck, StorageOverview, SystemSummary, TimezoneInfo, UpdateInfo } from '@apexos/api-types';
import type { TrueNasClient } from '@apexos/truenas-client';
import type { AppContext } from '../app.ts';
import { UserError } from '../lib/errors.ts';
import { servernameFormat } from '../lib/validators.ts';
import { GiB } from '../truenas/helpers.ts';
import type { TnDockerStatus, TnInterface, TnSystemInfo, TnUpdateStatus } from '../truenas/types.ts';
import { anyPoolAtRisk, getStorage } from './storage.ts';

export const serverNameSchema = z
  .string()
  .trim()
  .refine(servernameFormat, 'Use 2–15 letters, numbers or dashes, starting with a letter');

/** TrueNAS releases ApexOs is tested against: 25.10.x up to (not including) 27. */
export const SUPPORTED_VERSIONS = { min: [25, 10, 0], below: [27, 0, 0] } as const;

function versionParts(v: string): number[] {
  return v
    .replace(/^TrueNAS-/i, '')
    .split(/[.-]/)
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function isSupportedVersion(version: string): boolean {
  const parts = versionParts(version);
  return compare(parts, SUPPORTED_VERSIONS.min) >= 0 && compare(parts, SUPPORTED_VERSIONS.below) < 0;
}

export async function lanIp(client: TrueNasClient): Promise<string | null> {
  const ip = await client.call<string>('interface.websocket_local_ip').catch(() => null);
  if (ip && ip !== '127.0.0.1' && ip !== '::1') return ip;
  const summary = await client.call<{ ips: Record<string, { IPV4?: string[] }> }>('network.general.summary').catch(() => null);
  const first = Object.values(summary?.ips ?? {}).flatMap((i) => i.IPV4 ?? [])[0];
  return first ? first.split('/')[0]! : null;
}

export async function getSystemSummary(ctx: AppContext): Promise<SystemSummary> {
  const client = ctx.truenas.client();
  const [info, ip] = await Promise.all([client.call<TnSystemInfo>('system.info'), lanIp(client)]);
  return {
    hostname: info.hostname,
    version: info.version.replace(/^TrueNAS-/i, ''),
    cpuModel: info.model,
    cores: info.cores,
    physicalCores: info.physical_cores,
    memoryBytes: info.physmem,
    eccMemory: info.ecc_memory,
    uptimeSeconds: info.uptime_seconds,
    timezone: info.timezone,
    manufacturer: info.system_manufacturer || null,
    product: info.system_product || null,
    lanIp: ip,
  };
}

function card(id: ScanCard['id'], title: string, checks: ScanCheck[], facts: ScanCard['facts'], unavailable = false): ScanCard {
  const hasError = checks.some((c) => c.severity === 'error');
  const hasWarning = checks.some((c) => c.severity === 'warning');
  const status = unavailable ? 'unavailable' : hasError ? 'issues' : hasWarning ? 'attention' : 'ok';
  const summary = {
    ok: 'No issues detected',
    attention: 'Attention required',
    issues: 'Issues detected',
    unavailable: 'Details unavailable',
  }[status];
  return { id, title, status, summary, checks, facts };
}

/** Health & capabilities scan shown in the setup wizard and on the dashboard. */
export async function scanHardware(ctx: AppContext, storage?: StorageOverview): Promise<HardwareScan> {
  const client = ctx.truenas.client();
  const system = await getSystemSummary(ctx);
  const overview = storage ?? (await getStorage(ctx));
  const docker = await client.call<TnDockerStatus>('docker.status').catch(() => null);
  const virt = await client
    .call<{ supported: boolean; error: string | null }>('vm.virtualization_details')
    .catch(() => null);

  // System
  const sysChecks: ScanCheck[] = [];
  if (!isSupportedVersion(system.version)) {
    sysChecks.push({
      id: 'truenas-version',
      severity: 'error',
      title: 'Unsupported TrueNAS version',
      detail: `This server runs TrueNAS ${system.version}. ApexOs supports TrueNAS SCALE 25.10 up to 26.x.`,
    });
  }
  if (system.memoryBytes < 8 * GiB * 0.95) {
    sysChecks.push({
      id: 'memory-low',
      severity: 'warning',
      title: 'Less than 8 GB of memory',
      detail: 'TrueNAS works best with at least 8 GB of RAM. Apps will have little room.',
    });
  }
  const bootUsb = overview.bootDrives.some((d) => d.kind === 'USB');
  if (bootUsb) {
    sysChecks.push({
      id: 'boot-usb',
      severity: 'warning',
      title: 'System installed on a USB stick',
      detail: 'USB sticks wear out quickly as boot drives. A small SSD is much more reliable.',
    });
  }
  if (!system.eccMemory) {
    sysChecks.push({
      id: 'no-ecc',
      severity: 'info',
      title: 'Memory without error correction (ECC)',
      detail: 'This is normal for home hardware. ECC memory adds protection against rare memory errors.',
    });
  }
  const sysFacts = [
    { label: 'Processor', value: `${system.cpuModel} (${system.cores} threads)` },
    { label: 'Memory', value: `${Math.round(system.memoryBytes / GiB)} GB` },
    { label: 'TrueNAS', value: system.version },
  ];
  if (system.manufacturer || system.product) sysFacts.push({ label: 'Motherboard', value: [system.manufacturer, system.product].filter(Boolean).join(' ') });

  // Storage
  const stChecks: ScanCheck[] = [];
  for (const pool of overview.pools) {
    if (pool.health !== 'healthy') {
      stChecks.push({
        id: `pool-health-${pool.name}`,
        severity: pool.health === 'offline' || pool.health === 'errors' ? 'error' : 'warning',
        title: `Pool ${pool.displayName} is not healthy`,
        detail: pool.healthDetail ?? `ZFS reports ${pool.zfsStatus}.`,
      });
    }
    if (!pool.scrubScheduled) {
      stChecks.push({
        id: `pool-scrub-${pool.name}`,
        severity: 'warning',
        title: `Pool ${pool.displayName} has no scheduled health check`,
        detail: 'Regular checks (scrubs) find and repair silent damage. ApexOs schedules one when you finish setup.',
      });
    }
  }
  const allDrives = [...overview.unassigned, ...overview.pools.flatMap((p) => p.drives)];
  const smr = allDrives.filter((d) => d.warnings.includes('SMR'));
  if (smr.length) {
    stChecks.push({
      id: 'smr',
      severity: 'warning',
      title: `${smr.length === 1 ? 'A drive uses' : `${smr.length} drives use`} SMR recording`,
      detail: `${smr.map((d) => `${d.model} (${d.serial})`).join(', ')}: shingled (SMR) drives can be extremely slow to rebuild in a pool. Prefer CMR drives for protected pools.`,
    });
  }
  const withData = overview.unassigned.filter((d) => d.warnings.includes('EXISTING_DATA'));
  if (withData.length) {
    stChecks.push({
      id: 'existing-data',
      severity: 'info',
      title: `${withData.length === 1 ? 'A drive contains' : `${withData.length} drives contain`} existing data`,
      detail: withData
        .map((d) => `${d.model} (${d.serial})${d.exportedPool ? ` holds the pool "${d.exportedPool}"` : ' has partitions'}`)
        .join('; ') + '. Using these drives for a new pool erases them.',
    });
  }
  const dupes = allDrives.filter((d) => d.warnings.includes('DUPLICATE_SERIAL'));
  if (dupes.length) {
    stChecks.push({
      id: 'duplicate-serial',
      severity: 'warning',
      title: 'Drives report duplicate serial numbers',
      detail: 'This usually means a USB enclosure hides the real serials. Pools on such enclosures are risky.',
    });
  }
  const usable = overview.unassigned.filter((d) => d.available);
  if (!overview.pools.length && !usable.length) {
    stChecks.push({
      id: 'no-drives',
      severity: 'error',
      title: 'No drives available for storage',
      detail: 'Connect at least one drive besides the one TrueNAS is installed on.',
    });
  }
  const stFacts = [
    { label: 'Drives', value: `${allDrives.length + overview.bootDrives.length} (${overview.bootDrives.length} for the system)` },
    { label: 'Pools', value: String(overview.pools.length) },
    { label: 'Free drives', value: String(usable.length) },
  ];

  // Applications
  const appChecks: ScanCheck[] = [];
  if (system.memoryBytes < 16 * GiB * 0.95) {
    appChecks.push({
      id: 'apps-memory',
      severity: 'info',
      title: 'Limited memory for apps',
      detail: 'With less than 16 GB of RAM, run only a few apps at a time.',
    });
  }
  if (docker && !['RUNNING', 'UNCONFIGURED', 'INITIALIZING', 'PENDING'].includes(docker.status)) {
    appChecks.push({
      id: 'apps-engine',
      severity: 'error',
      title: 'The app engine is not running',
      detail: docker.description || `TrueNAS reports the app engine as ${docker.status}.`,
    });
  }
  const appFacts = [{ label: 'App engine', value: docker ? docker.status.toLowerCase() : 'unknown' }];

  // Virtualization (readiness only; VMs are not part of this release)
  const vmChecks: ScanCheck[] = [];
  if (system.cores < 4) vmChecks.push({ id: 'vm-cores', severity: 'warning', title: 'Fewer than 4 CPU threads', detail: 'Virtual machines need at least 4 threads.' });
  if (system.memoryBytes < 8 * GiB * 0.95) vmChecks.push({ id: 'vm-memory', severity: 'warning', title: 'Less than 8 GB of memory', detail: 'Virtual machines need at least 8 GB of RAM.' });
  if (virt && !virt.supported) {
    vmChecks.push({
      id: 'vm-disabled',
      severity: 'warning',
      title: 'Virtualization is turned off',
      detail: virt.error ?? 'Enable virtualization (Intel VT-x / AMD-V) in the BIOS to run virtual machines.',
    });
  }

  return {
    system,
    cards: [
      card('system', 'System', sysChecks, sysFacts),
      card('storage', 'Storage', stChecks, stFacts),
      card('apps', 'Applications', appChecks, appFacts, docker === null),
      card('virtualization', 'Virtualization', vmChecks, [{ label: 'CPU threads', value: String(system.cores) }], virt === null && vmChecks.length === 0),
    ],
  };
}

/** Sets the hostname and the SMB (NetBIOS) name so the server shows up under the same name everywhere. */
export async function setServerName(ctx: AppContext, name: string): Promise<void> {
  const client = ctx.truenas.client();
  await client.call('network.configuration.update', [{ hostname: name }]);
  await client.call('smb.update', [{ netbiosname: name }]);
  await ctx.store.update((s) => {
    s.server.name = name;
  });
  ctx.bus.changed('system');
}

export async function getTimezone(ctx: AppContext): Promise<TimezoneInfo> {
  const client = ctx.truenas.client();
  const [config, choices] = await Promise.all([
    client.call<{ timezone: string }>('system.general.config'),
    client.call<Record<string, string>>('system.general.timezone_choices'),
  ]);
  return { timezone: config.timezone, choices: Object.keys(choices).sort() };
}

export async function setTimezone(ctx: AppContext, timezone: string): Promise<void> {
  const { choices } = await getTimezone(ctx);
  if (!choices.includes(timezone)) throw new UserError('Unknown time zone', 400, 'VALIDATION', { timezone: 'Pick a time zone from the list' });
  await ctx.truenas.client().call('system.general.update', [{ timezone }]);
}

export async function getNetwork(ctx: AppContext): Promise<NetworkInfo> {
  const client = ctx.truenas.client();
  const [config, summary, interfaces] = await Promise.all([
    client.call<{ hostname: string }>('network.configuration.config'),
    client.call<{ default_routes: string[]; nameservers: string[] }>('network.general.summary'),
    client.call<TnInterface[]>('interface.query'),
  ]);
  return {
    hostname: config.hostname,
    gateway: summary.default_routes ?? [],
    nameservers: summary.nameservers ?? [],
    interfaces: interfaces.map((i) => {
      const speed = i.state.active_media_subtype?.match(/(\d+)\s*(G|M)b/i);
      return {
        name: i.name,
        type: i.type,
        linkUp: i.state.link_state === 'LINK_STATE_UP',
        speedMbps: speed ? Number(speed[1]) * (speed[2]!.toUpperCase() === 'G' ? 1000 : 1) : null,
        mac: i.state.link_address,
        dhcp: i.ipv4_dhcp,
        addresses: i.state.aliases.filter((a) => a.type === 'INET' || a.type === 'INET6').map((a) => `${a.address}${a.netmask !== undefined ? `/${a.netmask}` : ''}`),
      };
    }),
  };
}

export async function getUpdateInfo(ctx: AppContext, storage?: StorageOverview): Promise<UpdateInfo> {
  const client = ctx.truenas.client();
  const [version, status] = await Promise.all([
    client.call<string>('system.version_short'),
    client.call<TnUpdateStatus>('update.status').catch((err: Error) => ({ code: 'ERROR', status: null, error: { reason: err.message } }) as TnUpdateStatus),
  ]);
  const supported = isSupportedVersion(version);
  const atRisk = anyPoolAtRisk(storage ?? (await getStorage(ctx)));
  const next = status.status?.new_version ?? null;
  return {
    currentVersion: version,
    supported,
    supportNote: supported ? null : 'ApexOs supports TrueNAS SCALE 25.10 up to 26.x. Some features may not work.',
    available: next ? { version: next.version, releaseNotesUrl: next.release_notes_url } : null,
    riskWarning: atRisk ? `Pool ${atRisk.displayName} is ${atRisk.health}. Restarting now could make things worse.` : null,
    error: status.code === 'ERROR' ? (status.error?.reason ?? 'Could not check for updates') : null,
  };
}

export async function assertRiskAcknowledged(ctx: AppContext, acknowledged: boolean | undefined): Promise<void> {
  const atRisk = anyPoolAtRisk(await getStorage(ctx));
  if (atRisk && !acknowledged) {
    throw new UserError(
      `Pool ${atRisk.displayName} is ${atRisk.health}. Confirm that you understand the risk to continue.`,
      409,
      'RISK_NOT_ACKNOWLEDGED',
    );
  }
}

export async function power(ctx: AppContext, action: 'restart' | 'shutdown'): Promise<void> {
  const method = action === 'restart' ? 'system.reboot' : 'system.shutdown';
  // A job; the server goes away before it "finishes", so don't wait for it.
  await ctx.truenas.client().call(method, [`Requested from ApexOs by the administrator`, { delay: 3 }]);
}
