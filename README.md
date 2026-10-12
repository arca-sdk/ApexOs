# Hearth

**A friendly, open-source home server experience on top of TrueNAS SCALE.**

Hearth is a clean-room, GPL-licensed re-implementation of the core ideas behind
[HexOS](https://hexos.com): you bring your own hardware, install TrueNAS SCALE, and manage
everything — drives, shared folders, users and apps — from a simple web UI that hides ZFS jargon
without hiding what is happening. TrueNAS does the heavy lifting; Hearth talks to it only through
its public API, so the TrueNAS UI and CLI keep working alongside it.

> **Status: proof of concept.** This first release covers the *core* features only (see below). It has
> been developed against a protocol-accurate simulation of the TrueNAS 25.10 API and has **not yet been
> run against real hardware**. Do not trust it with data you can't afford to lose yet.

Hearth is not affiliated with, endorsed by, or connected to Eshtek, Inc. (HexOS) or iXsystems, Inc. (TrueNAS).

## Features (core)

| Area | What works |
|---|---|
| **Onboarding** | Create the Hearth admin account; connect to TrueNAS with the admin password (Hearth creates its own API key) or an existing API key. HTTPS only, API version pinned to `v25.10.0`. |
| **Setup wizard** | Server name and time zone → hardware scan (System / Storage / Apps / Virtualization cards: unsupported TrueNAS, low memory, USB boot drive, SMR drives, drives with existing data, unhealthy pools, missing scrub schedules) → keep, let go or import existing pools → *Recommended* (most space / balanced / most protection) or *Custom* pool layouts → review with erase/keep consents → one tracked task that re-checks every drive before erasing anything. |
| **Storage** | Pools with capacity, protection (computed from the real vdev layout), health in plain language, live scrub / rebuild / expansion progress; unused drives; create, rename, delete (typed confirmation), *Check pool* (scrub), add a drive (RAIDZ expansion), replace a drive, add a hot spare, import a pool; risk acknowledgement when a pool is degraded. |
| **Folders** | A folder is a ZFS dataset + SMB share. Public (guest) or private with per-user *View only* / *Full access*, storage limits, Time Machine targets, connection addresses for Mac/Windows, *Used by* tracking. |
| **Users** | Network-share users: create, rename, change password, delete (share permissions are cleaned up). |
| **Apps** | Browse the TrueNAS catalog with search and categories; one-click installs for curated apps through **install scripts** (requirements, questions, macros, folder preparation, see [docs/install-scripts.md](docs/install-scripts.md)); any other catalog app installs with TrueNAS defaults; start/stop, update (with restore-point snapshots), update all, uninstall with optional data removal. 11 curated scripts ship today: Jellyfin, Plex, Immich, Nextcloud, Syncthing, qBittorrent, Paperless-ngx, Navidrome, Sonarr, Radarr, Vaultwarden. |
| **Locations** | Named places for app data (*Apps (fast storage)*, *Media*, *Movies*, *Photos*, *Downloads*…), created on first use on the best pool and locked while apps use them. |
| **Dashboard** | System, memory, network and per-app live metrics, storage rings, app cards, update banner. |
| **Notifications & activity** | TrueNAS alerts with plain-language titles (dismissals sync back), Hearth task results, running tasks with step-by-step progress. |
| **Settings** | Server name, account password, time zone, network overview, locations, TrueNAS updates, restart/shut down, temperature unit. |

### Not in this release
Folder encryption and recovery keys, the file browser, virtual machines, Buddy-style backups,
remote access/relay, drive certification and deep checks, memory tests, email notifications,
static network configuration, translations, and app hooks/widgets. These were deliberately left
out of the core proof of concept.

## Try it (demo mode — no NAS needed)

Requires Node.js 24+ and pnpm.

```bash
pnpm install
pnpm demo            # builds the web UI and starts Hearth with a simulated TrueNAS
# open http://localhost:8080
```

Demo mode runs an in-process mock of the TrueNAS middleware with a realistic set of drives
(four 8 TB HDDs, an SMR 4 TB drive holding an old pool, two NVMe SSDs, a USB stick). State is kept in
`apps/server/.data/demo/`; delete that directory to start over. Set
`HEARTH_DEMO_SCENARIO=configured` to start with a server that is already set up.

For development with hot reload:

```bash
pnpm dev             # server on :8080 (demo mode) + Vite on :5173
```

## Use it with a real TrueNAS SCALE server

1. Install **TrueNAS SCALE 25.10** or newer on your server.
2. Run Hearth somewhere on your network (a container on the NAS itself works):
   ```bash
   pnpm install && pnpm build
   HEARTH_PORT=8080 HEARTH_DATA_DIR=/var/lib/hearth node apps/server/dist/index.js
   ```
   or with Docker: `docker build -t hearth . && docker run -p 8080:8080 -v hearth-data:/data hearth`.
3. Open Hearth, create your account, enter the server address and the TrueNAS admin password.
   The first person to open a new Hearth install creates its admin account, so do this right after starting it.

Hearth always connects to TrueNAS over HTTPS (TrueNAS revokes API keys that are ever sent over plain
HTTP) and accepts the self-signed certificate TrueNAS ships with. Hearth's own web UI is served over
plain HTTP on your LAN; put it behind HTTPS (and set `HEARTH_SECURE_COOKIES=1`) if you expose it
anywhere else.

| Variable | Default | Meaning |
|---|---|---|
| `HEARTH_PORT` / `HEARTH_HOST` | `8080` / `0.0.0.0` | Where the web UI listens |
| `HEARTH_DATA_DIR` | `.data` | Hearth's state (account, connection, preferences) |
| `HEARTH_TRUENAS_URL`, `HEARTH_TRUENAS_API_KEY` | — | Pre-configure the TrueNAS connection (e.g. `wss://nas.lan/api/v25.10.0`) |
| `HEARTH_SECURE_COOKIES` | off | Mark the session cookie `Secure` when served over HTTPS |
| `HEARTH_DEMO`, `HEARTH_DEMO_SCENARIO` | off, `fresh` | Demo mode with the simulated TrueNAS |

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
pnpm --filter @hearth/server validate-scripts   # check curated install scripts
```

## License and attribution

Hearth is free software: you can redistribute it and/or modify it under the terms of the
**GNU General Public License v3.0 or later** (see [LICENSE](LICENSE)).

It includes or builds on:
- [eshtek/hexos-shared](https://github.com/eshtek/hexos-shared) — GPL-3.0, © Eshtek, Inc. (vendored unmodified in `packages/shared`, see `UPSTREAM.md`).
- [truenas/webui](https://github.com/truenas/webui) types mirrored inside hexos-shared — GPL-3.0, © iXsystems, Inc.
- Curated install scripts written against the app schemas of [truenas/apps](https://github.com/truenas/apps) (LGPL-3.0).

See [NOTICE.md](NOTICE.md) for details, including what was deliberately *not* used.
