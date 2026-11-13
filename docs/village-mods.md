# Village mods: the world game as a swappable pack

Status: design document. This extends `docs/village-engine-v2.md`. Decisions D1–D5 there were accepted as
recommended.

Goal: the game is easily moddable, so someone can run Agentville with a village that is completely different: different ways
the cities scale, different art, different things to represent PRs and agents.

Other people can run the **public repo** (`qin2500/agentville`), so everything here ships there. Bundled mods,
fixtures and examples contain nothing personal.

**The principle:** the v2 engine becomes a platform that owns the grid, navigation, depth, rendering, input, camera,
labels and the security boundary. The **world game** (rules, planning, art, what everything represents, ambient life
and events) is a **mod**. Today's fantasy village is a mod too, called `agentville.fantasy`. It is built on exactly
the public API, and a CI test runs it inside the sandbox. If the default world can't be expressed as a mod, the API is
wrong.

---

## 1. What a mod controls

| Area | Mod controls | Engine keeps |
|---|---|---|
| **Growth and scaling** | Growth score per project, tier ladder (names, thresholds, hysteresis), capacity buckets, what earns a lot (homes, PR sites, caps) | Re-plan triggers (§1.4 of the v2 doc) and persistence |
| **Planning** | Settlement plan per tier (any shape, not necessarily streets), world placement parameters, or its own `placeSites` | Validation (doors reachable, no overlap, in bounds), stamping, cover mask |
| **Terrain** | Terrain and ground types (walk cost, critter flag, decal or tile art), scatter (wild decoration) | The grid, chunk baking |
| **Objects** | Object types: footprint, walk mode (block/edge/floor), height, anchors (stand, sit, work, vend, venue nodes) | Occupancy, edges, slots |
| **Art** | Sprites for every model, actor looks and animations, ground tiles, palettes, style pools, lighting tint, light sources, effects sprites | Sprite cache, slicing, sort, culling, LOD, the lightmap compositor |
| **Representation** | What a project, agent, sub-agent, crown (boss), Important agent, PR (ship, building, rocket…) and the PR area are | Hit-testing, selection, `va:dock` click |
| **Behaviour** | Per status bucket: where the actor goes and which pose it plays; ambient routines (townsfolk, vehicles, critters); world events (PR merged, tier-up, new project, crown gained) | Navigation, slot reservation, tick, interpolation, reduced motion |
| **UI look** | Status badge art, label theme tokens (colours, one font from an allow-list), plate and sign text templates, Map dot colours | DOM labels, the layout algorithm, priorities, the bubbles toggle, aria |

Out of scope for mods: the left panel, terminals, settings other than the world picker, the server, and anything that
acts on agents.

---

## 2. Two layers, plus inheritance

### 2.1 Data packs (no code)

A folder with `mod.json` plus assets (PNG or WebP only). Non-coders can retune or reskin a world:

```jsonc
{
  "id": "anna.autumn", "name": "Autumn Village", "version": "1.0.0", "apiVersion": 1,
  "extends": "agentville.fantasy",                       // optional; omitted = extends "agentville.base" (§2.3)
  "rules":   { "tiers": [{ "name": "hamlet", "at": 0 }, { "name": "village", "at": 20 }, { "name": "town", "at": 80 }],
               "growth": { "perPR": 3, "perAgentEver": 1, "perLog2MB": 1 }, "hysteresis": 0.6 },
  "palette": { "accents": ["#c0632b", "#8a5a2b"], "night": "#1e1430", "ramps": { "roof": "#9a4a2a" } },
  "styles":  { "pool": "styles.json" },                   // per-project style pool (§4.4 of the v2 doc), as data
  "sprites": { "sheet": "sheet.png", "atlas": "atlas.json" },   // frames, anchors, footprints per model
  "represent": { "pr": "building", "agent": "villager", "boss": { "model": "villager", "hat": "crown" } },
  "badges": { "sheet": "badges.png" }, "labels": { "accent": "#e8b04a", "font": "pixel" }
}
```

`atlas.json` names frames by **model id** (`timber`, `palace@crown`, `folk.walk.SE.0` …) with pivot, true bounds,
anchors and an optional footprint override. Anything a pack doesn't name comes from the mod it extends.

### 2.2 Code mods (JS hooks)

The same `mod.json` plus `"entry": "mod.js"`. The entry is an ES module whose default export implements any subset of
the hooks in §3.2. Code mods run in the sandbox (§4) and nowhere else.

### 2.3 Extension

- `extends` forms a chain, for example `anna.autumn → agentville.fantasy → agentville.base`. The engine resolves each
  hook and data key to the nearest mod in the chain that defines it. Data merges deeply (objects merge, arrays
  replace).
- Code hooks get `ctx.parent.<hook>(...)`, so they can wrap the parent instead of replacing it ("the fantasy planner,
  plus a lighthouse on every coast").
- `agentville.base` is a tiny, readable reference world. Every hook has a minimal correct answer: one tier, grid
  plots, flat coloured boxes for buildings, dot people, PRs as flags. It doubles as the template (§5.3) and as the
  last-resort fallback.

---

## 3. The stable contract

### 3.1 Input: `WorldInput` (read-only, sanitised)

Built only by `engine/mod/input.js` from the engine's `SnapshotView`, through an **allow-list**. It is deep-frozen and
structured-cloned into the sandbox.

```js
/** @typedef {{
 *  apiVersion: 1, now: number, seed: number,                // world seed (per install, per mod)
 *  agents: Array<{ id: string,                              // opaque, stable (a hash of the server id, salted per install, never the raw session id)
 *    name: string, project: string, parent: string|null,   // agent display name; project display name
 *    status: 'working'|'waiting'|'stalled'|'error'|'resting',   // derived from bucket and severity
 *    needs: null|'permission'|'question'|'plan'|'dialog',  // the prompt kind (an enum key, never its text)
 *    role: 'boss'|'lead'|'worker'|'sub', crown: boolean, important: boolean, stopped: boolean,
 *    harness: 'claude'|'codex'|'other', since: number, lastActive: number, prs: string[] }>,
 *  projects: Array<{ key: string, name: string, accent: string,
 *    stats: { prsEver: number, prsLive: number, agentsEver: number, agentsNow: number, transcriptMB: number } }>,
 *  prs: Array<{ id: string, project: string, number: number, title: string,   // titles OK
 *    state: 'building'|'loading'|'merged'|'closed', checks: { passed: number, failed: number, pending: number },
 *    review: null|'approved'|'changes'|'pending', size: { additions: number, deletions: number, files: number } }>,
 *  env: { night: number, reduceMotion: boolean, zoom: number },
 * }} WorldInput
 */
```

The input **never** contains:
- conversation or transcript text;
- `ask`, `reason` or `resume` strings;
- cwd or file paths, PR URLs, hrefs, account or model data, cost or spend;
- terminal state, or raw server ids.

PR hrefs stay engine-side: a click on a mod's PR representation is mapped back by `prs[].id`. A unit test feeds a
snapshot full of canary strings through `input.js` and asserts none of them come out the other side.

### 3.2 Hooks a mod implements

All hooks are optional, and an undefined hook falls back to the parent. Every mod extends `agentville.base` (directly or
through `agentville.fantasy`), and the base defines `layout`, so `layout` always resolves. "Pure" means deterministic,
with no clock or global RNG; use `ctx.rng` and `ctx.time`. The rules for what a mod may import and who owns which folder
are in [mod-boundary.md](mod-boundary.md); the how-to is [make-your-own-world.md](make-your-own-world.md). The source of
truth for every signature is `web/src/engine/mod/api.js`.

**Hooks in API v1** (`MOD0_HOOKS` plus the two MOD1 additions, `MOD1_HOOKS`):

| Hook | Signature | When | Notes |
|---|---|---|---|
| `growth` | `(project, ctx) → number` | each poll, per project | default `3·prsEver + agentsEver + ⌊log2(MB+1)⌋` |
| `tier` | `(growth, prevTier, ctx) → number` | each poll | default: `rules.tiers` with `rules.hysteresis` |
| `capacity` | `(tier, need, ctx) → number` | each poll | capacity only grows within a tier (engine-enforced) |
| `lots` | `(project, agents, prs, ctx) → LotRequest[]` | each poll | who and what needs a lot (homes, PR sites), with rank `L/M/S` |
| `crowns` | `(project, agents, ctx) → number` | each poll | boss slots a project shows |
| `planSettlement` | `({ tier, seed, lots, crowns, style }, ctx) → Plan` | re-plan only | ground codes come from the mod's `terrain` table (1..199) |
| `style` | `(projectKey, ctx, preset?) → { key, accent? }` | once per project | opaque to the engine except `accent` |
| `layout` | `(LayoutInput, ctx) → LayoutResult` | world rebuild, only when a block moves | input `{ settlements, square, parks, paths }`; `ctx.time` is not given and the result is cached. Returns bounds, focus, terrain-class, ground, road and lot rasters, `outside`, venue sites and `data` |
| `scatter` | `(ScatterTile, draw, ctx) → ScatterPick \| null` | world rebuild, per unbuilt tile whose class `grows` | optional |

**Data keys**, deep-merged over the parent (arrays replace) and frozen: `rules`, `terrain` (`types`, `byName`,
`wildCost`, `classes`), `objects`, `behaviour`, `represent` (`agent`, `boss`, `sub`, `poses`, `cues`, `pr`, `project`) and
`venues`. `represent.pr` merges per PR state: a state the child names replaces the parent's whole `PrSpec`. `persist` is
top-only and never inherited. A mod may name only its own `va.engine2.world.<id>` keys in it; the bare
`va.engine2.world` and classic `va.world<N>` keys belong to `agentville.fantasy`, and any other mod that names them does
not resolve. Most mods leave it out.

**Terrain classes.** `terrain.classes` are the terrain-layer codes 0..15 a layout writes (`water`, `wild`, `grows`,
`color`). Class 0 is required and means "outside the grid". Ground codes 1..199 belong to the mod; 200..255 are the
engine's `LAYOUT_GROUND` (`EDGE` 200, `VENUE` 201, `HUB` 202, `ROUTE` 203).

**Venues.** `mod.venues[kind]` is a `VenueDef`: `level(load, prev, ctx) → 0..16`, `plan({ site, level }, ctx) → { objects,
nodes, berths }` and an optional `assign`. The layout names venue sites in `LayoutResult.venues[siteId]`; the engine
builds `world.venues[siteId]`, and `resolvePlace('venue:<siteId>')` goes to the site anchor.

**Features.** `FEATURES` is `layout`, `terrain.classes`, `scatter.at`, `represent.pr`, `represent.project`, `venues`,
`persist`. A mod asks `ctx.api.has(name)` before relying on one.

**Design backlog, not in API v1.** These belong to the later sandbox and data-pack layers (`placeSites` is gone:
`layout` replaced it; `terrain`, `objects`, `represent`, `behaviour` and `venues` are the v1 data keys above):

| Hook | Signature | When | Notes |
|---|---|---|---|
| `ambient` | **not in API v1.** First-party worlds carry ambient behaviour as trusted code (children inherit it); an own `ambient` on any other mod is ignored and linted (M6). Planned later as declarative data: `[{ id, count(tier), look, routine: [{ go: 'anchor:vend', dwell: [20, 90] }…], night }]` | world rebuild | — |
| `events` | `(diff, ctx) → EventSpec[]` | each poll | `{ kind, at: 'plaza:<proj>'\|'actor:<id>'\|'pr:<id>', effect: '<sprite anim>', seconds }` |
| `sprites` | `render(model, variant, style, opts) → { bitmap, pivot, bounds?, anchors }` | sprite-cache miss (batched) | code art; data packs use an atlas instead |
| `actors` | `render(look, facing, anim, frame, style) → { bitmap, pivot, head }` | cache miss | |
| `ground` | `renderTile(code, neighbours, style) → bitmap` | chunk bake (batched) | |
| `lighting` | data: `{ tint(night) → rgba, sources: modelId → { r, warm } }` | load | |
| `ui` | data: badge sprites, label tokens, sign and plate templates (`"{name}"`, `"{name} · {stalled}"`) | load | no CSS strings, no HTML |
| `tick` | `(actorsView, dt, ctx) → ActorPatch[]` | **optional**, 10 Hz, 2 ms budget | escape hatch for exotic movement; the fantasy mod doesn't use it |

Every hook output passes a **validator** before use (`engine/mod/validate.js`), using the v2 invariants:
- plans: in-bounds footprints, no overlap, door forecourts walkable and connected;
- sprites: size ≤ 512×768, pivot inside, true bounds measured by the engine (a mod's bounds are a hint only);
- specs: known model ids and anchors.

A validation error names the mod, the hook, the field path and the fixture or project that triggered it.

### 3.3 Engine services (`ctx`)

| Service | API | Notes |
|---|---|---|
| RNG | `ctx.rng(stream) → () => [0,1)`, `ctx.hash(str)` | seeded from (world seed, mod id, project key, stream); never `Math.random` (a lint flags it) |
| Time | `ctx.time = { now, tick, night, dayFraction }` | pinned by `?t=` in captures |
| Grid (read-only) | `ctx.grid.at(tx, ty) → { terrain, ground, road, lot, walk, cover }`, `ctx.grid.size` | a snapshot copy in the sandbox (typed arrays transferred once per world version) |
| Navigation | `ctx.nav.distance(a, b)`, `ctx.nav.reachable(a, b)` | for planning and scatter checks; actor movement stays declarative |
| Art kit | `import { ramp, outline, faces, rasterize, palette } from 'agentville:art'` | the v2 face rasteriser and palette helpers as a library (sandbox-local copy); OffscreenCanvas available |
| Sprites | `ctx.sprite(model, variant)` | reuse another model's bitmap (e.g. a crown overlay on the parent's manor) |
| Parent | `ctx.parent.<hook>(...)` | the extended mod's implementation |
| Log | `ctx.log/warn(msg)` | shown in the Worlds panel's dev console, rate-limited |

### 3.4 Versioning, errors and fallback

- `apiVersion` is an integer major. The engine supports the current and previous major. Additive features are
  detected with `ctx.api.has('venues')`. Breaking changes bump the major, and the old one is supported for one
  release with a migration note.
- **Load-time failure** (bad manifest, schema error, missing asset, sandbox boot timeout, apiVersion unsupported): the
  mod is not activated. The world falls back to `agentville.fantasy`, and a toast says
  `World "Orbital" couldn't load: atlas.json: frames.rocket.pivot must be [x, y]. Using Agentville Fantasy.` The
  details are in Settings → World.
- **Runtime hook failure** (throws, invalid output, or over budget 3 times in 60 s): that hook falls back to the
  parent for the session. An outright sandbox crash or hang (the watchdog in §4.2) falls back to the default world.
  The village never goes blank.
- Each mod gets its own persisted layout (`va.engine2.world.<modId>`; fantasy keeps `va.engine2.world` as an alias),
  so switching worlds and back never reshuffles either one.

---

## 4. Security and sandboxing

### 4.1 Threat

The village page runs on the app origin (`http://127.0.0.1:5275`). Same-origin script can call every local API, and
those APIs can:
- send messages and broadcasts to agents;
- run actions, fleet and restore;
- switch Claude accounts;
- open terminal WebSockets (ticketed, but tickets are minted same-origin);
- read usage and spend.

`isLocalRequest` correctly refuses other origins, and refuses `Origin: null`. But it cannot tell a mod's script from
the app's own script once both run in the app origin. Data exfiltration (agent names, project names, PR titles) to
the internet is the second risk. A malicious or buggy mod must get **none** of this, and must not be able to freeze
the app.

### 4.2 Recommended isolation model: data in, data out, behind an opaque-origin sandbox

```
app page (trusted, 127.0.0.1:5275)          sandboxed iframe (opaque origin, CSP: no network)        dedicated Worker (inside the iframe)
engine: grid, nav, render, input  ── postMessage (WorldInput, hook calls) ──▶ relay (≈60 lines, no mod code) ──▶ mod code + agentville:art kit
       ◀── validated results: numbers, plans, specs, ImageBitmaps ──────────────────────────────────────────────── OffscreenCanvas for sprites
```

1. **Trusted code** stays in the app page: the engine, the default mod and data-pack parsing (data is parsed, never
   evaluated). Data packs can only add images (decoded with `createImageBitmap` from bytes; no SVG) and JSON.
2. **Code mods run only in a Worker inside a sandboxed iframe:**
   - The iframe has `sandbox="allow-scripts"`: no `allow-same-origin`, popups, top navigation, forms or modals. Its
     origin is therefore opaque, so any request it makes carries `Origin: null` and the server's existing guard
     refuses it. Its document is served by the engine (`/mod-host.html`).
   - CSP on that document is
     `default-src 'none'; script-src blob:; worker-src blob:; img-src blob: data:; connect-src 'none'; style-src 'none'`.
     That leaves no network, no WebSocket, no fetch of the API, and no beacons.
   - The relay receives mod source **text** from the engine (the server reads it from disk, and the trusted page
     passes it on), wraps it in a `blob:` URL, and starts the Worker. So the mod never gets a URL to fetch from.
3. **Capability-limited API.** The mod sees only `WorldInput`, the `ctx` services and the art kit. It returns plain
   data and `ImageBitmap`s, never DOM, never draw calls on the real canvas, and never CSS or HTML (label text is
   inserted with `textContent`).
4. **Resource limits.**
   - Each hook call has a deadline (plan 200 ms, sprite batch 50 ms, events 10 ms, tick 2 ms).
   - The relay `terminate()`s a Worker that misses a deadline by 5×, and the engine removes and recreates the iframe
     if the relay itself stops answering pings for 2 s.
   - Payloads are capped: 4 MB per message, ≤ 2,000 sprites per batch, and bitmaps ≤ 512×768.
   - Results that fail validation are dropped. Message types are a fixed allow-list on both sides.
5. **Explicit opt-in per code mod.** Selecting a code mod shows its manifest name, author, file list and a SHA-256 of
   its code, with the text "This world runs its own code in a sandbox. It can't reach your agents, terminals or
   accounts." Approval is stored with the hash. Any code change re-prompts, except when "developer mode" is on for
   that one mod's folder (hot reload, §5.2). Data packs need no prompt.
6. **Defence in depth on the server and in Electron:**
   - The app page gets a CSP for the first time: `script-src 'self'; connect-src 'self' ws://127.0.0.1:*;
     frame-src 'self'; object-src 'none'; base-uri 'none'`. Today `web/index.html` has none, so this is worth doing
     regardless.
   - The mod file routes (`/api/mods`, `/modfiles/...`) are GET-only and read-only, normalise paths (no `..`, no
     symlinks out of the mod dir), use an extension allow-list (`.json .js .png .webp`) with `nosniff`, and send
     `Content-Security-Policy: sandbox` on every response, so a mod file opened directly can't run in the app
     origin. Mod `.js` is served as `text/plain`; it only ever executes via the relay's blob.
   - Electron (`desktop/main.cjs`): keep `contextIsolation`, `sandbox: true` and `nodeIntegration: false` (already
     set). Add `setWindowOpenHandler(() => deny)` and `will-frame-navigate` deny for the mod frame. Add
     `session.setPermissionRequestHandler` that denies every permission for non-app origins. Add
     `webRequest.onBeforeRequest` that cancels any request whose `frame` is the mod host, except its own document.
7. **Why not the alternatives:**
   - A plain same-origin Worker has the app origin and can `fetch('/api/…')`.
   - SES/Compartments in-page has a larger attack surface and is harder to audit.
   - A separate Electron `BrowserView` doesn't exist in the browser build.
   - The iframe+Worker model works identically in Chrome and Electron.

**Gate:** a **security review** of `mod-host.html`, the relay, the bridge, the server mod routes, the CSP and the
Electron hardening, before the sandbox ships, and again before it reaches the public repo. Tests (written from this
spec by a separate agent) try the following from a hostile mod, and all must fail:
- `fetch`, XHR, WebSocket, `importScripts` of an http URL, `new Image().src=` to the API and to an external host;
- `top.location`, `parent.document`, `window.open`;
- a postMessage flood, an infinite loop, a 1 GB allocation, a giant bitmap;
- prototype-pollution payloads in results.

---

## 5. Distribution and selection

### 5.1 Where mods live

- **Bundled:** `mods/` at the repo root. It holds `agentville.base/`, `agentville.fantasy/` (the default; its code
  moves here from `web/src/engine/...` content modules, §6), `agentville.orbital/` (the example) and `_template/`.
  These ship in the public repo.
- **User:** `<config>/mods/<id>/`, where `<config>` is the existing config dir (`~/.config/agentville`, or
  `AGENTVILLE_CONFIG_DIR`). The server lists both; a user mod with a bundled id shadows it only in developer mode.
- **API:** `GET /api/mods` returns `[{ id, name, version, apiVersion, kind: 'data'|'code', extends, source:
  'bundled'|'user', hash, errors[] }]`. `GET /modfiles/<id>/<path>` serves files with the headers in §4.2.6.

### 5.2 Selection and hot reload

- **Settings → World:** a picker with a thumbnail per mod (from its `preview.png`), an "extends" chip and a
  data/code badge, plus the opt-in dialog for code mods. It is stored as `va.world.mod`.
- **URL:** `?world=<id>` overrides for the session. It is also used by captures and tests.
- **Developer mode** (per mod, toggled in the picker):
  - The server watches that mod's folder (`fs.watch`, debounced 300 ms) and bumps `modsVersion` in the
    `/api/agents` payload. The engine re-resolves the chain, drops that mod's sprite-cache entries, and re-plans
    only if planning hooks changed (hash per hook group).
  - Errors show in an in-village overlay with the field path.
  - `?world=<id>&grid=walk` and the sprite sheet page (`&artsheet=1`) work for any mod.

### 5.3 Template, guide and tooling

- **`mods/_template/`:** a `mod.json` that extends `agentville.base`, a commented `mod.js` with every hook stubbed to
  `ctx.parent`, a 64×64 placeholder atlas, and a README.
- **`docs/make-your-own-world.md`:**
  - a 10-minute data-only reskin (palette, tier names, badge sheet);
  - a 30-minute code mod (a custom planner and a PR representation);
  - the art kit (faces, ramps, outline, pivots, 2:1 iso rules);
  - the contract tables from §3;
  - the sandbox rules;
  - how to test.
- **`tools/mod.mjs`:**
  - `new <id> [--extends fantasy|base]` scaffolds from the template;
  - `check <path>` loads the mod headless against the bundled synthetic fixtures (`e2e/fixtures/engine/*.json`;
    names are made up, no real data) and runs every validator and the v2 invariants (walk-through, slots, clipping);
  - `shots <path>` runs the artpass capture harness with `--world <id>` (hidden, headless) and writes a review
    sheet.

### 5.4 Example mod that proves the API: `agentville.orbital` (space colony)

It is chosen to differ from fantasy on every axis:

| Axis | Orbital |
|---|---|
| Growth | Tiers outpost → base → colony → arcology. Growth weights live sessions (`agentsNow`) more than history |
| Planning | A radial planner: a central hub dome with spoke corridors and ring modules. No streets: "ground" is regolith plus corridor tubes |
| Terrain | Regolith, craters (block), corridor (walk), landing pad. No water at all |
| Agents | Astronauts in suits tinted by the project accent. Boss = commander with an antenna helmet. Subs = little drones (a `represent.agent` returning a different model) |
| PRs | Rockets on launch pads (`venue: 'spaceport'`). Checks pending = fuelling, approved = countdown, merged = launch, with an exhaust trail effect |
| Statuses | Stalled = red beacon spinning on the helmet; waiting = sitting in an airlock bench; working = welding sparks at the module |
| Ambient | Rovers on corridor loops, cargo drones, a satellite crossing the starfield. Lighting is a permanent night with module glow (`lighting.tint` constant) |
| Events | Tier-up = a supply ship lands; a new project = a lander touches down with a dust ring |

It is a code mod, so it exercises the sandbox, planning, venue, represent, sprites and events. A second tiny data-only
example (`examples/autumn-pack/`, extending fantasy with an autumn palette and orange tree sprites) proves the
non-coder path.

---

## 6. Impact on the engine plan

### 6.1 Minimal changes to M0–M1 now (before more code lands)

These are cheap now and expensive later. Each is a seam rename or move, not new features.

1. **`engine/mod/` skeleton** (A1, Engine Lead):
   - `api.js` holds the typedefs from §3 and `API_VERSION = 1`.
   - `registry.js` holds `resolveMod(id) → ResolvedMod`, the chain merge, and an in-process loader for bundled
     trusted mods only.
   - `index.js` asks the registry for the mod and passes `mod` into everything below.
   - There is no sandbox yet.
2. **`WorldInput` replaces direct snapshot use in world code.** `snapshot.js` keeps producing `SnapshotView` for the
   engine. A new `engine/mod/input.js` builds the sanitised `WorldInput` with the §3.1 allow-list. Note that today's
   `AGENT_FIELDS` includes `ask`, `reason` and `resume`; they must never pass into `WorldInput`. `planVillages` and
   the lot logic read `WorldInput`, not `SnapshotView`.
3. **Rules out of `sites.js`:**
   - `planVillages` becomes `planSettlements(input, persisted, mod, opts)` and calls `mod.growth`, `mod.tier`,
     `mod.capacity` and `mod.lots`.
   - `planFor` calls `mod.planSettlement`.
   - `ACCENT`, `RESTING_HOMES`, `PR_LIVE_CAP`, `PR_DONE_CAP`, `SQUARE` and the placement constants move into
     `mods/agentville.fantasy/rules.js` (data).
   - `sites.js` keeps only the mechanics: placement search, rings, land and dock site, parameterised by
     `mod.rules.layout`.
4. **Ground codes become mod-declared:**
   - The grid's `ground` layer stores codes 0–199 from the mod's `terrain` table. Engine-reserved codes move to
     200–255 (they are now `LAYOUT_GROUND`: `EDGE`, `VENUE`, `HUB`, `ROUTE`).
   - `GROUND_COST`/`WILD_COST` and `costOf` take a `TerrainTable` built from mod data instead of importing
     `city-plan.js`.
   - `city-plan.js` `GROUND` becomes the fantasy mod's terrain table.
5. **Footprints become mod data:** `footprints.js` `FOOTPRINTS` moves to `mods/agentville.fantasy/objects.js`, and
   `footprintFor(prop, objectTypes)` takes the table.
6. **Persistence per mod:** `persist.js` keys become `va.engine2.world.<modId>`, keeping today's `va.engine2.world`
   as the fantasy alias. Classic import (`va.world9/8`) applies only to `agentville.fantasy`.
7. **Signatures that carry `mod`:**
   - `buildWorld(input, persisted, { mod, now, seed })`
   - `stampPlan(grid, objects, plan, origin, { mod, ... })`
   - `assignLots(settlement, persistedLots, now, mod)`
   - `scatterWild(grid, objects, sites, seed, mod)`
   - `computeCover` stays engine-owned.
8. **`rng.js`:** add `streamFor(seed, modId, projectKey, stream)`. This is the only RNG mods ever see.

### 6.2 Seam changes in the v2 doc

| v2 piece | Was | Becomes |
|---|---|---|
| A3 sites / A4 plan adapter | imports `city-plan`, hard-coded rules and footprints | calls `mod.*` rule hooks; footprints and terrain from mod tables (§6.1) |
| B2 raster and sprite cache | `rasterize(model, style)` in-engine | `SpriteCache.get(key, miss)`, where `miss` batches `mod.sprites.render` (sync for trusted mods, async for the sandbox; the placeholder box shows meanwhile). The raster kit is exported as `agentville:art` |
| B3 renderer / ground | ground art in `render/ground.js` | the chunk baker calls `mod.ground.renderTile`; the renderer only knows sprite keys |
| B5 sim core | the agent behaviour table in code | the engine executor reads `mod.represent` and `mod.behaviour` (declarative); `events` from `mod.events` |
| B6 ambient | townsfolk, cart and critter modules | the engine runs declarative routines from `mod.ambient`; fantasy's townsfolk, carts and critters become data in `mods/agentville.fantasy/ambient.js` |
| C2 dock | dock adapter | a generic `venue` service; the fantasy harbour is `mods/agentville.fantasy/venue-harbour.js` (wrapping `dock-art.js`) |
| C3 style | `engine/art/style.js` | the fantasy mod's `style` hook (still imports city4 `styles-pool.js`); the engine treats style as opaque |
| C4 / C5 folk and building models | `engine/art/**` | content moves to `mods/agentville.fantasy/art/**`; the shared kit stays in `engine/art/kit/**` |
| C1 overlay | label theme in CSS | label tokens and badge sprites from `mod.ui` |

Content pieces (B6, C2–C5) now write into
`mods/agentville.fantasy/**`, and the engine pieces own `engine/**`.

### 6.3 Milestones

**Milestones** (folded into the v2 plan):
- **MOD0 (now, inside M1):** §6.1 changes, plus the registry with trusted bundled mods.
- **MOD1 (with M2–M3):** fantasy content written as a mod; art, behaviour and ambient as hooks.
- **MOD2 (after M4):** sandbox, server routes, data packs, picker, security review.
- **MOD3 (with M6):** Orbital, the autumn pack, tooling and the guide. A second security review happens before the
  public-repo release.

---

## 7. Risks and decisions

| Risk | Mitigation |
|---|---|
| Sandbox overhead (postMessage, bitmap transfer) | Coarse hooks (per rebuild, per cache miss, per status change); declarative behaviour and ambient; `tick` optional with a budget; the trusted default runs in-process, and CI also runs it sandboxed to keep parity honest |
| API too fantasy-shaped | Orbital (radial, no water, rockets) must ship on the same API before the API is frozen at v1 |
| A mod hangs or crashes the app | Worker deadlines, relay watchdog, iframe recreation, fallback chain |
| Data leaks through mod-visible strings | Allow-list input and a canary test; no network in the sandbox; label text via `textContent` |
| Public-repo users run untrusted code | Opt-in with a hash, a clear dialog, the security gate, and the sandbox as the only path for code |

Open decisions (my recommendation first):
1. **Should code mods be allowed at all in v1, or data packs only?** Recommendation: both, with code only through the
   sandbox. The other user's "different ways the cities scale" needs code.
2. **Should mods get PR titles and agent names?** Recommendation: yes, both are visible in the app anyway, but never
   URLs or conversation text. The alternative, opaque ids only, makes signs and labels useless.
3. **Should we host a shared catalogue of community mods?** Recommendation: not now. Folders plus a GitHub link in
   the guide are enough.
