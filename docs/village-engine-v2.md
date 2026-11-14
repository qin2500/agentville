# Village engine v2: a ground-up rebuild of the visual village

Status: design document.
Goals: the village should behave like a village sim: NPCs must never walk through things, so the visual part is rebuilt
from the ground up, and every new project should get slightly different buildings, streets and people, generated
from a pool of styles.
These come from reading `world.js`, `iso.js`, `city-plan.js`, `ambient.js`, `dock-walk.js`, `props-art.js`
and `village.js` at `main` 77565dc. Each class becomes a hard requirement (R1…R12) that v2 must meet and
that a test checks. The art audit (`docs/art-audit.md`) classes are merged into this table, and its capture harness
(`tools/artpass/capture.mjs`, `?artsheet`) is reused in §5.

| # | Root cause (today) | Symptom users see | v2 requirement |
|---|---|---|---|
| RC1 | **Props never block walking.** `city-plan` puts fountains, stalls, benches, statues, wells, lamps and carts on WALKABLE tiles (plaza, market, yard, street), and nothing ever marks those tiles blocked. Ambient routes (`ambient.js makeRoute`) check only the ground code. | Townsfolk walk through fountains, stalls and benches. | **R1** Every object has a footprint and a walk mode (`block`, `edge` or `floor`), stamped into one grid. Every mover reads only that grid. |
| RC2 | **Three separate path systems, none of them aware of objects.** Layout roads use A* over a noise field (`world.js route`). Ambient townsfolk use random loop walks inside a plan. Dock walkers use Dijkstra over `land − footprints` with an off-road cost (`dock-walk.js roadRoute`), so they cut through forest, fields, fences and gardens. | Porters walk through trees and fences. Townsfolk never leave their own plot. | **R2** One nav service (grid A* plus a road graph) serves every mover: agents, townsfolk, carts, porters, critters. |
| RC3 | **No occupancy for actors.** Stand spots are hand-tuned pixel offsets (`YARD = [[-26,12],…]`) checked at 2 sample points. Carriers shuttle ±6 px, chickens stroll a rect, townsfolk get a random ±2.5 px offset, and the cart rides a fixed row. None of them reserve space. | Villagers stand on each other or inside props. The cart drives through people. | **R3** Stationary actors claim stand slots from a reservation table (at most 2 per tile). Moving actors keep to lanes and yield. |
| RC4 | **Multi-tile props sort as a point.** In `world.js draw`, a fence of `len` tiles, a bench with `dir: 'y'`, a stall or a bridge is pushed with one foot point (`p.x, p.base`) into `isoSort`. | Fences poke out of buildings and draw over walls. A long fence is in front at one end and behind at the other. | **R4** Static objects are sliced per screen column, and each slice gets its own depth (§3.2). No drawable is ever wider than one column, unless it is an actor. |
| RC5 | **The topological sort hides its cycles.** `isoSort` says "a cycle: leave it where it is". Large footprints next to point actors can make cycles, and when they do, the order is arbitrary. | Occasional wrong layering that flickers between frames. | **R5** The sort key is total and deterministic, with no topological sort at runtime. A test checks it against random scenes. |
| RC6 | **Some objects skip the depth sort.** Wild trees that are not "near a building" are drawn in a pre-pass (`W.wildIso`), and the sky and effects layers ignore depth. | A villager behind a tree draws on top of it. | **R6** Everything that stands up joins the same sort. Only ground decals skip it. |
| RC7 | **Projection is not on the pixel grid.** `ISO = 0.8` makes 25.6 × 12.8 px tiles. The ground is drawn through a skew transform with `imageSmoothingEnabled = true`, but the sprites are not. | Soft, smeared ground next to crisp sprites. Seams, 1 px jitter, and lines that never sit on clean 2:1 steps. | **R7** Integer 2:1 projection: a tile diamond is 32 × 16 px. Ground is pre-rendered as iso tiles, never skewed at runtime (decision D2). |
| RC8 | **Sprite extents are estimates.** `iso.js` sizes each building canvas from `st.top ?? H + R + 44` and props from hand-written `bb()` boxes. A tall spire or finial can overrun the canvas, which crops it, and the hit-boxes, label anchors and culling all use the estimate. *(Suspected source of the "spire fragments". The audit should confirm it.)* | Cut-off spires, and floating fragments where a cached image was cropped or reused under the wrong key. | **R8** Sprites are rasterised into an auto-sized buffer, and their bounds come from real pixel coverage. A test asserts that no opaque pixel ever touches the buffer edge. Cache keys are derived from the full input tuple. |
| RC9 | **Mixed art sources and conventions.** Ninja Adventure top-down sheets (actors, trees, lantern) sit next to procedural iso rasterisation (buildings, props, dock). The lantern sprite "reads as a birdhouse" at this angle. Actors only have top-down facings. | Style clashes up close, and villagers face the wrong way in iso. | **R9** One art pipeline: procedural, data-defined, iso-native, with shared ramps, outline and light (§5). Ninja sheets stay only as a fallback until M6 (decision D3). |
| RC10 | **Units and constants are copied across modules.** `T`, `ISO` and `LOOKS` are copied into `ambient.js`. Plan tiles carry +0.5 offsets, and code mixes world px, view px and tiles. The renderer mutates layout items (`it.px`, `it.iso`). | Off-by-half-tile placements, and fixes that drift between files. | **R10** One `coords.js`. World positions are float tiles. The renderer never writes to world objects. |
| RC11 | **Layout, simulation and rendering are tangled in `world.js`** (1,200 lines). Every "who stands where" is recomputed every poll from the snapshot (`placeAgents`), so nothing has continuous state. | No movement between states (villagers teleport), so behaviours are hard to add. | **R11** Separate world build, sim and render stages. Actors are persistent entities whose behaviour is driven by status. |
| RC12 | **Nothing prevents occlusion; it is only patched.** Villagers can be placed behind tall buildings and then drawn as a masked silhouette. | Villagers hidden behind roofs. | **R12** Stand slots are only offered on tiles that no building covers on screen (the "visible-tile mask", §2.4). X-ray only handles passers-by. |

What already works and is kept: `city-plan.js` as a pure planner (its outputs get stamped, §1.3), the
`iso.js` face-raster technique (it gains a projection parameter and true-bounds output), `dock-art.js`
models and harbour tiers, the label priority and overlap logic (moved to a pure function), and the camera
behaviour (fit, Map plates, persisted camera).

---

## 1. World model

### 1.1 One authoritative grid per world

`web/src/engine/core/grid.js` holds a `WorldGrid` that covers the whole island (town, forest belt, shore and
harbour cove), with flat typed arrays indexed `i = (ty - oy) * w + (tx - ox)`:

| Layer | Type | Meaning |
|---|---|---|
| `terrain` | Uint8 | `SEA_DEEP, SEA, SHORE, GRASS, FOREST_FLOOR` |
| `ground` | Uint8 | the city-plan `GROUND` codes (street, lane, plaza, market, yard, field, garden, lawn, water, bridge, flowers …), plus `RING` (ring road) and `DOCK` |
| `road` | Uint8 | road class: 0 none, 1 path, 2 lane, 3 street, 4 main or ring street. Used by the road graph and by paving art |
| `lot` | Int32 | lot or settlement id (−1 = wild) |
| `occ` | Int32 | id of the object that **blocks** this tile (0 = free) |
| `edges` | Uint8 | bitmask of blocked tile **edges** (N=1, E=2, S=4, W=8), for fences, hedges and railings that run between tiles |
| `cost` | Uint8 | walk cost: 255 = impassable. Road 1, plaza 1, yard 2, lawn 4, garden, field and forest 255 for townsfolk, but passable for critters by flag |
| `cover` | Uint8 | screen-occlusion depth: how much a standing actor on this tile is hidden by a building in front of it (0 = fully visible). Derived from geometry (§2.4) |
| `slots` | Uint8 | stand-slot reservations: 2 bits per sub-slot, 2 sub-slots per tile |

`version` increases on every stamp or unstamp. Caches (paths, flow fields, chunks) store the version they
were built at.

### 1.2 Objects

Everything that stands in the world is an object in `world.objects` (a `Map<id, WorldObject>`):

```js
/** @typedef {{
 *  id: string,                       // stable, e.g. 'home:<agentId>', 'house:<proj>:L4', 'prop:<proj>:fountain:0'
 *  kind: 'building'|'prop'|'tree'|'decal'|'dock'|'ship',
 *  model: string,                    // art model id: 'timber', 'palace', 'fountain', 'fence', 'oak' …
 *  tx: number, ty: number, w: number, h: number,   // footprint in tiles (integers)
 *  z: number,                        // height in px above ground (for cover, x-ray and label anchoring)
 *  walk: 'block'|'edge'|'floor',     // block: occ on every footprint tile; edge: edges along a run; floor: decal, no effect
 *  run?: { dir: 'x'|'y', len: number, side: 'N'|'E'|'S'|'W' },   // for walk:'edge' (fences, hedges, railings)
 *  door?: { tx: number, ty: number, face: 'S'|'E' },   // the walkable tile in front of the door (a nav node)
 *  anchors?: { stand?: Slot[], work?: Slot[], sit?: Slot[], vend?: Slot[] },   // named spots that behaviours use
 *  project?: string, lot?: string, rank?: 'L'|'M'|'S', crown?: boolean,
 *  styleKey: string,                 // hash of the style fields this model reads (§5.4)
 *  variant: number, data?: object,   // e.g. { pr: 123, building: true } for a PR site
 * }} WorldObject
 *  Slot = { tx: number, ty: number, sub: 0|1, face: 0|1|2|3 }
 */
```

Every multi-tile prop gets a real footprint from one table (`engine/world/footprints.js`). A sample:

| Plan prop | Footprint | Walk | Notes |
|---|---|---|---|
| fountain | 2×2 | block | anchors.sit = the 4 rim sides (people sit on fountains: fun) |
| stall | 2×1 (dir x) | block | anchors.vend = the tile behind, facing south |
| bench | 1×1 (or 1×2 with dir y) | block | anchors.sit |
| statue, well, maypole, trough, noticeboard, signpost, cart (parked), woodpile, beehive | 1×1 | block | |
| lamp, lamppost, banner | 1×1 | block | the planner moves these to the street **edge** tile (§1.3) |
| fence, hedge, railing | run of `len` | edge | blocks the crossed edges only, so a lane beside it stays open |
| bridge | 1×N | floor (deck) | the water under it becomes walkable along `dir` |
| tree (plan or wild) | 1×1 trunk | block | the canopy overhangs neighbours on screen; depth uses the trunk tile |
| flowers, flowerbox, hay, crops | — | floor | ground decal, baked into chunks |

### 1.3 Settlement planning outputs into the grid

The world build runs in this order (all pure, no DOM). `buildWorld(view, persisted) → World`:

1. **Sites** (`world/sites.js`, ported from `world.js layout`): the town square, one block per shown
   project, its compact placement score, `GAP` streets, ring roads, roads to the square, eviction and park
   reserve rules, `dockSite`, land, shore, forest belt and lakes. The logic is unchanged. It writes
   `terrain`, `ground = RING` and `road`.
2. **Plans**: `planSettlement({ tier, seed, lots, crowns, style })` from `city-plan.js` for each block. It
   is not rewritten: the plan format stays the contract.
3. **Stamp** (`world/plan-adapter.js`): copies the plan ground in, creates `WorldObject`s for lots, civic
   buildings and props (footprint table above), and stamps `occ`, `edges` and `cost`. The adapter also
   **legalises** props:
   - A blocking prop on a tile the planner marked as a through-route (a street or lane tile whose removal
     would cut the walk graph) is nudged to the nearest non-cut tile, or dropped. Articulation points are
     computed once per plan.
   - Lamps, lampposts and banners snap to a street's **edge** tile (the tile beside the forecourt), never
     the middle of a 2-wide street.
   - Every door tile and its two forecourt tiles (`(dx+k, dy+k)`, k = 1, 2, as in the v2 planner rule) must
     stay unblocked, or the prop is dropped.
   - Each drop or nudge is logged in `world.lint`, and a test fails on any drop in the fixtures. That makes
     planner bugs visible instead of silently fixed.
4. **Assignment** (`world/lots.js`, ported from `placeVillage`): which agent or PR owns which lot, with
   L/M/S ranks, crowns first, the HOLD and RESERVE timers, the resting-home cap and the PR caps. Owners
   change `object.data` and `object.crown` only, never the geometry.
5. **Scatter**: wild trees and bushes are stamped as objects too (trunk tiles block). Their density comes
   from a BFS distance to anything built (the current rule), but a tree is never placed on a road, a door
   forecourt or a tile `cover` would hide.
6. **Derived layers**: `cover` (§2.4), the road graph (§2.2), and the stand-slot candidates per door.

### 1.4 Stability rules

- **Deterministic seeds.** The world seed is fixed per install (`va.engine2.seed`, random once). Each
  settlement's seed is `hash(projectKey)`, and each object's variant is `hash(id)`. No `Math.random` is
  allowed in build or sim; the sim uses `rng(seed, entity, tick)`.
- **Persisted plans.** `va.engine2.world` holds `{ v: 1, seed, blocks: { [project]: { x, y, w, h, tier, gt,
  cap, crowns, style, acc, seen, away? } }, lots: { [project]: { tier, cap, a: {itemId: lotId}, h: {itemId:
  goneSince} } } }`. It is the same shape as `va.world9`, plus `crowns` and `style`. **On first run v2
  imports `va.world9`, or `va.world8` if 9 is missing,** so switching engines does not reshuffle the town.
- **Re-plan triggers.** A plot is re-planned only when (tier, capacity bucket, crowns) changes, with the
  existing tier hysteresis (60%) and capacity that only grows within a tier. A re-plan keeps the block
  centre if the new size fits there. Other plots never move.
- **The rebuild signature** is `JSON.stringify([blocks(tier, cap, crowns, style), homes, PR states])`, as
  today. Status changes never rebuild the world: they only drive the sim.
- **Incremental stamping.** A changed settlement is unstamped and restamped inside its block. Only chunks
  that intersect it are re-baked, and only path caches that touched it are dropped (keyed by block id).

---

## 2. Navigation

### 2.1 Who moves

| Mover | Typical count | Moves how |
|---|---|---|
| Agent villagers | 400 today, 1,000 budget, mostly stationary | They walk when their state changes (home ↔ PR site ↔ dock ↔ square), then hold a stand slot |
| Townsfolk | per settlement 2/5/10/18 by tier, so ≤ ~300 | Daily routines between doors, market, square and benches |
| Carts | 1 per town or city | Along the road graph, on the street lane |
| Dock porters | at most 6 (CAP) | Home or PR building → crate yard → pier → ship → back |
| Critters (chickens, cat, pigeons) | ~40 | Wander inside a pen or square region, on grid cells with a critter flag |

### 2.2 Two levels: road graph and local grid

- **Road graph** (`nav/roadgraph.js`). Nodes are road intersections, settlement gates, door tiles, plaza
  centres, dock nodes (yard, each pier head, each berth) and the town square. Edges are road segments with
  length × class cost. On real data it has about 2–5k nodes. It is built once per world version.
- **Local grid A*** (`nav/astar.js`) runs on the `WorldGrid` with 8-way moves (no corner cutting past a
  blocked tile or edge), uses `cost`, and keeps its open list in a binary heap over typed arrays. Distances
  are Float64 (the known Float32 bug from 2026-10-22).
- **A request** `nav.path(from, to, opts)` finds the nearest graph node at each end with a bounded local A*
  (radius 12 tiles), runs A* on the road graph, and joins the result into a polyline of tile centres with
  **lane offsets**: keep right, ±0.25 tile across the road direction, so two-way traffic does not overlap.
  Short trips (≤ 24 tiles Manhattan) use grid A* directly.
- **Flow fields** for hot destinations (`nav/flow.js`): each settlement's plaza, the town square and the
  dock yard get one Dijkstra flow field, built lazily and cached per world version. Ambient townsfolk going
  to the market and porters returning to town read the field: O(1) per step, with no per-actor search.

### 2.3 Doors, crowds and slots

- Every door is a nav node: `door.tx, door.ty` is the forecourt tile. Entering a building means walking to
  the door node, playing a 0.4 s "enter" fade, and leaving the scene (the actor goes `indoors`). Leaving is
  the reverse.
- **Stand slots.** Each tile has two sub-slots (left and right of the tile centre along the screen's x).
  `nav/slots.js`: `claim(tx, ty, actorId) → sub | -1`, `release(actorId)`, and `nearestFree(anchor, radius,
  filter)`, which searches outward over walkable, `cover = 0`, unreserved tiles, preferring the owner's own
  forecourt, then the street in front, then neighbouring forecourts of the same project. This replaces
  `YARD` offsets, `YARD_CAP` and the "+N more" crowd logic. "+N more" stays only when no slot is free within
  the radius.
- **Door crowding.** A door has a small queue of claimed slots fanning out along the forecourt. An actor
  that finds its target slot taken re-plans to `nearestFree`. Two walkers are allowed to overlap while both
  are moving (sprites passing on a street read fine). A walker never stops on an occupied sub-slot. If the
  next cell holds a stationary actor, it side-steps to the other lane, or waits up to 0.5 s and then
  re-plans.
- **Carts** reserve the cells ahead of them (2 cells) on the road graph. Pedestrians treat reserved cells
  as cost ×4, so they step aside and the cart never drives through people.

### 2.4 The visible-tile mask (`cover`)

For each building, project its sprite's true opaque bounds (R8) onto the ground behind it. Any tile whose
standing actor (a 16×24 px box) would be ≥ 35% covered gets `cover = coverage`. Stand slots, work anchors
and townsfolk dwell points must have `cover = 0`. Walk paths may cross covered tiles, and x-ray handles
those (§3.6). The planner gets this as a lint: a lot whose door forecourt is covered by a neighbour is a
planner bug and fails a test.

### 2.5 Budgets (1,000 agents)

| Work | Budget | How |
|---|---|---|
| Road graph build | ≤ 15 ms | Once per world version |
| Flow field (one destination, 300×300 grid) | ≤ 8 ms | Lazy, cached, ≤ 6 hot destinations |
| Path request (graph A* + 2 local A*) | ≤ 0.3 ms avg, 2 ms p99 | LRU cache of 4,096 entries keyed `fromNode|toNode|flags` |
| Path requests per tick | ≤ 40 (extras queue to the next tick) | Time-sliced; an actor whose request waits idles in place |
| Off-screen actors | 0 per-step cost | They advance on their schedule (time to arrival); position is computed only when they come into view or arrive |

---

## 3. Rendering

### 3.1 Backend: Canvas2D first, WebGL2-ready (decision D1)

Recommendation: **Canvas2D with a narrow `Gfx` interface**, and a WebGL2 backend as an optional later
milestone (M8) if the measured budgets are missed.

- Today's look already runs in Canvas2D at about 1.5–2.3% CPU (2×, 8 fps, 403 agents). In Chromium,
  `drawImage` from cached canvases is GPU-composited. 3–6k draws per frame at 8–15 fps fits easily.
- WebGL2 would buy batched draws, a shader night lightmap and stencil x-ray. But it costs a texture-atlas
  packer, context-loss handling, text and overlay plumbing, and harder debugging, for a scene that is mostly
  cached static chunks.
- The `Gfx` interface keeps that door open: `begin(view)`, `image(img, sx, sy, sw, sh, dx, dy, flags)`,
  `fill(rect, color)`, `pushLayer(name)`, `end()`. Nothing outside `render/` touches `ctx`.
- **3D (three.js or similar): no.** The identity of this village is crisp pixel art. 3D would need
  pixel-perfect ortho rendering and new art for everything, and would bring nothing a village sim needs that
  2D cannot do. (The `agent-session-world` skill is 3D; we deliberately don't use it here.)

Measured-style budgets (MacBook-class, Chromium/Electron, 1440×900 village pane):

| Scenario | Frame CPU | Steady CPU | Memory |
|---|---|---|---|
| 2×, 40 projects, 400 agents, ~120 actors on screen | ≤ 4 ms | ≤ 2.5% at 10 fps | sprite cache ≤ 48 MB |
| 2×, 1,000 agents, ~300 actors on screen | ≤ 8 ms | ≤ 5% | ≤ 64 MB (LRU by bytes) |
| Map zoom, whole world | ≤ 3 ms (LOD map tiles) | ≤ 2% | |
| Pan or zoom gesture | ≤ 8 ms at 60 fps for the duration | | |
| Cold world build (40 projects / 1,000 agents) | ≤ 300 ms total, ≤ 50 ms per task (yield between settlements) | | |
| Per poll (status change only) | ≤ 3 ms | | |

### 3.2 Depth: per-column slicing with a total sort key

- **Projection** (`core/coords.js`): `sx = (tx - ty) * 16`, `sy = (tx + ty) * 8 - z`. One tile is a 32×16
  diamond, and all coordinates are integers at 1× (decision D2).
- **Slices.** Every static object sprite (building, multi-tile prop, tree canopy) is cut into **screen
  columns 16 px wide**, aligned to the tile half-diagonals (`col = tx − ty`). For the slice in column `c`,
  the object's frontmost footprint cell on that diagonal is `(x, y)` with the largest `x + y`, and the
  slice's **depth** is `d = x + y` of that cell.
- **Sort key** (64-bit packed into a float):
  `key = ((d * 4 + subDepth) * 8 + layerBias) * 2^12 + col`.
  `subDepth` is the actor's sub-tile position (0–3). `layerBias` orders, at equal depth: ground props <
  objects < actors < carried items < effects. This is a **total order**, so it needs no graph and has no
  cycles, and it is stable across frames. Actors sort by their feet `(x + y)` at quarter-tile resolution.
- **Static slices are pre-sorted** into each 16×16-tile chunk's list once per bake. Per frame, only the
  actors (≤ ~300 visible) are sorted, and the chunk lists are merged with a k-way merge of already-sorted
  arrays.
- **Fences and other edge runs** become one slice per tile of the run, so a fence beside a house can never
  draw over the wall (RC4).
- **Tall objects** that rise above their own column (a spire in a 2-tile-wide tower) are still sliced by
  column, and every slice keeps the depth of its own footprint cell. This is the standard isometric slicing
  solution, and it is exact for non-overlapping footprints on a grid. Overlap is impossible by R1.

### 3.3 Layers

| # | Layer | Content | Cached? |
|---|---|---|---|
| 0 | Sea | deep fill, swell | per frame (1 fill) |
| 1 | Ground | terrain, roads, paving, fields, shore, baked decals (flowers, crops, hay), building ground shadows, plot accent edge | **baked chunks** of 16×16 tiles, per style |
| 2 | Water fx | wave glints, wakes | per frame, sparse |
| 3 | World | sorted slices + actors + vehicles + ships + critters | slices cached; merge per frame |
| 4 | Effects | smoke, sparks, leaves, confetti, fountain spray, birds, gulls | per frame |
| 5 | Light | night veil and light pools (lightmap at ¼ resolution, `multiply` then `lighter`) | rebuilt when the light list changes or every 4th frame |
| 6 | X-ray | silhouettes of occluded actors (§3.6) | per frame |
| 7 | Screen-space canvas | status badges, selection marker, crowns (integer-scaled) | per frame |
| 8 | DOM overlay | names, signs, Map plates, PR tags (pure layout function, §6.3) | diffed |

### 3.4 Sprite and atlas caching keyed by style

- `render/sprites.js` holds a `SpriteCache` with `get(key, make)`. `key = model|styleKey|variant|w|h|
  door|lit|site|crown|anim`. `styleKey` is a hash of only the style fields that model reads (§5.4), so a
  plain cottage in two projects with the same family and palette shares one image.
- Entries are `{ img, bounds (true opaque rect), slices[], anchors (door, windows, ridge, chimney, hub) }`.
  The cache is an LRU by bytes (48–64 MB). Eviction never drops an entry used in the last 2 s.
- Generation is budgeted: at most 6 ms of rasterising per frame, and the rest queues. A missing sprite
  draws a low-detail placeholder the same size (a flat-shaded box from footprint and `z`), so the first
  frame never stalls. This replaces the full-sheet "simple renderer" fallback.
- Optional per-style atlas packing for the WebGL path (M8). Canvas2D does not need it.

### 3.5 Chunks, culling and LOD

- **Ground chunks** are 16×16 tiles (512×256 px at 1×), baked lazily for visible chunks plus a 1-chunk
  ring. Open sea is never baked. A chunk is invalidated by world version and block id.
- **Culling** is per chunk (screen rect), then per actor. Off-screen chunks skip the slice merge entirely.
- **Zoom levels.** Integer close-up zooms are 1×, 2×, 3× and 4×, at one canvas px per world px × zoom (as
  today). **Map** is a separate LOD: one pre-rendered "map tile" per chunk at ¼ scale. Buildings are drawn
  from a `mapSprite` (a simplified roof-colour silhouette), actors become 2×2 status dots, and settlements
  show their plate (§6.3). This is far cheaper than drawing full detail at ⅛.
- Zoom transitions cross-fade Map ↔ 1× over 150 ms. Integer zooms snap.

### 3.6 Occlusion handling

1. **Prevent it** (R12): stand, work and sit slots only exist where `cover = 0`.
2. **X-ray for passers-by**: an actor whose sprite rect intersects a slice drawn after it gets a silhouette
   pass in layer 6. The silhouette (1 px light rim plus a faded fill) is clipped to the union of the
   occluding slices' alpha, using one offscreen mask canvas per frame for at most 32 occluded actors. The
   selected or cursor actor uses α 0.9; others use 0.6.
3. **Building fade**: when the selected agent is behind a building or indoors, that building's slices draw
   at α 0.35. Hovering a building's roof for 600 ms does the same ("peek inside": fun).

### 3.7 Day and night lighting

- Light source: `night ∈ [0, 1]` from local time (as now) or `?night=`, with a dusk tint between 18:00 and
  20:00 (a warm orange multiply ramp). There are no seasons in v2 (drop or defer, §7.6).
- **Lightmap**: a ¼-resolution offscreen canvas filled with the night tint, from which light pools are
  erased (`destination-out` radial gradients), then multiplied onto the scene. A warm `lighter` glow is
  added above 0.35. Light sources are objects with `light: { r, warm, flicker }` anchors: lamps, windows
  (from the sprite's window anchors, lit when the agent is home or it is night), forges, the lighthouse
  sweep, dock lamps, and townsfolk lanterns at night.
- **Pool budget**: at most 160 pools per frame (nearest to the view centre first). The light list is
  cached per chunk.

---

## 4. Simulation

### 4.1 Entities and systems

There is a small entity store, not a full ECS framework. Each actor is a plain object
(`sim/actor.js`):

```js
/** @typedef {{
 *  id: string, kind: 'agent'|'folk'|'cart'|'porter'|'critter'|'ship',
 *  agentId?: string, project?: string,
 *  x: number, y: number,        // float tiles (feet)
 *  px: number, py: number,      // previous tick's position (render interpolates)
 *  face: 0|1|2|3,               // iso facings: 0 SE (toward viewer), 1 SW, 2 NW, 3 NE
 *  anim: 'idle'|'walk'|'hammer'|'sit'|'carry'|'wave'|'cheer'|'sleep'|'enter',
 *  frame: number, state: string, path?: Float32Array, pathI?: number,
 *  slot?: { tx: number, ty: number, sub: number }, home?: string, target?: string,
 *  look: LookKey,               // paper-doll parts + palette (§5.5)
 *  status?: { bucket, severity, prompt, role, important, stopped },   // from the snapshot, for badges
 *  flags: number,               // VISIBLE | SELECTED | OCCLUDED | INDOORS | GHOST …
 * }} Actor
 */
```

Systems run in a fixed order each tick (`sim/world-sim.js`): `snapshot → intent → behaviour → movement →
slots → animation → events`.

### 4.2 Behaviour from agent status

Readability rule: **an agent's status must be readable from its pose and place within 2 s, and stalled or
error agents never wander**.

| Bucket | Where | Pose and animation | Fun extras |
|---|---|---|---|
| building (live PR) | the PR site's work anchors (≤ 4 per site), else its own forecourt | hammer (with sparks), or carry crates between the site's yard and scaffold | the scaffold rises with build progress; a bell on PR merge |
| building (no PR) | its home's work anchor (a workbench, woodpile or anvil prop by the forecourt) | hammer or saw | chimney smoke |
| waiting | a sit anchor near home: a bench, fountain rim or doorstep | sit, with an idle look-around every 6–10 s | the cat may come and sit by it |
| stalled: needs you | its own forecourt, facing the viewer, `cover = 0` guaranteed | stand, bob, wave every 4 s | badge bob as now |
| stalled: prompt (click) | same | wave both arms | |
| stalled: error | same | stand, and a puff of dark smoke over the badge | |
| resting | indoors (window lit; zZ at night) | — | an Important or stopped agent stays on its doorstep, faded (as now) |
| resting with PRs loading | **porter**: home → crate yard → its ship → home (dock rules kept, CAP 6) | walk and carry | waves at the ship as it sails |
| sub-agent (`sub`, not a home owner) | slots in the parent's yard (nearest free) | as its bucket | ninja look (kept as a palette, not a sheet) |

**Transitions**: when the bucket changes, the actor gets a route (home ↔ site ↔ bench). It walks if the
route is ≤ 40 tiles, motion is allowed and the actor is on screen; otherwise it teleports with a 0.3 s fade.
A walk longer than 6 s is cut short with a fade-out and fade-in at the target (decision D4).

### 4.3 Townsfolk routines

Each settlement gets `n` townsfolk by tier (2/5/10/18, as now). Each one has a home door (a townsfolk house
lot) and a **day schedule** built deterministically from `rng(projectSeed, i)`:
`home → market stall (shop) → plaza bench (sit) → square (chat in pairs) → home`, with dwell times of
20–90 s. At night most go home and 20% walk with lanterns. Vendors stand at `vend` anchors in daytime.
Townsfolk use flow fields to plazas and the road graph between settlements: they **can visit other
settlements and the town square**, which makes the town feel like one place.

### 4.4 Carts, the dock and critters

- **Carts**: a looping route on the road graph through the settlement's main streets and the square. They
  reserve cells ahead, pause at intersections for 1–2 s, and park at the market at night.
- **Dock**: `dock-art.js` geometry and ship lifecycle are reused (harbour tier by load with hysteresis,
  ship class by PR size, berths, cast-off and sail-out, tug, lighthouse, gulls, rowboats). Porters are
  ordinary actors on the nav service, and the dock nodes (yard, pier heads, berths) join the road graph.
  `dock-walk.js` routing is replaced. Its policy (who carries, CAP 6, drop and pick times, rest at home) is
  ported verbatim into `sim/behaviours/porter.js`.
- **Critters**: chickens wander inside pen regions (pasture or yard cells flagged `critter`), the cat lives
  on the town square, and pigeons hop on squares and scatter when a walker passes within 1 tile (fun, and
  cheap).

### 4.5 Tick and render, and determinism

- **Sim tick**: a fixed 10 Hz (`dt = 0.1 s`), driven from the frame loop with an accumulator. At most 3
  catch-up ticks run per frame. If more are owed (the tab was hidden), the sim **fast-forwards by schedule**
  (it recomputes positions from route progress) instead of stepping.
- **Render**: on demand. It runs at 10 fps while anything animates (8 today; 10 is a slightly smoother walk
  at a similar cost), at 60 fps during pan, zoom or tweens, and draws once for a static scene. It pauses
  when the village is hidden (`active()` rules kept). Positions are interpolated from `px, py → x, y`.
- **Reduced motion and offline**: the sim stops, actors snap to their slots, and every animation shows its
  frame 0 (today's "still" rule).
- **Determinism**: build and sim are pure functions of (snapshot sequence, persisted plan, seed, tick
  count). `?t=<seconds>` pins the sim clock, and `?seed=` overrides the world seed. The capture harness
  uses both, so screenshots are reproducible.
- **Events** (`sim/events.js`) turn snapshot diffs into world moments, each with a short animation and no
  UI change: PR merged (the ship sails, the porter waves, a bell and confetti on the plaza), a new project
  (a founding cart arrives and scaffolds go up over 20 s), a tier-up (scaffolding on the new buildings for
  30 s), a crown gained (a banner unfurls on the palace), an agent going stalled (it walks out of the door,
  then the badge appears).

---

## 5. Art pipeline

### 5.1 One grid, outline, palette and light

- **Pixel grid**: 2:1 iso with a 32×16 tile diamond. Every line on the ground plane uses 2:1 steps. Every
  sprite is authored at 1× and only ever drawn at integer zooms.
- **Light**: from the upper left of the screen (south-west, above), at the vector iso.js already uses (`L =
  [-0.55, 0.62, 0.56]`). South faces are lit, east faces in half shade, shadows fall to the east (north-east
  on the ground). Ground shadows are baked into chunks as soft 2:1 parallelograms.
- **Ramps**: every material is a 5-tone ramp with hue shifting (shadows toward indigo `#2a1c4a`,
  highlights toward warm `#fff0b0`). This is unchanged, but moves into one shared `art/palette.js` instead
  of three copies.
- **Outline**: 1 px, tinted by the colour it outlines (never flat black). Interior edges get a softer line.
  Actors keep the "sticker" rim (1 px ink plus a 2 px light rim).
- **Value tiers** (from the v2 art direction): terrain muted < nature < buildings < actors < status badges,
  which stay the loudest. **Reserved hues**: badge fills (amber `#f5a623`, red `#e5383b`, violet `#9b5de5`,
  green `#2f9e5b`, blue `#3d7be0`) may not appear at high saturation in roofs, awnings or banners. The style
  pool validator enforces this (§5.4).

### 5.2 Sprite definitions as data

The building kit in `iso.js` already models buildings from faces with materials. v2 makes that a data
schema, with `art/models/<model>.js` exporting:

```js
export default {
  id: 'timber', footprints: [[3, 3], [4, 3]], parts: [   // storeys, roof, chimney, porch, dormers, sign, flowerboxes
    { part: 'storey', h: 14, wall: 'style.wall.lower' }, { part: 'jetty', h: 14, wall: 'style.wall.upper', overhang: 2 },
    { part: 'roof', shape: 'gable', pitch: 'style.roof.pitch', mat: 'style.roof.mat' }, { part: 'chimney', at: 'east' },
  ],
  anchors: ['door', 'windows', 'ridge', 'chimney', 'work', 'sit'],
  reads: ['family', 'wall', 'roof', 'trim', 'window', 'door', 'accent'],   // → styleKey (§5.4)
};
```

The rasteriser (`art/raster.js`, extracted from `iso.js make`) turns faces, solids and materials into an
auto-sized RGBA buffer and returns true bounds plus anchors (R8). `iso.js` stays as the implementation for
models not yet ported. The adapter calls it with `s = 1` (the new projection) and measures bounds from the
pixels.

### 5.3 Debug sprite sheet and visual regression

- **Sprite sheet page**: `?engine=2&artsheet=1` (dev only, built on the artpass `dev/art-sheet.js`). It
  shows a grid of every model × style family × {day, night-lit} × {plain, crown}, every prop, every actor
  look × facing × animation frame, and the ground tiles per paving style. Each cell shows its true bounds
  and anchors as an overlay when `&anchors=1` is set.
- **Capture harness**: extend `tools/artpass/capture.mjs` with `--engine 2`, `--t <sec>` and `--seed`.
  Fixtures are frozen snapshots in `e2e/fixtures/engine/*.json`: citydemo (4 tiers), a busy real-shaped
  world (40 projects / 400 agents), a 1,000-agent stress world, a harbour at tiers 1–4, and night. It runs
  headless and hidden, never a visible window.
- **Golden diffs**: per milestone, a set of crops (whole town at 1×, each tier at 3×, harbour, night,
  sheet pages) is compared with pixelmatch (threshold 0.1, ≤ 0.2% pixels). Goldens live in
  `test-artifacts/engine-golden/` (git LFS or a local path; decision for M0). Every milestone ships a
  screenshot set for maintainer review.
- **Machine invariants** (`test/engine-invariants.test.mjs`, node, no browser) run on every fixture:
  1. No blocking object footprints overlap. No object is outside its block.
  2. Every door forecourt is walkable, `cover = 0`, and connected to the road graph.
  3. No stand, sit, work or vend anchor is on a blocked or covered tile.
  4. Simulate 600 ticks: no actor's feet are ever on an `occ` tile or cross a blocked edge (**the
     walk-through test**). No two stationary actors share a sub-slot.
  5. Sort-key order equals a brute-force painter's reference on 10,000 random small scenes.
  6. Every sprite's opaque pixels are inside its buffer with at least a 1 px transparent border (the
     clipping test, against spire fragments), and its anchors are inside its bounds.
  7. Style pool: every seed 0..9999 yields a valid combination (§5.4), and reserved-hue distance holds.
  8. Stability: replaying a 50-poll snapshot sequence never moves an unchanged block or lot.

### 5.4 Per-project style pools

Every project to have slightly different buildings, streets and people, generated from a
pool. city4 is building `web/src/styles-pool.js` exporting `styleFor(projectKey) → plain data` (6 families:
timber, mediterranean, stone, alpine, canal, thatch). **v2 imports it and extends it, and never replaces
it.**

`art/style.js`:

```js
import { styleFor } from '../../styles-pool.js';
/** The full v2 style tuple for a project: city4's base plus the street and people axes, all deterministic. */
export function projectStyle(projectKey) -> StyleTuple
export function styleKeyFor(style, reads /* field names a model reads */) -> string   // hash of just those fields
export function validateStyle(style) -> string[]   // [] when valid; used by tests over seeds 0..9999
```

```js
/** @typedef {{
 *  key: string, family: 'timber'|'mediterranean'|'stone'|'alpine'|'canal'|'thatch',   // from styleFor()
 *  wall: { lower: Mat, upper: Mat, paint: Rgb }, roof: { mat: 'tile'|'slate'|'shingle'|'thatch'|'terracotta'|'lead', color: Rgb, pitch: 'low'|'mid'|'steep', eaves: number },
 *  trim: Rgb, window: 'square'|'arched'|'leaded'|'tall', door: 'plank'|'arched'|'panelled', shutters: Rgb|null,
 *  accent: Rgb,                          // the project accent (doors, banners, awnings, flags)
 *  street: { paving: 'earth'|'gravel'|'cobble'|'flagstone'|'brick'|'sett', pattern: 'running'|'herringbone'|'fan'|'random', kerb: boolean,
 *            lamp: 'woodpost'|'ironlantern'|'brassglobe'|'stonepillar', tree: 'oak'|'birch'|'apple'|'cypress'|'olive'|'pine'|'larch'|'willow', hedge: boolean },
 *  folk: { clothes: Rgb[4], headwear: ('none'|'hood'|'cap'|'straw'|'kerchief'|'feather')[], skin: Rgb[], apron: number },
 *  banner: { shape: 'swallowtail'|'pennant'|'square', motif: 'plain'|'chevron'|'stripe'|'cross' },
 * }} StyleTuple
 */
```

**Generation**: `projectStyle` takes `styleFor(key)`. Fields city4 does not produce are filled in by
weighted picks from `rng(hash(key) ^ AXIS_SALT[axis])`, one salt per axis, so adding an axis later never
changes the existing ones.

**Coherence rules** (one table, `art/style-rules.js`). Picks are made in this order: family → roof → wall →
paving → lamp → tree → folk. Each later axis is filtered by the earlier ones:

| Family | Roof mats (pitch) | Walls | Paving (town+) | Lamp | Trees | Folk palette band |
|---|---|---|---|---|---|---|
| timber | tile, shingle, slate (steep) | plaster + dark beams, clapboard | cobble, sett | ironlantern | oak, birch, apple | earthy greens and browns |
| mediterranean | terracotta (low, hipped) | lime plaster, cream render | flagstone, fan sett | brassglobe | cypress, olive | whites, ochres, sea blues |
| stone | slate (steep) | fieldstone, ashlar | flagstone, sett | stonepillar | pine, birch | greys, wool blues |
| alpine | shingle, slate (low, deep eaves) | white plaster + dark timber | gravel, cobble | woodpost | pine, larch | reds, forest greens, white |
| canal | tile, slate (steep, stepped gables) | red or brown brick | brick (herringbone) | ironlantern | willow, birch | navy, mustard, cream |
| thatch | thatch (round) | cob, warm render, logs | earth, gravel | woodpost | apple, oak | straw, russet, moss |

- **Tier override**: a hamlet always gets earth or gravel paving and woodpost lamps, a village gets gravel
  or cobble, and from town up the family's paving applies. Growth reads as a change of materials too.
- **Value rules**: a roof's value stays within the building tier. Roof and awning saturation is ≤ 0.55 in
  the reserved badge hues (hue distance < 18° from a badge fill). The accent is used at full strength only
  on banners and flags, and muted 40% on doors and shutters.
- **Neighbour rule**: two adjacent blocks with the same family get different roof colour and paving
  pattern. This is decided at build time from the block adjacency, never by re-rolling the project style.

**Caching** (§3.4): every model declares `reads`, and `styleKey = hash(pick(style, reads))`. Ground chunks
are keyed by `chunk|worldVersion` and read each tile's settlement paving at bake time. Actor looks are keyed
by `parts|palette`.

**Crown manors and landmarks**: the `palace` model (city4) reads `family, wall, roof, trim, window, door,
accent`. An alpine palace is a wide-eaved chalet-manor with a turret, and a canal palace is a tall
stepped-gable merchant house with a tower. `crown: true` adds gilded finials and cresting, an accent banner
on the tower, a crest over the door, and lit lanterns at the entrance. Landmarks (chapel, guildhall, clock
tower, market hall, cathedral, windmill, inn, smithy) keep their **silhouette** for recognisability, but
take `wall`, `roof.mat`, `trim` and `window` from the style: a mediterranean chapel has a bell arch and
terracotta roof, a stone chapel a slate spire. The town square (shared by all projects) uses a fixed
"capital" style.

### 5.5 People

Villagers become **paper-doll sprites** generated in code (`art/folk.js`), 16×24 px with 4 iso facings
(SE, SW, NW, NE) × the animation set (idle 2, walk 4, hammer 2, carry 4, sit 1, wave 2, cheer 2, sleep 1).
Parts are body (2 builds), skin, hair (6), clothes (tunic, dress, robe, apron, coat), headwear and a held
item (hammer, crate, lantern, basket). Agents get stable looks from `hash(agentId)` within their project's
folk palette. A boss gets a crown and cape in the accent, a sub-agent a hooded "ninja" palette (keeping
today's recognisable cue), and townsfolk get the project's folk band. The look is cached per `parts|palette|
facing|frame`, so about 2–4k tiny sprites, ≤ 6 MB. This also fixes RC9: actors face the iso directions.
Ninja Adventure sheets stay loaded only as the fallback until the paper-doll set passes review (D3).

---

## 6. Integration contract

### 6.1 The engine has the same API as `createVillage`

`web/src/engine/index.js` exports `createEngine(app)`, which returns **exactly** the object `createVillage`
returns today, so `main.js` changes by one line:

```js
const village = (useEngine2() ? createEngine : createVillage)(app);
// useEngine2(): ?engine=2 | ?engine=1 overrides; else store.get('va.engine', 1) === 2 (Settings → "Village engine: Classic / New (beta)")
```

| Method | Contract (unchanged) |
|---|---|
| `update({ loading, offline })` | Called every poll. Reads `S.agents`, `S.byId`, `S.data.projects`, `S.dock`, `S.hideQuiet`, `S.reduceMotion`, `S.panel`, `S.peek` |
| `setSelected(id, { pan })` | Select an agent (brings a quiet project back, centres on the agent when the panel allows) |
| `setActive()` | Start or stop the loop by visibility (hidden, full panel, peek, `village-only`) |
| `refit()` | Fit the whole town again unless the user moved the camera |
| `key(k)` | `+`, `=`, `-`, `0` |
| `showAllTags(on)` | Alt held |
| `setBubbles(on)` | Labels and status bubbles toggle (`bubbles.js`) |
| `camera()` / `setCamera(c)` | `{ x, y, z }`: the terminal view saves and restores it. v2 stores world-tile coordinates; `setCamera` accepts both formats (`c.v === 2` marks v2) |
| `debug()` | `villageDebug()` for e2e: keeps the existing fields (`zoom`, `cam`, `outdoors`, `homes`, `badges`, `hits`, `villages`, `dock`, `items`, `townWater`, `depthCheck`) and adds `grid`, `actors`, `lint`, `perf` |

The engine calls into the app the same way as today: `app.select(id, { fromVillage, pan })`,
`app.menu(id, { x, y } | { el })`, `app.activate(id, { x, y })`, `app.setHideQuiet(false)`, and it
dispatches `window` `va:dock` with `{ href }` for the dock and ship panel (`dock.js` is unchanged). DOM it
uses: `#village`, `#cv`, `#labels`, `#quiet-note`, `#zoom-in`, `#zoom-out`, `#zoom-reset`, and the `.zoom`
group (where the bubbles and zen buttons live). Storage keys kept: `va.seen`, `va.cam.iso` (v2 writes
`va.cam.e2`), `va.bubbles`.

The left panel, terminals, peek, zen mode, dock panel, context menu and broadcast **are not touched**.

### 6.2 Inputs from the snapshot (read-only)

Agents use `id, name, project, bucket (stalled|waiting|building|resting), severity, prompt, role
(boss|lead|sub|…), parentId, prs[{id}], live, hidden, important, since, lastActivityAt`, plus
`folds/pinned/stoppedNote` from `important.js`. Projects use `name, prs[{id, live}], transcriptBytes,
agentsEver`. The dock uses `loading[{href, checks, review, size}], sailed[{href}], total, level`. The
engine adapts all of this into one internal `SnapshotView` in `engine/snapshot.js`, the only file that
knows the server's shape, so server changes touch one file.

### 6.3 What the engine exposes internally (overlay seams)

- **Hit list**: each frame produces `hits: Array<{ id, kind: 'agent'|'house'|'dock'|'ship'|'village',
  rect: [x0, y0, x1, y1] (CSS px), z }>` in front-to-back order. Picking walks it, and a slice's hit is its
  object's.
- **Label layout** is a pure function `layoutLabels(cands, blockers, viewport) → placed[]` in
  `overlay/labels.js`, ported from `placeLabels` with its priority order: selected > cursor > hover >
  village signs > stalled (errors first, then the longest waiting) > PR numbers > crowds > Alt. The rules
  for overlap, slide-to-side and badge-blocking are kept. Bubbles-off keeps only hover, selected and
  cursor, as now.
- **Badges** are canvas layer 7, anchored at the actor's head anchor plus the boss offset, drawn at max(2,
  zoom), with their rects fed to `layoutLabels` as blockers.
- **Camera API** (`engine/camera.js`): `fit()`, `centerOn(worldPt, animate)`, `setZoom(z, anchorCss)`,
  `toWorld(css)`, `toScreen(world)`, and `clamp()`. Map fit levels (½, ¼, ⅛), auto-fit until the user moves
  the camera, and the 300 ms cubic tween are all kept.

---

## 7. Migration plan

### 7.1 Build alongside, behind a flag

- All new code lives in `web/src/engine/**`, plus `art/` models. Classic files are read and imported
  (`city-plan.js`, `styles-pool.js`, `dock-art.js` geometry, `iso.js` raster) but **not edited** by engine
  work until M7, except for one small seam each: an `s` (projection scale) parameter in `iso.js`,
  `props-art.js` and `dock-art.js`, defaulting to 0.8 so classic is pixel-identical.
- Flag order: `?engine=2` (M0–M4) → Settings toggle "New (beta)" (M4) → default on (M7, after the parity
  checklist is signed off) → classic removed (M7 + 2 weeks).

### 7.2 Feature-parity checklist (current village, all features)

Camera and view
- [ ] Map fit level (½, ¼, ⅛ that shows the whole town and harbour); zooms 1–4×; wheel zoom anchored at the pointer; drag pan with a 4 px threshold; camera clamp to land + 10 tiles
- [ ] Persisted camera; first-data home fit; auto-refit while the town changes until the user moves; refit after a peek resize; fit waits while hidden
- [ ] Zoom buttons, the reset button, and keys `+ = - 0`; the terminal view saves and restores the camera; centerOn selected (tween 300 ms; instant with reduced motion)
- [ ] Loop: 8 fps only while visible and animating, on demand otherwise; stops when hidden, under a full panel, or zero-width; peek and `village-only` count as visible

World and layout
- [ ] One town: a central square (big tree, 4 lanterns, cat), project blocks placed compactly around it, 2-wide shared streets, ring roads, A* roads to the square, forest belt, shore, sea, wave glints, lakes filled, no 1-tile spits
- [ ] Quiet projects hidden (note "N quiet projects hidden · Show"); the selected agent's project always shown; hidden blocks become parks for 14 days; vanished buildings hold their lot for 12 h
- [ ] Tiers hamlet/village/town/city with hysteresis; capacity buckets; tier, capacity or crown changes re-plan only that plot; persisted layout (`va.world8/9` → imported)
- [ ] Lot ranks L/M/S; boss and Important → L; leads → M; resting-home cap 2; PR caps (6 live, 3 done); free lots are townsfolk houses; civic landmarks per tier
- [ ] Per-neighbourhood accent colours (distinct from neighbours); plot accent edge line; banners on plazas; flags on home ridges in the accent
- [ ] city4: per-project styles (`?citystyle=N`), crown palaces (`it.crown` follows the boss)
- [ ] Debug params: `?citydemo=1`, `?citytier=N`, `?dockdemo=1&prs=&level=`, `?night=0|1`, `?debug` (`villageDebug`)

Buildings
- [ ] Every look (farmhouse, cottage, timber, townhouse, manor, palace, hall, barn, windmill with turning sails, granary, chapel, smithy with forge glow, inn, guildhall, clocktower, markethall, cathedral, legacy house and tower looks)
- [ ] Lit windows when the agent is home or at night; zZ on resting homes at night; chimney smoke (home while hammering, resting homes, a few townsfolk houses; ≤ 6 puffs on screen); PR building site (scaffold, crate, dust)
- [ ] Selected home outline when the selected agent is indoors or in the crowd; building ground shadows

Villagers
- [ ] Looks per agent (stable by first-seen order); boss look plus crown; Important star; stopped Important faded on the doorstep; subs in ninja looks
- [ ] Poses: stand, sit (on a log → bench or anchor in v2), hammer (sparks, badge hammer synced), carry (crate shuttle); stalled bob; ≤ 4 builders per PR site; yard cap and "+N more"
- [ ] Resting = indoors; selected-but-indoors ghost at the door; x-ray silhouette behind buildings; selection marker; sticker rim and white rim when selected
- [ ] Status badges need/error/click/build/wait, screen-space at max(2, zoom), loudest value tier; badges hidden with bubbles off except hover, selected and cursor

Labels and input
- [ ] DOM labels with priority, overlap avoidance and slide; village signs; Map plates with counts (prompt, error, stalled, waiting); PR numbers at zoom ≥ 3; ship PR tags; crowd tags; Alt shows all tags
- [ ] Click to select; double-click to open the terminal (`app.activate`); right-click and long-press menu; keyboard ←/→ cycles by bucket order, Enter selects, ContextMenu and Shift-F10 open the menu; hover cursor state; on Map, clicking a village zooms in; dock and ship click → `va:dock`; dock hover outline
- [ ] aria-label summary (counts plus cursor agent); `cv.dataset` (art, villages, zoom)

Ambient life
- [ ] Townsfolk walkers by tier (2/5/10/18) with night lanterns (20%); vendors at stalls; carts in towns and cities; chickens in hamlet and village yards; pigeons on squares; fountain sparkle; a V of birds every 40 s; falling leaves

Night
- [ ] Night amount by local time (20:00–06:00 full, ramps 18–20 and 06–08) or `?night`; veil with light pools (lamps, windows, doors, work lamps, plazas, square, villagers, dock); warm glow

Harbour
- [ ] Tiers 1–4 by PRs loading with a 10-minute shrink hysteresis; cove reserved for tier 4; ship class by PR size; berths, at-anchor overflow; cast-off stagger and sail-out; tug; lighthouse sweep; beacon; gulls; rowboats; cranes; crate yard; warehouses; level touches (lamps, warehouse, crane, flag)
- [ ] Porters (resting agents with PRs loading; townsperson fallback; CAP 6; drop and pick times; head home when the ship sails); `dockTags`; `dock.debug`

Tests and debug
- [ ] e2e `world.spec`, `village.spec` pass against `?engine=2` (adapted selectors); `depthCheck` and `flagCheck` are replaced by invariants 4–6; `townWater = 0`; `items[].wet = 0`

### 7.3 Milestones (each shippable behind the flag and reviewed from screenshots)

| M | Name | Delivers | Review set |
|---|---|---|---|
| **M0** | Foundations | `engine/` skeleton, `createEngine` stub (sea plus a "new engine" note), `coords.js`, `snapshot.js`, fixtures, the harness `--engine 2 --t --seed`, invariant test scaffold, `useEngine2()` flag in `main.js` | harness smoke screenshot |
| **M1** | World grid | `WorldGrid`, `sites.js` port, `plan-adapter` with footprints and prop legalising, `lots.js`, persist and import from `va.world9`; debug render: flat-coloured tiles plus walkability and `cover` heatmaps (`&grid=1`) | each tier at 3× as a coloured grid; the lint list |
| **M2** | Static town | Ground chunks (32×16 projection, paving per style), `raster.js` with true bounds, slicing and depth, `SpriteCache`, buildings, props, trees, banners and flags; night lightmap; Map LOD tiles | whole town 1×, each tier 3×, night, sprite sheet; **fences never through buildings, no clipped spires** |
| **M3** | Life | Actor store, nav (grid A*, road graph, flow fields, slots), agent behaviours by bucket, townsfolk routines, carts, critters, x-ray, building fade | 30 s capture GIFs per tier; invariant 4 (walk-through) green on 600 ticks |
| **M4** | Playable parity | Camera, input, hit list, `layoutLabels`, badges, bubbles, Alt, keyboard, ghost and indoors, quiet note, `debug()` parity; Settings toggle "New (beta)" | used for a day; parity checklist ≥ 90% |
| **M5** | Harbour | Dock adapter on the new projection, porters on nav, ships and tiers, dock click and tags | harbour tiers 1–4, day and night |
| **M6** | Style and people | `projectStyle` (street and folk axes over city4's `styleFor`), paper-doll villagers, palace and landmark style pickup, world events (merge confetti, founding, tier-up scaffolds) | sprite sheet per family; 6 projects side by side |
| **M7** | Switch | Parity checklist 100%, perf budgets met on the 1,000-agent fixture, default on, classic kept behind `?engine=1` for 2 weeks, then classic files removed | final go/no-go audit |
| M8 (optional) | WebGL2 backend | Only if M7 budgets are missed: `gfx-webgl.js` behind the same `Gfx` interface, atlas packing | perf report |

### 7.4 Risks

| Risk | Mitigation |
|---|---|
| Projection change (D2) makes everything 25% bigger at the same zoom and changes the look | M2 screenshot review before any further work; fallback is `s = 0.8` kept with integer-snapped slices (worse pixel grid, same engine) |
| Planner props fight the grid rules (many drops in lint) | `plan-adapter` legalises and lints; fixes go to `city-plan.js` through the city-plan owner, not the engine |
| Paper-doll villagers lose the charm of the Ninja sprites | Keep Ninja as the fallback; review at M6 (D3) |
| The 1,000-agent stress world misses frame budgets in Canvas2D | Chunk merge and culling first; M8 WebGL2 behind the same `Gfx` |
| Two engines diverge while classic keeps changing (city4, harbour work) | Engine imports classic pure modules (`city-plan`, `styles-pool`, `dock-art` geometry) rather than forking them; the M4–M7 window is kept short |
| Persisted layout import goes wrong and the town reshuffles | `importClassic` is tested against real-shaped `va.world9` fixtures; classic keys are never written by v2 |
| Electron and Chrome show different towns (separate localStorage) | Decision D5 |

### 7.5 What to drop

- The procedural "simple renderer" fallback (art is code now; the placeholder box in §3.4 covers cold frames).
- `isoSort` topological sort, `wildIso`/`wildNear` and the `nearBuilding` heuristic; `depthCheck` and `flagCheck` (replaced by invariants).
- `YARD` pixel offsets, `YARD_CAP`, `free()` and `ground()` sampling; `stroll()` rect wandering; `ambient.js makeRoute`; `dock-walk.js roadRoute`.
- The `R` sprite table and its compatibility shim; the `LOOKS` and `NINJAS` sheet lists (after M6); copied constants in `ambient.js`.
- Runtime ground skewing with smoothing on.
- Seasons, weather, interiors and any 3D: deferred, not in scope.

---

## 8. Open decisions

1. **D1 Renderer: Canvas2D first, with a WebGL2 option later?** *Recommendation: yes.* Canvas2D already
   meets today's budgets, the `Gfx` seam keeps WebGL2 a contained M8, and 3D is out.
2. **D2 Pixel grid: move from the soft 0.8 projection (25.6×12.8 px tiles) to a true 32×16 iso tile?**
   *Recommendation: yes.* It is the main fix for blur, seams and jitter, and makes slicing exact. The cost
   is that everything looks 25% bigger at the same zoom, so the default zoom steps go down one notch.
3. **D3 Villagers: replace the Ninja Adventure sheets with code-drawn paper-doll villagers (4 iso
   facings, per-project clothing pools)?** *Recommendation: yes, at M6*, with the Ninja sheets kept as a
   fallback until you have approved the new set. Per-project people styles need it, and today's sprites
   face the wrong directions in iso.
4. **D4 Should villagers physically walk when their status changes** (home → PR site → dock) instead of
   teleporting? *Recommendation: walk when the trip is short and on screen (≤ 6 s), fade otherwise.*
   Stalled and error villagers never wander, so status stays readable.
5. **D5 Should the town layout be saved on the server** (`~/.config/agentville`) instead of in each
   browser's localStorage, so Electron and a Chrome tab show the same town? *Recommendation: yes, at M7*
   (a small `GET/PUT /api/world-plan`). Until then, v2 imports the classic layout so nothing reshuffles.
