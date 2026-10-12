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
  seedFolderContents(mock, setupDay);

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

function textFile(path: string, text: string, mtime: number): FsNode {
  const bytes = Buffer.from(text, 'utf8');
  return { path, type: 'FILE', size: bytes.length, mtime, sample: bytes.toString('base64') };
}

/** Something to browse in the configured scenario: files of realistic sizes and a child dataset ("Scans"). */
function seedFolderContents(mock: Mock, setupDay: number): void {
  const { state } = mock;
  const ago = (days: number, hours = 0) => Date.now() - days * DAY - hours * 3600_000;
  const add = (base: string, entries: Array<[name: string, type: 'DIRECTORY' | 'FILE', size: number, daysAgo: number]>) =>
    state.fs.nodes.push(...entries.map(([name, type, size, days]) => ({ path: `${base}/${name}`, type, size, mtime: ago(days, (size % 7) + 1) })));
  add('/mnt/HDDs/Media/Movies', [
    ['Big Buck Bunny (2008)', 'DIRECTORY', 4, 30],
    ['Big Buck Bunny (2008)/Big Buck Bunny (2008).mkv', 'FILE', 4_389_202_117, 30],
    ['Big Buck Bunny (2008)/Big Buck Bunny (2008).en.srt', 'FILE', 41_870, 30],
    ['Sintel (2010)', 'DIRECTORY', 3, 21],
    ['Sintel (2010)/Sintel (2010).mkv', 'FILE', 2_146_883_901, 21],
    ['Tears of Steel (2012).mp4', 'FILE', 1_498_115_220, 12],
  ]);
  add('/mnt/HDDs/Media/TV Shows', [
    ['Nature Walks', 'DIRECTORY', 3, 40],
    ['Nature Walks/Season 01', 'DIRECTORY', 5, 40],
    ['Nature Walks/Season 01/Nature Walks - S01E01.mkv', 'FILE', 734_003_200, 40],
    ['Nature Walks/Season 01/Nature Walks - S01E02.mkv', 'FILE', 702_545_920, 39],
    ['Nature Walks/Season 01/Nature Walks - S01E03.mkv', 'FILE', 761_266_176, 38],
  ]);
  add('/mnt/HDDs/Media/Music', [
    ['Field Recordings', 'DIRECTORY', 5, 60],
    ['Field Recordings/01 Morning Birds.flac', 'FILE', 38_211_004, 60],
    ['Field Recordings/02 Rain on the Roof.flac', 'FILE', 41_920_660, 60],
    ['Field Recordings/03 Harbour.flac', 'FILE', 29_507_312, 60],
    ['Field Recordings/cover.jpg', 'FILE', 412_330, 60],
  ]);
  add('/mnt/HDDs/Photos/2024', [
    ['IMG_0012.JPG', 'FILE', 3_912_440, 300],
    ['IMG_0013.JPG', 'FILE', 4_105_772, 300],
    ['IMG_0047.JPG', 'FILE', 3_377_019, 280],
    ['Birthday.mov', 'FILE', 187_663_431, 250],
  ]);
  add('/mnt/HDDs/Photos/2025', [
    ['Beach day', 'DIRECTORY', 5, 90],
    ['Beach day/IMG_2201.HEIC', 'FILE', 2_811_904, 90],
    ['Beach day/IMG_2202.HEIC', 'FILE', 2_704_113, 90],
    ['Beach day/IMG_2203.HEIC', 'FILE', 3_016_257, 90],
    ['IMG_1990.JPG', 'FILE', 4_430_871, 120],
  ]);
  add('/mnt/HDDs/Photos/2026', [
    ['Summer trip', 'DIRECTORY', 4, 70],
    ['Summer trip/IMG_3301.HEIC', 'FILE', 3_204_118, 70],
    ['Summer trip/IMG_3302.HEIC', 'FILE', 2_998_404, 70],
    ['Summer trip/Ferry.mov', 'FILE', 96_221_806, 69],
  ]);
  add('/mnt/HDDs/Documents/Taxes', [
    ['2024 return.pdf', 'FILE', 402_118, 200],
    ['2025 return.pdf', 'FILE', 418_903, 8],
  ]);
  state.fs.nodes.push(
    textFile('/mnt/HDDs/Documents/Recipes/Pancakes.txt', 'Pancakes (serves 4)\n\n2 cups flour\n2 eggs\n1.5 cups milk\n2 tbsp sugar\n2 tsp baking powder\nPinch of salt\n\nWhisk, rest 10 minutes, cook on a hot pan.\n', ago(15)),
    textFile('/mnt/HDDs/Documents/Recipes/Tomato soup.txt', 'Tomato soup\n\n1 kg tomatoes\n1 onion\n2 cloves garlic\n500 ml stock\nOlive oil, salt, pepper\n\nRoast, blend, season.\n', ago(33)),
    textFile('/mnt/HDDs/Documents/Shopping list.txt', 'Milk\nBread\nCoffee\nBatteries (AA)\n', ago(1)),
  );
  // A dataset inside a folder ("separate storage"): the file browser must not move things across it.
  addDataset(mock, { id: 'HDDs/Documents/Scans', share_type: 'SMB', usedBytes: Math.round(220 * MiB), createdAt: setupDay + 86400_000 }, false);
  add('/mnt/HDDs/Documents/Scans', [
    ['Receipt 2026-09-14.pdf', 'FILE', 188_224, 28],
    ['Warranty - dishwasher.pdf', 'FILE', 932_550, 110],
  ]);
}

export function seedScenario(mock: Mock, scenario: 'fresh' | 'configured'): void {
  seedOldtank(mock);
  if (scenario === 'configured') seedConfigured(mock);
  syncAllAlerts(mock);
}
