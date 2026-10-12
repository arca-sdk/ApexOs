# Catalog schema notes

Minimal excerpts of the TrueNAS `questions.yaml` structure that each script in this folder relies
on, so the scripts can be re-verified when the catalog changes. Notation:
`path: type, required?, default, enum, min/max, show_if`.

Source: [truenas/apps](https://github.com/truenas/apps) at commit
`fca56f2374d13d956d3cd18491609a16d9c02020` (2026-10-12), files
`ix-dev/<train>/<app>/questions.yaml` (schema) and `templates/docker-compose.yaml` (usage).
Only paths, types and defaults are listed here; nothing is copied verbatim.

## Shared shapes (all scripts)

These shapes are identical across the apps below unless noted.

- `TZ`: string, required, default `"Etc/UTC"`, `$ref: definitions/timezone` (absent in navidrome).
- `run_as.user` / `run_as.group`: int, required, default `568` (the `min` differs per app, see below).
- Port dict `network.<name>`:
  - `bind_mode`: string, enum `["published", "exposed", ""]` (`""` = not exposed; the library skips the port).
  - `port_number`: int, required, min 1, max 65535 (default per port, see below).
  - `host_ips`: list, default `[]` (not set by any script).
- Single-volume storage `storage.<name>`:
  - `type`: string, required, enum `["host_path", "ix_volume"]` (some volumes also allow `temporary`/`tmpfs`).
  - `host_path_config` (show_if `type = host_path`):
    - `acl_enable`: boolean, default `false`.
    - `path`: hostpath, required, show_if `acl_enable = false`.
    - `acl`: dict, show_if `acl_enable = true` (not used).
  - `ix_volume_config` (show_if `type = ix_volume`): `dataset_name` hidden default, `acl_enable` (not used).
- Postgres volume `storage.postgres_data` adds `host_path_config.auto_permissions`: boolean,
  default `false`, show_if `acl_enable = false`. When `true`, the library's permissions container
  `chown`s the top-level directory to `999:999` (postgres) in `check` mode
  (`library/base_v2_3_4/deps_postgres.py`, `deps_perms.py`). Other host paths are never chowned
  (the perms container skips `host_path` unless `auto_permissions` is set, and only postgres
  volumes expose that field).
- `storage.additional_storage[]` item (the list item variable is `storageEntry`, `storage_entry` in plex):
  - `type`: string, required, default `"ix_volume"`, enum `["host_path", "ix_volume", "cifs", "nfs"]`
    (plex adds `"temporary", "tmpfs"`).
  - `read_only`: boolean, default `false`.
  - `mount_path`: path, required.
  - `host_path_config`: same shape as above.
- `resources.limits.cpus`: int, required, default `2`. `resources.limits.memory`: int, required,
  default `4096` (MiB). `resources.gpus` is not set by any script.

## jellyfin (community, version 1.3.17)

- `jellyfin.publish_server_url`: string, default `""` (template only sets `JELLYFIN_PublishedServerUrl` when non-empty).
- `run_as.*`: min 2.
- `network.web_port`: `bind_mode` default `"published"`, `port_number` default `30013`; show_if `host_network = false`.
- `network.https_port`: `bind_mode` default `"published"`, `port_number` default `30014`. Script sets `bind_mode: ""`.
- `network.discovery_port`: `bind_mode` default `""`, `port_number` default `7359` (not set).
- `network.host_network`: boolean, default `false` (not set).
- `storage.config`: single volume, default `ix_volume`. Script: host_path.
- `storage.cache`: single volume, default `ix_volume`. Not set.
- `storage.transcodes`: enum adds `temporary`, `tmpfs`; default `temporary`. Not set.
- `storage.additional_storage[]`: shared item shape.

## plex (stable, version 1.3.15)

- `plex.claim_token`: string, default `""`, private (becomes `PLEX_CLAIM`).
- `plex.image_selector`: string, required, default `"image"`, enum `["image", "plex_pass_image"]` (not set).
- `plex.allowed_networks`: list, default RFC 1918 ranges (not set).
- `run_as.*`: min 568 (container runs as root and drops to `PLEX_UID`/`PLEX_GID` from `run_as`).
- `network.web_port`: `port_number` default `32400`.
- `storage.data` (mounted at `/data`): single volume, default `ix_volume`. Not set.
- `storage.config`: single volume, default `ix_volume`. Script: host_path.
- `storage.logs`, `storage.transcode`: default `temporary`. Not set.
- `storage.additional_storage[]`: shared item shape (variable `storage_entry`).

## immich (community, version 1.14.49)

- `immich.postgres_image_selector`: string, required, default `"vectorchord_18_image"`, enum `["vectorchord_18_image"]`.
- `immich.db_password`: string, required, default `""`, private.
- `immich.redis_password`: string, required, default `""`, private (the library rejects space, `'` and `#`).
- `immich.db_storage_type`: enum `["SSD", "HDD"]`, default `"SSD"` (not set).
- `immich.enable_ml`: boolean, default `true` (not set).
- `run_as.*`: min 0.
- `network.web_port`: `port_number` default `30041` (also passed as `IMMICH_PORT`).
- `network.api_metrics_port` (30363), `network.microservices_metrics_port` (30364): `bind_mode` default `""`. Not set.
- `storage.data` (mounted at `/data`, the upload location): single volume.
- `storage.ml_cache`: enum `["host_path", "ix_volume", "temporary"]`, default `temporary`. Script: host_path.
- `storage.postgres_data`: postgres volume (with `auto_permissions`).

## nextcloud (stable, version 2.3.77)

There is also a `community/nextcloud` (FPM-based, different schema). The script targets `stable`.

- No `run_as` section; the container runs as root and the image drops to `www-data` (uid 33).
- `nextcloud.postgres_image_selector`: string, required, default `"postgres_18_image"`, enum `["postgres_17_image", "postgres_18_image"]`.
- `nextcloud.admin_user`: string, required, default `""`.
- `nextcloud.admin_password`: string, required, default `""`, private.
- `nextcloud.host`: string, default `""`. Template: if it contains no `:`, the web port is appended;
  the host part is added to `NEXTCLOUD_TRUSTED_DOMAINS` (alongside `127.0.0.1`, `localhost`, `nextcloud`).
- `nextcloud.redis_password`, `nextcloud.db_password`: string, required, default `""`, private.
- `nextcloud.db_user`: string, required, default `"nextcloud"`, hidden (not set).
- `nextcloud.data_dir_path`: string, required, default `"/var/www/html/data"` (not set).
- `nextcloud.php_upload_limit` (3), `max_execution_time` (30), `php_memory_limit` (512),
  `op_cache_interned_strings_buffer` (32), `op_cache_memory_consumption` (128): int, required, with defaults (not set).
- `nextcloud.cron.enabled`: boolean, default `false`. `nextcloud.cron.schedule`: string, required, default `"*/5 * * * *"`, show_if `enabled = true`.
- `network.web_port`: `port_number` default `30027`.
- `network.certificate_id`: int, null, `$ref: definitions/certificate` (not set; nginx sidecar only when set).
- `storage.html` (`/var/www/html`), `storage.data` (`data_dir_path`): single volumes.
- `storage.postgres_data`: postgres volume.

## syncthing (stable, version 1.3.15)

Also published in the `enterprise` train (version 2.0.5), which targets TrueNAS Enterprise.

- `run_as.*`: min 0 (passed to the image as `PUID`/`PGID`).
- `network.web_port`: `port_number` default `20910`.
- `network.tcp_port`: `port_number` default `20978` (container 22000/tcp).
- `network.udp_port`: `port_number` default `20970` (container 22000/udp).
- `network.certificate_id`: int, null (not set).
- `storage.config` (mounted at `/var/syncthing`): single volume.
- `storage.additional_storage[]`: shared item shape.

## qbittorrent (community, version 1.4.12)

- `run_as.*`: min 568.
- `network.web_port`: `port_number` default `30024`.
- `network.bt_port`: `port_number` default `51413` (published as both tcp and udp).
- `storage.config` (mounted at `/config`): single volume.
- `storage.downloads`: single volume plus `mount_path`: path, required, default `"/downloads"`.
  This dict has no `read_only` key.

## paperless-ngx (community, version 1.6.59)

- `paperless.postgres_image_selector`: string, required, default `"postgres_18_image"`, enum `["postgres_17_image", "postgres_18_image"]`.
- `paperless.db_password`, `paperless.redis_password`, `paperless.secret_key`: string, required, default `""`, private.
- `paperless.admin_user`, `paperless.admin_mail`: string, required, default `""`, immutable.
- `paperless.admin_password`: string, required, default `""`, immutable, private.
- `paperless.enable_trash` (true), `paperless.enable_tika_gotenberg` (true): boolean (not set).
- `run_as.*`: min 568 (container runs as root with `USERMAP_UID`/`USERMAP_GID`).
- `network.web_port`: `port_number` default `30070`.
- `storage.data`, `storage.media`, `storage.consume`, `storage.trash`: single volumes.
- `storage.postgres_data`: postgres volume.

## navidrome (community, version 1.3.17)

- No `TZ` field.
- `navidrome.welcome_message`: string, required, default `"Welcome to Navidrome"` (not set).
- `navidrome.local_playback`: boolean, default `false` (not set).
- `run_as.*`: min 568.
- `network.web_port`: `port_number` default `30043`.
- `storage.data` (`/data`), `storage.music` (`/music`, fixed as `ND_MUSICFOLDER`): single volumes, no `read_only` key.

## sonarr (community, version 1.3.21) and radarr (community, version 1.4.18)

The two schemas are identical except the default web port.

- `sonarr.instance_name` / `radarr.instance_name`: string, required, default `"Sonarr"` / `"Radarr"` (not set).
- `run_as.*`: min 568.
- `network.web_port`: `port_number` default `30113` (sonarr) / `30025` (radarr).
- `storage.config` (`/config`): single volume.
- `storage.additional_storage[]`: shared item shape.

## vaultwarden (community, version 1.6.37)

- `vaultwarden.postgres_image_selector`: string, required, default `"postgres_18_image"`, enum `["postgres_17_image", "postgres_18_image"]`.
- `vaultwarden.db_password`: string, required, default `""`, private.
- `vaultwarden.admin_token`: string, default `""`, private (becomes `ADMIN_TOKEN`; the admin portal is added only when non-empty).
- `vaultwarden.enable_websocket`: boolean, default `true` (not set).
- `run_as.*`: min 568.
- `network.web_port`: `port_number` default `30032` (also `ROCKET_PORT`).
- `network.certificate_id`: int, null. `network.domain`: uri, default `""`. Neither is set.
- `storage.data` (`/data`): single volume.
- `storage.postgres_data`: postgres volume.

## home-assistant (stable, version 1.8.71) — no script

Recorded so the decision can be revisited. `deprecations.yaml` marks the whole app deprecated
(scope `full`, deprecated 2026-08-26, removal 2026-11-26). Schema at that commit:
`home_assistant.postgres_image_selector` (required, default `postgres_18_image`),
`home_assistant.db_password` (required, default `""`), `run_as.*` (min 568),
`network.web_port` (default `30103`), `network.additional_ports[]` (list without default),
`storage.config`, `storage.media`, `storage.postgres_data` (with `auto_permissions`).
