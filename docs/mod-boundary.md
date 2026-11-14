# Mod boundary: who owns what

A world lives in `mods/<id>/`. The engine in `web/src/engine/**` knows nothing about any world. This page says what a mod
may import, who owns each folder, and what a PR from `mods/<id>/` may touch. `tools/mod-lint.mjs` enforces it.

## What is public

A mod may import only:

1. **`#agentville/mod`**, the public barrel (`web/src/engine/mod/public.js`, mapped in `package.json` `"imports"`). It holds
   `API_VERSION`, `MOD_CODE_MAX`, `FEATURES`, `hash`, `ROAD`, `LAYOUT_GROUND`, `LOT`, the layout kit
   (`createRaster`, `routeOnRaster`, `noise`, `flood4`, `distance4`, `rectsBounds`, `near`, `inRect`) and the terrain kit
   (`checkClasses`, `classByName`). The relative path to `public.js` is also accepted: the lint checks the resolved file.
2. **Its own files** (`./`, `../` inside `mods/<id>/`).

Anything else is engine-internal. A mod never imports another mod: share code with `extends` and `ctx.parent`.

`agentville.fantasy` keeps two named exceptions, `web/src/city-plan.js` and `web/src/styles-pool.js`, because classic still
uses them. They move into the mod when classic is deleted, and the entry in `GRANDFATHERED` (in `tools/mod-lint.mjs`) goes
with them. No other mod gets an exception.

## The rules (`tools/mod-lint.mjs`)

| Rule | Meaning |
|---|---|
| M1 | A mod imports only its own files, the public barrel and its grandfathered files. |
| M2 | No bare, `node:` or URL specifiers, and no `import()` with a non-literal argument. |
| M3 | No import from another mod's folder. |
| M4 | The folder name equals `mod.id`. The `agentville.` prefix is reserved for first-party mods (`agentville.base`, `agentville.fantasy`). Folders starting with `_` (the template) are exempt. |
| M5 | No `Math.random`, `Date.now`, `performance.now` or `new Date(`. Worlds must be deterministic: use `hash` and the seeded draws the hooks give you. |
| M7 | No `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`, `indexedDB`, `document`, `window` or `navigator` identifiers (comments and strings are ignored). Ownership hygiene, not a sandbox. A mod draws from its input and owns no I/O. |
| E1 | `web/src/engine/**` never imports `mods/**`, except `mod/registry.js` importing `mods/index.js`. |
| E2 | The ratchet (below). |

API: `checkModImports(modDir, { root }) -> { errors: [{ file, spec, rule }] }` and `checkEngineImports(root)`.
Run `node tools/mod-lint.mjs` (all mods and the engine) or `node tools/mod-lint.mjs <id>...`.

## The ratchet (E2)

The engine must end up with zero world words. Until it does, `test/mod-ready-ratchet.test.mjs` counts these words,
case-insensitive, in each file under `web/src/engine/**`:

`dock|harbou?r|ship|sloop|island|shore|sea_?deep|forest|porter|palace|villager|townsfolk`

`test/mod-ready-ratchet.json` pins the maximum per file. A file not listed is pinned at 0. The count may only go down:

- A count above its pin fails. Move the world-specific code into a mod.
- A count below its pin also fails, so the pin stays tight. Run `UPDATE_RATCHET=1 node --test test/mod-ready-ratchet.test.mjs`
  and commit the lower numbers. That command refuses to raise any pin.
- Never edit the json by hand to raise a number. A reviewer rejects a PR that does.

## Who owns what

| Path | Owner | Review |
|---|---|---|
| `mods/<id>/**` (third-party) | The mod's author | Review is routed to the author through their CODEOWNERS line; a maintainer merges. |
| `mods/agentville.*/**` | Maintainers | Reviewed. |
| `mods/index.js` | Generated, gitignored (`npm run mods`) | Never committed, so world PRs cannot conflict on it. `dev`, `build` and `test` regenerate it. |
| `web/src/engine/**` | Maintainers | Shared and reviewed: every change needs a maintainer. |
| `tools/`, `docs/`, `package.json`, `test/`, `.github/` | Maintainers | Reviewed (CODEOWNERS `*` and `/.github/`). |

### What a PR from `mods/<id>/` may touch

- Files inside `mods/<id>/`.
- Its own line in `.github/CODEOWNERS` (`/mods/<id>/ @handle`).
- Tests for the mod, in `test/` with the name `mod-<id>-*.test.mjs`, if maintainers allow it.

It may not touch `web/src/engine/**`, another mod, `tools/`, `package.json` or the ratchet json. If a world needs something
the engine does not offer, open an issue or a separate engine PR: the engine change is reviewed on its own.

## CODEOWNERS

The repo ships `.github/CODEOWNERS`. Order matters: the last matching pattern wins.

```
# Maintainers own the engine, tooling and the first-party worlds.
/web/src/engine/    @qin2500
/tools/             @qin2500
/mods/agentville.*/ @qin2500

# World authors: add your own line in your first PR, so you review your own folder.
# /mods/<your-mod-id>/ @your-handle
```

A world author adds one line for their own folder (`/mods/<your-mod-id>/ @your-handle`) in their first PR. With branch
protection set to "require review from code owners", a PR that only touches `/mods/<id>/` is reviewed by its author, and
any PR that touches the engine, tools or the index needs a maintainer.

CI (`.github/workflows/mods.yml`) runs `npm run lint:mods` and the engine and mod tests on every pull request.
