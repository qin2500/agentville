# Village art audit (2026-11-13)

Note: this audit covers the city planner (`city-plan.js`), the harbour and `props-art.js`, so some of
the commands and file names below only apply once those modules are on the main branch.

A close-up pass over everything the village draws, made as a **requirements input for future renderer
work**. Nothing in the renderer was changed. Each finding records what, where, the evidence, and the
**root-cause class** in the current architecture, so a later rewrite can rule the class out by
construction rather than patch instances.

Scope looked at: every growth tier (`?mock&citydemo=1`, `?mock&citytier=0..3`), day and night, the
harbour at 3/6/10/16 PRs, the big mock (`?mock=big`), an animated time-lapse of the city square, and
every building look and procedural prop in isolation (sprite sheet). Not looked at closely: the Map
zoom levels (< 1x), the simple fallback renderer, DOM labels, and the legacy sprite-era looks beyond
one sheet page each.

## How to re-run the captures

The harness is reusable as a visual regression check for renderer changes. It runs a hidden headless
Chromium against a vite dev server with the dev mock API: no visible window, no real sessions, no
network.

```sh
# 1. dev server (own port 5391 and own cache dir; never the app's port)
node_modules/.bin/vite -c tools/artpass/vite.config.mjs &

# 2. town tiles: overview.png + r<row>c<col>.png + index.json under /tmp/artpass/<tag>/
node tools/artpass/capture.mjs --q 'mock&citydemo=1' --tag demo --zoom 3            # whole demo town
node tools/artpass/capture.mjs --q 'mock&citydemo=1' --tag city --only City --zoom 3 --no-overview
node tools/artpass/capture.mjs --q 'mock&citydemo=1' --tag night --only City --zoom 3 --night
node tools/artpass/capture.mjs --q 'mock&citytier=3' --tag tier3 --zoom 2
node tools/artpass/capture.mjs --q 'mock&dockdemo=1&prs=16' --tag dock16 --dock --zoom 2
node tools/artpass/capture.mjs --q 'mock=big' --tag big --zoom 1

# 3. walkers: a time-lapse of one view with animation on
node tools/artpass/capture.mjs --q 'mock&citydemo=1' --tag walk --only City --zoom 2 --anim --frames 6 --every 2500

# 4. sprite sheet: every building look x variant and every prop, isolated, 3x (66 pages)
node tools/artpass/capture.mjs --sheet --tag sheet [--night]

# 5. walk-through audit of the plans (no browser): what stands on tiles walkers treat as free
node tools/artpass/walk-audit.mjs 20
```

Flags: `--zoom N` (real app zoom 1-4), `--only <settlement>`, `--region x0,y0,x1,y1` (view px),
`--dock`, `--night`, `--anim` (default is reduced motion, so frames are deterministic), `--labels`
and `--bubbles` (both hidden by default so they don't cover the art), `--vw/--vh`, `--out`.
Pieces: `tools/artpass/capture.mjs`, `tools/artpass/vite.config.mjs`, `tools/artpass/walk-audit.mjs`,
`web/src/dev/art-sheet.js` (dev-only, `?mock&artsheet`), and one debug hook in `web/src/main.js`
(`window.villageSetCamera`, only with `?debug`).

The evidence references below (`artpass-NN`) name screenshots from the original pass. They were
temporary and are not kept; regenerate equivalents with the commands above (tile sets land under
`/tmp/artpass/<tag>/`).

## How things are drawn and moved today (the parts that cause the findings)

- **Depth order** (`world.js` `isoSort`): every drawable has a ground footprint and a screen rect;
  overlapping pairs are ordered by footprint, then a topological sort. Buildings have a real footprint
  box. **Everything else is a single point**: villagers, trees, lamps, and every procedural prop
  including multi-tile ones (a fence run of up to 7+ tiles, a 2x2 fountain, a 2x1 stall) sort by their
  foot point only (`world.js` draw: `pt(...)` for `p.pk`).
- **Occupancy**: there is no shared occupancy or collision grid. `W.fp` holds building footprints,
  `W.path` holds walkable ground codes, `W.occ` only keeps the forest out. Props are not in any of them.
- **Who walks how**:
  - *Townsfolk* (`ambient.js` `makeRoute`): a random walk over tile centres of any ground code in
    `WALK` (street, lane, plaza, market, yard, bridge), out and back, with a +/-2.5 px offset. It never
    consults props or footprints.
  - *Agents and crews* (`world.js` `placeAgents`): fixed spots by the door (`YARD` offsets); a spot is
    accepted if it is on a walkable tile, off footprints, and not within ~20 px of another taken spot.
    Props are not checked. Carriers shuttle +/-3 px around their spot.
  - *Strollers* (`world.js` `stroll`): the square's cat and each plaza's chicken move in straight lines
    between hashed points in a rectangle; `ambient.js` chickens do the same in a 2x2-tile box. No
    obstacle test at all.
  - *Dock porters* (`dock-walk.js` `roadRoute` + `tripLine`): a 4-way Dijkstra over tiles that are land
    and off footprints (roads cost 1, anything else 6). Canal tiles inside a plot count as land, fields
    and gardens are just "off road", and props and fences don't exist for it. The last legs (yard pick
    point, quay, pier) are straight segments with no test.
  - *Cart* (`ambient.js`): slides along the longest east-west street run; no test.
- **Plans** (`city-plan.js`): props are emitted by local rules with no check against footprints or
  against each other; farmland fences are the clearest case (below).
- **Art sources**: three unrelated ones share the screen. (1) `iso.js`, `props-art.js`, `dock-art.js`:
  code-drawn, true 2:1 iso, 5-tone hue-shifted ramps, tinted 1 px outline, light from the south-west.
  (2) Ninja Adventure sprites (trees, bushes, flowers, cart, barrel/crate, laundry, scarecrow, log,
  chicken, cat, villagers): top-down RPG perspective, own palette, heavier dark outline, re-toned with
  CSS filters. (3) Hand-placed `fillRect` art in `world.js` (street lamp, banner post) with flat
  near-black ink.
- **Ground**: baked in 48x48-tile chunk canvases and drawn through the iso transform with image
  smoothing on.

## Catalogue

Severity: **A** = plainly wrong at 2-4x, **B** = reads as sloppy, **C** = polish.

### 1. Depth sorting and layering

| # | Sev | What and where | Evidence | Root-cause class |
|---|-----|----------------|----------|------------------|
| 1.1 | A | Fences come out of buildings: a fence run starts inside the windmill, the barn and the granary and continues out the other side (hamlet and village, every seed). | `artpass-02`, `-03`, `-04`, `-01` | Two classes at once. **Placement without collision**: `farmland()` lays the x-direction fence across the whole parcel width and never tests footprints (the y-direction fence does, via `freeCol`). `walk-audit.mjs`: fence tiles inside a footprint in 20 of 60 hamlet plans and 61 fences over 60 village plans. **Single-point sort of a multi-tile object**: the run sorts by its first tile, so where it is in front of or behind a building is decided once for the whole length. |
| 1.2 | A | A fence run drawn over the haystack, beehive, hut or trough it passes (hamlet, village). | `artpass-01` (hive at the fence end), `-04` | Single-point sort for multi-tile props; props placed on each other with no occupancy check. |
| 1.3 | B | Trees appear inside building sites; two adjacent sites read as one tangle. | `artpass-06`, `-03` | The site scaffold is a see-through sprite over a full footprint, so whatever sorts behind it shows through the middle. A site needs an opaque base or its own occluder. |
| 1.4 | B | Roofs of neighbouring houses overlap each other's walls in the village centre; a granary hut vanishes behind the barn. | `artpass-04` | Sprites with geometry outside their footprint (eaves, roof rise) packed with 0-1 tile gaps; the plan has no notion of a sprite's screen extent. |
| 1.5 | B | Villagers "painted" on roofs, chimneys and the clock tower. This is the hidden-villager silhouette (`drawHidden`), but close up it reads as a rendering error. | `artpass-05` (tower face, chimney), `-18`, `-04` | Occlusion is solved by drawing through the occluder instead of keeping people out of occluded spots (crew spots are chosen without regard to what covers them on screen). |
| 1.6 | B | The settlement banner is drawn across the boss standing on her doorstep; lamp posts cut through villagers' faces. | `artpass-05`, `-04` | Props and agent spots are placed independently; no shared reservation of doorstep tiles. |
| 1.7 | C | Lamp heads poke out of tree crowns all along the ring roads; iron lamps are buried in the border pines. | `artpass-03`, `-06` | Lamp and tree placement don't know about each other; upright things sort by a point. |
| 1.8 | C | Status crate, hand cart and villager stacked on one corner of a site. | `artpass-01`, `-03` | Fixed pixel offsets per item, no layout. |

### 2. Detached or nonsensical sprite geometry

| # | Sev | What and where | Evidence | Root-cause class |
|---|-----|----------------|----------|------------------|
| 2.1 | A | Cathedral, single-spire variant: a free-standing wall fin left of the west front; corner pinnacles float off the crossing tower; buttress bars read as stray diagonals over the aisle roof. | `artpass-11` | Geometry outside the building's own massing: buttresses and pinnacles are separate solids placed by offsets, not attached to a wall face. |
| 2.2 | A | Cathedral, twin-tower variant: the nave gable's cross hangs in mid-air between the towers (its gable is hidden behind the right tower). | `artpass-11` | Finial placed at a point with no check that its support is visible. |
| 2.3 | A | Chapel spire variant: a needle spire on a tiny dark louvre box perched at the gable end, narrower than the spire above it. The bellcote variant is fine. | `artpass-12` | Proportions of an attached part chosen independently of the roof it sits on. |
| 2.4 | B | The clock tower stands directly in front of the cathedral in the city, so the two merge into one confusing mass of spires. This is most likely the "random spire parts" seen in the city. | `artpass-05`, `-09` | Landmark placement ignores screen-space extent of tall sprites. |
| 2.5 | B | Flags stand on chimney stacks rather than on the ridge. | `artpass-18`, `-06` | One anchor (`ridge`) reused for the flag while the chimney is modelled at the same ridge end. |
| 2.6 | B | Market stall: a thin rod sticks out past the awning's top-right corner on every variant. | `artpass-14` | Stray face in the prop model. |
| 2.7 | B | Footbridge: a small stone saddle on legs; identical for both directions; it does not span the canal banks or line up with the street. | `artpass-13` | Prop drawn as a one-tile object with no relation to the water tile's banks; `dir` has no effect on the art. |
| 2.8 | C | Baked yard props outside the footprint: the windmill's flour sack, barn bales and barrels, manor and chapel corner shrubs sit on the neighbouring tile (often a street). | sheet pages `windmill`, `barn`, `manor`, `chapel` | Sprites with geometry outside their footprint. |
| 2.9 | C | Laundry lines hang between or over roofs. | `artpass-18`, `-04` | A flat sprite prop on a yard tile behind taller roofs. |

### 3. Placement

| # | Sev | What and where | Evidence | Root-cause class |
|---|-----|----------------|----------|------------------|
| 3.1 | A | Fence runs through building footprints (same as 1.1). | as 1.1 | Props placed without collision. |
| 3.2 | B | The canal is the back row of a block, one tile wide, hard against the houses' rear walls: it shows only through building sites and gaps, as if buildings stood in water. | `artpass-06`, `-08` | Terrain feature placed without clearance for sprite height. |
| 3.3 | B | The hamlet's banner is planted against the windmill, under its sails. | `artpass-01` | Banner placed by plaza corner, no test against landmarks. |
| 3.4 | C | Sunflowers and bushes of the wild scatter sit in open lawn next to plot borders; barrels are drawn with the pack's clay-pot/stump sprite. | `artpass-03` | Mixed sprite sources. |

### 4. NPCs walking through things

| # | Sev | What and where | Evidence | Root-cause class |
|---|-----|----------------|----------|------------------|
| 4.1 | A | Townsfolk walk through benches, lamp posts, fountains, statues, stalls, banners, barrels, crates, carts and street trees. | `artpass-09` (on a lamp post, on the fountain rim), `-10` (through a bench, through a statue, in a tree clump) | **No walkability/occupancy grid.** Props stand on walkable ground codes and walkers only read the ground code. `walk-audit.mjs` over 60 plans per tier, props on walkable tiles: town: stalls 720/720, lamps 500/500, benches 180/180, fountains 60/60, banners 120/120, carts 60/60, crates 124/161, trees 480/4425. City: stalls 720/720, statues 120/120, fountains 60/60, lampposts 960/2220, banners 120/120, carts 60/60, trees 480/5439. Village: carts 60/120, crates 60/60, barrels 120/418. |
| 4.2 | A | Dock porters cut across fields, gardens, fences and the canal on their way to the harbour, and through the crate-yard fence, cranes and warehouses on the quay. | code reading (`roadRoute`: `ok = land && !fp`; `tripLine` straight legs) | Same class: the router's only obstacles are building footprints and the sea. |
| 4.3 | B | The plaza chicken and the square's cat walk straight through fountains, statues, benches and the square's tree. | code reading (`stroll`) | Straight-line wander in a rectangle with no obstacles. |
| 4.4 | B | Crew members stand in flower boxes, barrels and behind banners at a doorstep. | `artpass-05`, `artpass-04` | Agent spots test ground code and footprints only. |
| 4.5 | B | The cart slides through lamp posts and walkers. | code reading (`ambient.js` cart) | No shared moving-object avoidance. |
| 4.6 | C | Every mover snaps between four facings on tile centres; out-and-back routes turn on the spot at dead ends. | time-lapse | Routes are tile polylines without steering. |
| 4.7 | - | Not found: a walker crossing a *building footprint*. Walkable tiles under footprints: 0 at every tier; every lot's door tile is walkable. |  |  |

Seam note: `dock-walk.js` `originOf` still reads a door from the sprite table shim (`R[look][5]`)
instead of `it.doorX`. They agree today for plan lots (both are the footprint's middle), so it is
harmless but fragile.

### 5. Seams, ground and water

| # | Sev | What and where | Evidence | Root-cause class |
|---|-----|----------------|----------|------------------|
| 5.1 | A | Hairline seams across the sea and grass, long straight diagonals, at chunk borders. | `artpass-07`, `-18` (top left) | Baked 48-tile chunks drawn through a rotated transform with smoothing on: neighbouring chunk edges are each anti-aliased against transparency. |
| 5.2 | B | Shallow-water bands are hard one-tile steps while the sand edge beside them is a soft autotile curve. | `artpass-07`, `-03` | Sea depth bands are per-tile `fillRect` over an autotiled shore. |
| 5.3 | C | Building ground shadows are flat rectangles offset a few px; trees get ellipses; props get none. | all town tiles | Three shadow conventions. |
| 5.4 | C | A faint accent rectangle outlines every plot and runs under trees and across lanes. | `artpass-02` | Debug-like plot border baked into the ground. |

### 6. Consistency between modules

| # | Sev | What | Root-cause class |
|---|-----|------|------------------|
| 6.1 | B | **Two perspectives on one screen.** Buildings, procedural props and the harbour are true 2:1 iso; trees, bushes, the cart, barrels, crates, laundry, scarecrows and all people and animals are top-down RPG sprites stood upright. Most visible on the cart beside stalls and barrels beside houses (`artpass-02`, `-04`). | Mixed sprite sources. |
| 6.2 | B | **Three outline weights**: tinted 1 px (iso/props/dock), heavy dark sticker rim plus light halo (villagers), flat near-black ink (street lamp, banner post, pigeons, windmill sails). | Per-module conventions. |
| 6.3 | B | **Two street lamps**: the slim wooden post in `world.js` (ring roads, square) and the iron lamppost in `props-art.js` (plans), often within a few tiles of each other; they also light differently at night (radial pool vs dithered halo). | Duplicate art for one concept. |
| 6.4 | C | Windmill sails are anti-aliased vector strokes over pixel art. | Overlay drawn with canvas paths. |
| 6.5 | C | Palette: procedural art uses hue-shifted ramps; pack sprites are filtered copies (`hue-rotate/saturate/contrast`), so greens and browns don't match between a tree and a shrub pot. | Mixed sources. |
| 6.6 | C | Site scaffold lines are a bright 2 px orange with no tinted outline, unlike every other building. | Separate drawing path for sites. |

### 7. Night

| # | Sev | What | Evidence |
|---|-----|------|----------|
| 7.1 | C | Light pools are smooth radial gradients over pixel art, while lamppost halos are dithered pixels. | `artpass-08` |
| 7.2 | C | Hidden-villager silhouettes glow on walls at night (same as 1.5). | `artpass-08` (tower) |
| 7.3 | - | No broken windows, missing lights or veil gaps found in the city at night. |  |

### Not reproduced

- Flicker / z-fighting between frames: not seen in the time-lapses (the sort is deterministic per
  frame); a walker crossing a fence run's single sort point would pop from front to back, which is
  class 1.1 again.
- Buildings or props on sea tiles: none (`villageDebug().items[].wet` is 0 in every capture).

## Root-cause classes, as requirements for future work

1. **One occupancy grid, shared by placement, routing and spots.** Every solid thing (building, prop,
   fence segment, tree, water, lamp) registers the tiles or sub-tile cells it blocks; planners refuse
   overlapping placements; every mover routes on the same grid. This removes 1.1, 1.2, 1.6, 3.1, 3.3
   and all of section 4.
2. **Depth by footprint for everything, per tile for long things.** Fences, walls, bridges and quays
   are per-tile segments; multi-tile props carry a footprint box. Removes 1.1, 1.2.
3. **A sprite's screen extent is data the planner can read.** Height, overhang and anchor points live
   in the sprite's metadata, so tall landmarks aren't stacked on a sight line (2.4), canals get
   clearance (3.2), and yard dressing stays inside the lot (2.8).
4. **Attached parts are attached.** Finials, flags, chimneys, pinnacles and buttresses are placed on a
   named socket of a visible face, with a check that the socket isn't occluded by the same sprite
   (2.1-2.5).
5. **People are kept out of occluded and blocked cells** rather than drawn through walls (1.5, 4.4).
6. **One art convention**: one projection, one outline rule, one shadow rule, one light model, one
   lamp (section 6, 5.3, 7.1).
7. **Seamless ground**: either draw tiles/chunks unsmoothed at integer positions in screen space, or
   pad baked chunks with a bleed margin (5.1).

## What to port and what to redraw

**Port as-is (good, coherent, already cached pixel art):**

- The `iso.js` rasteriser and its materials: clapboard, logs, fieldstone, ashlar, brick, timber
  framing, shingle/tile/slate/lead/thatch roofs, windows with shutters and flower boxes, doors.
- House looks: farmhouse, cottage, timber (3x3 and 4x3), townhouse (2x3 and 3x3), manor (including the
  turret variants), the boss hall.
- Civic looks: barn (gable and gambrel), windmill body, granary, smithy, inn, guildhall, markethall,
  clock tower, chapel with the bellcote. The gatehouse, wall and wall tower are finished and good but
  not used by any plan today.
- Building sites (the scaffold model), given an opaque floor (1.3).
- Props (`props-art.js`): fountain, well, haystack, woodpile, bench, noticeboard, signpost, beehives,
  trough, maypole, flower boxes, iron lamppost, fence pieces (as per-tile segments).
- The whole harbour (`dock-art.js`): jetty, quay, piers, breakwater, lighthouse, warehouses, cranes,
  ships in three classes, buoys, rowboats, crate yard. It is the most consistent module.
- Palettes and ramps: `SCHEMES`, `PLASTER`, `BEAMS`, `FARM`, roof bases, the hue-shifted `ramp()` and
  outline tint; the plot ground textures in `ground-art.js`.
- Night window lighting (`LIT` ramp) and the dithered lamppost halo.

**Port with a fix:**

- Market stall (remove the stray rod, 2.6).
- Chapel spire variant (re-proportion the spire base, 2.3).
- Flags (give them a ridge socket clear of the chimney, 2.5).
- Statue (fine, but thin for a square centrepiece).

**Redraw:**

- Cathedral buttresses, pinnacles and the nave-gable cross on both variants (2.1, 2.2); the main
  massing, roofs, rose windows and towers are worth keeping.
- Footbridge (2.7).
- Everything still taken from the sprite pack, in the building art's projection and palette: trees
  (4 kinds plus pine and sapling), bushes, flowers, cart, barrel, crate, laundry, scarecrow, log seat,
  hay, chicken, cat, and ideally the villagers themselves (6.1, 6.2, 6.5).
- The `world.js` street lamp and banner post (use the iron lamppost; one lamp only, 6.3).
- Windmill sails as pixel art frames (6.4).
- Shoreline shallows (5.2) and ground shadows (5.3).
