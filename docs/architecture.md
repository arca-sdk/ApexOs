# Architecture

## Components

| Package | Role |
|---|---|
| `apps/web` | Vue 3 single-page app. Talks only to `apps/server` over `/api` (JSON) and `/api/events` (Server-Sent Events). |
| `apps/server` | Fastify backend. Owns the single TrueNAS connection, implements every user-facing operation, tracks long operations as *tasks*, and serves the built web UI. |
| `packages/truenas-client` | JSON-RPC 2.0 websocket client for the TrueNAS middleware (`/api/v25.10.N`): authentication, request/response, job tracking (`core.get_jobs` events), subscriptions, keepalive and reconnect. |
| `packages/mock-truenas` | Stateful in-memory simulation of the middleware for tests and demo mode. |
| `packages/api-types` | Request/response types shared by server and web. |
| `packages/shared` | Vendored eshtek/hexos-shared domain types (GPL-3.0). |

## Talking to TrueNAS

- **Transport.** `wss://<host>/api/v25.10.N`, the newest 25.10 version the server lists in `GET /api/versions`,
  picked again before every connection attempt; releases older than 25.10 are refused. TrueNAS answers only
  its newest version directly: older ones go through a reply converter that fails for some replies on
  25.10.7 ("Object of type _NotRequired is not JSON serializable" for `interface.query` and
  `network.configuration.*`). Within 25.10 newer versions only add compatible changes. Plain `ws://` is
  refused for anything but loopback because TrueNAS revokes API keys sent without TLS.
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

## Drive health

`apps/server/src/services/drive-health.ts` runs in the background (every 10 minutes and shortly after
pool changes) and compares each pool member's ZFS read/write/checksum counters with what it saw last.
New errors are recorded per drive, and SMART is read with `smartctl -j -H -A`. A drive that reports
damaged areas, rates itself as failing, or stopped working gets a "Replace drive" notice and its
counters are never reset. Otherwise ApexOs runs a pool check; if that check finishes clean, it resets
that drive's counters once (`zpool clear <pool> <vdev guid>`, at most once a month per drive) and
watches it for a month. Errors that come back within the month produce one notice with the likely cause
(cable, controller, memory, or unclear). Per-drive history lives in `state.json` (`driveHealth`).

## Tasks

Every operation that changes the server (setup, pool changes, folder changes, app installs, updates)
runs as a server-side task with named steps and progress. Tasks are broadcast over SSE, so the UI can
be closed and reopened mid-operation; finished tasks also produce a notification.

## Data model mapping

| ApexOs concept | TrueNAS primitive |
|---|---|
| Pool | ZFS pool (`pool.create`, `pool.attach`, `pool.replace`, `pool.export`, `pool.import_pool`, `pool.scrub`); display names are stored by ApexOs, ZFS names never change. |
| Health check | Scrub task (`pool.scrub.create`, weekly with a 35-day threshold) and `pool.scrub` on demand. |
| Damaged files | `zpool status -v <pool>` through the host helper, classified as app-catalog files (under `catalog.config` → `location`), user files, snapshot entries and deleted/internal entries. Repair deletes catalog files only (`rm -f --`, at most 20, list re-read and paths validated first), then scrubs and runs `catalog.sync`; Reset error count is `zpool clear <pool>`, allowed only after a clean check ApexOs started. |
| Folder | Top-level dataset `<pool>/<Name>` (`share_type: SMB`, user property `apexos:folder`) + SMB share. |
| Folder access | SMB share ACL: public = Everyone (guest share); private = admin + listed users (READ or CHANGE). The filesystem gets a broad NFSv4 ACL (owner full, group/everyone modify, inherited) so whoever the share admits can work with the files; TrueNAS DENY entries and principals ApexOs doesn't manage are preserved. |
| User | Local TrueNAS user with SMB enabled and no shell. |
| Location | A folder (or sub-folder such as `Media/Movies`) recorded in ApexOs's preferences; created on first use on the most suitable pool (SSD for apps, largest HDD pool for content). |
| App | TrueNAS catalog app (`app.create` with `values` produced by an install script, or TrueNAS defaults). App data lives in host-path datasets created with the `APPS` preset (uid 568 can write). |
| Apps pool | `docker.config` → `pool`. Changing it is `docker.update {pool}`. With apps installed it also sends `migrate_applications: true`, which makes TrueNAS back up `<old>/ix-apps`, replicate it to the new pool, restore it there and redeploy the apps that were running. When the current apps pool is offline or missing, nothing can be copied: the change is allowed without migrating, and nothing is backed up or copied (a dead apps pool isn't a dead end). The apps stay with that pool and come back if it is chosen again once repaired, and the dialog says so. After a migration TrueNAS keeps the old copy; ApexOs records it, shows it on the old pool and deletes it after 7 days (hourly check) or earlier on request, only if it recorded it and apps don't run from that pool. TrueNAS won't migrate onto an existing `<pool>/ix-apps`, so app data left there from an earlier time is deleted first, only after the user agrees. App changes, folder locks and unlocks wait while apps move, and a move waits for them and for pool creation (a pool created during a move doesn't become the apps pool). A pool created while apps have no pool (theirs was deleted) becomes the apps pool. |
| Restore point | `pool.snapshot.create` before updates for directories the script marks; 3 newest kept. |
| Remote access: Tailscale | Catalog app `tailscale`, train `community` (`app.create` defaults to `stable`, so the train is always sent). Values: `tailscale.{hostname, auth_key, auth_once: true, userspace: false, accept_dns: false, advertise_routes, extra_args}` (`--login-server=` for Headscale), `network.host_network: true`. The schema is re-read with `catalog.get_app_details` before every install. Subnet routing adds a `SYSCTL` tunable `net.ipv4.ip_forward=1` (`tunable.create`, removed or restored on Turn off). Turn off = `app.delete` with `remove_ix_volumes` (drops the node identity). |
| Remote access: Cloudflare Tunnel | Catalog app `cloudflared`, train `community`, values `cloudflared.tunnel_token`, `network.host_network: false` (the tunnel reaches ApexOs at the LAN address). |
| Encrypted folder | The folder dataset is its own encryption root (child of the unencrypted pool root): `pool.dataset.create` with `encryption: true, inherit_encryption: false` and `generate_key` (*Automatic key*, HEX, stored by TrueNAS so it unlocks at boot) or `passphrase` (never stored by TrueNAS or ApexOs, locked after every boot). Lock/unlock: `pool.dataset.lock` / `pool.dataset.unlock` (passphrase or hex key checked first with `pool.dataset.encryption_summary`); TrueNAS hides the share while locked and brings it back on unlock, but doesn't restart apps, so ApexOs records the apps that were running and starts them. Key mode: `pool.dataset.change_key`. |
| Turn on encryption | ZFS can't encrypt in place, so ApexOs copies: snapshot `apexos-enc-1` → `replication.run_onetime` (LOCAL, `encryption_key_location: "$TrueNAS"`, all snapshots, `readonly: IGNORE`, quotas overridden) into the hidden `<pool>/.apexos-enc-<Name>` → share paused → snapshot `apexos-enc-2` + incremental run → compare datasets, snapshots and files → rename original to `<Name>-unencrypted-<date>` and the copy to `<Name>` → `change_key` with the same key (renames don't move TrueNAS's stored key) or the chosen passphrase → quotas and share restored. Always received with an automatic key that ApexOs escrows in its state until TrueNAS stores it under the folder's name; a chosen passphrase is applied at the end and lives only in memory. Each step is idempotent and recorded, so Retry (and a restart) resumes; before the switch-over the original is untouched and Discard removes the attempt. Refused for system folders, folders apps use, other shares or TrueNAS services inside the folder, encrypted sub-datasets, replication sources, and when the pool lacks ~103% of the folder's size. |
| Recovery file | `core.download` of `pool.dataset.export_keys <pool>` for every pool, fetched by the ApexOs server (download tokens are tied to the caller's address) and merged into one JSON file in TrueNAS's key-file format. ApexOs remembers when it was downloaded and which automatic keys were added or changed since. |
| File browser | Paths relative to a folder; `filesystem.listdir` (no dates, so only the visible page is `filesystem.stat`ed), `filesystem.mkdir`, uploads streamed browser → ApexOs → `POST /_upload` (`filesystem.put`), downloads via `core.download('filesystem.get')` streamed back; rename/move/copy/delete with `mv -n`, `cp -a -n --one-file-system`, `rm -r --one-file-system` through the host helper (batched, run as tasks, verified with `stat` afterwards). |

## File browser safety

`apps/server/src/services/files.ts` never trusts the browser: paths are folder-relative and every segment
is a validated name (no `/`, `..`, control characters or `.zfs`); every component below the folder root is
`stat`ed so symlinks are never followed and unknown mounts are refused; folder roots and datasets inside a
folder can't be renamed, moved or deleted, and nothing is moved or copied across a dataset boundary.
TrueNAS's `filesystem.put` replaces files silently and creates them as root, so ApexOs checks names first,
writes replacements to a hidden temporary file that is renamed into place once complete, and gives new
files the owner of their directory. Downloads are always sent as attachments.
| Backup destination | Another TrueNAS server (its API key and address stored by ApexOs): receiving user `apexosbk_<this server>` (key login, sudo only `/usr/sbin/zfs`), SSH service, `<pool>/apexos-backups/<this server>` with quota = reservation = granted space; here an `SSH_KEY_PAIR` and pinned `SSH_CREDENTIALS` keychain entry. See [backups.md](backups.md). |
| Folder backup | `pool.snapshottask` (recursive, schedule, lifetime = retention, no empty snapshots) + PUSH `replication` over SSH (`sudo`, `properties` so encrypted folders go raw, `readonly: SET`, `retention_policy: SOURCE`, `hold_pending_snapshots`, never from scratch). Restore = `replication.run_onetime` PULL into a new folder. |

## Security notes

- The ApexOs UI has a single admin account (scrypt-hashed password). Share users can't sign in to ApexOs.
- **Sessions.** Stateless HMAC-SHA256-signed cookie `username|expiry|generation` (`HttpOnly`,
  `SameSite=Strict`, 7 days; `Secure` with `APEXOS_SECURE_COOKIES=1` or when the request arrived over
  HTTPS, including `X-Forwarded-Proto: https`). A request is authenticated only if the generation matches
  `security.sessionGeneration`; *Sign out everywhere*, password changes and enabling 2FA bump it.
- **Two-factor sign-in** (`lib/totp.ts`, `services/two-factor.ts`). RFC 6238 TOTP on `node:crypto`
  (HMAC-SHA1, 30 s, 6 digits, ±1 step, constant-time comparison of every candidate). The newest accepted
  step is stored and codes at or before it are refused (replay protection). The 160-bit base32 secret
  lives only in `state.json`. Ten recovery codes (~50 bits each) are stored as scrypt hashes and removed
  when used. Enrollment only activates after one correct code; disabling needs password + code and is
  refused while Cloudflare Tunnel is on. The QR code for the `otpauth://` URI is drawn by a small built-in
  encoder (`lib/qr.ts`).
- **Sign-in flow.** `POST /api/auth/login` checks the password (always running scrypt, also for unknown
  usernames, and comparing the username in constant time). With 2FA on it returns a challenge token
  signed with a key derived from the session secret (so it can never pass as a session cookie), bound to
  the username and session generation, valid 5 minutes and 5 code attempts, single use.
  `POST /api/auth/login/verify` takes the challenge and a code.
- **Attempt limiting** (`lib/rate-limit.ts`). Per client address: 5 free failures, then each failure
  doubles a lockout (1 s … 15 min; HTTP 429 with `Retry-After`); forgotten an hour after the last failure or
  on a complete sign-in. Password and code failures share the counter (also for password changes and
  turning 2FA off). Credential checks run one at a time right after the limit check, so parallel guesses
  can't slip past the limit and concurrent requests can't both use one code. In-memory only.
- **Remote access** never routes traffic through the ApexOs project: Tailscale and Cloudflare Tunnel run
  as TrueNAS apps with the user's own credentials, which go into the app configuration only (deleted with
  the app). TrueNAS hides the `tailscale0` interface from `interface.query`, so the tailnet address is
  learned from requests that arrive from 100.64.0.0/10.
- `state.json` (0600, directory 0700) holds the TrueNAS API key, the session secret and the TOTP secret;
  it must stay private.
- The filesystem ACL is deliberately broad (the share ACL is the gate). Local shell users on the NAS
  could therefore read folder contents; ApexOs creates share users without a shell.
- Serve ApexOs over HTTPS if it is reachable from outside your LAN other than through Tailscale.
- Backup destinations: ApexOs keeps an admin API key for each destination server (never its password). The
  receiving account there can run `sudo zfs` without a password, which is root-equivalent over that server's
  pools; it only accepts this server's SSH key. Keep the servers on your own network or VPN.
