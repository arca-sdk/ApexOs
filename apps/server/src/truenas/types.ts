/**
 * Shapes of the TrueNAS SCALE 25.10 middleware results ApexOs reads (API v25.10.0).
 * Only the fields ApexOs uses are declared.
 */

export interface TnDate {
  $date: number;
}

export interface TnProperty<T = unknown> {
  parsed: T;
  rawvalue: string;
  value: string | null;
  source: string;
}

export interface TnSystemInfo {
  version: string;
  hostname: string;
  physmem: number;
  model: string;
  cores: number;
  physical_cores: number;
  uptime_seconds: number;
  timezone: string;
  system_manufacturer: string | null;
  system_product: string | null;
  ecc_memory: boolean;
}

export interface TnDisk {
  identifier: string;
  name: string;
  devname: string;
  serial: string;
  lunid?: string | null;
  size: number;
  model: string;
  type: 'HDD' | 'SSD' | string;
  rotationrate: number | null;
  bus: string;
  subsystem: string;
  zfs_guid: string | null;
  pool: string | null;
}

export interface TnDiskDetail {
  name: string;
  identifier: string;
  serial: string;
  size: number;
  model: string;
  type: string;
  bus: string;
  subsystem: string;
  partitions: unknown[];
  exported_zpool: string | null;
  imported_zpool: string | null;
  duplicate_serial: string[];
}

export interface TnVdevStats {
  read_errors: number;
  write_errors: number;
  checksum_errors: number;
}

export interface TnVdev {
  name: string;
  type: string;
  guid: string;
  status: string;
  path: string | null;
  disk?: string | null;
  device?: string | null;
  unavail_disk?: TnDisk | null;
  stats?: TnVdevStats;
  children: TnVdev[];
}

export interface TnPoolScan {
  function: 'SCRUB' | 'RESILVER' | string | null;
  state: 'SCANNING' | 'FINISHED' | 'CANCELED' | string | null;
  start_time: TnDate | null;
  end_time: TnDate | null;
  percentage: number | null;
  errors: number | null;
  total_secs_left: number | null;
  pause: TnDate | null;
}

export interface TnPoolExpand {
  state: string;
  percentage: number | null;
  total_secs_left: number | null;
  end_time?: TnDate | null;
}

export interface TnPool {
  id: number;
  name: string;
  guid: string;
  path: string;
  status: string;
  healthy: boolean;
  warning: boolean;
  status_code: string | null;
  status_detail: string | null;
  size: number | null;
  allocated: number | null;
  free: number | null;
  scan: TnPoolScan | null;
  expand: TnPoolExpand | null;
  topology: {
    data: TnVdev[];
    log: TnVdev[];
    cache: TnVdev[];
    spare: TnVdev[];
    special: TnVdev[];
    dedup: TnVdev[];
  } | null;
}

export interface TnDataset {
  id: string;
  name: string;
  pool: string;
  type: 'FILESYSTEM' | 'VOLUME';
  mountpoint: string | null;
  encrypted: boolean;
  locked: boolean;
  used: TnProperty<number>;
  available: TnProperty<number>;
  quota: TnProperty<number | null>;
  user_properties?: Record<string, { value: string } | string>;
  children?: TnDataset[];
}

export interface TnSmbShare {
  id: number;
  name: string;
  path: string;
  purpose: string;
  enabled: boolean;
  comment: string;
  readonly: boolean;
  browsable: boolean;
  locked: boolean;
  options: Record<string, unknown> | null;
}

export interface TnShareAce {
  ae_perm: 'FULL' | 'CHANGE' | 'READ';
  ae_type: 'ALLOWED' | 'DENIED';
  ae_who_sid?: string | null;
  ae_who_id?: { id_type: 'USER' | 'GROUP' | 'BOTH'; id: number } | null;
}

export interface TnUser {
  id: number;
  uid: number;
  username: string;
  full_name: string;
  builtin: boolean;
  smb: boolean;
  locked: boolean;
  password_disabled: boolean;
  group: { id: number; bsdgrp_gid: number; bsdgrp_group: string } | null;
  roles?: string[];
}

export interface TnApp {
  name: string;
  id: string;
  state: 'RUNNING' | 'STOPPED' | 'DEPLOYING' | 'CRASHED' | 'STOPPING' | string;
  upgrade_available: boolean;
  latest_version: string | null;
  human_version: string;
  version: string;
  custom_app: boolean;
  metadata: {
    name?: string;
    title?: string;
    train?: string;
    icon?: string;
    app_version?: string;
    description?: string;
    categories?: string[];
  } | null;
  portals: Record<string, string> | null;
  active_workloads?: { used_ports?: { host_ports: { host_port: number }[] }[] };
  /** The app's values; only with `extra.retrieve_config`. */
  config?: Record<string, unknown>;
}

export interface TnCatalogApp {
  name: string;
  title: string;
  train: string;
  installed: boolean;
  latest_version: string;
  latest_app_version: string;
  icon_url: string | null;
  categories: string[];
  description: string;
  home: string | null;
  screenshots?: string[];
  sources?: string[];
  recommended?: boolean;
  popularity_rank?: number | null;
}

export interface TnAlert {
  uuid: string;
  klass: string;
  level: 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL' | 'ALERT' | 'EMERGENCY';
  formatted: string | null;
  text: string;
  args: unknown;
  datetime: TnDate;
  last_occurrence?: TnDate;
  dismissed: boolean;
}

export interface TnDockerConfig {
  pool: string | null;
  dataset: string | null;
  /** NVIDIA drivers installed (Apps → Configuration in TrueNAS). */
  nvidia?: boolean;
}

/** `app.gpu_choices` entry (keyed by PCI slot). NVIDIA cards only appear once TrueNAS's NVIDIA driver is installed. */
export interface TnGpuChoice {
  vendor: string | null;
  description: string | null;
  error: string | null;
  vendor_specific_config: { uuid?: string } | null;
  pci_slot: string;
}

/** `resources.gpus` in an app's values (TrueNAS apps library): `use_all_gpus` passes Intel/AMD cards, NVIDIA cards are picked one by one. */
export interface TnGpuValues {
  use_all_gpus?: boolean;
  kfd_device_exists?: boolean;
  nvidia_gpu_selection?: Record<string, { use_gpu?: boolean; uuid?: string }>;
}

/** One question of a catalog app's install schema (`questions.yaml`). */
export interface SchemaQuestion {
  variable: string;
  schema?: { attrs?: SchemaQuestion[] };
}

/** `catalog.get_app_details` */
export interface TnAppDetails {
  latest_version: string;
  versions: Record<string, { schema?: { questions?: SchemaQuestion[] } }>;
}

export interface TnDockerStatus {
  status: string;
  description: string | null;
}

export interface TnUpdateStatus {
  code: 'NORMAL' | 'ERROR' | string;
  status: {
    current_version: { train?: string; version?: string } | null;
    new_version: { version: string; release_notes_url: string | null } | null;
  } | null;
  error: { errname?: string; reason?: string } | null;
}

export interface TnInterface {
  id: string;
  name: string;
  type: string;
  ipv4_dhcp: boolean;
  aliases: { address: string; netmask: number; type?: string }[];
  state: {
    link_state: string;
    link_address: string | null;
    active_media_subtype?: string | null;
    aliases: { type: string; address: string; netmask?: number }[];
  };
}

export interface TnScrubTask {
  id: number;
  pool: number;
  pool_name: string;
  threshold: number;
  enabled: boolean;
}

/** `reporting.realtime` event fields. */
export interface TnRealtime {
  cpu?: Record<string, { usage?: number | null; temp?: number | null }>;
  memory?: {
    arc_size?: number;
    physical_memory_total?: number;
    physical_memory_available?: number;
  };
  disks?: { read_bytes?: number; write_bytes?: number; busy?: number };
  interfaces?: Record<string, { link_state?: string; speed?: number | null; received_bytes_rate?: number; sent_bytes_rate?: number }>;
}

/** `app.stats` event entry. */
export interface TnAppStats {
  app_name: string;
  cpu_usage: number;
  memory: number;
}
