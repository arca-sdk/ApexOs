# Notices

## License

Copyright (C) 2026 the Hearth contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the License,
or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see `LICENSE`.

## Third-party material included

| Material | Location | License | Copyright |
|---|---|---|---|
| eshtek/hexos-shared @ `dfd0a3c` | `packages/shared/` (unmodified; `shims.d.ts` and `package.json` added) | GPL-3.0 | Eshtek, Inc. and contributors |
| truenas/webui types (as mirrored by hexos-shared) | `packages/shared/truenas/webui/` | GPL-3.0 | iXsystems, Inc. |
| Validation rules adapted from hexos-shared `eshtek/common.ts` | `apps/server/src/lib/validators.ts` | GPL-3.0 | Eshtek, Inc. |
| App catalog metadata (names, descriptions, icons URLs, versions) used by the simulator | `packages/mock-truenas/src/data/` | LGPL-3.0 (truenas/apps) | iXsystems, Inc. |

Curated install scripts in `apps/server/catalog/` are original work written against the public
app schemas (`questions.yaml`) of [truenas/apps](https://github.com/truenas/apps) (LGPL-3.0); see
`apps/server/catalog/README.md` for the catalog commit they target.

## Clean-room boundaries

Hearth's feature set was derived from HexOS's *public* product descriptions (website, documentation,
release notes). The following were deliberately **not** used, copied or consulted for code:

- HexOS's proprietary application code (the "Command Deck" web app and on-server agent), including
  the minified JavaScript served by `deck.hexos.com`.
- Repositories without a license grant: `eshtek/hexos-app-catalog`, `eshtek/hexos-vm-catalog`,
  `eshtek/hexos-offline`. Hearth's install-script format is inspired by the concepts described in
  HexOS's public docs and by the GPL-licensed types in hexos-shared; every script was written from scratch.
- Any leaked or non-public material.

HexOS documentation is licensed CC BY-SA 4.0; no documentation text is included in this repository.

## Trademarks

"HexOS" is a trademark of Eshtek, Inc. "TrueNAS" is a trademark of iXsystems, Inc. They are used
here only to describe compatibility and origin. Hearth is not affiliated with or endorsed by either.
