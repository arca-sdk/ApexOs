/**
 * Scenario seeding. Both scenarios share the hardware from `freshState()` plus the exported "oldtank"
 * pool on sdf. "configured" additionally builds a set-up system through the same internal operations
 * the RPC methods use, so its entries look exactly like ones created through the API.
 */
import { syncAllAlerts } from './alerts.ts';
import type { Mock } from './context.ts';
import { createIxAppsDatasets, installAppInternal } from './methods/apps.ts';
import { createUser } from './methods/accounts.ts';
import { createPoolInternal, exportPoolInternal, resolvedFromNames } from './methods/pools.ts';
import { createShare, setShareAcl } from './methods/smb.ts';
import { catalogApp, type FsNode } from './state.ts';
import { addDataset, getDataset } from './storage.ts';
import { GiB, MiB, previousVersion, TiB } from './util.ts';

const DAY = 86400_000;

function files(base: string, entries: Array<[name: string, type: 'DIRECTORY' | 'FILE', size?: number]>, mtime: number): FsNode[] {
  return entries.map(([name, type, size]) => ({ path: `${base}/${name}`, type, size: size ?? (type === 'DIRECTORY' ? 4 : 0), mtime }));
}

/** An importable pool left behind by the previous NAS ("old-nas") on the 4 TB WD Red (sdf). */
export function seedOldtank(mock: Mock): void {
  const { state } = mock;
  const created = Date.UTC(2019, 4, 11, 9, 30);
  const pool = createPoolInternal(mock, 'oldtank', resolvedFromNames(mock, { data: [{ type: 'STRIPE', disks: ['sdf'] }] }), false);
  pool.createdAt = created;
  pool.scan = {
    function: 'SCRUB',
    state: 'FINISHED',
    start_time: Date.UTC(2025, 1, 2, 0, 0),
    end_time: Date.UTC(2025, 1, 2, 6, 41),
    percentage: 100,
    bytes_to_process: Math.round(1.16 * TiB),
    bytes_processed: Math.round(1.16 * TiB),
    bytes_issued: Math.round(1.16 * TiB),
    pause: null,
    errors: 0,
    total_secs_left: null,
  };
  const root = getDataset(state, 'oldtank');
  if (root) root.createdAt = created;
  addDataset(mock, { id: 'oldtank/Backups', usedBytes: Math.round(820 * GiB), createdAt: created + DAY }, false);
  addDataset(mock, { id: 'oldtank/Old-Photos', usedBytes: Math.round(310 * GiB), createdAt: created + 2 * DAY }, false);
  const mtime = Date.UTC(2024, 10, 3, 18, 0);
  state.fs.nodes.push(
    ...files('/mnt/oldtank/Backups', [['laptop-2023', 'DIRECTORY'], ['phone-backup-2024.tar', 'FILE', Math.round(58 * GiB)]], mtime),
    ...files('/mnt/oldtank/Old-Photos', [['2018', 'DIRECTORY'], ['2019', 'DIRECTORY'], ['2020', 'DIRECTORY'], ['Wedding', 'DIRECTORY']], mtime),
  );
  exportPoolInternal(mock, pool, { destroy: false, cascade: false });
  const rec = state.exportedPools.find((e) => e.pool.name === 'oldtank');
  if (rec) rec.hostname = 'old-nas';
  // The seed must not consume ids a fresh box would hand out first.
  state.nextIds.pool = 1;
  state.nextIds.scrubTask = 1;
}

export function seedConfigured(mock: Mock): void {
  const { state } = mock;
  const setupDay = Date.now() - 45 * DAY;
  state.scenario = 'configured';
  state.system.wizardshown = true;
  state.catalog.synced = true;

  const hdds = createPoolInternal(mock, 'HDDs', resolvedFromNames(mock, { data: [{ type: 'RAIDZ1', disks: ['sdb', 'sdc', 'sdd', 'sde'] }] }), false);
  const ssds = createPoolInternal(mock, 'SSDs', resolvedFromNames(mock, { data: [{ type: 'MIRROR', disks: ['nvme0n1', 'nvme1n1'] }] }), false);
  for (const p of [hdds, ssds]) {
    p.createdAt = setupDay;
    const root = getDataset(state, p.name);
    if (root) root.createdAt = setupDay;
  }
  const scrubbed = Date.now() - 3 * DAY;
  hdds.scan = {
    function: 'SCRUB',
    state: 'FINISHED',
    start_time: scrubbed,
    end_time: scrubbed + 7.5 * 3600_000,
    percentage: 100,
    bytes_to_process: Math.round(2.8 * TiB),
    bytes_processed: Math.round(2.8 * TiB),
    bytes_issued: Math.round(2.8 * TiB),
    pause: null,
    errors: 0,
    total_secs_left: null,
  };

  // Folders (SMB datasets) and app storage
  const folders: Array<[string, number]> = [
    ['HDDs/Media', Math.round(2.4 * TiB)],
    ['HDDs/Photos', Math.round(412 * GiB)],
    ['HDDs/Documents', Math.round(38 * GiB)],
  ];
  for (const [id, used] of folders) addDataset(mock, { id, share_type: 'SMB', usedBytes: used, createdAt: setupDay + 3600_000 }, false);
  addDataset(mock, { id: 'SSDs/Applications', share_type: 'APPS', usedBytes: Math.round(12 * GiB), createdAt: setupDay + 3600_000 }, false);

  const mtime = Date.now() - 2 * DAY;
  state.fs.nodes.push(
    ...files('/mnt/HDDs/Media', [['Movies', 'DIRECTORY'], ['TV Shows', 'DIRECTORY'], ['Music', 'DIRECTORY'], ['Audiobooks', 'DIRECTORY']], mtime),
    ...files('/mnt/HDDs/Photos', [['2024', 'DIRECTORY'], ['2025', 'DIRECTORY'], ['2026', 'DIRECTORY'], ['IMG_4821.HEIC', 'FILE', 3_481_220]], mtime),
    ...files(
      '/mnt/HDDs/Documents',
      [['Taxes', 'DIRECTORY'], ['Recipes', 'DIRECTORY'], ['passport-scan.pdf', 'FILE', 1_204_331], ['budget-2026.xlsx', 'FILE', 88_120]],
      mtime,
    ),
  );

  // Share user and shares
  const { user: alice } = createUser(mock, { username: 'alice', full_name: 'Alice', password: 'alice-password', group_create: true, smb: true }, false);
  alice.last_password_change = setupDay + 7200_000;
  for (const name of ['Media', 'Photos', 'Documents']) createShare(mock, { name, path: `/mnt/HDDs/${name}`, purpose: 'DEFAULT_SHARE' }, false);
  for (const name of ['Photos', 'Documents']) {
    setShareAcl(mock, name, [{ ae_who_id: { id_type: 'USER', id: alice.uid }, ae_perm: 'FULL', ae_type: 'ALLOWED' }]);
    state.fs.acls[`/mnt/HDDs/${name}`] = {
      acltype: 'NFS4',
      acl: [
        { tag: 'owner@', id: -1, type: 'ALLOW', perms: { BASIC: 'FULL_CONTROL' }, flags: { BASIC: 'INHERIT' } },
        { tag: 'group@', id: -1, type: 'ALLOW', perms: { BASIC: 'MODIFY' }, flags: { BASIC: 'INHERIT' } },
        { tag: 'GROUP', id: 544, type: 'ALLOW', perms: { BASIC: 'FULL_CONTROL' }, flags: { BASIC: 'INHERIT' } },
        { tag: 'USER', id: alice.uid, type: 'ALLOW', perms: { BASIC: 'MODIFY' }, flags: { BASIC: 'INHERIT' } },
      ],
      aclflags: { autoinherit: false, protected: false, defaulted: false },
      trivial: false,
    };
  }
  const cifs = state.services.find((s) => s.service === 'cifs');
  if (cifs) Object.assign(cifs, { enable: true, state: 'RUNNING' });

  // Apps on the SSD pool, with jellyfin one catalog version behind
  state.docker.pool = 'SSDs';
  state.docker.status = 'RUNNING';
  const docker = state.services.find((s) => s.service === 'docker');
  if (docker) Object.assign(docker, { enable: true, state: 'RUNNING' });
  createIxAppsDatasets(mock, 'SSDs', false);
  const jellyfin = catalogApp('jellyfin', 'community');
  if (jellyfin) {
    installAppInternal(mock, {
      name: 'jellyfin',
      catalogApp: 'jellyfin',
      train: 'community',
      version: previousVersion(jellyfin.latest_version),
      values: {
        storage: {
          additional_storage: [
            { type: 'host_path', read_only: false, mount_path: '/media', host_path_config: { acl_enable: false, path: '/mnt/HDDs/Media' } },
          ],
        },
      },
    });
  }
  const ixApps = getDataset(state, 'SSDs/ix-apps/docker');
  if (ixApps) ixApps.usedBytes += Math.round(600 * MiB);
}

export function seedScenario(mock: Mock, scenario: 'fresh' | 'configured'): void {
  seedOldtank(mock);
  if (scenario === 'configured') seedConfigured(mock);
  syncAllAlerts(mock);
}
