# Upstream

This directory is an unmodified vendored copy of
[eshtek/hexos-shared](https://github.com/eshtek/hexos-shared), licensed under the
GNU General Public License v3.0 (see `LICENSE` in this directory).

- Upstream commit: `dfd0a3c0f644ca3a0165b2c785de897e0bd66189` (2026-03-24)
- Copyright: Eshtek, Inc. and contributors
- `truenas/webui/` mirrors parts of [truenas/webui](https://github.com/truenas/webui) (GPL-3.0),
  copyright iXsystems, Inc.

Removed from the vendored copy: `.github/`, `.vscode/`, `package-lock.json`,
`ts-to-zod.config.js`, and the upstream `package.json` (replaced with a workspace manifest).
No source files were modified. ApexOs-specific code lives in the other workspace packages.
To update, replace the contents of this directory with a newer upstream checkout and
update the commit hash above.

ApexOs additions (new files only): `shims.d.ts` declares the Nuxt auto-imported `useI18n`
global so the upstream types compile outside a Nuxt app.

Consumers should import types and enums from `eshtek/server`, `eshtek/apps`,
`eshtek/preferences` and `truenas/webui/**`. `eshtek/common.ts` depends on browser globals and
does not pass strict type checking; the few helpers ApexOs needs from it are re-implemented in
`apps/server/src/lib/validators.ts` with attribution.
