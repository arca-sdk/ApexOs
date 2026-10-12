# Install scripts (format version 4)

An install script is a JSON document that turns a TrueNAS catalog app into a one-click install:
it declares what the app needs, asks a few questions, prepares folders, and produces the exact
`values` object passed to TrueNAS `app.create`. Curated scripts live in
`apps/server/catalog/<catalog-app-id>.json`, named after the TrueNAS catalog app id
(e.g. `jellyfin.json`). Apps without a script can still be installed with TrueNAS defaults.

The format follows the concepts of the HexOS install-script schema (see `AppsInstallScript` in
`packages/shared/eshtek/apps.ts`); Hearth implements version 4 without hooks or widgets.

## Root fields

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Must be `4`. |
| `train` | no | TrueNAS catalog train, default `"community"`. |
| `script` | yes | `{ "version": "1.0.0", "changeLog"?: string }` — version of the curation itself (semver). |
| `requirements` | yes | See below. |
| `installation_questions` | no | Questions asked before install (see below). |
| `ensure_directories_exists` | no | Folders to create before install (see below). |
| `app_values` | yes | The `values` object for `app.create`, after macro expansion. It must follow that app's TrueNAS catalog schema (`catalog.get_app_details`). |

### `requirements`

```json
{
  "locations": ["ApplicationsPerformance", "Movies"],
  "specifications": ["2CORE", "4GBRAM", "1GB"],
  "permissions": ["READ_WRITE_LOCATIONS"],
  "ports": [30013]
}
```

- `locations`: every location id used by `$LOCATION(...)`. Valid ids: `ApplicationsPerformance`,
  `ApplicationsCapacity`, `Downloads`, `Documents`, `Media`, `Photos`, `Music`, `Movies`, `Shows`, `Videos`.
  Locations are created by Hearth on first use (a folder named after the location on a suitable pool).
- `specifications`: `{n}CORE` (minimum CPU threads), `{n}GBRAM` / `{n}MBRAM` (minimum memory),
  `{n}GB` / `{n}MB` (approximate install size), `GPU` (needs a GPU; advisory only).
- `permissions`: currently only `READ_WRITE_LOCATIONS`.
- `ports`: host ports the app publishes. Conflicts with ports already in use block the install.

### `installation_questions`

```json
{ "key": "admin_password", "question": "Admin password", "type": "password",
  "default": "$RANDOM_STRING(16)", "required": true, "description": "Used to sign in to the app." }
```

`type` is `text`, `number`, `select` (needs `options: [{ "text", "value" }]`), `boolean` or `password`.
Optional: `description`, `placeholder`, `required`, `default` (literal or `$RANDOM_STRING(n)`).

### `ensure_directories_exists`

```json
{ "path": "$LOCATION(ApplicationsPerformance)/jellyfin/config", "owner": { "user": "apps", "group": "apps" } }
```

- `path` must be inside a location: `$LOCATION(Id)/<app>/<sub>`. Each entry becomes its own ZFS dataset
  (created with the `APPS` preset so the `apps` user, uid 568, can write). Location roots themselves
  are never created or changed by a script.
- `owner` (optional): user/group names; default `apps`/`apps`.
- `snapshot` (optional): `{ "id": "config" }` — snapshot this dataset before every app upgrade
  (the 3 newest are kept per app and dataset).

## Macros

Macros are expanded once, over every string in `ensure_directories_exists` and `app_values`.
When a macro is the entire string and produces an object, the string is replaced by the object.

| Macro | Result |
|---|---|
| `$LOCATION(Id)` | Absolute path of that location, e.g. `/mnt/HDDs/Movies`. Unknown or unset locations abort the install. |
| `$QUESTION(key)` | The answer to a question (numbers and booleans keep their type when the macro is the whole string). |
| `$RANDOM_STRING(n)` | Random alphanumeric string of length `n`. |
| `$MEMORY(percent, minMb)` | `max(percent% of system RAM, minMb)` in MiB, as a number. |
| `$CPUS(n)` | `min(n, available CPU threads)`, as a number. |
| `$HOST_PATH(path)` | `{ "type": "host_path", "host_path_config": { "path": path, "acl_enable": false } }` |
| `$MOUNTED_HOST_PATH(path, mountPath)` | `$HOST_PATH` plus `"mount_path": mountPath, "read_only": false` (for `additional_storage` lists). |
| `$IF(condition, then, else?)` | `then` when the condition is true, else `else` (or an empty string, which is dropped from arrays). Conditions: `true`, `false`, `!x`, `a == b`, `a != b`, with nested macros. |
| `$APP_INSTALLED(id)` | `"true"` if an app with that catalog id is installed. |
| `$SERVER_LAN_IP` | The server's LAN IP address. |
| `$TIMEZONE` | The server's time zone, e.g. `Europe/Madrid`. |

Unknown `$NAMES` are left as text and reported by the validator (`pnpm --filter @hearth/server validate-scripts`).

## Install pipeline

1. Check requirements (locations exist or can be created, CPU/RAM, port conflicts).
2. Collect answers (defaults filled in, required answers enforced).
3. Expand macros.
4. Create missing locations, then each `ensure_directories_exists` dataset and its owner.
5. `app.create` with `catalog_app`, `train`, `app_name` and the expanded `values` (a TrueNAS job).
6. Record which locations the app uses (so they cannot be moved while the app is installed).

Upgrades snapshot every directory that declares `snapshot`, then run `app.upgrade`.
