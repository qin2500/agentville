<!-- Paste into the public AGENTS.md. The repo has no AGENTS.md in this branch, so the lead adds it at merge. -->

## Worlds and mods

The village is a mod. Each world lives in `mods/<id>/` (reverse-DNS id such as `yourname.autumn`; `agentville.*` is
reserved for the bundled worlds). A world is `mods/<id>/index.js` with an id, a name, optional data (`rules`,
`terrain`, `objects`, `behaviour`, `represent`, `venues`) and hooks (`growth`, `tier`, `capacity`, `lots`, `crowns`,
`planSettlement`, `style`, `layout`, and the optional `scatter`). `persist` is the one data key that is never inherited;
most worlds leave it out and may name only their own `va.engine2.world.<id>` keys. It builds on another world with `extends` and
`ctx.parent`. `mods/index.js` is generated and gitignored (`npm run mods`; dev, build and test run it); `mods/_template/` is the starting copy and is not bundled.

- **Public API:** the only engine import a mod may use is `#agentville/mod` (`web/src/engine/mod/public.js`). It
  exports `API_VERSION`, `MOD_CODE_MAX`, `FEATURES`, `MOD1_HOOKS`, `hash`, the constants `ROAD`, `LAYOUT_GROUND` and
  `LOT`, the layout kit (`createRaster`, `routeOnRaster`, `noise`, `flood4`, `distance4`, `rectsBounds`, `near`,
  `inRect`) and the terrain kit (`checkClasses`, `classByName`). Ask `ctx.api.has(feature)` before using a newer
  capability. Every world extends `agentville.base` (directly or through `agentville.fantasy`), which defines `layout`.
- **Import boundary:** a mod imports only `#agentville/mod` and files inside its own folder. Never engine internals
  under `web/src/engine/**`, and never another mod (the rules are in [docs/mod-boundary.md](docs/mod-boundary.md)). Hooks are pure: no `Math.random`, no clock; use `ctx.rng`,
  `ctx.hash` and `ctx.time`.
- **Ownership:** `mods/<id>/**` belongs to its author. `web/src/engine/**`, `mods/agentville.*/**`, `tools/`, `docs/` and
  `package.json` are shared and reviewed by the maintainers (`.github/CODEOWNERS` enforces it for the engine, `tools/`,
  and the first-party worlds; add a line for your own folder in your first PR). A pull request from a world author touches only their
  own folder.
- **Ambient life:** not part of API v1. First-party worlds may ship `ambient` and children inherit it; an own `ambient`
  on any other mod is ignored and linted (rule M6).
- **Tools:**
  - `node tools/mod.mjs new <id> [--extends agentville.base|agentville.fantasy]` copies the template.
  - `node tools/mod.mjs check <id|all|_template>` runs the boundary check, resolves the mod, reports lint in its own
    terrain classes as a failure, and builds every engine fixture twice to prove it is deterministic.
  - `npm run mod -- <new|check|shots> ...` is the same tool; `npm run mods` regenerates the gitignored `mods/index.js`;
    `npm run lint:mods` runs the boundary lint.
  - `node tools/mod.mjs shots <id> [--dry-run]` takes headless screenshots into `out/mod-shots/<id>/`. Run it
    headless and in the background only; use `--dry-run` to see the plan.
- **Tests and data:** synthetic data only (`e2e/fixtures/engine`). Nothing personal in a mod: this repo is public.
- **Guide:** [docs/make-your-own-world.md](docs/make-your-own-world.md).
