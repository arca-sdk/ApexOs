/**
 * Persistent state of the simulated TrueNAS box. Everything here is plain JSON so it can be saved to
 * `MockOptions.stateFile`. Runtime-only data (jobs, timers, sessions) lives in `Mock` (context.ts).
 */
import catalogFile from './data/catalog.json' with { type: 'json' };
import type { Obj } from './util.ts';

export const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// Catalog (static, from github.com/truenas/apps; see data/catalog.json)
// ---------------------------------------------------------------------------

export interface CatalogPort {
  name: string;
  label: string;
  port: number;
  bind_mode: string;
  protocol: string;
}

export interface CatalogApp {
  name: string;
  title: string;
  description: string;
  app_readme: string | null;
  categories: string[];
  home: string;
  icon_url: string | null;
  latest_version: string;
  latest_app_version: string;
  latest_human_version: string;
  last_update: string;
  recommended: boolean;
  healthy: boolean;
  healthy_error: string | null;
  maintainers: Array<{ name: string; email: string; url: string | null }>;
  tags: string[];
  screenshots: string[];
  sources: string[];
  capabilities: unknown[];
  run_as_context: unknown[];
  train: string;
  app_metadata: Obj;
  changelog: string | null;
  images: Record<string, string>;
  ports: CatalogPort[];
  storage: Array<{ name: string; label: string; type: string | null; dataset_name: string | null }>;
  default_values: Obj;
  schema: { groups: unknown[]; questions: unknown[] };
}

export const CATALOG: CatalogApp[] = (catalogFile as unknown as { apps: CatalogApp[] }).apps;
export const CATALOG_COMMIT: string = (catalogFile as unknown as { commit: string }).commit;

export function catalogApp(name: string, train?: string): CatalogApp | undefined {
  return CATALOG.find((a) => a.name === name && (!train || a.train === train));
}

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type DiskType = 'HDD' | 'SSD';

export interface DiskState {
  identifier: string;
  name: string;
  serial: string;
  lunid: string | null;
  model: string;
  size: number;
  type: DiskType;
  rotationrate: number | null;
  bus: 'ATA' | 'NVME' | 'USB' | 'SCSI';
  subsystem: 'scsi' | 'nvme';
  number: number;
  description: string;
  hddstandby: string;
  advpowermgmt: string;
  /** GUID of the ZFS leaf vdev when the disk belongs to an imported or exported pool. */
  zfs_guid: string | null;
  /** Typical idle temperature in °C; null when the device has no sensor (USB sticks). */
  baseTemp: number | null;
  tempOverride: number | null;
  criticalTemp: number | null;
  /** False after the drive has been pulled (failDrive(name, 'REMOVED')). */
  present: boolean;
  expiretime: number | null;
  /** Non-ZFS partitions (e.g. a FAT partition on a USB stick). */
  foreignPartitions: Array<{ number: number; size: number; type: string }>;
  /** Boot pool member (sda). */
  boot: boolean;
}

export type LeafStatus = 'ONLINE' | 'FAULTED' | 'REMOVED' | 'OFFLINE' | 'UNAVAIL' | 'DEGRADED' | 'AVAIL';

export interface LeafState {
  guid: string;
  partuuid: string;
  /** Disk identifier (stable), resolved to a kernel name when rendering. */
  disk: string;
  status: LeafStatus;
  errors: { read: number; write: number; checksum: number };
  /** New leaf while a `pool.replace` resilver is running (rendered as a REPLACING vdev). */
  replacing: LeafState | null;
}

export type VdevType = 'STRIPE' | 'MIRROR' | 'RAIDZ1' | 'RAIDZ2' | 'RAIDZ3';
export type VdevCategory = 'data' | 'log' | 'cache' | 'special' | 'dedup';

export interface VdevState {
  type: VdevType;
  guid: string;
  children: LeafState[];
}

export interface ScanState {
  function: 'SCRUB' | 'RESILVER';
  state: 'SCANNING' | 'FINISHED' | 'CANCELED';
  start_time: number;
  end_time: number | null;
  percentage: number;
  bytes_to_process: number;
  bytes_processed: number;
  bytes_issued: number;
  pause: number | null;
  errors: number;
  total_secs_left: number | null;
}

export interface ExpandState {
  state: 'EXPANDING' | 'FINISHED';
  expanding_vdev: number;
  start_time: number;
  end_time: number | null;
  bytes_to_reflow: number;
  bytes_reflowed: number;
  waiting_for_resilver: number;
  total_secs_left: number | null;
  percentage: number;
}

export interface PoolState {
  id: number;
  name: string;
  guid: string;
  topology: Record<VdevCategory, VdevState[]> & { spare: LeafState[] };
  scan: ScanState | null;
  expand: ExpandState | null;
  autotrim: boolean;
  createdAt: number;
}

export type DatasetShareType = 'GENERIC' | 'SMB' | 'APPS' | 'MULTIPROTOCOL' | 'NFS';

export interface DatasetState {
  id: string;
  pool: string;
  type: 'FILESYSTEM' | 'VOLUME';
  /** Bytes referenced by this dataset itself (children excluded). */
  usedBytes: number;
  quota: number | null;
  refquota: number | null;
  reservation: number | null;
  refreservation: number | null;
  volsize: number | null;
  /** Locally set ZFS properties (upper-case API values, e.g. compression: "LZ4"); others are inherited. */
  props: Record<string, string>;
  comments: string;
  share_type: DatasetShareType;
  user_properties: Record<string, string>;
  createdAt: number;
  createtxg: number;
}

export interface SnapshotState {
  id: string;
  dataset: string;
  name: string;
  createtxg: number;
  createdAt: number;
  referenced: number;
  usedBytes: number;
}

export interface FsNode {
  path: string;
  type: 'DIRECTORY' | 'FILE';
  size: number;
  mtime: number;
}

export interface Owner {
  uid: number;
  gid: number;
  mode: number;
}

export interface AclState {
  acltype: 'NFS4' | 'POSIX1E';
  acl: Obj[];
  aclflags: Obj | null;
  trivial: boolean;
}

export interface ExportedPoolState {
  hostname: string;
  pool: PoolState;
  datasets: DatasetState[];
  snapshots: SnapshotState[];
  fsNodes: FsNode[];
  acls: Record<string, AclState>;
  owners: Record<string, Owner>;
  apps: AppState[];
}

export interface SmbShareAce {
  ae_perm: 'FULL' | 'CHANGE' | 'READ';
  ae_type: 'ALLOWED' | 'DENIED';
  ae_who_sid: string | null;
  ae_who_id: { id_type: 'USER' | 'GROUP'; id: number } | null;
}

export interface SmbShareState {
  id: number;
  purpose: string;
  name: string;
  path: string;
  enabled: boolean;
  comment: string;
  readonly: boolean;
  browsable: boolean;
  access_based_share_enumeration: boolean;
  audit: { enable: boolean; watch_list: string[]; ignore_list: string[] };
  options: Obj;
  share_acl: SmbShareAce[];
}

export interface ServiceState {
  id: number;
  service: string;
  enable: boolean;
  state: 'RUNNING' | 'STOPPED';
}

export interface UserState {
  id: number;
  uid: number;
  username: string;
  full_name: string;
  email: string | null;
  home: string;
  shell: string;
  smb: boolean;
  builtin: boolean;
  immutable: boolean;
  locked: boolean;
  password_disabled: boolean;
  ssh_password_enabled: boolean;
  sshpubkey: string | null;
  sudo_commands: string[];
  sudo_commands_nopasswd: string[];
  /** DB id of the primary group. */
  group: number;
  /** DB ids of auxiliary groups. */
  groups: number[];
  /** Plain text: this is a simulator. */
  password: string | null;
  last_password_change: number | null;
}

export interface GroupState {
  id: number;
  gid: number;
  name: string;
  builtin: boolean;
  immutable: boolean;
  smb: boolean;
  sudo_commands: string[];
  sudo_commands_nopasswd: string[];
  roles: string[];
}

export interface ApiKeyState {
  id: number;
  name: string;
  username: string;
  key: string;
  created_at: number;
  expires_at: number | null;
  revoked: boolean;
  revoked_reason: string | null;
}

export type DockerStatus = 'PENDING' | 'RUNNING' | 'STOPPED' | 'INITIALIZING' | 'STOPPING' | 'UNCONFIGURED' | 'FAILED';

export interface DockerState {
  pool: string | null;
  status: DockerStatus;
  description: string;
  enable_image_updates: boolean;
  nvidia: boolean;
  address_pools: Array<{ base: string; size: number }>;
  cidr_v6: string;
  secure_registry_mirrors: string[];
  insecure_registry_mirrors: string[];
}

export type AppRunState = 'CRASHED' | 'DEPLOYING' | 'RUNNING' | 'STOPPED' | 'STOPPING';

export interface AppState {
  name: string;
  /** Apps pool the app was installed on (it lives in `<pool>/ix-apps`). */
  pool: string;
  catalog_app: string | null;
  train: string;
  version: string;
  app_version: string;
  custom_app: boolean;
  state: AppRunState;
  config: Obj;
  custom_compose: string | null;
  createdAt: number;
  /** Versions this app was upgraded from (for rollback). */
  history: Array<{ version: string; app_version: string }>;
  /** Container ids per compose service. */
  containers: Record<string, string>;
}

export interface AlertState {
  uuid: string;
  klass: string;
  source: string;
  level: 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL' | 'ALERT' | 'EMERGENCY';
  args: unknown;
  key: string;
  text: string;
  formatted: string;
  datetime: number;
  last_occurrence: number;
  dismissed: boolean;
  one_shot: boolean;
}

export interface ScrubTaskState {
  id: number;
  pool: number;
  threshold: number;
  description: string;
  schedule: { minute: string; hour: string; dom: string; month: string; dow: string };
  enabled: boolean;
}

export interface InterfaceState {
  name: string;
  mac: string;
  linkUp: boolean;
  speed: number | null;
  ipv4_dhcp: boolean;
  /** Live addresses (from DHCP or static config). */
  addresses: Array<{ address: string; netmask: number }>;
  /** Configured static aliases. */
  aliases: Array<{ type: 'INET' | 'INET6'; address: string; netmask: number }>;
  description: string;
  mtu: number;
}

export interface MockState {
  version: typeof STATE_VERSION;
  scenario: 'fresh' | 'configured';
  txg: number;
  nextIds: {
    pool: number;
    user: number;
    group: number;
    share: number;
    apiKey: number;
    scrubTask: number;
    disk: number;
  };
  system: {
    version: string;
    buildtime: number;
    timezone: string;
    kbdmap: string;
    usage_collection: boolean | null;
    wizardshown: boolean;
    ui_httpsport: number;
    ui_port: number;
    ui_httpsredirect: boolean;
    ui_consolemsg: boolean;
    system_serial: string;
    update: {
      autocheck: boolean;
      profile: string;
      /** Version offered by `update.status`, or null when up to date. */
      available: string | null;
    };
  };
  network: {
    hostname: string;
    domain: string;
    /** Statically configured name servers ('' when unset; DHCP-provided ones are used then). */
    nameservers: [string, string, string];
    ipv4gateway: string;
    dhcp: { gateway: string; nameservers: string[] };
    interfaces: InterfaceState[];
  };
  disks: DiskState[];
  pools: PoolState[];
  exportedPools: ExportedPoolState[];
  datasets: DatasetState[];
  snapshots: SnapshotState[];
  shares: SmbShareState[];
  smb: Obj;
  services: ServiceState[];
  users: UserState[];
  groups: GroupState[];
  apiKeys: ApiKeyState[];
  fs: { nodes: FsNode[]; acls: Record<string, AclState>; owners: Record<string, Owner> };
  docker: DockerState;
  catalog: { preferred_trains: string[]; synced: boolean };
  apps: AppState[];
  alerts: AlertState[];
  scrubTasks: ScrubTaskState[];
}

// ---------------------------------------------------------------------------
// Fresh-install seed
// ---------------------------------------------------------------------------

export interface SeedOptions {
  adminUsername: string;
  adminPassword: string;
  apiKey: string;
}

const TB8 = 8001563222016;
const TB4 = 4000787030016;

function scsiNumber(index: number): number {
  return 8 * 256 + index * 16;
}

function disk(partial: Partial<DiskState> & Pick<DiskState, 'name' | 'serial' | 'model' | 'size' | 'type'>): DiskState {
  const identifier = partial.lunid ? `{serial_lunid}${partial.serial}_${partial.lunid}` : `{serial}${partial.serial}`;
  return {
    identifier,
    lunid: null,
    rotationrate: null,
    bus: 'ATA',
    subsystem: 'scsi',
    number: 0,
    description: '',
    hddstandby: 'ALWAYS ON',
    advpowermgmt: 'DISABLED',
    zfs_guid: null,
    baseTemp: 35,
    tempOverride: null,
    criticalTemp: 60,
    present: true,
    expiretime: null,
    foreignPartitions: [],
    boot: false,
    ...partial,
  };
}

export function seedDisks(): DiskState[] {
  const hdds = [
    ['sdb', 'ZR16N8KQ', '5000c500e5a1c3d1', 36],
    ['sdc', 'ZR16N9F3', '5000c500e5a1d4e2', 37],
    ['sdd', 'ZR16NA2X', '5000c500e5a1e5f3', 38],
    ['sde', 'ZR16NB7M', '5000c500e5a1f604', 36],
  ] as const;
  return [
    disk({
      name: 'sda',
      serial: '2306E6A4B7C1',
      lunid: '500a0751e6a4b7c1',
      model: 'Crucial MX500',
      size: 256060514304,
      type: 'SSD',
      number: scsiNumber(0),
      baseTemp: 31,
      criticalTemp: 70,
      boot: true,
    }),
    ...hdds.map(([name, serial, lunid, temp], i) =>
      disk({
        name,
        serial,
        lunid,
        model: 'ST8000VN004-2M2101',
        size: TB8,
        type: 'HDD',
        rotationrate: 7200,
        number: scsiNumber(i + 1),
        baseTemp: temp,
        criticalTemp: 70,
      }),
    ),
    disk({
      name: 'sdf',
      serial: 'WD-WX32D81HJ4K7',
      lunid: '50014ee2bf1c6a83',
      model: 'WDC WD40EFAX-68JH4N1',
      size: TB4,
      type: 'HDD',
      rotationrate: 5400,
      number: scsiNumber(5),
      baseTemp: 33,
      criticalTemp: 65,
    }),
    disk({
      name: 'sdg',
      serial: '4C530001240815112283',
      model: 'SanDisk Ultra Fit',
      size: 30752636928,
      type: 'SSD',
      bus: 'USB',
      number: scsiNumber(6),
      baseTemp: null,
      criticalTemp: null,
      foreignPartitions: [{ number: 1, size: 30751588352, type: 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7' }],
    }),
    ...(['nvme0n1', 'nvme1n1'] as const).map((name, i) =>
      disk({
        name,
        serial: i === 0 ? 'S6B0NL0W412873K' : 'S6B0NL0W412911P',
        lunid: i === 0 ? '002538b431a2c4d1' : '002538b431a2c5e7',
        model: 'Samsung SSD 980 PRO 1TB',
        size: 1000204886016,
        type: 'SSD',
        bus: 'NVME',
        subsystem: 'nvme',
        number: 259 * 256 + i * 2,
        baseTemp: i === 0 ? 45 : 44,
        criticalTemp: 82,
      }),
    ),
  ];
}

export function freshState(opts: SeedOptions): MockState {
  const now = Date.now();
  const builtinGroups: GroupState[] = [
    { id: 1, gid: 0, name: 'root', builtin: true, immutable: true, smb: false, sudo_commands: [], sudo_commands_nopasswd: [], roles: [] },
    { id: 2, gid: 544, name: 'builtin_administrators', builtin: true, immutable: true, smb: true, sudo_commands: [], sudo_commands_nopasswd: [], roles: ['FULL_ADMIN'] },
    { id: 3, gid: 545, name: 'builtin_users', builtin: true, immutable: true, smb: true, sudo_commands: [], sudo_commands_nopasswd: [], roles: [] },
    { id: 4, gid: 546, name: 'builtin_guests', builtin: true, immutable: true, smb: true, sudo_commands: [], sudo_commands_nopasswd: [], roles: [] },
    { id: 5, gid: 568, name: 'apps', builtin: true, immutable: true, smb: false, sudo_commands: [], sudo_commands_nopasswd: [], roles: [] },
    { id: 6, gid: 65534, name: 'nogroup', builtin: true, immutable: true, smb: false, sudo_commands: [], sudo_commands_nopasswd: [], roles: [] },
    { id: 7, gid: 950, name: opts.adminUsername, builtin: false, immutable: false, smb: false, sudo_commands: [], sudo_commands_nopasswd: [], roles: [] },
  ];
  const baseUser = {
    email: null,
    smb: false,
    locked: false,
    ssh_password_enabled: false,
    sshpubkey: null,
    sudo_commands: [],
    sudo_commands_nopasswd: [],
    groups: [],
    last_password_change: null,
  };
  const users: UserState[] = [
    {
      ...baseUser,
      id: 1,
      uid: 0,
      username: 'root',
      full_name: 'root',
      home: '/root',
      shell: '/usr/bin/zsh',
      builtin: true,
      immutable: true,
      password_disabled: true,
      group: 1,
      groups: [2],
      password: null,
    },
    {
      ...baseUser,
      id: 2,
      uid: 65534,
      username: 'nobody',
      full_name: 'Unprivileged user',
      home: '/var/empty',
      shell: '/usr/sbin/nologin',
      builtin: true,
      immutable: true,
      password_disabled: true,
      group: 6,
      password: null,
    },
    {
      ...baseUser,
      id: 3,
      uid: 568,
      username: 'apps',
      full_name: 'Unprivileged Apps User',
      home: '/var/empty',
      shell: '/usr/sbin/nologin',
      builtin: true,
      immutable: true,
      password_disabled: true,
      group: 5,
      password: null,
    },
    {
      ...baseUser,
      id: 4,
      uid: 950,
      username: opts.adminUsername,
      full_name: 'Local Administrator',
      home: `/home/${opts.adminUsername}`,
      shell: '/usr/bin/zsh',
      builtin: false,
      immutable: false,
      password_disabled: false,
      group: 7,
      groups: [2],
      password: opts.adminPassword,
      last_password_change: now - 1000 * 60 * 60 * 2,
      sudo_commands: [],
      sudo_commands_nopasswd: [],
    },
  ];

  return {
    version: STATE_VERSION,
    scenario: 'fresh',
    txg: 4096,
    nextIds: { pool: 1, user: 5, group: 8, share: 1, apiKey: 2, scrubTask: 1, disk: 0 },
    system: {
      version: '25.10.7',
      buildtime: Date.UTC(2026, 8, 24, 18, 12, 0),
      timezone: 'America/Los_Angeles',
      kbdmap: 'us',
      usage_collection: null,
      wizardshown: false,
      ui_httpsport: 443,
      ui_port: 80,
      ui_httpsredirect: false,
      ui_consolemsg: false,
      system_serial: 'M80-F3007900123',
      update: { autocheck: true, profile: 'GENERAL', available: '25.10.8' },
    },
    network: {
      hostname: 'truenas',
      domain: 'local',
      nameservers: ['', '', ''],
      ipv4gateway: '',
      dhcp: { gateway: '192.168.1.1', nameservers: ['192.168.1.1'] },
      interfaces: [
        {
          name: 'enp5s0',
          mac: '70:85:c2:4a:91:3e',
          linkUp: true,
          speed: 1000,
          ipv4_dhcp: true,
          addresses: [{ address: '192.168.1.20', netmask: 24 }],
          aliases: [],
          description: '',
          mtu: 1500,
        },
        {
          name: 'enp6s0',
          mac: 'a0:36:9f:5c:21:08',
          linkUp: false,
          speed: null,
          ipv4_dhcp: false,
          addresses: [],
          aliases: [],
          description: '',
          mtu: 1500,
        },
      ],
    },
    disks: seedDisks(),
    pools: [],
    exportedPools: [],
    datasets: [],
    snapshots: [],
    shares: [],
    smb: {
      id: 1,
      netbiosname: 'truenas',
      netbiosalias: [],
      workgroup: 'WORKGROUP',
      description: 'TrueNAS Server',
      enable_smb1: false,
      unixcharset: 'UTF-8',
      localmaster: false,
      syslog: false,
      aapl_extensions: false,
      admin_group: null,
      guest: 'nobody',
      filemask: 'DEFAULT',
      dirmask: 'DEFAULT',
      ntlmv1_auth: false,
      multichannel: false,
      encryption: 'DEFAULT',
      bindip: [],
      server_sid: 'S-1-5-21-3315487692-3297227315-3361424391',
      smb_options: '',
      debug: false,
      search_protocols: ['SPOTLIGHT'],
      stateful_failover: false,
    },
    services: [
      { id: 1, service: 'ftp', enable: false, state: 'STOPPED' },
      { id: 2, service: 'iscsitarget', enable: false, state: 'STOPPED' },
      { id: 3, service: 'nfs', enable: false, state: 'STOPPED' },
      { id: 4, service: 'cifs', enable: false, state: 'STOPPED' },
      { id: 5, service: 'snmp', enable: false, state: 'STOPPED' },
      { id: 6, service: 'ssh', enable: false, state: 'STOPPED' },
      { id: 7, service: 'ups', enable: false, state: 'STOPPED' },
      { id: 8, service: 'docker', enable: false, state: 'STOPPED' },
      { id: 9, service: 'nvmet', enable: false, state: 'STOPPED' },
    ],
    users,
    groups: builtinGroups,
    apiKeys: [
      {
        id: 1,
        name: 'apexos',
        username: opts.adminUsername,
        key: opts.apiKey,
        created_at: now - 1000 * 60 * 60,
        expires_at: null,
        revoked: false,
        revoked_reason: null,
      },
    ],
    fs: { nodes: [], acls: {}, owners: {} },
    docker: {
      pool: null,
      status: 'UNCONFIGURED',
      description: '',
      enable_image_updates: true,
      nvidia: false,
      address_pools: [{ base: '172.17.0.0/12', size: 24 }],
      cidr_v6: 'fdd0::/64',
      secure_registry_mirrors: [],
      insecure_registry_mirrors: [],
    },
    catalog: { preferred_trains: ['stable', 'community'], synced: false },
    apps: [],
    alerts: [],
    scrubTasks: [],
  };
}
