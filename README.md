# ApexOs

**A friendly, open-source home server experience on top of TrueNAS SCALE.**

ApexOs is a clean-room, GPL-licensed re-implementation of the core ideas behind
[HexOS](https://hexos.com): you bring your own hardware, install TrueNAS SCALE, and manage
everything — drives, shared folders, users and apps — from a simple web UI that hides ZFS jargon
without hiding what is happening. TrueNAS does the heavy lifting; ApexOs talks to it only through
its public API, so the TrueNAS UI and CLI keep working alongside it.

> **Status: proof of concept.** This first release covers the *core* features only (see below). It has
> been developed against a protocol-accurate simulation of the TrueNAS 25.10 API and has **not yet been
> run against real hardware**. Do not trust it with data you can't afford to lose yet.

ApexOs is not affiliated with, endorsed by, or connected to Eshtek, Inc. (HexOS) or iXsystems, Inc. (TrueNAS).

## Features (core)

| Area | What works |
|---|---|
| **Onboarding** | Create the ApexOs admin account; connect to TrueNAS with the admin password (ApexOs creates its own API key) or an existing API key. HTTPS only, using the newest 25.10 API version the server offers. |
| **Setup wizard** | Server name and time zone → hardware scan (System / Storage / Apps / Virtualization cards: unsupported TrueNAS, low memory, USB boot drive, SMR drives, drives with existing data, unhealthy pools, missing scrub schedules) → keep, let go or import existing pools → *Recommended* (most space / balanced / most protection) or *Custom* pool layouts → review with erase/keep consents → one tracked task that re-checks every drive before erasing anything. |
| **Storage** | Pools with capacity, protection (computed from the real vdev layout), health in plain language, live scrub / rebuild / expansion progress; unused drives; create, rename, delete (typed confirmation), *Check pool* (scrub), add a drive (RAIDZ expansion), replace a drive, add a hot spare, import a pool; risk acknowledgement when a pool is degraded. |
| **Folders** | A folder is a ZFS dataset + SMB share. Public (guest) or private with per-user *View only* / *Full access*, storage limits, Time Machine targets, connection addresses for Mac/Windows, *Used by* tracking. |
| **Encryption** | Per-folder ZFS encryption: *Automatic key* (unlocks at boot) or *Passphrase* (locked after every restart, never stored). Lock / unlock (locked shares disappear from the network; apps ApexOs stopped are started again), switch key mode, *Turn on encryption* for an existing folder (encrypted copy, check, swap, unencrypted original kept as a safety copy for 7 days), and a downloadable recovery file with every automatic key (TrueNAS key-file format) that tracks what changed since the last download. |
| **Files** | Browse any folder in the browser: breadcrumbs, sorting, multi-select with keyboard and context menu, new folder, rename, move/copy (never replacing anything), delete, uploads of files and whole folders (queue with progress, asks before replacing), downloads. Refuses anything outside the folder, symlinks, snapshots and crossing into datasets inside a folder. |
| **Users** | Network-share users: create, rename, change password, delete (share permissions are cleaned up). |
| **Backups** | Copies of folders on another TrueNAS server you own, reached directly (same network or your own VPN such as Tailscale). ApexOs sets up both servers: a restricted receiving account (SSH key only, sudo for `zfs` only), SSH, and a space with quota + reservation on the other server; snapshot + replication tasks here. Schedules (hourly/daily/weekly), retention, speed limit, *Back up now*, encrypted folders sent raw (they stay locked on the other server), status with overdue / out of space / unreachable notices, restore into a new folder, removal that also cleans up the other server (deferred while it is off). See [docs/backups.md](docs/backups.md). |
| **Apps** | Browse the TrueNAS catalog with search and categories; one-click installs for curated apps through **install scripts** (requirements, questions, macros, folder preparation, see [docs/install-scripts.md](docs/install-scripts.md)); any other catalog app installs with TrueNAS defaults; start/stop, update (with restore-point snapshots), update all, uninstall with optional data removal. Choose the pool apps run from during setup and change it later (*Use for apps* on a pool): installed apps move along (the copy left on the old pool is removed after a week), and a new pool is used automatically when apps have none. 11 curated scripts ship today: Jellyfin, Plex, Immich, Nextcloud, Syncthing, qBittorrent, Paperless-ngx, Navidrome, Sonarr, Radarr, Vaultwarden. |
| **Locations** | Named places for app data (*Apps (fast storage)*, *Media*, *Movies*, *Photos*, *Downloads*…), created on first use on the best pool and locked while apps use them. |
| **Dashboard** | System, memory, network and per-app live metrics, storage rings, app cards, update banner. |
| **Notifications & activity** | TrueNAS alerts with plain-language titles (dismissals sync back), ApexOs task results, running tasks with step-by-step progress. |
| **Network** | Per-port DHCP or static address, gateway, DNS servers and VLANs. Changes are applied with TrueNAS's automatic rollback: if ApexOs can't reach the server afterwards, the previous settings come back by themselves. |
| **Settings** | Server name, account password, time zone, locations, TrueNAS updates, restart/shut down, temperature unit. |
| **Sign-in security** | Optional two-factor sign-in (authenticator app codes, 10 single-use recovery codes), failed-attempt limiting with backoff, *Sign out everywhere*. See [Two-factor sign-in](#two-factor-sign-in). |
| **Remote access** | Reach the server from anywhere through accounts you own: Tailscale (recommended, includes file shares) or Cloudflare Tunnel (web page only), installed as TrueNAS apps; guidance for your own VPN or reverse proxy; a security checklist. No ApexOs cloud or relay. See [Remote access](#remote-access). |

### Not in this release
Virtual machines, backups to *other people's* servers (backups go to your own servers only),
a hosted relay (remote access uses your own Tailscale or Cloudflare account instead), drive certification and deep checks, memory tests, email notifications,
translations, and app hooks/widgets.

## Try it (demo mode — no NAS needed)

Requires Node.js 24+ and pnpm.

```bash
pnpm install
pnpm demo            # builds the web UI and starts ApexOs with a simulated TrueNAS
# open http://localhost:8080
```

Demo mode runs an in-process mock of the TrueNAS middleware with a realistic set of drives
(four 8 TB HDDs, an SMR 4 TB drive holding an old pool, two NVMe SSDs, a USB stick). State is kept in
`apps/server/.data/demo/`; delete that directory to start over. Set
`APEXOS_DEMO_SCENARIO=configured` to start with a server that is already set up. Add `APEXOS_DEMO_PEER=1` to
also start a second simulated server (`backup-nas`, on port `APEXOS_PORT + 1`) to try backups: the console
prints its address and admin password for *Backups → Add destination*.

For development with hot reload:

```bash
pnpm dev             # server on :8080 (demo mode) + Vite on :5173
```

## Use it with a real TrueNAS SCALE server

1. Install **TrueNAS SCALE 25.10** or newer on your server.
2. Run ApexOs somewhere on your network (a container on the NAS itself works):
   ```bash
   pnpm install && pnpm build
   APEXOS_PORT=8080 APEXOS_DATA_DIR=/var/lib/apexos node apps/server/dist/index.js
   ```
   or with Docker: `docker build -t apexos . && docker run -p 8080:8080 -v apexos-data:/data apexos`.
3. Open ApexOs, create your account, enter the server address and the TrueNAS admin password.
   The first person to open a new ApexOs install creates its admin account, so do this right after starting it.

ApexOs always connects to TrueNAS over HTTPS (TrueNAS revokes API keys that are ever sent over plain
HTTP) and accepts the self-signed certificate TrueNAS ships with. ApexOs's own web UI is served over
plain HTTP on your LAN; put it behind HTTPS (and set `APEXOS_SECURE_COOKIES=1`) if you expose it
anywhere else.

| Variable | Default | Meaning |
|---|---|---|
| `APEXOS_PORT` / `APEXOS_HOST` | `8080` / `0.0.0.0` | Where the web UI listens |
| `APEXOS_DATA_DIR` | `.data` | ApexOs's state (account, connection, preferences) |
| `APEXOS_TRUENAS_URL`, `APEXOS_TRUENAS_API_KEY` | — | Pre-configure the TrueNAS connection (e.g. `wss://nas.lan/api/v25.10.0`; ApexOs switches to the newest 25.10 version on connect) |
| `APEXOS_SECURE_COOKIES` | off | Always mark the session cookie `Secure`. Set it when ApexOs is reached over HTTPS (it is also set automatically for requests that arrive over HTTPS). With it on, browsers only keep the cookie on HTTPS addresses, so plain `http://` sign-in on the LAN stops working. |
| `APEXOS_DEMO`, `APEXOS_DEMO_SCENARIO` | off, `fresh` | Demo mode with the simulated TrueNAS |
| `APEXOS_DRIVE_CHECK_INTERVAL_MS` | `600000` (10 min) | How often drive error counters are checked (pool changes also trigger a check) |
| `APEXOS_NETWORK_CHECKIN_TIMEOUT` | `60` | Seconds TrueNAS waits for ApexOs to confirm a network change before undoing it |
| `APEXOS_UPLOAD_MAX_BYTES` | 32 GiB | Largest file the file browser accepts in one upload |
| `APEXOS_LOG_LEVEL` | `warn` | Server log level (`info` adds one line per request, `debug` more) |
| `APEXOS_DEMO_PEER`, `APEXOS_DEMO_PEER_PORT` | off, `APEXOS_PORT + 1` | Demo mode: a second simulated TrueNAS to use as a backup destination |

## Two-factor sign-in

Settings → *Your account* → *Turn on two-factor sign-in* shows a QR code (and the key as text) for any
authenticator app that supports time-based codes (Aegis, 2FAS, Ente Auth, Google or Microsoft
Authenticator, 1Password, Bitwarden…). Nothing changes until you confirm one code. You then get **10
recovery codes**, shown once: each lets you sign in a single time without your phone. Signing in then
takes two steps: password, then a 6-digit code (or a recovery code).

- Codes follow RFC 6238 (HMAC-SHA1, 30-second steps, 6 digits) and are accepted one step either side for
  clock drift. A code is never accepted twice. ApexOs implements this itself with `node:crypto`.
- Turning it off needs your password and a current code (or a recovery code). It can't be turned off while
  Cloudflare Tunnel is on.
- After a correct password the browser gets a signed challenge that is valid for 5 minutes and 5 code
  attempts. Failed passwords and codes are counted per client address: after 5 failures each further one
  doubles a waiting period (1 s, 2 s, 4 s … up to 15 minutes). Behind a tunnel or proxy every visitor shares
  the proxy's address, so attempts from the internet slow down everyone coming through it; sign-in from
  your home network is unaffected.
- *Sign out everywhere* (Settings → *Your account*) ends every session, including the current one.
  Changing your password or turning on two-factor sign-in also ends all other sessions.
- TrueNAS's own two-factor setting is separate. It doesn't affect ApexOs, which talks to TrueNAS with an API
  key (TrueNAS never asks API keys for a code).

**Locked out?** If you lost both your phone and your recovery codes, prove you own the server by editing
its files: stop ApexOs, open `APEXOS_DATA_DIR/state.json`, set `"twoFactor": null` inside `"security"`,
start ApexOs again and sign in with your password. Then turn two-factor sign-in on again.

## Remote access

The *Remote access* page sets up access from outside your home with services **you** sign up for. ApexOs
runs no cloud service or relay, and none of your traffic passes through the ApexOs project.

| Method | What it reaches | How ApexOs sets it up |
|---|---|---|
| **Tailscale** (recommended) | ApexOs, shared folders (SMB), the TrueNAS UI; optionally your whole home network | You paste an auth key from your Tailscale account (or a [Headscale](https://headscale.net) server you run). ApexOs installs the `tailscale` app from the TrueNAS **community** train with host networking, kernel networking (not userspace), the server name as machine name and your DNS settings untouched. *Share my home network* advertises your LAN (e.g. `192.168.1.0/24`) as a subnet route and makes IPv4 forwarding persistent with a TrueNAS sysctl tunable; you approve the route in the Tailscale admin console. |
| **Cloudflare Tunnel** (web page only) | Only the ApexOs web page, at a hostname on your own domain | You paste a tunnel token from your Cloudflare account and point the tunnel's public hostname at `http://<server LAN IP>:<ApexOs port>`. ApexOs installs the `cloudflared` app (community train). File shares don't work through it, and Cloudflare caps uploads at 100 MB per request on its free plan. **Requires two-factor sign-in**, because it puts your sign-in page on the internet. |
| **Your own VPN or reverse proxy** | Whatever you configure | Guidance only: a WireGuard/OpenVPN server on your router, or an HTTPS reverse proxy (Caddy, nginx, Traefik) in front of ApexOs. |

- Enabling Tailscale while two-factor sign-in is off needs an explicit "continue anyway"; Cloudflare Tunnel
  refuses outright.
- Auth keys and tunnel tokens go straight into the TrueNAS app configuration; ApexOs keeps no copy.
  *Turn off* uninstalls the app together with its internal data (for Tailscale, the server's tailnet
  identity) and removes the forwarding tunable ApexOs created. Remove the machine or tunnel in your
  Tailscale / Cloudflare dashboard afterwards.
- TrueNAS doesn't report the server's Tailscale address (its interface list hides `tailscale0`), so ApexOs
  shows the MagicDNS name (`http://<machine name>:<port>`, `\\<machine name>\<folder>`) and remembers the
  100.x address once you have opened ApexOs through Tailscale.
- A Tailscale or Cloudflare app installed outside ApexOs (e.g. from the TrueNAS UI) is detected and left
  alone.
- A security checklist on the page shows two-factor sign-in, password strength and secure cookies.

## Security notes

- `APEXOS_DATA_DIR/state.json` (mode 0600, in a 0700 directory) holds the TrueNAS API key, the session
  signing secret and the two-factor secret. Keep it private and out of backups others can read. Recovery
  codes and the password are stored only as scrypt hashes.
- Sessions are HMAC-signed cookies (`HttpOnly`, `SameSite=Strict`, 7 days) carrying a session generation;
  bumping the generation (Sign out everywhere, password change, enabling 2FA) voids older cookies.
- ApexOs's own web UI is plain HTTP. Over Tailscale that is fine (WireGuard encrypts it). Anywhere else, put
  HTTPS in front and set `APEXOS_SECURE_COOKIES=1`.

## How it works

```
 Browser ──HTTP/SSE──▶ apps/server (Fastify) ──JSON-RPC 2.0 over wss──▶ TrueNAS middleware
   apps/web (Vue)        services/ (storage, folders,                 (pools, datasets, SMB,
                         apps, setup, …) + task engine                 users, apps, alerts…)
```

- `packages/truenas-client` — JSON-RPC 2.0 websocket client: auth, jobs with progress, subscriptions, reconnect.
- `packages/mock-truenas` — in-memory simulation of the TrueNAS 25.10 API used for tests and demo mode.
- `packages/api-types` — the HTTP contract shared by server and UI.
- `packages/shared` — vendored [eshtek/hexos-shared](https://github.com/eshtek/hexos-shared) (GPL-3.0) domain types.
- `apps/server` — the backend: one TrueNAS connection, long operations as tracked tasks (streamed to the UI over SSE), curated install scripts in `apps/server/catalog/`.
- `apps/web` — the Vue 3 single-page UI.

More detail in [docs/architecture.md](docs/architecture.md).

## Development

```bash
pnpm test                                   # unit + integration tests (server runs against the mock)
pnpm typecheck
pnpm --filter @apexos/server validate-scripts   # check curated install scripts
```

## License and attribution

ApexOs is free software: you can redistribute it and/or modify it under the terms of the
**GNU General Public License v3.0 or later** (see [LICENSE](LICENSE)).

It includes or builds on:
- [eshtek/hexos-shared](https://github.com/eshtek/hexos-shared) — GPL-3.0, © Eshtek, Inc. (vendored unmodified in `packages/shared`, see `UPSTREAM.md`).
- [truenas/webui](https://github.com/truenas/webui) types mirrored inside hexos-shared — GPL-3.0, © iXsystems, Inc.
- Curated install scripts written against the app schemas of [truenas/apps](https://github.com/truenas/apps) (LGPL-3.0).

See [NOTICE.md](NOTICE.md) for details, including what was deliberately *not* used.
