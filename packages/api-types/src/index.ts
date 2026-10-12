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
