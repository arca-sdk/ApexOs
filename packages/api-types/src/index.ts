/**
 * HTTP API contract between the ApexOs server (`apps/server`) and web UI (`apps/web`).
 * All routes live under `/api`. Errors are `{ error: { code, message, fields? } }`.
 * Sizes are bytes, times are ISO-8601 strings, temperatures are °C.
 */
import type { LocationPreferenceId } from '@apexos/shared/eshtek/preferences';

export type { LocationPreferenceId };

// ---------------------------------------------------------------------------
// Session / onboarding
// ---------------------------------------------------------------------------

/** GET /api/status */
export interface StatusResponse {
  authenticated: boolean;
  needsAccount: boolean;
  truenasConfigured: boolean;
  truenasConnected: boolean;
  setupComplete: boolean;
  serverName: string | null;
  demo: boolean;
  username: string | null;
}

/** POST /api/truenas/connect */
export type ConnectRequest =
  | { host: string; method: 'password'; username: string; password: string }
  | { host: string; method: 'apiKey'; apiKey: string };

// ---------------------------------------------------------------------------
// Tasks (long-running operations). Also streamed as SSE `task` events.
// ---------------------------------------------------------------------------

export interface TaskStep {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  progress: number;
  message?: string;
}

export interface Task {
  id: string;
  type: string;
  title: string;
  status: 'running' | 'success' | 'failed';
  progress: number;
  message?: string;
  error?: string;
  steps: TaskStep[];
  startedAt: string;
  finishedAt?: string;
  ref?: string;
}

/** Response of endpoints that start a background task. */
export interface TaskStarted {
  task: Task;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface SystemSummary {
  hostname: string;
  /** e.g. "25.10.7" */
  version: string;
  cpuModel: string;
  cores: number;
  physicalCores: number;
  memoryBytes: number;
  eccMemory: boolean;
  uptimeSeconds: number;
  timezone: string;
  manufacturer: string | null;
  product: string | null;
  lanIp: string | null;
}

export type ScanCardId = 'system' | 'storage' | 'apps' | 'virtualization';
export type ScanStatus = 'ok' | 'attention' | 'issues' | 'unavailable';

export interface ScanCheck {
  id: string;
  /** `error` blocks or strongly discourages continuing; `warning` needs attention; `info` is advisory. */
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
}

export interface ScanCard {
  id: ScanCardId;
  title: string;
  status: ScanStatus;
  /** One-line status, e.g. "No issues detected". */
  summary: string;
  checks: ScanCheck[];
  facts: { label: string; value: string }[];
}

/** GET /api/system/scan */
export interface HardwareScan {
  system: SystemSummary;
  cards: ScanCard[];
}

/** GET /api/system/network (the full response is `NetworkSettings`, see "Network settings" below) */
export interface NetworkInfo {
  hostname: string;
  gateway: string[];
  nameservers: string[];
  interfaces: {
    name: string;
    type: string;
    linkUp: boolean;
    speedMbps: number | null;
    mac: string | null;
    dhcp: boolean;
    addresses: string[];
  }[];
}

/** GET /api/system/update */
export interface UpdateInfo {
  currentVersion: string;
  /** Whether ApexOs supports the installed TrueNAS version. */
  supported: boolean;
  supportNote: string | null;
  available: { version: string; releaseNotesUrl: string | null } | null;
  /** Set when a pool is degraded or rebuilding; the user must acknowledge the risk. */
  riskWarning: string | null;
  error: string | null;
}

/** POST /api/system/update  { acknowledgeRisk } → TaskStarted */
/** POST /api/system/power   { action, acknowledgeRisk } → { ok } */
export interface PowerRequest {
  action: 'restart' | 'shutdown';
  acknowledgeRisk?: boolean;
}

/** GET /api/system/timezone → { timezone, choices }; PUT { timezone } */
export interface TimezoneInfo {
  timezone: string;
  choices: string[];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type DriveKind = 'HDD' | 'SSD' | 'NVME' | 'USB';
export type DriveRole = 'data' | 'spare' | 'cache' | 'log' | 'special' | 'dedup' | 'boot';
export type DriveWarning = 'SMR' | 'EXISTING_DATA' | 'DUPLICATE_SERIAL';

export interface Drive {
  /** Stable TrueNAS disk identifier. Use this, never `name`, to refer to drives. */
  identifier: string;
  /** Current kernel name (e.g. `sda`); can change across reboots. */
  name: string;
  serial: string;
  model: string;
  sizeBytes: number;
  kind: DriveKind;
  rotationRate: number | null;
  temperatureC: number | null;
  pool: string | null;
  role: DriveRole | null;
  /** ZFS device state for pool members (ONLINE, DEGRADED, FAULTED, REMOVED, UNAVAIL, OFFLINE). */
  status: string | null;
  errors: { read: number; write: number; checksum: number };
  warnings: DriveWarning[];
  /** Name of an exported pool found on the drive, if any. */
  exportedPool: string | null;
  /** True when the drive can be used for a new pool, spare, expansion or replacement. */
  available: boolean;
  unavailableReason: string | null;
  /** True for a pool member that ZFS reports as missing. */
  missing: boolean;
  /** Automatic error handling for pool members (see "Drive diagnosis" below); absent until ApexOs has seen errors on the drive. */
  health?: DriveHealth;
}

export type PoolLayout = 'STRIPE' | 'MIRROR' | 'RAIDZ1' | 'RAIDZ2' | 'RAIDZ3';
export type PoolHealth = 'healthy' | 'degraded' | 'rebuilding' | 'offline' | 'errors' | 'unknown';
export type PoolKind = 'performance' | 'capacity' | 'mixed';

export interface PoolScan {
  kind: 'scrub' | 'resilver' | 'expand';
  state: 'running' | 'finished' | 'canceled' | 'paused';
  percent: number;
  secondsLeft: number | null;
  finishedAt: string | null;
  errors: number;
}

export interface PoolLayoutInfo {
  /** Human label, e.g. "RAIDZ1 (3 drives)" or "Mirror" or "Layout not recognized". */
  label: string;
  recognized: boolean;
  vdevs: { type: string; drives: number }[];
  /** How many drives can fail without losing data; null when unknown. */
  faultTolerance: number | null;
  /** Whether a single drive can be added (RAIDZ expansion or mirror widening). */
  expandable: boolean;
}

export interface Pool {
  id: number;
  name: string;
  displayName: string;
  path: string;
  kind: PoolKind;
  health: PoolHealth;
  /** Plain-language explanation of the health state. */
  healthDetail: string | null;
  zfsStatus: string;
  sizeBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  layout: PoolLayoutInfo;
  drives: Drive[];
  spares: Drive[];
  scan: PoolScan | null;
  scrubScheduled: boolean;
  isAppsPool: boolean;
  errors: { read: number; write: number; checksum: number };
  /** Damaged-file summary; only present for pools whose state suggests damage (see "Pool data errors"). */
  dataErrors?: PoolDataErrorSummary;
}

export interface ImportablePool {
  guid: string;
  name: string;
  status: string;
  hostname: string | null;
}

/** GET /api/storage */
export interface StorageOverview {
  pools: Pool[];
  /** Drives that are not part of any pool (excluding the boot drive). */
  unassigned: Drive[];
  bootDrives: Drive[];
}

/** GET /api/storage/importable → ImportablePool[]  (slow: runs pool.import_find) */

export interface NewPoolSpec {
  name: string;
  layout: PoolLayout;
  /** Drive identifiers. */
  drives: string[];
}

/** POST /api/storage/pools  NewPoolSpec → TaskStarted */
/** DELETE /api/storage/pools/:id  { confirmName } → TaskStarted */
/** PATCH /api/storage/pools/:id  { displayName } → Pool */
/** POST /api/storage/pools/:id/scrub → { ok } */
/** POST /api/storage/pools/:id/drives  { drive } → TaskStarted (add drive / expand) */
/** POST /api/storage/pools/:id/replace  { oldDrive, newDrive, acknowledgeRisk } → TaskStarted */
/** POST /api/storage/pools/:id/spares  { drive } → TaskStarted */
/** POST /api/storage/import  { guid } → TaskStarted */

export type PlanPriority = 'space' | 'balanced' | 'protection';

export interface PlannedPool {
  name: string;
  layout: PoolLayout;
  /** Drive identifiers. */
  drives: string[];
  kind: PoolKind;
  usableBytes: number;
  faultTolerance: number;
  /** Why this layout was chosen. */
  reason: string;
  warnings: string[];
}

export interface PoolPlan {
  pools: PlannedPool[];
  unassigned: { identifier: string; reason: string }[];
}

/** POST /api/storage/plan  { priority, drives? } → PoolPlan  (recommended layout over the given or all free drives) */
/** POST /api/storage/estimate  { layout, drives } → { usableBytes, faultTolerance, valid, problems: string[] } */
export interface LayoutEstimate {
  valid: boolean;
  usableBytes: number;
  faultTolerance: number;
  problems: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

export interface ExistingPoolSummary {
  id: number;
  name: string;
  displayName: string;
  health: PoolHealth;
  sizeBytes: number;
  usedBytes: number;
  layoutLabel: string;
  faultTolerance: number | null;
  drives: string[];
  folders: string[];
  apps: string[];
}

/** GET /api/setup */
export interface SetupInfo {
  scan: HardwareScan;
  drives: Drive[];
  existingPools: ExistingPoolSummary[];
  /** Users (besides the admin) that live on the server regardless of pools. */
  serverUsers: string[];
  timezone: string;
  timezones: string[];
  suggestedName: string;
}

export interface SetupRequest {
  serverName: string;
  timezone: string;
  /** Names of pools already on this server to keep. Others may be erased if their drives are reused. */
  keepPools: string[];
  /** GUIDs of foreign pools to import. */
  importPools: string[];
  newPools: NewPoolSpec[];
  consentErase: boolean;
  consentKeep: boolean;
}

/** POST /api/setup/review  SetupRequest → SetupReview (validates without changing anything) */
export interface SetupReview {
  ok: boolean;
  problems: string[];
  /** Existing pools that will be erased because a new pool reuses their drives. */
  erasePools: string[];
  /** Existing pools that are let go but untouched (their drives are not reused). */
  untouchedPools: string[];
  newPools: (NewPoolSpec & { usableBytes: number; faultTolerance: number })[];
  appsPool: string | null;
  needsEraseConsent: boolean;
  needsKeepConsent: boolean;
}

/** POST /api/setup/finish  SetupRequest → TaskStarted */

// ---------------------------------------------------------------------------
// Folders and users
// ---------------------------------------------------------------------------

export type FolderAccess = 'public' | 'private';
export type AccessLevel = 'read' | 'full';

export interface FolderUserAccess {
  username: string;
  level: AccessLevel;
}

export interface FolderUse {
  type: 'app' | 'location';
  id: string;
  name: string;
}

export interface Folder {
  /** Folder (and share) name. Immutable. */
  name: string;
  pool: string;
  poolDisplayName: string;
  dataset: string;
  path: string;
  access: FolderAccess;
  users: FolderUserAccess[];
  quotaBytes: number | null;
  usedBytes: number;
  timeMachine: boolean;
  /** Managed by ApexOs for apps/locations (e.g. Media, Downloads). */
  system: boolean;
  usedBy: FolderUse[];
  shared: boolean;
  /** e.g. `smb://192.168.1.20/Photos` */
  smbUrl: string | null;
  /** e.g. `\\192.168.1.20\Photos` */
  uncPath: string | null;
}

/** GET /api/folders */
export interface FoldersResponse {
  folders: Folder[];
  /** Names that cannot be used for personal folders. */
  reservedNames: string[];
}

export interface FolderRequest {
  name: string;
  pool: string;
  access: FolderAccess;
  users: FolderUserAccess[];
  quotaBytes: number | null;
  timeMachine: boolean;
}

/** POST /api/folders  FolderRequest → TaskStarted */
/** PUT /api/folders/:name  Omit<FolderRequest, 'name' | 'pool'> → TaskStarted */
/** DELETE /api/folders/:name  { confirmName } → TaskStarted */

export interface ShareUser {
  id: number;
  uid: number;
  username: string;
  folders: { name: string; level: AccessLevel }[];
}

/** GET /api/users → ShareUser[] */
/** POST /api/users  { username, password } → ShareUser */
/** PUT /api/users/:id  { username?, password? } → ShareUser */
/** DELETE /api/users/:id → { ok } */

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export type LocationGroup = 'applications' | 'content';

export interface LocationInfo {
  id: LocationPreferenceId;
  name: string;
  group: LocationGroup;
  description: string;
  /** Absolute path, e.g. `/mnt/HDDs/Media`; null if not set. */
  path: string | null;
  folder: string | null;
  pool: string | null;
  /** Whether the folder exists on the server. */
  created: boolean;
  /** Apps that use this location; while non-empty the location cannot change. */
  usedBy: FolderUse[];
  /** Where ApexOs would create it by default. */
  suggestedPath: string | null;
}

/** GET /api/locations → LocationInfo[] */
/** PUT /api/locations/:id  { path } → LocationInfo  (path must be a folder inside a pool) */

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export type SupportTier = 'curated' | 'catalog';

export interface AppRequirementsInfo {
  locations: { id: LocationPreferenceId; name: string; met: boolean; path: string | null }[];
  specs: { label: string; met: boolean }[];
  ports: number[];
  portConflicts: number[];
  ok: boolean;
}

export interface CatalogApp {
  id: string;
  title: string;
  description: string;
  icon: string | null;
  categories: string[];
  train: string;
  version: string;
  appVersion: string;
  homepage: string | null;
  tier: SupportTier;
  installed: boolean;
}

/** GET /api/apps/catalog?search=&category= */
export interface CatalogResponse {
  apps: CatalogApp[];
  categories: string[];
  appsPool: string | null;
}

export interface InstallQuestion {
  key: string;
  question: string;
  description?: string;
  placeholder?: string;
  type: 'text' | 'number' | 'select' | 'boolean' | 'password';
  options?: { text: string; value: string | number | boolean }[];
  required?: boolean;
  /** Default value; random-string macros are already expanded. */
  default?: string | number | boolean;
  /** True when `default` was randomly generated (offer a "Generate again" button). */
  generated?: boolean;
}

/** GET /api/apps/catalog/:id?train= */
export interface CatalogAppDetail extends CatalogApp {
  screenshots: string[];
  sources: string[];
  questions: InstallQuestion[];
  requirements: AppRequirementsInfo | null;
  /** Suggested TrueNAS app name (unique on this server). */
  suggestedName: string;
}

/** POST /api/apps/install  InstallRequest → TaskStarted */
export interface InstallRequest {
  catalogApp: string;
  train: string;
  appName?: string;
  answers: Record<string, string | number | boolean>;
}

export type AppState = 'running' | 'stopped' | 'deploying' | 'crashed' | 'stopping' | 'unknown';

export interface InstalledApp {
  name: string;
  title: string;
  icon: string | null;
  state: AppState;
  /** TrueNAS catalog (chart) version, e.g. `1.3.16`. */
  version: string;
  /** Version of the application itself, e.g. `10.10.7`. */
  appVersion: string;
  upgradeAvailable: boolean;
  latestVersion: string | null;
  latestAppVersion: string | null;
  webUrl: string | null;
  tier: SupportTier | 'custom';
  catalogApp: string | null;
  train: string | null;
  /** Locations the app stores data in. */
  locations: LocationPreferenceId[];
}

/** GET /api/apps → { apps, engine } */
export interface AppsResponse {
  apps: InstalledApp[];
  engine: { status: string; pool: string | null; description: string | null };
}

/** POST /api/apps/:name/start | stop | upgrade → TaskStarted */
/** POST /api/apps/upgrade-all → TaskStarted */
/** DELETE /api/apps/:name  { removeData } → TaskStarted */

// ---------------------------------------------------------------------------
// Dashboard, metrics and notifications
// ---------------------------------------------------------------------------

/** GET /api/dashboard */
export interface DashboardResponse {
  system: SystemSummary;
  pools: Pool[];
  apps: InstalledApp[];
  update: UpdateInfo | null;
  unreadNotifications: number;
}

/** SSE `metrics` event payload (sent every few seconds while a client is connected). */
export interface MetricsSample {
  time: string;
  cpu: { usage: number; temperatureC: number | null; cores: { usage: number; temperatureC: number | null }[] };
  memory: { totalBytes: number; usedBytes: number; cacheBytes: number; availableBytes: number };
  network: { name: string; up: boolean; speedMbps: number | null; rxBytesPerSec: number; txBytesPerSec: number }[];
  disks: { readBytesPerSec: number; writeBytesPerSec: number; busyPercent: number };
  apps: Record<string, { cpuPercent: number; memoryBytes: number }>;
}

export type NoticeLevel = 'info' | 'warning' | 'error' | 'critical';

export interface Notice {
  id: string;
  source: 'truenas' | 'apexos';
  level: NoticeLevel;
  title: string;
  message: string;
  time: string;
  dismissed: boolean;
  /** UI route related to the notice, e.g. `/storage`. */
  link: string | null;
}

/** GET /api/notifications → { notices: Notice[] } */
/** POST /api/notifications/:id/dismiss → { ok } */
/** POST /api/notifications/dismiss-all → { ok } */

/** SSE `changed` event topics. */
export type ChangeTopic =
  | 'storage'
  | 'folders'
  | 'users'
  | 'apps'
  | 'alerts'
  | 'locations'
  | 'system'
  | 'backups'
  | 'truenas-connected'
  | 'truenas-disconnected';

// --- Pool data errors ---
// Files ZFS lists as permanently damaged (`zpool status -v`), and the Repair / Check pool /
// Reset error count actions built on that list.

/**
 * How ApexOs classifies one entry of a pool's permanent-error list:
 * - `catalog`: a file in TrueNAS's own downloaded copy of the app catalog; Repair may delete it.
 * - `user`: any other file. ApexOs never deletes these.
 * - `snapshot`: a damaged file held by a snapshot (restore point), listed as `dataset@snapshot:/path`.
 * - `unreadable`: a file that was already deleted, or internal data (`<0x..>:<0x..>`, `<metadata>:<0x..>`).
 */
export type DataErrorKind = 'catalog' | 'user' | 'snapshot' | 'unreadable';

export interface DataErrorEntry {
  /** The entry exactly as ZFS lists it. */
  raw: string;
  kind: DataErrorKind;
  /** File path (for snapshots: the path inside the snapshot); null for unreadable entries. */
  path: string | null;
  /** `dataset@snapshot` for snapshot entries. */
  snapshot: string | null;
}

/**
 * - `none`: nothing listed.
 * - `quick-repair`: only TrueNAS app-catalog files are damaged ("Needs a quick repair").
 * - `user-files`: the user's own files (or snapshots of them) are damaged ("N files can't be read").
 * - `data-errors`: the list couldn't be read, only deleted/internal entries remain, or too many
 *   system files are damaged to repair safely ("Data errors").
 */
export type DataErrorState = 'none' | 'quick-repair' | 'user-files' | 'data-errors';

export interface PoolDataErrorSummary {
  state: DataErrorState;
  /** Short line for pool cards, e.g. "Needs a quick repair"; null when the state is `none`. */
  label: string | null;
  /** User files plus snapshot entries. */
  userFiles: number;
  catalogFiles: number;
  /** Deleted-file and internal-data entries. */
  unreadable: number;
  /** Why the list could not be read; never means "no errors". */
  readError: string | null;
}

/** Whether an action is allowed now, and if not, why (plain language) with a stable code. */
export interface PoolActionAvailability {
  allowed: boolean;
  /**
   * Refusal code. Repair: POOL_UNAVAILABLE, LIST_UNREADABLE, USER_FILES, TOO_MANY_FILES,
   * NOTHING_TO_REPAIR, BUSY. Reset error count: POOL_UNAVAILABLE, NOTHING_TO_RESET, DRIVE_MISSING,
   * CHECK_RUNNING, NO_CLEAN_CHECK, CHECK_FOUND_ERRORS, RESTARTED, BUSY.
   */
  code: string | null;
  reason: string | null;
}

/** Outcome of the last check (scrub) ApexOs itself started on the pool; `stale` = TrueNAS rebooted since. */
export type PoolCheckOutcome = 'none' | 'running' | 'clean' | 'errors' | 'stale';

/** GET /api/storage/pools/:id/errors[?fresh=1] */
export interface PoolDataErrors extends PoolDataErrorSummary {
  poolId: number;
  entries: DataErrorEntry[];
  /** Identifies this exact list; send it back with Repair so a changed list aborts the repair. */
  fingerprint: string;
  /** When the list was read from the server. */
  checkedAt: string;
  /** Where TrueNAS keeps its app catalog copy (`catalog.config` location). */
  catalogLocation: string | null;
  /** Repair refuses more damaged system files than this. */
  maxRepairFiles: number;
  /** The pool keeps a single copy of its data (no mirror or parity), so ZFS has nothing to repair from. */
  singleCopy: boolean;
  /** Every data drive is ONLINE with no read or write errors (points to memory or cables instead). */
  drivesLookHealthy: boolean;
  lastCheck: PoolCheckOutcome;
  repair: PoolActionAvailability;
  resetErrors: PoolActionAvailability;
}

/** POST /api/storage/pools/:id/repair  RepairPoolRequest → TaskStarted (task type `pool-repair`) */
export interface RepairPoolRequest {
  /** `PoolDataErrors.fingerprint` the user saw when clicking Repair. */
  fingerprint: string;
}

/** POST /api/storage/pools/:id/reset-errors → { ok: true }  (clears error counters only) */

// --- Drive diagnosis ---
//
// ApexOs watches the ZFS read/write/checksum error counters of every pool member (every 10 minutes and
// whenever the pool changes). When a drive reports new errors it records them, reads the drive's SMART
// data and either flags the drive for replacement right away (damaged areas, or the drive failed and did
// not come back) or runs a pool check. If that check finishes clean, ApexOs resets the drive's counters
// once and watches it for a month. Errors that come back during that month produce exactly one notice
// with a likely cause (`DriveDiagnosis`).

/** `ok`: nothing to do · `checking`: a pool check is (about to be) running for this drive's errors ·
 *  `watching`: errors were repaired and the counters reset; watched until `watchUntil` ·
 *  `attention`: the user should act (see `diagnosis`). */
export type DriveHealthState = 'ok' | 'checking' | 'watching' | 'attention';

/** Likely cause of errors that came back (or of a drive that is wearing out). */
export type DriveDiagnosis = 'check-cable' | 'check-controller' | 'check-memory' | 'replace-drive' | 'unclear';

export interface DriveErrorCounts {
  read: number;
  write: number;
  checksum: number;
}

export interface DriveHealth {
  state: DriveHealthState;
  /** End of the watch period after ApexOs reset the counters (ISO date), else null. */
  watchUntil: string | null;
  /** When ApexOs last saw new errors on this drive. */
  lastErrorAt: string | null;
  diagnosis: DriveDiagnosis | null;
}

/** What the drive says about itself (smartctl). Counts are null when the drive does not report them. */
export interface SmartSummary {
  readAt: string;
  /** False when the drive's own overall assessment is "failing"; null when unknown. */
  passed: boolean | null;
  /** ATA attribute 5. */
  reallocatedSectors: number | null;
  /** ATA attribute 197. */
  pendingSectors: number | null;
  /** ATA attribute 198. */
  offlineUncorrectable: number | null;
  /** NVMe media and data integrity errors. */
  mediaErrors: number | null;
  powerOnHours: number | null;
  temperatureC: number | null;
  /** The drive reports damaged areas (any of the sector/media counts above is non-zero). */
  damaged: boolean;
}

export type DriveHealthEventKind =
  | 'errors' // new errors were counted
  | 'failed' // the drive stopped working (FAULTED, REMOVED, UNAVAIL)
  | 'recovered' // a failed drive is back online
  | 'smart' // SMART data was read
  | 'check' // pool check started, waiting, finished or could not finish
  | 'cleared' // ApexOs reset the drive's error counters
  | 'kept' // ApexOs deliberately did not reset the counters
  | 'watch' // watch period started or ended
  | 'diagnosis' // a likely cause was found and the user was told
  | 'pool'; // the drive joined or left a pool

export interface DriveHealthEvent {
  time: string;
  kind: DriveHealthEventKind;
  /** Plain-language description of what happened or what ApexOs did. */
  message: string;
  /** New errors counted with this event (for `errors`), else null. */
  errors: DriveErrorCounts | null;
}

/** GET /api/storage/drives/:identifier/health → DriveHealthDetail (`identifier` URL-encoded). */
export interface DriveHealthDetail {
  identifier: string;
  name: string;
  serial: string;
  model: string;
  pool: string | null;
  /** Current ZFS error counters (zero for drives outside a pool). */
  errors: DriveErrorCounts;
  health: DriveHealth;
  /** Why ApexOs reached `health.diagnosis`, e.g. which drives reported errors together. */
  diagnosisNote: string | null;
  /** Latest SMART reading, or null when it has never been read. */
  smart: SmartSummary | null;
  /** Error episodes and the actions ApexOs took, newest first. */
  events: DriveHealthEvent[];
  /** How often the counters are checked, in minutes. */
  checkIntervalMinutes: number;
}

/**
 * POST /api/storage/drives/:identifier/smart → SmartSummary
 * Reads SMART now (takes a few seconds). 409 SMART_UNAVAILABLE when the drive can't report it.
 */

// --- Network settings ---

/** How a network connection gets its IPv4 address: automatically (DHCP), fixed (static), or not set up. */
export type NetworkMode = 'dhcp' | 'static' | 'none';

export interface NetworkAddress {
  address: string;
  /** Prefix length, e.g. 24 for 255.255.255.0. */
  prefix: number;
}

/** One network port or VLAN with its configuration. Extends the read-only fields of `NetworkInfo`. */
export interface NetworkInterfaceSettings extends NetworkInfoInterface {
  mode: NetworkMode;
  /** Fixed IPv4 addresses configured in TrueNAS (the first one is what ApexOs edits). */
  configuredAddresses: NetworkAddress[];
  /** IPv4 addresses the port has right now. */
  liveAddresses: NetworkAddress[];
  description: string;
  /** Configured MTU; null means the default (1500). */
  mtu: number | null;
  vlan: { parent: string; tag: number } | null;
  /** ApexOs talks to TrueNAS through this connection: changing it can cut ApexOs off. */
  usedByApexOs: boolean;
  /** ApexOs can change ports and VLANs; bridges and bonds are left to the TrueNAS UI. */
  editable: boolean;
  /** False for a VLAN that exists in the configuration but was never applied. */
  applied: boolean;
}

export type NetworkInfoInterface = NetworkInfo['interfaces'][number];

/** GET /api/system/network */
export interface NetworkSettings extends NetworkInfo {
  interfaces: NetworkInterfaceSettings[];
  domain: string;
  /** Gateway set by hand ('' = taken from DHCP). `gateway` holds the one in use. */
  configuredGateway: string;
  /** DNS servers set by hand ([] = taken from DHCP). `nameservers` holds the ones in use. */
  configuredNameservers: string[];
  gatewayFromDhcp: boolean;
  nameserversFromDhcp: boolean;
  /** TrueNAS lets only one connection use DHCP; this is it (null when none does). */
  dhcpInterface: string | null;
  /** Address of the server that ApexOs connects to, when TrueNAS reports it. */
  apexosAddress: string | null;
  /** Staged network changes that were never applied (e.g. left over in the TrueNAS UI). */
  pendingChanges: boolean;
  /** Seconds until TrueNAS undoes applied-but-unconfirmed changes; null when nothing is waiting. */
  rollbackSecondsLeft: number | null;
  /** How long ApexOs gives itself to confirm a change before TrueNAS undoes it. */
  checkinTimeoutSeconds: number;
}

/** PUT /api/system/network/interfaces/:name → TaskStarted */
export interface InterfaceChangeRequest {
  mode: 'dhcp' | 'static';
  /** Required for `static`. */
  address?: string;
  /** Required for `static`. */
  prefix?: number;
  /** Router address. Omit to keep the current setting; '' = take it from DHCP. */
  gateway?: string;
  /** Up to three DNS servers. Omit to keep the current setting; [] = take them from DHCP. */
  nameservers?: string[];
  /** Required when `usedByApexOs`: the user accepts that ApexOs may lose its connection for a moment. */
  acknowledgeConnectionRisk?: boolean;
}

/** PUT /api/system/network/dns → TaskStarted */
export interface DnsChangeRequest {
  /** [] = take them from DHCP. */
  nameservers: string[];
  /** '' = take it from DHCP. */
  gateway: string;
}

/** POST /api/system/network/vlans → TaskStarted */
export interface VlanCreateRequest {
  parent: string;
  /** 1–4094, unique per parent. */
  tag: number;
  mode: 'dhcp' | 'static';
  address?: string;
  prefix?: number;
  description?: string;
}

/** DELETE /api/system/network/vlans/:name → TaskStarted */
/** POST /api/system/network/discard → { ok } (drops staged changes that were never applied) */

/** Step a network task adds when it had to put the previous settings back (the task then fails). */
export type NetworkRestoreStep = 'Restoring your previous settings';

// --- Remote access & 2FA ---
// Two-factor sign-in (TOTP, RFC 6238) for the ApexOs admin account, session controls, and remote
// access through services the user runs or owns (Tailscale, Cloudflare Tunnel, their own VPN/proxy).

/**
 * POST /api/auth/login { username, password }. When two-factor sign-in is on, the password step
 * returns a short-lived challenge to send with the code to /api/auth/login/verify.
 * Errors: 401 INVALID_CREDENTIALS, 429 RATE_LIMITED (with a Retry-After header).
 */
export type LoginResponse = { ok: true } | { ok: false; twoFactorRequired: true; challenge: string; expiresAt: string };

/** POST /api/auth/login/verify. `code` is a 6-digit authenticator code or a recovery code. */
export interface LoginVerifyRequest {
  challenge: string;
  code: string;
}

/** Errors: 401 INVALID_CODE, 401 CHALLENGE_EXPIRED (start again with the password), 429 RATE_LIMITED. */
export interface LoginVerifyResponse {
  ok: true;
  recoveryCodeUsed: boolean;
  recoveryCodesLeft: number;
}

/** GET /api/auth/security */
export interface AccountSecurity {
  twoFactor: {
    enabled: boolean;
    enabledAt: string | null;
    recoveryCodesLeft: number;
  };
  /** Whether the password looked strong when it was set; null when it was set before ApexOs checked. */
  strongPassword: boolean | null;
  /** APEXOS_SECURE_COOKIES=1 is set. */
  secureCookies: boolean;
  /** This request arrived over HTTPS (directly, or through a proxy that says so). */
  https: boolean;
}

/** POST /api/auth/2fa/setup → a new secret to add to an authenticator app. Nothing changes until it is confirmed. */
export interface TwoFactorSetup {
  /** Base32 secret, for typing in by hand. */
  secret: string;
  otpauthUri: string;
  issuer: string;
  account: string;
  /** QR code of `otpauthUri`: `size` modules square, SVG path data in module units (add a 4-module light margin). */
  qr: { size: number; path: string };
}

/** POST /api/auth/2fa/enable { code } → RecoveryCodesResponse. Other browsers are signed out. Errors: 400 INVALID_CODE, 409 SETUP_EXPIRED. */
export interface TwoFactorEnableRequest {
  code: string;
}

/** Shown once; only hashes are kept. */
export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

/** POST /api/auth/2fa/disable → { ok: true }. `code` may be a recovery code. Errors: 400 INVALID_CREDENTIALS / INVALID_CODE, 409 REMOTE_ACCESS_ON. */
export interface TwoFactorDisableRequest {
  password: string;
  code: string;
}

/** POST /api/auth/2fa/recovery-codes { code } → RecoveryCodesResponse (replaces all unused codes). */
export interface RecoveryCodesRequest {
  code: string;
}

// DELETE /api/auth/2fa/setup → { ok: true } (cancels an unfinished enrollment)
// POST /api/auth/sign-out-everywhere → { ok: true } (every session ends, including this one)

export type RemoteMethodId = 'tailscale' | 'cloudflare';

/** `missing`: ApexOs set it up but the app has since been removed (e.g. from the TrueNAS UI). */
export type RemoteAppState = AppState | 'missing';

export interface SecurityCheckItem {
  id: 'two-factor' | 'password' | 'secure-cookies';
  /** null = can't tell. */
  ok: boolean | null;
  title: string;
  detail: string;
}

export interface TailscaleStatus {
  /** ApexOs set Tailscale up and remembers it. */
  enabled: boolean;
  /** A Tailscale app ApexOs didn't set up is installed (ApexOs leaves it alone). */
  external: boolean;
  appName: string | null;
  state: RemoteAppState | null;
  /** Machine name in the tailnet (from the app's configuration). */
  hostname: string | null;
  /** Machine name suggested for a new setup (the server name). */
  suggestedHostname: string;
  routes: string[];
  /** The home network "share my home network" would advertise, e.g. 192.168.1.0/24. */
  homeNetwork: string | null;
  controlServer: string | null;
  /** The server's 100.x address. Known only once ApexOs has been opened through Tailscale. */
  tailnetIp: string | null;
  /** Full MagicDNS name (e.g. `homeserver.tail1234.ts.net`), when seen. */
  tailnetName: string | null;
  /** ApexOs address for tailnet devices, e.g. http://homeserver:8080 (needs MagicDNS) or the 100.x address. */
  remoteUrl: string | null;
  /** File-share address for tailnet devices, e.g. \\homeserver */
  filesAddress: string | null;
  appVersion: string | null;
  enabledAt: string | null;
}

/** POST /api/remote/tailscale → TaskStarted (task type `remote-enable`). Errors: 409 TWO_FACTOR_RECOMMENDED / ALREADY_INSTALLED / NO_APPS_POOL. */
export interface TailscaleEnableRequest {
  /** Auth key from the user's own Tailscale (or Headscale) account. Passed to TrueNAS, never stored by ApexOs. */
  authKey: string;
  /** Machine name: lowercase letters, numbers and dashes. */
  hostname: string;
  /** Advertise the home network as a subnet route (needs approval in the Tailscale admin console). */
  shareHomeNetwork: boolean;
  /** Self-hosted coordination server (Headscale), https URL. */
  controlServer?: string | null;
  /** Required while two-factor sign-in is off. */
  acceptWithoutTwoFactor?: boolean;
}

export interface CloudflareStatus {
  enabled: boolean;
  external: boolean;
  appName: string | null;
  state: RemoteAppState | null;
  publicHostname: string | null;
  /** What to enter as the tunnel's service URL in Cloudflare, e.g. http://192.168.1.20:8080 */
  serviceUrl: string | null;
  appVersion: string | null;
  enabledAt: string | null;
}

/** POST /api/remote/cloudflare → TaskStarted. Errors: 409 TWO_FACTOR_REQUIRED / ALREADY_INSTALLED / NO_APPS_POOL, 400 VALIDATION. */
export interface CloudflareEnableRequest {
  /** Tunnel token from the user's Cloudflare account. Passed to TrueNAS, never stored by ApexOs. */
  token: string;
  /** Public hostname set up for the tunnel in Cloudflare, e.g. nas.example.com (informational). */
  publicHostname?: string | null;
}

// DELETE /api/remote/tailscale, DELETE /api/remote/cloudflare → TaskStarted (task type `remote-disable`):
// removes the app and its internal data (node identity, tunnel connection); nothing secret is kept.

/** GET /api/remote */
export interface RemoteAccessStatus {
  /** ApexOs on the home network, e.g. http://192.168.1.20:8080 */
  localUrl: string | null;
  lanIp: string | null;
  port: number;
  /** How the browser asking is connected right now. */
  connectedVia: 'tailscale' | 'cloudflare' | 'proxy' | 'direct';
  /** Apps can be installed (an apps pool is set up and Docker runs). */
  appsReady: boolean;
  appsMessage: string | null;
  twoFactorEnabled: boolean;
  checklist: SecurityCheckItem[];
  tailscale: TailscaleStatus;
  cloudflare: CloudflareStatus;
}

// --- Encryption ---
// Folder encryption (ZFS native encryption, one encryption root per folder), lock/unlock, key modes,
// turning encryption on for an existing folder, and the server recovery file. Passphrases travel only in
// requests and are never stored by ApexOs.

/**
 * - `none`: not encrypted.
 * - `key`: automatic key, kept by TrueNAS on the system drive; the folder unlocks by itself at start-up.
 * - `passphrase`: the folder stays locked after every restart until someone types the passphrase.
 */
export type EncryptionMode = 'none' | 'key' | 'passphrase';

export interface FolderEncryption {
  mode: EncryptionMode;
  /** Encrypted and locked: files can't be opened and the network share is hidden. */
  locked: boolean;
  /** Dataset whose key protects the folder; null when not encrypted. */
  root: string | null;
  /** The folder uses the key of a dataset above it, so lock, unlock and key changes happen there. */
  inherited: boolean;
  /** Automatic-key folder that the current recovery file doesn't cover (added or changed since the last download). */
  notInRecoveryFile: boolean;
  /** Apps that keep files in the folder (TrueNAS attachments); filled for locked folders, which they can't reach. */
  appsAffected: string[];
}

/** Turning on encryption for an existing folder (Copy strategy); present while running or until cleaned up. */
export interface EncryptionConversion {
  /** `interrupted`: ApexOs restarted while it ran; Retry continues where it stopped. */
  state: 'running' | 'failed' | 'interrupted' | 'done';
  /** The step that is running or that failed. */
  step: string | null;
  error: string | null;
  /** The encrypted copy has taken over the folder's name; Discard is no longer possible. */
  switched: boolean;
  taskId: string | null;
  mode: Exclude<EncryptionMode, 'none'>;
  /** A passphrase was chosen but couldn't be applied (ApexOs restarted); the folder uses an automatic key for now. */
  passphrasePending: boolean;
  /** The unencrypted original kept as a safety copy, and when ApexOs removes it on its own. */
  safetyCopy: { dataset: string; usedBytes: number; removeAfter: string } | null;
  startedAt: string;
}

// Interface merging: these fields extend the declarations in "Folders and users" above.
export interface Folder {
  /** Always present in server responses. */
  encryption?: FolderEncryption;
  conversion?: EncryptionConversion | null;
}

export interface FolderRequest {
  /** How a new folder is encrypted; omitted means `{ mode: 'none' }`. Ignored when editing. */
  encryption?: NewFolderEncryption;
}

export interface NewFolderEncryption {
  mode: EncryptionMode;
  /** Required for `passphrase` (at least 8 characters). Never stored. */
  passphrase?: string;
}

/** POST /api/folders/:name/lock → TaskStarted (passphrase folders only) */
/** POST /api/folders/:name/unlock  UnlockFolderRequest → TaskStarted (a wrong passphrase or key is a 400 with fields) */
export interface UnlockFolderRequest {
  /** For passphrase folders. */
  passphrase?: string;
  /** For automatic-key folders whose key TrueNAS lost: the 64-character hex key from the recovery file. */
  key?: string;
}

/** PUT /api/folders/:name/encryption  ChangeKeyModeRequest → TaskStarted */
export interface ChangeKeyModeRequest {
  mode: Exclude<EncryptionMode, 'none'>;
  /** New passphrase when switching to `passphrase` (at least 8 characters). */
  passphrase?: string;
  /** Current passphrase, needed when the folder is locked. */
  currentPassphrase?: string;
}

export type ConversionDuration = 'minutes' | 'up-to-an-hour' | 'a-few-hours' | 'a-day-or-more';

/** GET /api/folders/:name/encryption/convert — can encryption be turned on, and what it takes. */
export interface ConversionCheck {
  allowed: boolean;
  /** Each reason it can't start, in plain words. Codes: SYSTEM_FOLDER, ALREADY_ENCRYPTED, APPS, IN_USE, CHILD_ENCRYPTED, CHILD_SHARED, REPLICATION, SPACE, BUSY, NAME_TAKEN, LOCKED_PARENT. */
  blockers: { code: string; message: string }[];
  /** Space the encrypted copy needs on the pool (the folder, its snapshots and sub-datasets, plus a margin). */
  spaceNeededBytes: number;
  freeBytes: number;
  duration: ConversionDuration;
  /** Datasets inside the folder that are copied along. */
  childDatasets: string[];
  /** Restore points (snapshots) copied along. */
  snapshots: number;
}

/** POST /api/folders/:name/encryption/convert  StartConversionRequest → TaskStarted */
export interface StartConversionRequest {
  mode: Exclude<EncryptionMode, 'none'>;
  passphrase?: string;
  /** Keep the unencrypted original as a safety copy for a while (default true). */
  keepOriginal?: boolean;
}

/** POST /api/folders/:name/encryption/convert/retry  { passphrase? } → TaskStarted */
/** POST /api/folders/:name/encryption/convert/discard → TaskStarted (only before the switch-over) */
/** DELETE /api/folders/:name/encryption/safety-copy → TaskStarted (removes the unencrypted original) */

/** GET /api/encryption/recovery */
export interface RecoveryKeyStatus {
  /** Folders with an automatic key: these are what the recovery file unlocks. */
  keyFolders: { name: string; pool: string; dataset: string; inFile: boolean; keyStored: boolean }[];
  /** Folders with a passphrase (not in the file: only their owner knows the passphrase). */
  passphraseFolders: string[];
  lastDownloadedAt: string | null;
  /** Automatic-key folders added or changed since the last download. */
  addedSinceDownload: number;
}

/** POST /api/encryption/recovery/file → the recovery file (JSON, `{"<dataset>": "<hex key>"}`), as an attachment. */

// --- File browser ---
// Browse and organize the files inside the folders ApexOs lists. Paths are always relative to the
// folder ('' is the folder itself, segments separated by '/'); the server resolves and checks them.
// `folder` is a folder name as in GET /api/folders (or `pool/Name` when two pools have the same name).

/** `link`: a symbolic link (shown, never opened or followed). `other`: devices, sockets and the like. */
export type FileEntryType = 'folder' | 'file' | 'link' | 'other';
export type FileSortKey = 'name' | 'size' | 'type' | 'modified';
export type FileSortOrder = 'asc' | 'desc';

export interface FileEntry {
  name: string;
  /** Relative to the folder. */
  path: string;
  type: FileEntryType;
  /** Bytes, for files and links; null for folders. */
  size: number | null;
  /** Last modification (ISO); null when unknown. */
  modified: string | null;
  /** A separately stored area inside the folder (its own dataset): can be opened, but not renamed, moved or deleted. */
  separate: boolean;
  /** Name starts with a dot. */
  hidden: boolean;
}

/** One folder the file browser can open. */
export interface FileRoot {
  name: string;
  pool: string;
  poolDisplayName: string;
  dataset: string;
  /** Encrypted and locked: nothing can be browsed until it is unlocked. */
  locked: boolean;
  encrypted: boolean;
}

/** GET /api/files */
export interface FileRootsResponse {
  folders: FileRoot[];
  /** Largest file the server accepts in one upload (APEXOS_UPLOAD_MAX_BYTES). */
  uploadMaxBytes: number;
  /** Most items one move, copy or delete may act on. */
  maxItems: number;
}

/**
 * GET /api/files/list?folder=&path=&sort=name|size|type|modified&order=asc|desc&offset=0&limit=200&hidden=1&foldersOnly=1
 * Folders always come first. Only the returned page is `stat`ed for dates.
 */
export interface FileListing {
  folder: string;
  path: string;
  entries: FileEntry[];
  /** Entries in the directory (after the hidden filter, at most `scanLimit`). */
  total: number;
  offset: number;
  limit: number;
  sort: FileSortKey;
  order: FileSortOrder;
  /** The directory has more than `scanLimit` entries; only the first ones (by name) are shown. */
  truncated: boolean;
  scanLimit: number;
  /** Sorting by date was not possible for a directory this large; sorted by name instead. */
  sortFallback: boolean;
  /** This directory is inside a separately stored area (a dataset inside the folder). */
  separate: boolean;
}

/** How to handle a name that already exists at the destination. `ask` fails with 409 CONFLICT. */
export type FileConflictMode = 'ask' | 'replace' | 'keep-both' | 'skip';

/** POST /api/files/check  { folder, path, names } → which names already exist in that directory */
export interface FileCheckRequest {
  folder: string;
  path: string;
  names: string[];
}
export interface FileCheckResponse {
  existing: { name: string; type: FileEntryType }[];
  /** Names the server would refuse, with the reason. */
  invalid: { name: string; reason: string }[];
}

/**
 * POST /api/files/mkdir → FileEntry. With `parents`, `name` may be a relative path and existing folders
 * along it are reused. `conflict`: 'ask' (default, 409 EXISTS if taken), 'keep-both' (adds " (1)"),
 * 'skip' (reuse an existing folder).
 */
export interface FileMkdirRequest {
  folder: string;
  path: string;
  name: string;
  parents?: boolean;
  conflict?: 'ask' | 'keep-both' | 'skip';
}

/** POST /api/files/rename → FileEntry (never replaces an existing name) */
export interface FileRenameRequest {
  folder: string;
  path: string;
  newName: string;
}

/**
 * POST /api/files/move and /api/files/copy → TaskStarted (task types `files-move`, `files-copy`).
 * `conflict`: 'ask' fails with 409 CONFLICT listing the names; 'keep-both' adds " (1)"; 'skip' leaves them.
 * Nothing is ever replaced.
 */
export interface FileTransferRequest {
  folder: string;
  paths: string[];
  destination: string;
  conflict?: 'ask' | 'keep-both' | 'skip';
}

/** POST /api/files/delete → TaskStarted (task type `files-delete`). There is no trash. */
export interface FileDeleteRequest {
  folder: string;
  paths: string[];
}

/**
 * POST /api/files/upload?folder=&path=&name=&conflict=  (body: the raw file, Content-Type application/octet-stream)
 * `name` may contain '/' to recreate a folder structure (missing folders are created).
 */
export interface FileUploadResponse {
  action: 'created' | 'replaced' | 'renamed' | 'skipped';
  entry: FileEntry;
}

/** GET /api/files/download?folder=&path= → the file as an attachment (single files only). */

// --- Backups ---
// Copies of folders on another TrueNAS server the user owns. The servers talk directly (same home
// network or the user's own VPN such as Tailscale): ApexOs sets up both sides through their TrueNAS APIs,
// and TrueNAS replication sends snapshots over SSH. Task types: `backup-destination-add`,
// `backup-destination-remove`, `backup-create`, `backup-run`, `backup-fresh-copy`, `backup-remove`,
// `backup-restore`.

export type BackupFrequency = 'hourly' | 'daily' | 'weekly';

export interface BackupSchedule {
  frequency: BackupFrequency;
  /** "HH:MM" (24 h) in the server's time zone; hourly backups use only the minutes. */
  time: string;
  /** 0 = Sunday … 6 = Saturday; weekly backups only. */
  weekday: number;
}

export interface BackupOptions {
  schedule: BackupSchedule;
  /** Restore points are kept this many days, on both servers. */
  keepDays: number;
  /** Upload limit in megabits per second; null means full speed. */
  speedLimitMbps: number | null;
}

export type DestinationHealth = 'online' | 'unreachable' | 'nearly-full' | 'full';

export interface BackupDestination {
  id: string;
  /** The other server's name (its hostname when it was added). */
  name: string;
  /** Address ApexOs uses to reach it, e.g. `https://192.168.1.30`. */
  address: string;
  pool: string;
  /** Where the copies live on the other server, e.g. `tank/apexos-backups/myserver`. */
  dataset: string;
  /** Space set aside on the other server (quota and reservation). */
  grantedBytes: number;
  /** Space the copies use, including restore points; null when the server can't be reached. */
  usedBytes: number | null;
  health: DestinationHealth;
  /** Plain-language problem, e.g. why it can't be reached. */
  problem: string | null;
  checkedAt: string | null;
  /** The backup area is inside an encrypted dataset: only encrypted folders can be sent there. */
  encryptedOnly: boolean;
  ssh: { host: string; port: number };
  backupCount: number;
  createdAt: string;
}

export type BackupState = 'waiting' | 'running' | 'ok' | 'failed' | 'overdue' | 'paused' | 'needs-fresh-copy';

export interface BackupStatus {
  state: BackupState;
  /** Short summary, e.g. "Up to date". */
  label: string;
  /** What went wrong and what to do, in plain language. */
  detail: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  nextRunAt: string | null;
  progress: { percent: number; bytesSent: number; bytesTotal: number } | null;
}

export interface Backup extends BackupOptions {
  id: string;
  folder: string;
  pool: string;
  dataset: string;
  /** False when the folder was deleted on this server (its copy can still be restored). */
  folderExists: boolean;
  /** The folder is encrypted: it travels and is stored encrypted (the other server can't read it). */
  encrypted: boolean;
  destinationId: string;
  destinationName: string;
  remoteDataset: string;
  remoteUsedBytes: number | null;
  restorePoints: number | null;
  paused: boolean;
  status: BackupStatus;
  createdAt: string;
}

/** Removal work waiting for an offline server to come back. */
export interface PendingCleanup {
  id: string;
  destinationName: string;
  description: string;
  since: string;
  lastError: string | null;
}

/** GET /api/backups */
export interface BackupsResponse {
  serverName: string;
  /** Time zone schedules run in (the TrueNAS server's). */
  timezone: string;
  destinations: BackupDestination[];
  backups: Backup[];
  pendingCleanups: PendingCleanup[];
}

/** How to sign in to the other server once. Passwords are never stored. */
export type DestinationCredentials =
  | { address: string; method: 'password'; username: string; password: string }
  | { address: string; method: 'apiKey'; apiKey: string };

export interface DestinationPoolChoice {
  name: string;
  sizeBytes: number;
  freeBytes: number;
  encrypted: boolean;
  usable: boolean;
  /** Why the pool can't be used, or a caveat when it can. */
  note: string | null;
}

/** POST /api/backups/destinations/check  DestinationCredentials → DestinationCheck */
export interface DestinationCheck {
  name: string;
  version: string;
  address: string;
  pools: DestinationPoolChoice[];
  sshEnabled: boolean;
  /** Total size of this server's folders, to suggest how much space to set aside. */
  foldersBytes: number;
}

/** POST /api/backups/destinations  AddDestinationRequest → TaskStarted */
export type AddDestinationRequest = DestinationCredentials & { pool: string; spaceBytes: number };

/** PUT /api/backups/destinations/:id  { spaceBytes } → { ok } */
export interface UpdateDestinationRequest {
  spaceBytes: number;
}

/** DELETE /api/backups/destinations/:id → TaskStarted (removes its backups and everything ApexOs set up there) */

/** POST /api/backups  NewBackupRequest → TaskStarted */
export interface NewBackupRequest extends BackupOptions {
  destinationId: string;
  folders: string[];
}

/** PUT /api/backups/:id  UpdateBackupRequest → Backup */
export interface UpdateBackupRequest extends Partial<BackupOptions> {
  paused?: boolean;
}

/** POST /api/backups/:id/run → TaskStarted ("Back up now") */
/** POST /api/backups/:id/fresh-copy → TaskStarted (deletes the copy on the other server and sends everything again) */
/** DELETE /api/backups/:id → TaskStarted (removes the tasks here and the copy on the other server) */
/** DELETE /api/backups/cleanups/:id → { ok } (forget cleanup work for a server that is gone for good) */

export interface RestorePoint {
  name: string;
  createdAt: string;
}

/** GET /api/backups/:id/restore */
export interface RestoreInfo {
  /** Newest first. */
  restorePoints: RestorePoint[];
  suggestedName: string;
  sizeBytes: number;
  encrypted: boolean;
  keyFormat: 'passphrase' | 'key' | null;
  pools: { name: string; displayName: string; freeBytes: number }[];
  defaultPool: string;
  /** The original folder still exists (the restored copy gets the same access). */
  originalExists: boolean;
}

/** POST /api/backups/:id/restore  RestoreRequest → TaskStarted. Always creates a new folder. */
export interface RestoreRequest {
  /** Restore point name; null for the newest. */
  restorePoint: string | null;
  name: string;
  pool: string;
  /** Unlocks an encrypted restore right away; used once and never stored. */
  secret?: string | null;
}
