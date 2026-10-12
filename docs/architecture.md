# Architecture

## Components

| Package | Role |
|---|---|
| `apps/web` | Vue 3 single-page app. Talks only to `apps/server` over `/api` (JSON) and `/api/events` (Server-Sent Events). |
| `apps/server` | Fastify backend. Owns the single TrueNAS connection, implements every user-facing operation, tracks long operations as *tasks*, and serves the built web UI. |
| `packages/truenas-client` | JSON-RPC 2.0 websocket client for the TrueNAS middleware (`/api/v25.10.0`): authentication, request/response, job tracking (`core.get_jobs` events), subscriptions, keepalive and reconnect. |
| `packages/mock-truenas` | Stateful in-memory simulation of the middleware for tests and demo mode. |
| `packages/api-types` | Request/response types shared by server and web. |
| `packages/shared` | Vendored eshtek/hexos-shared domain types (GPL-3.0). |

## Talking to TrueNAS

- **Transport.** `wss://<host>/api/v25.10.0` — the version is pinned so a TrueNAS upgrade can't silently
  change request/response shapes; `GET /api/versions` is checked first and releases older than 25.10 are
  refused. Plain `ws://` is refused for anything but loopback because TrueNAS revokes API keys sent
  without TLS.
- **Credentials.** The user enters the TrueNAS admin password once; ApexOs logs in with
  `auth.login_ex` (`PASSWORD_PLAIN`), creates its own API key with `api_key.create`, and stores only the
  key (in `APEXOS_DATA_DIR/state.json`, mode 0600).
- **Jobs.** Long middleware calls return a job id; the client follows `core.get_jobs` events and
  reports progress, guarding against jobs that finish before the waiter is registered.
- **Events.** ApexOs subscribes to pool, dataset, share, user, app, alert, scrub-progress and realtime
  reporting events and turns them into coarse UI topics (`storage`, `folders`, `apps`, …) and metric samples.
- **Drift tolerance.** TrueNAS stays the source of truth. Pools, shares, users and apps created in the
  TrueNAS UI show up in ApexOs; ApexOs stores only what TrueNAS can't (account, pool display names,
  location choices, which datasets an app's install script created).

## Host commands

A few things have no middleware API in TrueNAS 25.10: reading the list of damaged files
(`zpool status -v`), resetting error counters (`zpool clear`), SMART data (`smartctl`), and renaming,
copying or deleting files. For these, `apps/server/src/lib/host.ts` uses public API calls only:

1. A hidden service account, `apexos_helper` (no password, no shell, no SMB), may `sudo` exactly
   `/usr/sbin/zpool`, `/usr/sbin/smartctl`, `/usr/bin/rm`, `/usr/bin/mv` and `/usr/bin/cp`.
2. Each command runs as a temporary, disabled cron job for that account (`cronjob.create` →
   `cronjob.run` → `cronjob.delete`); the output is read from the job log via `core.job_download_logs`.
3. Callers pass argv arrays. Every argument is single-quoted and only allow-listed absolute binary
   paths are invoked, so arguments can never turn into shell syntax. Callers additionally validate
   pool names, device names and paths before running anything destructive.

Running as the helper rather than root also avoids TrueNAS mailing cron output to root's address.
The helper account is visible in the TrueNAS UI (Credentials → Users); deleting it is harmless, ApexOs
recreates it on next use.

## Tasks

Every operation that changes the server (setup, pool changes, folder changes, app installs, updates)
runs as a server-side task with named steps and progress. Tasks are broadcast over SSE, so the UI can
be closed and reopened mid-operation; finished tasks also produce a notification.

## Data model mapping

| ApexOs concept | TrueNAS primitive |
|---|---|
| Pool | ZFS pool (`pool.create`, `pool.attach`, `pool.replace`, `pool.export`, `pool.import_pool`, `pool.scrub`); display names are stored by ApexOs, ZFS names never change. |
| Health check | Scrub task (`pool.scrub.create`, weekly with a 35-day threshold) and `pool.scrub` on demand. |
| Folder | Top-level dataset `<pool>/<Name>` (`share_type: SMB`, user property `apexos:folder`) + SMB share. |
| Folder access | SMB share ACL: public = Everyone (guest share); private = admin + listed users (READ or CHANGE). The filesystem gets a broad NFSv4 ACL (owner full, group/everyone modify, inherited) so whoever the share admits can work with the files; TrueNAS DENY entries and principals ApexOs doesn't manage are preserved. |
| User | Local TrueNAS user with SMB enabled and no shell. |
| Location | A folder (or sub-folder such as `Media/Movies`) recorded in ApexOs's preferences; created on first use on the most suitable pool (SSD for apps, largest HDD pool for content). |
| App | TrueNAS catalog app (`app.create` with `values` produced by an install script, or TrueNAS defaults). App data lives in host-path datasets created with the `APPS` preset (uid 568 can write). |
| Restore point | `pool.snapshot.create` before updates for directories the script marks; 3 newest kept. |

## Security notes

- The ApexOs UI has a single admin account (scrypt-hashed password, HMAC-signed session cookie,
  `SameSite=Strict`). Share users can't sign in to ApexOs.
- The filesystem ACL is deliberately broad (the share ACL is the gate). Local shell users on the NAS
  could therefore read folder contents; ApexOs creates share users without a shell.
- Serve ApexOs over HTTPS if it is reachable from outside your LAN.
