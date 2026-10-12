# @apexos/mock-truenas

An in-memory, stateful simulation of the TrueNAS SCALE 25.10 middleware JSON-RPC 2.0 websocket API.
ApexOs uses it for server integration tests and for demo mode, where you can click through the whole
product without a NAS. It follows the shapes in the ApexOs TrueNAS API reference: upper-case enums,
`{"$date": ms}` datetimes, ZFS property objects, legacy job semantics (calls return a job id and
progress arrives through `core.get_jobs` events), and `collection_update` events.

```ts
import { startMockTrueNas } from '@apexos/mock-truenas';

const mock = await startMockTrueNas({ scenario: 'configured', jobDelayMs: 0 });
// mock.url     -> ws://127.0.0.1:PORT/api/current (/api/v25.10.0 … /api/v25.10.5 work too)
// mock.baseUrl -> http://127.0.0.1:PORT (GET /api/versions, GET /api/boot_id)
mock.failDrive('sdc');
await mock.close();
```

## Options

| Option | Default | |
|---|---|---|
| `port` / `host` | random / `127.0.0.1` | |
| `apiKey` | `demo-api-key` | accepted for the admin user (also re-added to a loaded state file) |
| `adminUsername` / `adminPassword` | `truenas_admin` / `demo-password` | |
| `jobDelayMs` | `150` | delay per simulated job step; tests use `0` or `1` |
| `stateFile` | none | load state at start; save after every change (debounced, write + rename) |
| `scenario` | `fresh` | seed used when there is no saved state |

## Scenarios

Both scenarios simulate the same hardware: ASRock B550M Pro4, AMD Ryzen 5 5600G (6 cores / 12 threads),
32 GiB non-ECC RAM, TrueNAS 25.10.7 with 25.10.8 offered as an update.

| Disk | Device |
|---|---|
| `sda` | 256 GB Crucial MX500 SATA SSD, the boot pool |
| `sdb`–`sde` | 8 TB Seagate IronWolf `ST8000VN004-2M2101`, 7200 rpm |
| `sdf` | 4 TB WD Red `WD40EFAX-68JH4N1` (SMR), with an exported pool `oldtank` from host `old-nas` |
| `nvme0n1`, `nvme1n1` | 1 TB Samsung 980 PRO |
| `sdg` | 32 GB SanDisk Ultra Fit USB stick |

The network has `enp5s0` (DHCP, 192.168.1.20/24, gateway and DNS 192.168.1.1, link up at 1 Gb/s) and
`enp6s0` (link down).

- **fresh**: just installed. There are no pools, Docker is `UNCONFIGURED`, SMB is stopped, and there is
  only the admin account (plus builtin `root`, `apps` and `nobody`). `pool.import_find` finds `oldtank`;
  importing it brings in `oldtank/Backups` and `oldtank/Old-Photos`.
- **configured**: an already set-up system. It has:
  - pool `HDDs` (RAIDZ1 on `sdb`–`sde`) with SMB datasets and shares `Media`, `Photos` and `Documents`
    (Photos and Documents are private to `alice`);
  - pool `SSDs` (MIRROR on the NVMe drives) with `SSDs/Applications` and the apps pool (`SSDs/ix-apps`);
  - SMB running and share user `alice` / `alice-password`;
  - Jellyfin running one catalog version behind, so it shows `upgrade_available` and an `AppUpdate` alert.

## Simulating failures

Use these helpers on the returned object, or mutate `mock.state` directly. If you use a state file,
call `mock.save()` after direct mutations.

- `failDrive(name, mode = 'FAULTED')`: `FAULTED` adds error counters, `REMOVED` pulls the disk (it disappears
  from `disk.query` and shows up as `unavail_disk` in the topology), and `UNAVAIL` and `OFFLINE` are also
  accepted. The pool goes `DEGRADED` (or `UNAVAIL` when redundancy is exceeded) and a CRITICAL
  `VolumeStatus` alert is raised. `pool.replace` then simulates a resilver: you see a `REPLACING` vdev,
  `zfs.pool.scan` events, the old disk is released and the alert clears.
- `restoreDrive(name)`: back to `ONLINE` with cleared counters.
- `setDiskTemperature(name, celsius | null)`: overrides `disk.temperatures`. At or above the critical
  threshold it raises a `DiskTemperatureTooHot` alert.
- `addDisk(spec?)`: hot-plugs another disk (an 8 TB IronWolf by default) and returns its name (`sdh`, …).
- `setDataErrors(pool, entries)`: the permanent-error list printed by `zpool status -v` (file paths,
  `pool/ds@snap:/path` or `<0x..>:<0x..>`); the pool reports `CORRUPT_DATA`. `rm` turns a listed path into
  an object reference, and the next scrub drops references and counts the entries still listed as errors.
  In a demo state file, edit the pool's `dataErrors` array instead.
- `addLatentDataErrors(pool, entries)`: damage nobody noticed yet; the next scrub that finishes adds it to
  the list (e.g. a check after a repair finding more damage).
- `setMemoryErrors(count, location?)`: raises (or, with 0, clears) the `MemoryErrors` hardware alert.

## What is simulated

- Authentication: `auth.*` (API key, `login_ex` with password, API key or token) and `api_key.*`.
- System: `system.*`, `update.*`, `network.*`, `interface.*`, `service.*`.
- Storage: `disk.*`, `boot.*`, and `pool.*` (create/update/attach with RAIDZ expansion/replace/remove/
  detach/offline/online/export/import/scrub plus scrub tasks), `pool.dataset.*` and `pool.snapshot.*`.
- Sharing and accounts: `sharing.smb.*`, `smb.*`, `user.*`, `group.*`, `filesystem.*` (stat, listdir,
  mkdir, ACLs, setperm, chown, ACL templates).
- Apps: `docker.*`, `catalog.*`, `app.*` (catalog and custom compose apps, port and host-path
  validation, `ix_volume` datasets, upgrade and rollback) and `app.image.*`.
- `tunable.*` (sysctl tunables; create/update/delete are jobs, unknown sysctls and duplicates are refused).
- Encryption (see below), `pool.dataset.rename`, `core.download` with `GET /_download/<job>`, and
  `replication.run_onetime` over LOCAL transport.
- `alert.*`; the event sources `reporting.realtime` and `app.stats` (both accept `:{"interval": n}`);
  `core.get_methods`; and CRUD events for pools, datasets, snapshots, shares, users, groups, apps,
  services and alerts.

Run `core.get_methods` for the full list. Things that are approximated:
- Capacity: RAIDZ capacity is `(n − parity) × smallest disk − 3%`. MIRROR uses the smallest disk and
  STRIPE the sum. Allocation is the sum of the datasets' simulated usage.
- VMs, replication over SSH, periodic snapshot/replication tasks and SMART are not modelled.
- Operations still running when the state is saved are settled on load: resilvers finish, scrubs are
  cancelled, and deploying apps come up.

## Encryption

ZFS native encryption follows middleware 25.10 (`plugins/pool_/dataset_encryption_*.py`):

- Only encryption roots carry encryption settings (`DatasetState.encryption`: key format, algorithm, the key
  or passphrase in plain text, `keyLoaded`, `keylocation`); everything below a root inherits it. `encrypted`,
  `encryption_root`, `key_loaded` and `locked` are only included in `pool.dataset.query` when `extra.properties`
  is omitted or names a crypto property (`encryption`, `encryptionroot`, `keyformat`, `keylocation`,
  `keystatus`); `key_format` needs `keyformat` (or no list).
- `pool.dataset.create` validates `encryption` / `inherit_encryption` / `encryption_options` like the
  middleware (passphrase roots can't have key-encrypted children, no unencrypted dataset inside an
  encrypted one, parent must be unlocked).
- TrueNAS's key store is `state.encryptionKeys` (dataset name → hex key). HEX keys are stored on create,
  `change_key`, unlock with a key, and LOCAL replication receives with `encryption_key_location: "$TrueNAS"`;
  passphrases never are. Records are keyed by name: `pool.dataset.rename` leaves them behind, destroying a
  dataset or exporting its pool drops them, and `export_keys` first prunes records that no longer open a root
  of that name (`sync_db_keys`).
- `pool.dataset.lock` (passphrase roots only; stops apps with host paths inside), `unlock` (wrong secrets
  come back in `failed` as `Invalid Key`; apps aren't restarted), `encryption_summary`, `change_key`,
  `export_key`, and `export_keys` (output pipe only: call it through `core.download`). Uploaded key files
  (`key_file: true`) are not simulated.
- Locked datasets: shares report `locked: true`, `filesystem.listdir` of the mountpoint is empty, paths
  below it don't exist, `mkdir` fails with EPERM and ACL/permission changes are refused.
- `system.reboot` (and `update.run` with reboot) lock every root and unlock key-encrypted ones whose key is
  stored under their current name; passphrase roots stay locked. Pool import does the same (after an export
  no keys are left, so encrypted datasets come back locked).
- `replication.run_onetime` (LOCAL, PUSH) copies a dataset tree with its snapshots, files, owners, ACLs and
  properties; with `encryption` the target becomes a new encryption root (`-x encryption` for children) and
  takes ~1% more space. `only_from_scratch`, `allow_from_scratch`, `readonly` (default SET), retention
  SOURCE/NONE, `properties_override` / `_exclude`, `name_regex` and naming schemas are honoured. The LOCAL
  code lives in `methods/replication-local.ts` behind a transport check so other transports can be added.

## Catalog data

`src/data/catalog.json` holds real metadata for 29 apps from the TrueNAS apps catalog,
[github.com/truenas/apps](https://github.com/truenas/apps), at commit
`fca56f2374d13d956d3cd18491609a16d9c02020`. That data is **LGPL-3.0** (© iXsystems). Each entry
includes titles, descriptions, versions, icons, screenshots, images, default ports and a trimmed install
schema. Regenerate it with:

```sh
python3 -I scripts/generate-catalog.py [git-ref]
```

The current catalog no longer has `overseerr`, `jellyseerr` or `minio`, so it includes their successors:
`seerr` (community) and MinIO's `aistor` (stable). `tailscale` and `cloudflared` (both community) back
ApexOs's remote access. Both the `stable` and `community` trains are preferred by default.

## License

GPL-3.0-or-later, like the rest of ApexOs. The bundled catalog metadata keeps its LGPL-3.0 license.
