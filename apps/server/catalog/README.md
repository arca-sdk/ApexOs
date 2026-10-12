# Curated install scripts

One-click install scripts for TrueNAS catalog apps, in the format described in
[`docs/install-scripts.md`](../../../docs/install-scripts.md) (format version 4). Each file is named
after the TrueNAS catalog app id. `_schema-notes.md` lists the catalog schema paths each script
relies on.

## Scripts

| App | File | Train | Catalog version (app version) | Locations | Host ports |
|---|---|---|---|---|---|
| Jellyfin | `jellyfin.json` | community | 1.3.17 (12.2) | ApplicationsPerformance, Movies, Shows, Music, Videos | 30013 |
| Plex | `plex.json` | stable | 1.3.15 (1.43.4.10903-e5521bd8c) | ApplicationsPerformance, Movies, Shows, Music, Videos | 32400 |
| Immich | `immich.json` | community | 1.14.49 (v3.3.1) | ApplicationsPerformance, Photos | 30041 |
| Nextcloud | `nextcloud.json` | stable | 2.3.77 (35.0.1) | ApplicationsPerformance, Documents | 30027 |
| Syncthing | `syncthing.json` | stable | 1.3.15 (2.1.6) | ApplicationsPerformance, Documents | 20910, 20978 (tcp), 20970 (udp) |
| qBittorrent | `qbittorrent.json` | community | 1.4.12 (5.2.4) | ApplicationsPerformance, Downloads | 30024, 51413 (tcp+udp) |
| Paperless-ngx | `paperless-ngx.json` | community | 1.6.59 (3.3.0) | ApplicationsPerformance, Documents | 30070 |
| Navidrome | `navidrome.json` | community | 1.3.17 (0.64.2) | ApplicationsPerformance, Music | 30043 |
| Sonarr | `sonarr.json` | community | 1.3.21 (4.0.20.3012) | ApplicationsPerformance, Shows, Downloads | 30113 |
| Radarr | `radarr.json` | community | 1.4.18 (6.4.4.10685) | ApplicationsPerformance, Movies, Downloads | 30025 |
| Vaultwarden | `vaultwarden.json` | community | 1.6.37 (1.37.4) | ApplicationsPerformance | 30032 |

All ports are the catalog defaults. Every app's `min_scale_version` is 24.10.2.2, so all of them
install on TrueNAS SCALE 25.10.

### Not scripted

- **home-assistant** (stable, 1.8.71): the catalog marks the whole app as deprecated
  (`deprecations.yaml`, scope `full`, deprecated 2026-08-26, removed 2026-11-26). It tells
  users to run Home Assistant OS in a VM instead. A one-click script would install an app that
  leaves the catalog about six weeks after this script was written. After that it gets no
  upgrades, and its PostgreSQL history is lost when users migrate to HAOS. The schema itself is
  scriptable; see `_schema-notes.md` if this needs revisiting.

## Source and license

- Schemas were read from [truenas/apps](https://github.com/truenas/apps) at commit
  `fca56f2374d13d956d3cd18491609a16d9c02020` (2026-10-12T17:30:17Z, branch `master`):
  `ix-dev/<train>/<app>/{app.yaml,questions.yaml,ix_values.yaml,templates/}` and the bundled
  library `templates/library/base_v2_3_4/`.
- That repository is licensed under the **GNU LGPL v3.0** (its root `LICENSE` file). The scripts
  here copy no catalog code. Each one is a new `values` document that conforms to the catalog's
  published schema.
- Clean room: the HexOS app catalog (eshtek/hexos-app-catalog) was not consulted.

## Conventions used by every script

- **Storage objects are written out explicitly**:
  `{ "type": "host_path", "host_path_config": { "path": ..., "acl_enable": false } }`.
  The scripts do not use `$HOST_PATH`/`$MOUNTED_HOST_PATH`, so they do not depend on nested
  macro arguments (`$MOUNTED_HOST_PATH($LOCATION(X), /m)`) being parsed. Some dicts have no
  `read_only` key (qBittorrent `storage.downloads`, Navidrome `storage.music`), and the macro's
  output would add one.
- **Shared libraries mount the location root.** Movies, Shows, Music, Videos, Downloads and
  Documents are mounted as `$LOCATION(X)` itself. They are not listed in
  `ensure_directories_exists`, because location roots are created by ApexOs and the format
  forbids scripts from creating them. App-private folders always use `$LOCATION(Id)/<app>/<sub>`
  and are listed in `ensure_directories_exists`.
- **Snapshots** (`snapshot.id`) are taken on config and database folders only. Large user-data
  folders (photo library, Nextcloud data, Paperless media/consume/trash) are not snapshotted,
  to keep retained snapshot space small.
- **PostgreSQL data folders** are owned by `apps` and set `host_path_config.auto_permissions: true`.
  The catalog's permissions container then chowns the folder to `999:999` before postgres starts.
  `PGDATA` is a versioned subfolder (`/var/lib/postgresql/<major>/docker`).
- **`TZ: "$TIMEZONE"`** is set wherever the schema has `TZ` (all except Navidrome).
- **`run_as` 568:568** is set wherever the schema has `run_as` (all except Nextcloud).
- **`resources.limits`** use `$CPUS(n)` and `$MEMORY(percent, minMb)`. In multi-container apps
  the catalog applies the same limit to every container (server, postgres, redis, ML, ...).
  The values are limits, not reservations.
- **Omitted fields fall back to schema defaults.** The scripts assume `app.create` fills defaults
  for omitted attributes, which is standard middleware behaviour (examples: Jellyfin
  `storage.cache` = ix_volume, `storage.transcodes` = temporary; Plex `storage.data` = ix_volume,
  `logs`/`transcode` = temporary). Every attribute marked `required` with an empty default
  (passwords, admin fields) is set explicitly.
- **Random secrets.** DB, Redis and secret keys that users never need to see use
  `$RANDOM_STRING(n)` directly in `app_values`. That output is alphanumeric, so it passes the
  library's Redis password check (no space, `'` or `#`).

## Per-app notes, assumptions and open questions

### jellyfin
- Libraries are mounted read-write at `/media/movies`, `/media/shows`, `/media/music` and `/media/videos`.
- `network.https_port.bind_mode` is set to `""` (not published). The catalog default publishes
  30014, but it only works after a certificate is configured inside Jellyfin, so publishing it
  would just use up a port.
- The optional question `publish_server_url` maps to `jellyfin.publish_server_url`. An empty
  answer means no `JELLYFIN_PublishedServerUrl`.

### plex
- Libraries are mounted at `/media/*`, the same paths as Jellyfin. `storage.data` (`/data`) is
  left at its ix_volume default and is unused. Mounting the libraries under `/data/...` would
  nest them inside that volume.
- The `claim_token` question maps to `plex.claim_token` (`PLEX_CLAIM`). Claim tokens expire after
  4 minutes, so the question tells users to fetch one just before installing.
- `plex.image_selector` is left at `image` (the non-Plex-Pass image).

### immich
- The upload location (`storage.data`, `/data`) is at `$LOCATION(Photos)/immich/data`.
  Postgres and the ML model cache are on ApplicationsPerformance. The ML cache uses a host path
  instead of the `temporary` default, so models are not downloaded again on every restart.
- `immich.postgres_image_selector` is set explicitly to the only allowed value, `vectorchord_18_image`.
- `immich.db_storage_type` is left at `SSD`, on the assumption that ApplicationsPerformance is on SSD.
- The DB password is a question (`password`, default `$RANDOM_STRING(32)`) as requested. The Redis
  password is generated with no question.

### nextcloud
- This targets **stable**/nextcloud. `community/nextcloud` is a separate FPM-based app with a
  different schema.
- `nextcloud.host` is `"$SERVER_LAN_IP:30027"`. The template adds the host part to
  `NEXTCLOUD_TRUSTED_DOMAINS` (plus `localhost`, `127.0.0.1`, `nextcloud`). If the LAN IP or port
  changes, add the new address through Nextcloud's `trusted_domains`.
- `nextcloud.cron.enabled` is set to `true` (schedule `*/5 * * * *`). This departs from the
  catalog default, which leaves Nextcloud on AJAX background jobs.
- The html (`ApplicationsPerformance/nextcloud/html`) and data (`Documents/nextcloud/data`)
  folders are owned by `www-data` (uid 33), because Nextcloud runs as www-data and nothing in the
  catalog chowns these host paths. **Verify:** Nextcloud requires the data directory to be 0770
  (not readable by others). Confirm the APPS dataset preset ACL does not make it report
  "readable by other users".
- The data folder sits inside the Documents location, so it is visible on that share. Files
  changed there directly are not seen by Nextcloud until `occ files:scan` runs.
- The schema has no `run_as`. The admin password needs 10 or more characters (Nextcloud's
  password policy), and the question says so.

### syncthing
- This targets **stable** (`enterprise/syncthing` also exists, for TrueNAS Enterprise).
- Documents is mounted at `/documents`. Syncthing's default folder (`~/Sync`) lives inside the
  config dataset, so users should add `/documents` (or subfolders) as shared folders.
- Ports 20978/tcp and 20970/udp are published (sync protocol). `requirements.ports` cannot carry
  the protocol, so they are listed as plain numbers.
- The Web UI starts without authentication until the user sets a password; Syncthing shows a warning.

### qbittorrent
- `storage.downloads` takes `mount_path` (required, default `/downloads`) and has no `read_only`
  key. The script mounts the Downloads location root at `/downloads`.
- Sonarr and Radarr mount Downloads at the same `/downloads` path, so completed-download paths
  match without remote path mappings. Hardlinks or atomic moves into Movies/Shows will not work,
  because they are separate datasets; the *arr apps fall back to copying.
- **Verify:** qBittorrent 4.6.1+ prints a temporary Web UI password to the container log on
  first start, unless the image (`ghcr.io/home-operations/qbittorrent`) pre-configures one. ApexOs
  may need to surface the app log for the first login. Also check that the default save path
  inside the image is `/downloads`; otherwise users set it once in qBittorrent.

### paperless-ngx
- data, media, consume and trash are on `Documents/paperless-ngx/*`. Postgres is on
  ApplicationsPerformance. Trash is set because `enable_trash` defaults to `true`.
- `paperless.admin_mail` is required with no usable default. It is fixed to `root@localhost`
  (Paperless's own default) to avoid an extra question; users can change it in the app.
- `admin_user`, `admin_mail` and `admin_password` are `immutable` and only used on first start,
  so editing those answers later has no effect.
- Tika/Gotenberg stay enabled (catalog default), hence the 4 GB RAM minimum.

### navidrome
- The schema has no `TZ`.
- The music library is mounted **read-write**. `storage.music` has no `read_only` field, and
  `ND_MUSICFOLDER` is fixed to `/music`, so a read-only `additional_storage` mount at `/music`
  would collide with it. Navidrome does not write to the music folder.

### sonarr / radarr
- Shows are mounted at `/tv` (Sonarr), Movies at `/movies` (Radarr), and Downloads at
  `/downloads` in both.
- `instance_name` is left at its default.

### vaultwarden
- `network.domain` and `network.certificate_id` are not set. Certificate ids are specific to each
  system, and there is no macro for them. The result is an HTTP-only install on port 30032.
  The catalog README states that HTTPS is required for most features, so the `admin_token`
  question's description tells users to put Vaultwarden behind HTTPS before using clients.
- `admin_token` is passed as plain text. Vaultwarden accepts this but recommends an Argon2 PHC
  hash and logs a warning. An empty answer leaves the `/admin` page disabled.

## Re-verifying after catalog updates

1. Find the new `version` in `ix-dev/<train>/<app>/app.yaml` and diff `questions.yaml` against the
   paths in `_schema-notes.md`. Watch for renamed keys, new required fields without defaults,
   and changed enums (especially `postgres_image_selector`).
2. Check `deprecations.yaml` for each app.
3. Bump `script.version` in the affected script and update the table above.
