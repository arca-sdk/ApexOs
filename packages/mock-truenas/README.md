# @hearth/mock-truenas

An in-memory, stateful simulation of the TrueNAS SCALE 25.10 middleware JSON-RPC 2.0 websocket API.
Hearth uses it for server integration tests and for demo mode, where you can click through the whole
product without a NAS. It follows the shapes in the Hearth TrueNAS API reference: upper-case enums,
`{"$date": ms}` datetimes, ZFS property objects, legacy job semantics (calls return a job id and
progress arrives through `core.get_jobs` events), and `collection_update` events.

```ts
import { startMockTrueNas } from '@hearth/mock-truenas';

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

## What is simulated

- Authentication: `auth.*` (API key, `login_ex` with password, API key or token) and `api_key.*`.
- System: `system.*`, `update.*`, `network.*`, `interface.*`, `service.*`.
- Storage: `disk.*`, `boot.*`, and `pool.*` (create/update/attach with RAIDZ expansion/replace/remove/
  detach/offline/online/export/import/scrub plus scrub tasks), `pool.dataset.*` and `pool.snapshot.*`.
- Sharing and accounts: `sharing.smb.*`, `smb.*`, `user.*`, `group.*`, `filesystem.*` (stat, listdir,
  mkdir, ACLs, setperm, chown, ACL templates).
- Apps: `docker.*`, `catalog.*`, `app.*` (catalog and custom compose apps, port and host-path
  validation, `ix_volume` datasets, upgrade and rollback) and `app.image.*`.
- `alert.*`; the event sources `reporting.realtime` and `app.stats` (both accept `:{"interval": n}`);
  `core.get_methods`; and CRUD events for pools, datasets, snapshots, shares, users, groups, apps,
  services and alerts.

Run `core.get_methods` for the full list. Things that are approximated:
- Capacity: RAIDZ capacity is `(n − parity) × smallest disk − 3%`. MIRROR uses the smallest disk and
  STRIPE the sum. Allocation is the sum of the datasets' simulated usage.
- Encryption, VMs, replication and SMART are not modelled.
- Operations still running when the state is saved are settled on load: resilvers finish, scrubs are
  cancelled, and deploying apps come up.

## Catalog data

`src/data/catalog.json` holds real metadata for 28 apps from the TrueNAS apps catalog,
[github.com/truenas/apps](https://github.com/truenas/apps), at commit
`fca56f2374d13d956d3cd18491609a16d9c02020`. That data is **LGPL-3.0** (© iXsystems). Each entry
includes titles, descriptions, versions, icons, screenshots, images, default ports and a trimmed install
schema. Regenerate it with:

```sh
python3 -I scripts/generate-catalog.py [git-ref]
```

The current catalog no longer has `overseerr`, `jellyseerr` or `minio`, so it includes their successors:
`seerr` (community) and MinIO's `aistor` (stable). Both the `stable` and `community` trains are preferred
by default.

## License

GPL-3.0-or-later, like the rest of Hearth. The bundled catalog metadata keeps its LGPL-3.0 license.
