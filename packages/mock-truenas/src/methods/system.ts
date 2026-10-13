import { randomUUID } from 'node:crypto';
import { syncUpdateAlert } from '../alerts.ts';
import type { Mock } from '../context.ts';
import { validationError, validationErrors } from '../rpc.ts';
import { $date, argObj, round, timedeltaStr, type Obj } from '../util.ts';
import { unlockAfterBoot } from './encryption.ts';

export const TIMEZONES = [
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Bogota',
  'America/Chicago',
  'America/Denver',
  'America/Halifax',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'America/Sao_Paulo',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Bangkok',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Jerusalem',
  'Asia/Kolkata',
  'Asia/Manila',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Atlantic/Reykjavik',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Berlin',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Honolulu',
  'UTC',
];

const UPDATE_TRAIN = 'TrueNAS-SCALE-Goldeye';
const RELEASE_NOTES = 'https://www.truenas.com/docs/scale/25.10/gettingstarted/scalereleasenotes/';

export function systemInfo(mock: Mock): Obj {
  const { state } = mock;
  const uptime = (Date.now() - mock.bootTime) / 1000;
  const load = 0.18 + Math.random() * 0.25 + state.apps.filter((a) => a.state === 'RUNNING').length * 0.08;
  return {
    version: state.system.version,
    buildtime: $date(state.system.buildtime),
    hostname: state.network.hostname,
    physmem: 32 * 1024 ** 3,
    model: 'AMD Ryzen 5 5600G with Radeon Graphics',
    cores: 12,
    physical_cores: 6,
    loadavg: [round(load, 2), round(load * 0.9, 2), round(load * 0.8, 2)],
    uptime: timedeltaStr(uptime),
    uptime_seconds: round(uptime, 2),
    system_serial: state.system.system_serial,
    system_product: 'B550M Pro4',
    system_product_version: 'To Be Filled By O.E.M.',
    license: null,
    boottime: $date(mock.bootTime),
    datetime: $date(Date.now()),
    timezone: state.system.timezone,
    system_manufacturer: 'ASRock',
    ecc_memory: false,
  };
}

function generalConfig(mock: Mock): Obj {
  const s = mock.state.system;
  return {
    id: 1,
    ui_certificate: {
      id: 1,
      type: 8,
      name: 'truenas_default',
      certificate_path: '/etc/certificates/truenas_default.crt',
      privatekey_path: '/etc/certificates/truenas_default.key',
      issuer: 'external',
      common: 'localhost',
      san: ['DNS:localhost'],
      from: 'Mon Oct 12 10:00:00 2026',
      until: 'Sun Nov 12 10:00:00 2027',
      expired: false,
    },
    ui_httpsport: s.ui_httpsport,
    ui_httpsredirect: s.ui_httpsredirect,
    ui_httpsprotocols: ['TLSv1.2', 'TLSv1.3'],
    ui_port: s.ui_port,
    ui_address: ['0.0.0.0'],
    ui_v6address: ['::'],
    ui_allowlist: [],
    ui_consolemsg: s.ui_consolemsg,
    ui_x_frame_options: 'SAMEORIGIN',
    kbdmap: s.kbdmap,
    timezone: s.timezone,
    usage_collection: s.usage_collection,
    wizardshown: s.wizardshown,
    usage_collection_is_set: s.usage_collection !== null,
    ds_auth: false,
  };
}

export function updateStatus(mock: Mock, progress: Obj | null = null): Obj {
  const available = mock.state.system.update.available;
  return {
    code: 'NORMAL',
    status: {
      current_version: { train: UPDATE_TRAIN, profile: mock.state.system.update.profile, matches_profile: true },
      new_version: available
        ? {
            version: available,
            manifest: { filename: `TrueNAS-SCALE-${available}.update`, version: available, date: '2026-10-28T00:00:00', changelog: '', checksum: '9c3f2a51d7b84e06a1c5f8e2d4b7a90c3e6f1d8b2a5c7e9f0b4d6a8c1e3f5a7b', filesize: 1745623040, profile: 'GENERAL', train: UPDATE_TRAIN },
            release_notes: null,
            release_notes_url: `${RELEASE_NOTES}#${available.replaceAll('.', '')}`,
          }
        : null,
    },
    error: null,
    update_download_progress: progress,
  };
}

/**
 * Simulated reboot: uptime and boot id reset; connections stay up. Encrypted datasets come back the way the
 * middleware unlocks them at boot: key-encrypted ones with their stored keys, passphrase ones stay locked.
 */
export function simulateReboot(mock: Mock): void {
  mock.bootTime = Date.now();
  mock.server.bootId = randomUUID();
  unlockAfterBoot(mock);
}

function requireReason(params: unknown[], method: string): void {
  if (typeof params[0] !== 'string' || !params[0].trim()) throw validationError(`${method}.reason`, 'Field required');
}

export function registerSystem(mock: Mock): void {
  const { server } = mock;
  server.method('system.info', () => systemInfo(mock));
  server.method('system.version', () => `TrueNAS-${mock.state.system.version}`);
  server.method('system.version_short', () => mock.state.system.version);
  server.method('system.release_notes_url', () => `${RELEASE_NOTES}#${mock.state.system.version.replaceAll('.', '')}`);
  server.method('system.product_type', () => 'COMMUNITY_EDITION');
  server.method('system.state', () => 'READY');
  server.method('system.ready', () => true);
  server.method('system.boot_id', () => server.bootId);
  server.method('system.host_id', () => '6f2b1a4c9d8e4f0a8b7c6d5e4f3a2b1c');
  server.method('system.is_stable', () => true);

  server.job(
    'system.reboot',
    async (_p, job) => {
      job.progress(50, 'Rebooting');
      await job.sleep(2);
      simulateReboot(mock);
      return null;
    },
    (p) => requireReason(p, 'system_reboot'),
  );
  server.job(
    'system.shutdown',
    async (_p, job) => {
      job.progress(50, 'Shutting down');
      await job.sleep(1);
      return null;
    },
    (p) => requireReason(p, 'system_shutdown'),
  );

  server.method('system.general.config', () => generalConfig(mock));
  server.method('system.general.timezone_choices', () => Object.fromEntries(TIMEZONES.map((t) => [t, t])));
  server.method('system.general.kbdmap_choices', () => ({ us: 'English (US)', gb: 'English (UK)', de: 'German', fr: 'French', es: 'Spanish' }));
  server.method('system.general.ui_restart', () => null);
  server.method('system.general.checkin', () => null);
  server.method('system.general.update', (p) => {
    const data = argObj(p[0], 'general_settings');
    const s = mock.state.system;
    const errors: Array<[string, string]> = [];
    for (const key of ['id', 'wizardshown', 'usage_collection_is_set']) {
      if (key in data) errors.push([`general_settings.${key}`, 'Extra inputs are not permitted']);
    }
    if ('timezone' in data && (typeof data.timezone !== 'string' || !TIMEZONES.includes(data.timezone))) {
      errors.push(['general_settings.timezone', 'Timezone not known.']);
    }
    for (const key of ['ui_port', 'ui_httpsport'] as const) {
      if (key in data && (typeof data[key] !== 'number' || (data[key] as number) < 1 || (data[key] as number) > 65535)) {
        errors.push([`general_settings.${key}`, 'Input should be a valid port number']);
      }
    }
    if (errors.length) throw validationErrors(errors);
    if (typeof data.timezone === 'string') s.timezone = data.timezone;
    if (typeof data.kbdmap === 'string') s.kbdmap = data.kbdmap;
    if (typeof data.usage_collection === 'boolean') s.usage_collection = data.usage_collection;
    if (typeof data.ui_port === 'number') s.ui_port = data.ui_port;
    if (typeof data.ui_httpsport === 'number') s.ui_httpsport = data.ui_httpsport;
    if (typeof data.ui_httpsredirect === 'boolean') s.ui_httpsredirect = data.ui_httpsredirect;
    if (typeof data.ui_consolemsg === 'boolean') s.ui_consolemsg = data.ui_consolemsg;
    return generalConfig(mock);
  });

  // Updates (25.10 model: update.update edits configuration, update.run applies)
  server.method('update.config', () => ({ id: 1, autocheck: mock.state.system.update.autocheck, profile: mock.state.system.update.profile }));
  server.method('update.update', (p) => {
    const data = argObj(p[0], 'update_update');
    const u = mock.state.system.update;
    if ('profile' in data) {
      if (!['DEVELOPER', 'EARLY_ADOPTER', 'GENERAL', 'MISSION_CRITICAL'].includes(String(data.profile))) {
        throw validationError('update_update.profile', "Input should be 'DEVELOPER', 'EARLY_ADOPTER', 'GENERAL' or 'MISSION_CRITICAL'");
      }
      u.profile = String(data.profile);
    }
    if (typeof data.autocheck === 'boolean') u.autocheck = data.autocheck;
    return { id: 1, autocheck: u.autocheck, profile: u.profile };
  });
  server.method('update.profile_choices', () => ({
    DEVELOPER: { name: 'Developer', footnote: '', description: 'Bleeding-edge builds for developers.', available: true },
    EARLY_ADOPTER: { name: 'Early Adopter', footnote: '', description: 'Releases as soon as they are published.', available: true },
    GENERAL: { name: 'General', footnote: '(Default)', description: 'Field-tested releases for general use.', available: true },
    MISSION_CRITICAL: { name: 'Mission Critical', footnote: '', description: 'Mature releases for mission-critical systems.', available: true },
  }));
  server.method('update.status', async () => {
    if (mock.offline) {
      await new Promise((resolve) => setTimeout(resolve, mock.offline?.delayMs ?? 0));
      return {
        code: 'ERROR',
        status: null,
        error: { errname: 'ETIMEDOUT', reason: 'Connection timeout while fetching update manifest' },
        update_download_progress: null,
      };
    }
    return updateStatus(mock);
  });
  server.method('update.available_versions', () => {
    const v = mock.state.system.update.available;
    return v ? [{ train: UPDATE_TRAIN, version: (updateStatus(mock).status as Obj).new_version }] : [];
  });
  server.job('update.download', async (_p, job) => {
    if (!mock.state.system.update.available) return false;
    for (let i = 1; i <= 4; i++) {
      job.progress(i * 25, 'Downloading update');
      await job.sleep();
    }
    return true;
  });
  server.job('update.run', async (p, job) => {
    const opts = argObj(p[0], 'update_run');
    const target = mock.state.system.update.available;
    if (!target) throw validationError('update_run', 'No update available');
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const percent = Math.round((i / steps) * 60);
      const progress = { percent, total: 1745623040, transferred: Math.round((1745623040 * i) / steps) };
      job.progress(percent, 'Downloading update');
      mock.emit('update.status', 'changed', null, { status: updateStatus(mock, progress) });
      await job.sleep();
    }
    job.progress(70, 'Verifying update');
    await job.sleep();
    job.progress(85, 'Installing update');
    await job.sleep(2);
    mock.state.system.version = target;
    mock.state.system.buildtime = Date.now() - 86400_000;
    mock.state.system.update.available = null;
    syncUpdateAlert(mock);
    job.progress(95, opts.reboot === true ? 'Rebooting' : 'Update installed; reboot to activate the new boot environment');
    if (opts.reboot === true) simulateReboot(mock);
    mock.emit('update.status', 'changed', null, { status: updateStatus(mock) });
    return true;
  });

  server.method('core.get_methods', () => {
    const out: Obj = {};
    for (const m of server.listMethods()) {
      out[m.name] = { description: null, examples: {}, item_method: false, no_auth_required: false, filterable: m.name.endsWith('.query'), pass_application: false, require_websocket: false, job: m.job, downloadable: false, uploadable: false, roles: ['FULL_ADMIN'], accepts: [], returns: [] };
    }
    return out;
  });
  server.method('core.get_services', () => {
    const out: Obj = {};
    for (const m of server.listMethods()) {
      const ns = m.name.slice(0, m.name.lastIndexOf('.'));
      out[ns] = { config: {}, type: 'service' };
    }
    return out;
  });
}
