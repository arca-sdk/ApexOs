/**
 * @apexos/mock-truenas: an in-memory, stateful simulation of the TrueNAS SCALE 25.10 middleware
 * JSON-RPC 2.0 websocket API, for integration tests and ApexOs's demo mode.
 */
import { registerAlerts, syncAllAlerts, syncPoolAlerts } from './alerts.ts';
import { Mock, type MockConfig } from './context.ts';
import { registerEvents } from './events.ts';
import { registerAccounts } from './methods/accounts.ts';
import { registerApps } from './methods/apps.ts';
import { registerAuth } from './methods/auth.ts';
import { registerCron } from './methods/cron.ts';
import { registerDatasets } from './methods/datasets.ts';
import { checkTemperatureAlert, registerDisks } from './methods/disks.ts';
import { registerFilesystem } from './methods/filesystem.ts';
import { registerNetwork } from './methods/network.ts';
import { registerPools } from './methods/pools.ts';
import { registerServices } from './methods/services.ts';
import { registerSmb } from './methods/smb.ts';
import { registerSystem } from './methods/system.ts';
import { normalizeLoadedState, StateStore } from './persist.ts';
import { RpcServer } from './rpc.ts';
import { seedScenario } from './scenario.ts';
import { freshState, type DiskState, type MockState, type SmartState } from './state.ts';
import { diskByName, emitPool, findLeafByDisk, renderDisk } from './storage.ts';
import { HEALTHY_SMART } from './host.ts';
import { randomHex, randomString } from './util.ts';

export { API_VERSIONS, CallError, callError, queryFilter, RpcServer, validationError, validationErrors } from './rpc.ts';
export type { EventSourceContext, JobControl, MethodContext, MockJob } from './rpc.ts';
export type { MockState } from './state.ts';
export { CATALOG, CATALOG_COMMIT } from './state.ts';

export interface MockOptions {
  /** TCP port (0 or omitted: random free port). */
  port?: number;
  /** Bind address (default 127.0.0.1). */
  host?: string;
  /** API key accepted for the admin user (default 'demo-api-key'). */
  apiKey?: string;
  /** Admin account (default 'truenas_admin'). */
  adminUsername?: string;
  /** Admin password (default 'demo-password'). */
  adminPassword?: string;
  /** Delay per simulated job step in ms (default 150; tests use 0 or 1). */
  jobDelayMs?: number;
  /** Load state from / save state to this JSON file (debounced, atomic). */
  stateFile?: string;
  /** Seed used when there is no saved state (default 'fresh'). */
  scenario?: 'fresh' | 'configured';
}

export type DriveFailure = 'FAULTED' | 'REMOVED' | 'UNAVAIL' | 'OFFLINE';

export interface MockTrueNas {
  /** e.g. ws://127.0.0.1:PORT/api/current (/api/v25.10.x paths are served too). */
  url: string;
  /** e.g. http://127.0.0.1:PORT (serves GET /api/versions and /api/boot_id). */
  baseUrl: string;
  /** Live state; mutate it freely in tests (call `save()` afterwards when using a state file). */
  readonly state: MockState;
  server: RpcServer;
  close(): Promise<void>;
  /**
   * Simulates a failing pool member: FAULTED (I/O errors), REMOVED (pulled; disappears from disk.query),
   * UNAVAIL or OFFLINE. The pool becomes DEGRADED (or UNAVAIL) and a VolumeStatus alert is raised.
   */
  failDrive(name: string, mode?: DriveFailure): void;
  /** Brings a failed or pulled drive back ONLINE with cleared error counters. */
  restoreDrive(name: string): void;
  /** Overrides a disk's temperature (null restores the simulated value); raises/clears DiskTemperatureTooHot. */
  setDiskTemperature(name: string, celsius: number | null): void;
  /** Hot-plugs a new disk (default: another 8 TB IronWolf) and returns its kernel name. */
  addDisk(spec?: Partial<Pick<DiskState, 'model' | 'size' | 'type' | 'rotationrate' | 'serial' | 'bus'>>): string;
  /** Adds read/write/checksum errors to a pool member (as ZFS would after I/O or checksum failures). */
  addDriveErrors(name: string, errors: Partial<{ read: number; write: number; checksum: number }>): void;
  /** Overrides what smartctl reports for a disk (merged into healthy defaults). */
  setSmart(name: string, smart: Partial<SmartState>): void;
  /** Sets the files `zpool status -v` lists as permanently damaged for a pool (empty array clears). */
  setDataErrors(pool: string, files: string[]): void;
  /** Damage the next finished scrub of the pool discovers (added to the `zpool status -v` list then). */
  addLatentDataErrors(pool: string, files: string[]): void;
  /** Mail the simulated middleware sent (cron output to users with an e-mail address). */
  readonly mailLog: readonly { to: string; subject: string; text: string }[];
  /** Writes the state file now (no-op without `stateFile`). */
  save(): void;
}

export async function startMockTrueNas(opts: MockOptions = {}): Promise<MockTrueNas> {
  const config: MockConfig = {
    apiKey: opts.apiKey ?? 'demo-api-key',
    adminUsername: opts.adminUsername ?? 'truenas_admin',
    adminPassword: opts.adminPassword ?? 'demo-password',
    jobDelayMs: opts.jobDelayMs ?? 150,
    scenario: opts.scenario ?? 'fresh',
  };
  const host = opts.host ?? '127.0.0.1';
  const server = new RpcServer({ port: opts.port, host, jobDelayMs: config.jobDelayMs });
  const store = opts.stateFile ? new StateStore(opts.stateFile) : null;
  const loaded = store?.load() ?? null;
  const mock = new Mock(loaded ?? freshState(config), server, config);
  if (loaded) {
    normalizeLoadedState(loaded);
    ensureApiKey(mock);
    syncAllAlerts(mock);
  } else {
    seedScenario(mock, config.scenario);
  }

  registerSystem(mock);
  registerNetwork(mock);
  registerAuth(mock);
  registerAccounts(mock);
  registerDisks(mock);
  registerPools(mock);
  registerDatasets(mock);
  registerSmb(mock);
  registerServices(mock);
  registerFilesystem(mock);
  registerApps(mock);
  registerCron(mock);
  registerAlerts(mock);
  registerEvents(mock);

  const persist = () => store?.schedule(() => mock.state);
  server.onActivity(persist);

  const url = await server.listen();
  store?.save(mock.state);

  const requireDisk = (name: string): DiskState => {
    const d = diskByName(mock.state, name) ?? mock.state.disks.find((x) => x.name === name);
    if (!d) throw new Error(`No disk named ${name}`);
    return d;
  };

  return {
    url,
    baseUrl: `http://${host}:${server.port}`,
    get state() {
      return mock.state;
    },
    server,
    async close() {
      await server.close();
      store?.close(mock.state);
    },
    failDrive(name, mode = 'FAULTED') {
      const d = requireDisk(name);
      if (d.boot) throw new Error('Failing the boot disk is not simulated');
      const ref = findLeafByDisk(mock.state, d.identifier);
      if (!ref) throw new Error(`${name} is not part of an imported pool`);
      ref.leaf.status = mode;
      if (mode === 'FAULTED') ref.leaf.errors = { read: 3, write: 117, checksum: 0 };
      if (mode === 'REMOVED') {
        d.present = false;
        mock.emit('disk.query', 'removed', d.identifier);
      }
      emitPool(mock, ref.pool);
      syncPoolAlerts(mock);
      persist();
    },
    restoreDrive(name) {
      const d = requireDisk(name);
      d.present = true;
      d.expiretime = null;
      const ref = findLeafByDisk(mock.state, d.identifier);
      if (ref) {
        ref.leaf.status = ref.category === 'spare' ? 'AVAIL' : 'ONLINE';
        ref.leaf.errors = { read: 0, write: 0, checksum: 0 };
        emitPool(mock, ref.pool);
      }
      mock.emit('disk.query', 'changed', d.identifier, renderDisk(mock.state, d, false));
      syncPoolAlerts(mock);
      persist();
    },
    setDiskTemperature(name, celsius) {
      const d = requireDisk(name);
      d.tempOverride = celsius;
      checkTemperatureAlert(mock, d);
      persist();
    },
    addDisk(spec = {}) {
      const { state } = mock;
      const used = new Set(state.disks.map((d) => d.name));
      let letter = 'h';
      while (used.has(`sd${letter}`)) letter = String.fromCharCode(letter.charCodeAt(0) + 1);
      const name = `sd${letter}`;
      const serial = spec.serial ?? `ZR1${randomString(5).toUpperCase()}`;
      const lunid = `5000c500${randomHex(4)}`;
      const disk: DiskState = {
        identifier: `{serial_lunid}${serial}_${lunid}`,
        name,
        serial,
        lunid,
        model: spec.model ?? 'ST8000VN004-2M2101',
        size: spec.size ?? 8001563222016,
        type: spec.type ?? 'HDD',
        rotationrate: spec.rotationrate === undefined ? 7200 : spec.rotationrate,
        bus: spec.bus ?? 'ATA',
        subsystem: 'scsi',
        number: 8 * 256 + (letter.charCodeAt(0) - 97) * 16,
        description: '',
        hddstandby: 'ALWAYS ON',
        advpowermgmt: 'DISABLED',
        zfs_guid: null,
        baseTemp: (spec.type ?? 'HDD') === 'HDD' ? 35 : 32,
        tempOverride: null,
        criticalTemp: 70,
        present: true,
        expiretime: null,
        foreignPartitions: [],
        boot: false,
      };
      state.disks.push(disk);
      mock.emit('disk.query', 'added', disk.identifier, renderDisk(state, disk, false));
      persist();
      return name;
    },
    addDriveErrors(name, errors) {
      const ref = findLeafByDisk(mock.state, requireDisk(name).identifier);
      if (!ref) throw new Error(`${name} is not part of an imported pool`);
      ref.leaf.errors = {
        read: ref.leaf.errors.read + (errors.read ?? 0),
        write: ref.leaf.errors.write + (errors.write ?? 0),
        checksum: ref.leaf.errors.checksum + (errors.checksum ?? 0),
      };
      emitPool(mock, ref.pool);
      syncPoolAlerts(mock);
      persist();
    },
    setSmart(name, smart) {
      const d = requireDisk(name);
      d.smart = { ...HEALTHY_SMART, ...d.smart, ...smart };
      persist();
    },
    setDataErrors(poolName, files) {
      const pool = mock.state.pools.find((p) => p.name === poolName);
      if (!pool) throw new Error(`No pool named ${poolName}`);
      if (files.length) pool.dataErrors = [...files];
      else delete pool.dataErrors;
      emitPool(mock, pool);
      syncPoolAlerts(mock);
      persist();
    },
    addLatentDataErrors(poolName, files) {
      const pool = mock.state.pools.find((p) => p.name === poolName);
      if (!pool) throw new Error(`No pool named ${poolName}`);
      pool.latentDataErrors = [...(pool.latentDataErrors ?? []), ...files];
      persist();
    },
    get mailLog() {
      return mock.mailLog;
    },
    save() {
      store?.save(mock.state);
    },
  };
}

/** A loaded state keeps its own keys and passwords, but the configured API key must keep working. */
function ensureApiKey(mock: Mock): void {
  const { state, config } = mock;
  if (state.apiKeys.some((k) => k.key === config.apiKey)) return;
  const admin = state.users.find((u) => u.username === config.adminUsername) ? config.adminUsername : 'truenas_admin';
  state.apiKeys.push({
    id: state.nextIds.apiKey++,
    name: `apexos-${state.nextIds.apiKey}`,
    username: admin,
    key: config.apiKey,
    created_at: Date.now(),
    expires_at: null,
    revoked: false,
    revoked_reason: null,
  });
}
