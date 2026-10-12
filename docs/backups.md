# Backups between your own servers

ApexOs copies folders from this server (A) to another TrueNAS SCALE 25.10+ server you own (B). It is the
own-server variant of HexOS's Buddy Backups, without accounts, requests, a cloud relay or a mesh: **the two
servers must reach each other directly**, on the same network or through your own VPN (Tailscale, WireGuard…).
Code: `apps/server/src/services/backups.ts`, `lib/remote.ts`, `routes/backups.ts`; UI: `views/BackupsView.vue`,
`components/backups/`.

## What ApexOs sets up

| Where | What | API |
|---|---|---|
| B | Sign-in once with the admin password (ApexOs creates its own API key there, the password is not kept) or an API key | `api_key.create` |
| B | `<pool>/apexos-backups` (GENERIC) and `<pool>/apexos-backups/<A>` with quota = reservation = the space you grant, tagged `apexos:backup-source=<install id>` | `pool.dataset.create` |
| B | Receiving account `apexosbk_<A>`: no password, SSH key only, bash, sudo **only** `/usr/sbin/zfs`, home inside its dataset; hidden from ApexOs user lists | `user.create` |
| B | SSH service on (remembered, so it is turned off again on removal if nobody else uses it); B's own recursive snapshot tasks get `apexos-backups` excluded | `service.update`, `service.control`, `pool.snapshottask.update` |
| A | SSH key pair and SSH credentials pinned to B's host key (A's `ssh-keyscan` must match B's `ssh.config` keys) | `keychaincredential.*` |
| A, per folder | Periodic snapshot task (recursive, your schedule, lifetime = retention, no empty snapshots) and a PUSH replication task: SSH, `sudo`, `properties` (encrypted folders go raw), `readonly: SET`, `retention_policy: SOURCE`, `hold_pending_snapshots`, never `allow_from_scratch`, LZ4, optional `speed_limit` | `pool.snapshottask.create`, `replication.create` |

TrueNAS runs the schedule itself, so backups continue while ApexOs is stopped. If any setup step fails, the
steps already done are undone.

## Decisions

- **Per folder settings.** Each folder/destination pair has its own schedule (hourly, daily or weekly at a time in
  the TrueNAS server's time zone), retention in days (weekly needs ≥ 7) and speed limit (Mbit/s), instead of one
  set per destination. Defaults: daily 02:00, 2 weeks.
- **Copies are named after the folder** (`<pool>/apexos-backups/<A>/<Folder>`) rather than hashed: B is your own
  server. Snapshot names are `apexosbk-<backup id>-%Y%m%d-%H%M%S` so two destinations never share snapshots.
- **Encrypted folders** are sent raw: B stores ciphertext it can't open, and restores arrive locked.
- **Encrypted backup area (B's pool root is encrypted):** unencrypted folders are refused. Receiving them with
  `encryption_inherit` would make B re-encrypt them with *B's* key, and a later raw restore would need B's key.
- **Encrypting a folder that is already backed up** breaks the copy's history (raw sends can't continue a plain
  copy). The backup shows *Needs a fresh copy*; *Start a fresh copy* deletes B's copy and sends everything again.
- **Restores** always create a new folder (`<Folder>-restored-<YYYYMMDD>` by default) with a one-off PULL
  (`replication.run_onetime`, `name_regex` = the restore point, `readonly: IGNORE`, `properties_exclude: readonly`,
  `only_from_scratch`). The new folder gets the original's access if it still exists, else it is private. Encrypted
  restores can be unlocked right away with the folder's key or passphrase (used once, never stored); otherwise
  they stay locked and unshared until unlocked.
- **Deleting a folder does not delete its backups**: the copy stays restorable until you remove the backup.
- **Removal** (§11.10): removing a backup deletes its tasks and snapshots here and, after a checkbox
  confirmation, the copy on B. Removing a destination also removes the account, the datasets, the SSH service
  (if ApexOs turned it on) and ApexOs's API key on B, and the keys here. When B is offline, A's side is removed at
  once and B's side is queued; the monitor finishes it when B is back (*Waiting to clean up*, with *Forget* for
  servers that are gone).
- **Status and notices.** States: waiting, running (with progress), up to date, failed (errors explained in plain
  language), overdue (no success for one interval + 1 day, at least 2 days), paused, needs a fresh copy.
  Destinations: online, can't be reached, almost full (90 %), full. One notice per change of state, and a notice
  when things work again; "can't be reached" waits 15 minutes before notifying.
- **Not included:** pause ownership, transfer speed tests and "smart" limits, changing pool or server of a
  destination, recovering a lost source server, cross-account backups, file-level restore.

## Security

ApexOs stores B's address and an admin API key for B (in `state.json`, mode 0600). `sudo zfs` is root-equivalent
over B's pools, so the receiving account is only as safe as the network: keep both servers on your own network
or VPN. SSH key options (`from=`, forced commands) are not set yet.
