# Make your own world

A world is a mod: a folder `mods/<your-id>/` that decides what your village looks like and how it grows. The engine
keeps the grid, walking, drawing, the camera and your saved layout. You keep everything that makes the world yours.
This takes about 30 minutes for a first change.

You need Node 22.13 or newer and a clone of the repo with `npm install` done.

## The steps

1. **Pick an id.** Reverse-DNS, lowercase, with a dot, for example `example.autumn`. The `agentville.` prefix is
   reserved for the worlds that ship with the repo.
2. **Create the folder.**
   ```sh
   node tools/mod.mjs new example.autumn                       # starts empty: extends agentville.base
   node tools/mod.mjs new example.autumn --extends agentville.fantasy   # or start from the full village
   ```
   This copies `mods/_template/` to `mods/example.autumn/`, sets the id and name, regenerates the (gitignored) `mods/index.js`, and
   prints the URL to open: `?engine=2&world=example.autumn`.
3. **Check it.**
   ```sh
   node tools/mod.mjs check example.autumn
   ```
   A fresh copy passes. Run it after every change; it is fast and needs no browser.
4. **Change one hook.** Open `mods/example.autumn/index.js`. Every hook starts as a call to the world you extend.
   Replace one body, for example `capacity`, so a settlement grows faster, then run step 3 again.
5. **Look at it.**
   ```sh
   node tools/mod.mjs shots example.autumn                     # headless; writes out/mod-shots/example.autumn/
   node tools/mod.mjs shots example.autumn --dry-run           # prints what it would do, starts nothing
   ```
   Or run the app and open `?engine=2&world=example.autumn`.
6. **Repeat 4 and 5** until you like it. Change data (`rules`, `terrain`, `objects`) before code; data merges over the
   world you extend and is the easiest way to see a result.
7. **Open a pull request.** Touch only `mods/example.autumn/**` plus your own `.github/CODEOWNERS` line. `mods/index.js` is generated and gitignored; never commit it. If you
   need something the API does not offer, open an issue; changes to `web/src/engine/**` are reviewed by the
   maintainers.

## What `check` does

- The import boundary: your files import only `#agentville/mod` and files inside your own folder.
- The mod resolves through its `extends` chain.
- Every fixture in `e2e/fixtures/engine/` is built twice from the same input. Both worlds must be identical, which is
  why hooks may not use the clock or `Math.random`.
- Your own `terrain.classes` are linted (`checkClasses`); any lint there fails the check.
- The world lint is summarised per kind and is advisory. A throw from any hook, or a lint of level `error`, fails the check (non-zero exit).

`node tools/mod.mjs check all` also checks the template and the bundled worlds. The same commands run as
`npm run mod -- <new|check|shots> ...`; `npm run mods` regenerates the gitignored `mods/index.js` and `npm run lint:mods` runs the
boundary lint.

## The hooks

Every hook is optional. Leave one out and the world you extend answers. Every mod extends `agentville.base`, directly
or through `agentville.fantasy`, and the base defines `layout`, so `layout` always resolves.

| Hook | What it decides | Notes |
|---|---|---|
| `growth(project, ctx)` | A growth score per project | returns a number |
| `tier(growth, prevTier, ctx)` | Which tier a score earns | use `prevTier` for hysteresis |
| `capacity(tier, need, ctx)` | How many lots a settlement gets | |
| `lots(project, agents, prs, ctx)` | Which homes and PR sites a project asks for | `[{ item, owner, rank, agent?, pr?, building? }]` |
| `crowns(project, agents, ctx)` | How many boss slots a project shows | |
| `planSettlement(req, ctx)` | The plan of one settlement: ground, lots, props, buildings | `req` is `{ tier, seed, lots, crowns, style }` |
| `style(projectKey, ctx, preset?)` | A per-project look; the engine reads `accent` only | returns `{ key, accent? }` |
| `layout(input, ctx)` | The land round the settlements: bounds, camera focus, terrain classes, ground, roads, lots, venue sites | `input` is `{ settlements, square, parks, paths }`. `ctx.time` is not given: the result is cached and runs only when a block moves. Returns a `LayoutResult`. |
| `scatter(tile, draw, ctx)` | Wild decoration, per unbuilt tile whose terrain class has `grows` | optional. Returns `{ terrain?, model?, variant? }` or `null`. `draw(k)` is a seeded number in [0, 1). Ask `ctx.api.has('scatter.at')`. |

The typedefs for all of these (`LayoutInput`, `LayoutResult`, `ScatterTile`, `VenueDef`, ...) are in
`web/src/engine/mod/api.js`. `MOD1_HOOKS` lists the hook names.

### Data keys

Merged deeply over the world you extend (objects merge, arrays replace) and frozen: `rules`, `terrain` (`types`,
`byName`, `wildCost`, `classes`), `objects`, `behaviour`, `represent` (`agent`, `boss`, `sub`, `poses`, `cues`, `pr`,
`project`) and `venues`.

- `represent.pr` merges per PR state (`building`, `loading`, `merged`, `closed`). A state you name replaces the
  parent's whole entry for that state, so it never inherits the parent's `model`. A PR spec is
  `{ as: 'lot' | 'venue' | 'none', model?, venue?, tint? }`.
- `represent.pr` merges per PR state across the whole `extends` chain, not only with the direct parent. A data table
  you give replaces a parent's function form of `pr`.
- WorldInput currently emits only the PR states `building` and `merged`. `loading` and `closed` are accepted by the
  merge but are never produced yet, so do not rely on them.
- `terrain.classes` are the codes 0..15 your layout writes: `{ code, name, water?, wild?, grows?, color? }`. Class 0 is
  required and is also "outside the grid", so its colour is the background. `water` blocks walking, `wild` is land
  outside settlements, `grows` lets `scatter` place things there. The registry lints your own classes with
  `checkClasses`; `check` reports any lint as a failure.
- `venues[kind]` is `{ level(load, prev, ctx), plan({ site, level }, ctx), assign? }`. The layout names the sites in
  `LayoutResult.venues[siteId] = { kind, rect, anchor: { tx, ty }, data? }`. `level` returns an integer 0..16 and
  `plan` returns `{ objects, nodes, berths }`. Objects outside `site.rect` are dropped with a lint.
  `resolvePlace('venue:<siteId>')` goes to the anchor.
- `persist` is the one key that is never inherited. Leave it out: your layout is then saved under
  `va.engine2.world.<id>` (and `.demo`). If you give one, you may name only your own `va.engine2.world.<id>` keys; the
  bare `va.engine2.world` key and the classic `va.world<N>` keys belong to `agentville.fantasy`, and a mod that names
  them does not resolve.

Ask `ctx.api.has(feature)` before relying on a newer feature. `FEATURES` is `layout`, `terrain.classes`, `scatter.at`,
`represent.pr`, `represent.project`, `venues`, `persist`.

Ambient life (townsfolk, carts, critters) is not part of API v1. First-party worlds may ship `ambient`, and a world
that extends one inherits it. An own `ambient` on any other mod is ignored and reported by the lint (rule M6), so do not
write one.

Hooks that run after the layout may read `world.focus`, `world.layoutData` (the `data` your layout returned) and
`world.venues[siteId]` = `{ id, kind, tx, ty, rect, level, nodes, berths }`.

Every hook receives `ctx`:

- `ctx.rng(stream)`: a seeded random stream. Use it, never `Math.random`.
- `ctx.hash(string)`: a stable string hash.
- `ctx.time.now`: the time this world is built for. Never `Date.now()`. Not available in `layout`.
- `ctx.parent`: the hooks of the world you extend. Wrap them, or replace them. It is bound per level of the `extends`
  chain: each hook's `ctx.parent` is its own parent world, even when the hook was inherited from further up.
- `ctx.api`: `{ version, has(feature) }`.

## The kit

`#agentville/mod` is the one public entry point. It exports exactly these names:

| Name | What it is |
|---|---|
| `API_VERSION`, `MOD_CODE_MAX` | The API version (1) and the highest ground code a mod may use (199; 200..255 are the engine's). |
| `FEATURES`, `MOD1_HOOKS` | The feature names and the hook names. |
| `hash` | Stable string hash. |
| `ROAD` | Road levels: `NONE`, `PATH`, `LANE`, `STREET`, `MAIN`. |
| `LAYOUT_GROUND` | Engine ground codes a layout may write: `EDGE` 200, `VENUE` 201, `HUB` 202, `ROUTE` 203. |
| `LOT` | Lot markers in a layout: `WILD` -1, `HUB` -2, `VENUE` -3. |
| `createRaster(rect)` | A flag raster over `{ ox, oy, w, h }`: 16 flag bits per tile. |
| `routeOnRaster(...)` | Finds a road route across a raster, steering round blocks. |
| `noise(x, y, scale)` | Smooth value noise in [0, 1), pure in its inputs. |
| `flood4`, `distance4` | 4-way flood fill and distance field on a raster. |
| `rectsBounds(rects)` | Bounding box `{ x0, y0, x1, y1 }` (x1 and y1 exclusive). |
| `near(a, b, gap)`, `inRect(r, x, y)` | Rect helpers. |
| `checkClasses(classes)`, `classByName(table, name)` | Lint a `terrain.classes` list; look a class up by name. |

## The rules of the road

- Import engine code only from `#agentville/mod`. Never from `web/src/engine/**` and never from another mod. To build
  on another world, use `extends` and `ctx.parent`.
- Keep hooks pure and deterministic.
- Don't touch `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`, `indexedDB`, `document`, `window` or `navigator`: a mod owns no I/O (lint rule M7, not a sandbox).
- `mods/<id>/**` belongs to its author. `web/src/engine/**` is shared and reviewed.
- Nothing personal in a mod: it ships in a public repo. Tests and fixtures use synthetic data only.
- Mods run in the app's own process and are trusted code; review each other's pull requests accordingly.
- Set `apiVersion: 1` as a literal. API v1 is frozen: new things arrive only as `FEATURES` entries, so a v1 world keeps
  working. A breaking change bumps the major, and the engine keeps supporting the previous major for at least one release.

See [docs/mod-boundary.md](mod-boundary.md) for the full import and ownership rules.

## A 30-minute walkthrough

1. `node tools/mod.mjs new example.autumn` and `node tools/mod.mjs check example.autumn`. Open
   `?engine=2&world=example.autumn`.
2. Change `style` so every project gets an autumn accent from a list, picked with `ctx.hash(projectKey)`:
   ```js
   const ACCENTS = ['#c8641e', '#a8431f', '#d9a441', '#7a4a21'];
   style: (projectKey, ctx, preset) => ({ ...ctx.parent.style(projectKey, ctx, preset), accent: ACCENTS[ctx.hash(projectKey) % ACCENTS.length] }),
   ```
   Run `check`, then `shots`, and compare the overview picture with your starting one.
3. Give it a layout. The template's `layout` already calls the parent: `ctx.parent.layout(input, ctx)`. Either copy
   the shape of `mods/agentville.base/layout.js` into your own `layout.js` (import only from `#agentville/mod`) and
   change what you like, or keep calling the parent and change one thing in the `LayoutResult` it returns, for
   example its `focus` rectangle. Use the kit (`createRaster` for the land, `routeOnRaster` for roads).
4. Add `represent.pr` data so a pull request shows as something else. In `index.js`:
   ```js
   const represent = { pr: { building: { as: 'lot', model: 'flag' }, merged: { as: 'none' } } };
   // and add `represent` next to `rules` and `hooks` in the exported object
   ```
   Each state you name replaces the parent's entry for that state; the others are inherited.
5. `node tools/mod.mjs check example.autumn` until it passes, then `shots`, then open the pull request. It touches
   only `mods/example.autumn/**` and your own CODEOWNERS line.
