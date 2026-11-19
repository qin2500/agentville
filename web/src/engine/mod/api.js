// The mod API, MOD0 subset (docs/village-mods.md §3, §6.1).
// MOD0 = the seams only: bundled trusted mods run in-process; no sandbox, no data packs yet. Every world rule the
// engine used to hard-code reaches it through a ResolvedMod.
export const API_VERSION = 1;
/** Ground codes 0..199 belong to the mod's terrain table; 200..255 are the engine's (grid.js LAYOUT_GROUND). */
export const MOD_CODE_MAX = 199;

/** Additive v1 capabilities. A mod asks `ctx.api.has(name)` before relying on one. Every name listed here is wired:
 *  layout (hooks.layout), terrain.classes (TerrainTable.classes), scatter.at (hooks.scatter per tile), represent.pr,
 *  represent.project, venues (mod.venues + LayoutResult.venues), persist (PersistDecl). */
export const FEATURES = Object.freeze(['layout', 'terrain.classes', 'scatter.at', 'represent.pr', 'represent.project', 'venues', 'persist', 'prs.loading']);

/** @typedef {{
 *  apiVersion: 1, now: number, seed: number,
 *  agents: Array<{ id: string,                      // opaque per install (input.js), never the server id
 *    name: string, project: string, parent: string|null,   // parent: an opaque id of an agent the server still has, else null
 *    status: 'working'|'waiting'|'stalled'|'error'|'resting',
 *    needs: null|'permission'|'question'|'plan'|'dialog',
 *    role: 'boss'|'lead'|'worker'|'sub', crown: boolean, important: boolean, stopped: boolean,
 *    harness: 'claude'|'codex'|'other', since: number, lastActive: number, prs: string[] }>,
 *  projects: Array<{ key: string, name: string, accent: string,
 *    stats: { prsEver: number, prsLive: number, agentsEver: number, agentsNow: number, transcriptMB: number } }>,
 *  prs: Array<{ id: string, project: string, number: number, title: string,
 *    state: 'building'|'loading'|'merged'|'closed', checks: { passed: number, failed: number, pending: number },
 *    review: null|'approved'|'changes'|'pending', size: { additions: number, deletions: number, files: number },
 *    live?: boolean }>,                             // additive: the PR is current work (see below)
 *  history?: { merged: number, rank: number },     // additive: lifetime PR totals the host knows (see below)
 *  env: { night: number, reduceMotion: boolean, zoom: number },
 * }} WorldInput
 *
 * PR ids are `<projectKey>#<number>`. MOD0: prs[] holds the project's PR history (the classic rule: the server's
 * per-project list, else what its agents list now); state 'building' = live, 'merged' = not live.
 *
 * Additive v1 fields (optional; a mod checks for them, absent means "the host does not know"):
 *  - prs[].state 'loading': the host's PR source says the PR is open now (awaiting checks and review); 'merged' that it
 *    merged. One state per PR, so a PR that is both open and still current work is 'loading' with `live: true`.
 *  - prs[].live: the PR is current work (what 'building' meant before 'loading' was known). Absent: state === 'building'.
 *    A rule that means "being worked on" reads `p.live ?? p.state === 'building'`.
 *  - history: { merged, rank }: merged = PRs ever merged (lifetime, never decreasing), rank = the host's lifetime level
 *    (an integer from 1; 0 = unknown). Venue levels see them as load.merged / load.rank (VenueDef).
 */

/** @typedef {{ code: number, name: string, cost: number, color?: string, tags?: string[] }} TerrainType
 *  A GROUND type (plan ground codes 1..199). cost: walk cost 1..254, or 255 = impassable. tags (engine-known): 'street'
 *  (paved through-route; lamps snap to its edge), 'walk' (actors may stand), 'water', 'decal-ok', 'over-water' (walkable
 *  on a water terrain class).
 * @typedef {{ types: TerrainType[], byName: Record<string, number>, wildCost: number, classes: TerrainClass[] }} TerrainTable
 *  wildCost: cost of wild land outside settlements (a `wild` terrain class with no ground, no road, not in a block).
 *  classes: the terrain-layer codes 0..15 the layout writes (TerrainClass below); class 0 is required (kit
 *  checkClasses). Inherited from the parent like any data; a table with no classes has no water and no wild land.
 */

/** @typedef {{ w?: number, h?: number, walk: 'block'|'edge'|'floor', z: number, anchors?: object,
 *    snap?: 'street-edge', decal?: boolean, kind?: 'tree', dir?: 'x'|'y',
 *    byDir?: { x?: ObjectType, y?: ObjectType } }} ObjectType
 *  Plain data only (no functions): the table must survive structuredClone / JSON to cross into a mod sandbox.
 *  byDir: the variant is picked by the plan prop's dir ('y', else 'x'); the entry's other fields are defaults it overrides.
 *  walk 'edge' (fences): omit w/h/run; the engine derives w, h and run { dir, len, side } from prop.dir/len and its foot point.
 * @typedef {{ props: Record<string, ObjectType>, buildings: Record<string, { z: number }>, scatter?: object }} ObjectTypeTable
 */

/** @typedef {{ item: string, owner: 'home'|'pr', rank: 'L'|'M'|'S', agent?: string, pr?: string, building?: boolean }} LotRequest
 *  item: 'home:<opaqueAgentId>' or 'pr:<prId>'. The engine maps opaque ids back to server ids before persisting.
 */

/** @typedef {{
 *  rng: (stream: string) => () => number,   // rng.js streamFor(world seed, mod id, project key, stream)
 *  hash: (s: string) => number,
 *  time: { now: number },
 *  forcedTier: number|null, forcedStyle: number|null,   // dev params (?citytier, ?citystyle)
 *  parent: object|null,                      // the extended mod's hooks
 *  api: { version: number, has: (feature: string) => boolean },   // has(f) = FEATURES.includes(f)
 * }} ModCtx
 */

// ---------------- MOD-READY seams (additive to v1; advertised through FEATURES) ----------------

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect   tiles
 *
 * @typedef {{ code: number, name: string, water?: boolean, wild?: boolean, grows?: boolean, color?: string }} TerrainClass
 *  code 0..15. Code 0 is also "outside the grid" (cost 255). water: cost 255 unless the tile's ground type is
 *  'over-water' (LAYOUT_GROUND.VENUE always is). wild: wild land (no ground, no road, not in a block) costs
 *  table.wildCost, else 255. grows: wild scatter may use this tile. Listed in `terrain.classes` (TerrainTable).
 *
 * @typedef {{ index: number, name: string, block: Rect, plaza: Rect, cx: number, cy: number, accent: string,
 *   plan: { w: number, h: number, ground: number[], lots: Rect[], civic?: Rect[] } }} PlacedSettlement
 * @typedef {{ settlements: PlacedSettlement[], square: Rect, parks: Rect[], paths: number[] }} LayoutInput
 *   paths: the plan ground codes that count as walkable path (mod.rules.layout.paths, else terrain types tagged street/walk)
 * @typedef {{ kind: string, rect: Rect, anchor: { tx: number, ty: number }, data?: object }} VenueSite
 * @typedef {{
 *   bounds: { ox: number, oy: number, w: number, h: number },   // world grid rect; must contain every block (engine lints + grows it if not)
 *   focus: { ox: number, oy: number, w: number, h: number },    // what a camera fit shows
 *   tiles: { ox: number, oy: number, w: number, h: number, terrain: Uint8Array, ground: Uint8Array, road: Uint8Array, lot: Int8Array },
 *          // row-major over any rect. ground: mod codes 1..199 or LAYOUT_GROUND, 0 = leave; road: ROAD; lot: 0 | LOT.HUB | LOT.VENUE
 *   outside?: number,                    // terrain class for grid tiles outside `tiles` (default 0)
 *   venues?: Record<string, VenueSite>,  // site id -> site
 *   data?: object,                       // the mod's own structured-clonable extras -> world.layoutData
 * }} LayoutResult
 *  hooks.layout(input: LayoutInput, ctx: ModCtx) => LayoutResult: pure in `input`; ctx.time is NOT given (the result is cached).
 *  Optional hooks.layout.steps: a generator function with the same arguments that yields between its passes and returns
 *  the same LayoutResult; the engine prefers it so the cold build can hand the main thread back mid-layout.
 *
 * @typedef {{ x: number, y: number, dist: number, park: boolean, terrain: number,
 *   terrainAt: (dx: number, dy: number) => number, canPlace: boolean }} ScatterTile
 *  dist: 0..8 tiles from anything built, 9 = farther. canPlace: lattice tile, 2x2 cell free, not covered.
 * @typedef {{ terrain?: number, model?: string, variant?: number }} ScatterPick
 *  hooks.scatter(tile: ScatterTile, draw: (k: number) => number, ctx: ModCtx) => ScatterPick|null, called for every
 *  unbuilt tile whose class `grows`; draw(k) = rand(seed, mod.id, 'scatter', x, y, k).
 *
 * @typedef {{ as: 'lot'|'venue'|'none', model?: string, venue?: string, tint?: string, flag?: string, load?: number }} PrSpec
 *  venue: a VenueDef kind. Additive v1: flag (#rrggbb) and load (0..1, clamped) say how a venue PR is doing; its token
 *  shows them (the vessel art: a pennant in the flag colour, cargo stowed by load). mod.represent.pr: { building?, loading?, merged?, closed?: PrSpec } (data) or (prView, ctx) => PrSpec.
 *  The data table merges per state over the parent's: a state the child names replaces the parent's whole PrSpec.
 * @typedef {{ label?: string, model?: string, accent?: string }} ProjectSpec
 *  label: a template of at most 40 characters, `{name}` is the project name.
 *  mod.represent.project: ProjectSpec (data) or (projectView, ctx) => ProjectSpec.
 * @typedef {{
 *   level: (load: { prs: number, states: { building: number, loading: number, merged: number, closed: number },
 *                   merged: number, rank: number },
 *           prev: number|null, ctx: ModCtx) => number,   // an integer 0..63 (was 0..16); prev: the level persisted for this site
 *   plan: (req: { site: VenueSite, level: number }, ctx: ModCtx) => { objects: object[], nodes: Record<string, { tx: number, ty: number }>,
 *          berths: Array<{ id: string, tx: number, ty: number, face: 0|1|2|3 }> },
 *   assign?: (prIds: string[], berths: object[], prev: Record<string, string>, ctx: ModCtx,
 *             info: Record<string, { model?: string, state?: string }>) => Record<string, string>,
 *   shrinkAfterMs?: number,
 * }} VenueDef
 *  mod.venues: Record<kind, VenueDef> (functions allowed: trusted, in-process). assign defaults to stable first-free.
 *  plan is memoised on kind + level + site; objects outside site.rect, and nodes/berths outside the world, are dropped
 *  with lint. Additive v1 (all optional, old mods unchanged):
 *   - load.merged, load.rank: WorldInput.history (0 when the host gives none), the same for every kind.
 *   - shrinkAfterMs: a level lower than the persisted one is taken only after it has been wanted for longer than this
 *     (ctx.time.now; the engine keeps the low-since time in persisted.venues[siteId].low). Higher levels are taken at once.
 *   - a plan object `deck: true` (walk 'floor' only): its footprint becomes walkable ground (LAYOUT_GROUND.VENUE where the
 *     ground is empty, ROAD.PATH where there is no road), so actors and the road graph reach a pier over water.
 *   - assign's 5th argument: prId -> { model?, state? } (the PrSpec model and the PR state), e.g. to berth by size. world.venues[siteId] = { id, kind, tx, ty, rect, level, nodes, berths }; resolvePlace('venue:<siteId>')
 *  goes to (tx, ty), the site anchor.
 *
 * @typedef {{ key?: string, demoKey?: string, also?: string[], import?: string[] }} PersistDecl
 *  Top-only, never inherited. key/demoKey: where this mod reads and writes (default `va.engine2.world.<id>` / `.demo`);
 *  also: extra read-only keys tried next; import: read-only legacy imports (demo: `${k}.demo`), tried last. Every key
 *  must match /^va\.(engine2\.world(\.[a-z0-9.-]+)?|world\d+)(\.demo)?$/ and key/demoKey must start with `va.engine2.world`.
 *  Owner rule (registry.js checkPersistOwner; the mod does not resolve otherwise): a mod names only its own
 *  `va.engine2.world.<id>` keys. The bare `va.engine2.world` key and the classic `va.world<N>` keys are agentville.fantasy's.
 *  Leave persist out to get the default keys; most mods should.
 */

/** @typedef {{
 *  growth?: (project: object, ctx: ModCtx) => number,
 *  tier?: (growth: number, prevTier: number|null, ctx: ModCtx) => number,
 *  capacity?: (tier: number, need: number, ctx: ModCtx) => number,
 *  lots?: (project: object, agents: object[], prs: object[], ctx: ModCtx) => LotRequest[],
 *  crowns?: (project: object, agents: object[], ctx: ModCtx) => number,
 *  planSettlement?: (req: { tier: number, seed: number, lots: number, crowns: number, style: object, from?: string, grow?: { room?: { se: number[], sw: number[], ne: number[], nw: number[] } } }, ctx: ModCtx) => object,   // from (M6, optional): the `chain` of the plan the block drew before; a nesting planner returns { ..., chain, nest: { from, dx, dy, plan } }. grow (M7, optional, only with from): grow thin; room (when this rebuild re-plans a standing block): per corner, R[g] = the most the block can grow vertically toward that corner while it grows g tiles horizontally toward it and keeps the layout gap (-1: none; world/room.js growthRoom)
 *  style?: (projectKey: string, ctx: ModCtx, preset?: object) => { key: string, accent?: string },
 *  layout?: (input: LayoutInput, ctx: ModCtx) => LayoutResult,
 *  scatter?: (tile: ScatterTile, draw: (k: number) => number, ctx: ModCtx) => ScatterPick|null,
 *  styleNeighbours?: (styles: Map<string, object>, blocks: Array<{ name: string, x: number, y: number, w: number, h: number }>,
 *    distinctPicks: (blocks, options: (name: string) => any[], near?: number) => Map<string, any>) => Map<string, object>,   // additive: after layout, vary adjacent blocks' styles
 *  lotVariants?: (lots: object[], projectKey: string, opts: { w: number, h: number, nest: object|null }) => Map<string, number>,   // additive (city-variety): how each lot draws (0..63), art only
 *  propVariants?: (props: object[], projectKey: string) => Map<number, number>,   // additive (market stalls): index into plan.props -> variant (0..4095), art only
 *  freeLot?: (lot: { id: string, w: number, h: number, rank: string|null, look: string|null }, ctx: ModCtx) => { kind?: string, ground: number, props?: Array<{ kind: string, x: number, y: number, v?: number }> },   // additive (city cap): a free lot drawn as a green (lot-local tiles); without it the house stays
 * }} ModHooks
 *
 * @typedef {{
 *  id: string, name: string, version: string, apiVersion: number, chain: string[],
 *  rules: { layout: { square: { x: number, y: number, w: number, h: number }, gap: number, accents: string[],
 *            searchX: number, searchY: number, aspect: number, reserveMs: number }, holdMs: number,
 *            styleReads?: string[], compact?: boolean },   // styleReads (additive): style fields the building art draws; a hash of only these keys the sprite cache
 *                                       // compact (additive, city-compact): false keeps plans growing only (no size-to-fit, world/fit.js)
 *  terrain: TerrainTable, objects: ObjectTypeTable, hooks: ModHooks,
 *  venues?: Record<string, VenueDef>,        // data key, deep-merged and frozen
 *  behaviour?: object, represent?: object,  // data keys, deep-merged and frozen (represent.pr per state)
 *  persist: PersistDecl|null,                // the top mod's own; never inherited
 *  parentHooks: ModHooks,                    // the extended mod's resolved hooks (ctx.parent)
 *  lint: Array<{ kind: string, mod: string, reason: string }>,   // problems in the top mod's own data (terrain classes)
 * }} ResolvedMod
 */

/** Hook names the MOD0 engine calls. */
export const MOD0_HOOKS = ['growth', 'tier', 'capacity', 'lots', 'crowns', 'planSettlement', 'style'];
/** Hook names the MOD1 engine knows: MOD0 plus the MOD-READY layout and scatter hooks (both optional). */
export const MOD1_HOOKS = [...MOD0_HOOKS, 'layout', 'scatter'];

// ---------------- M6 actors (paper-doll people; additive to v1, a data key like venues) ----------------
// BEGIN M6-ACTORS (M6 doll). Engine side: art/doll.js (createDoll) and render/actor-art.js (createActorArt).

/** @typedef {string} PartRef   an id in ActorsDecl.parts
 * @typedef {string|number[]} Colour   palette slot name, '#rgb', '#rrggbb', '#rrggbbaa' or [r, g, b, a?]
 * @typedef {{ draw(g: object, facing: 0|2, anim: string, f: number, pal: Record<string, Colour>): void,
 *   layer: number, bob?: boolean }
 *  | { rows: string[]|{ 0?: string[], 2?: string[] }, keys: Record<string, Colour>, x?: number, y?: number, layer: number, bob?: boolean }} PartDef
 *  Drawn in a size.w x size.h box (default 16 x 24, feet on the bottom row, centred on x = w/2) for the drawn facing
 *  0 (SE, front) or 2 (NW, back); the engine mirrors them for SW (1) and NE (3) and adds the 1 px outline, rim and
 *  shadow. Parts sort by layer (ties: look order). Painter g: w, h, facing, anim, f, dy, px(x, y, c), rect(x, y, w, h, c),
 *  rows(x, y, rows, keys), erase(x, y, w, h), col(c). Pure and deterministic: no randomness, no time, no I/O.
 * @typedef {{ parts: PartRef[], palette?: Record<string, Colour>, extras?: PartRef[] }} Look
 *  extras: overlays (crown, cape, tool) drawn with the parts; they take part in the cache key like everything else.
 * @typedef {{ frames: number, bob?: number[] }} AnimDef   bob[f]: vertical px offset of the bob-able parts at frame f
 * @typedef {{ id: string, kind: 'agent'|'folk'|'critter'|string, role: string|null, parent: string|null, crown: boolean,
 *   important: boolean, project: string|null, status: string|null, species: string|null, seed: number|null, seen: number|null }} ActorView
 *  seen: agents, the install-stable first-seen ordinal (classic va.seen); folk, their spawn look seed; else null.
 * @typedef {{
 *   anims?: Record<string, AnimDef>,          // engine anim names: idle walk hammer sit carry wave cheer sleep enter
 *   parts?: Record<string, PartDef>,
 *   size?: { w: number, h: number },
 *   lookOf?: (actor: ActorView, style: object|null, ctx: { hash: (s: string) => number, api: { version: number } }) => Look|null,
 *   fallback?: { looks: string[], subs: string[], boss: string, critters: Record<string, string>, defaultCritter?: string },
 * }} ActorsDecl
 *  mod.actors. lookOf returns null for an actor the doll does not draw (it gets the sheet fallback, e.g. critters).
 *  Without parts + lookOf, or after lookOf throws, the engine draws the fallback sheet stickers named in `fallback`
 *  (the default world's when the mod has none). Looks are computed once per actor and cached: lookOf must be pure.
 */
/** Doll box size when ActorsDecl.size is not given. */
export const DOLL_SIZE = Object.freeze({ w: 16, h: 24 });
// END M6-ACTORS

// ---------------- M6 world events (additive to v1: an optional top-level `events` function on the mod) ----------------
// BEGIN M6-EVENTS (M6 events). Engine side: render/event-fx.js (runEvents, createEventFx, drawEventFx).

/** @typedef {{ type: 'merge'|'found'|'tierUp'|'arrive'|'leave'|'retire', project?: string, lot?: string, pr?: string, id?: string, from?: number, to?: number, tick: number }} SimEvent
 *  What the sim saw change at a poll: merge { pr, project }, found { project }, tierUp { project, from, to },
 *  arrive / leave { id (actor), project }, retire { project, lot (the freed lot's object id) } (city cap). Frozen plain data.
 * @typedef {{ kind: string, at: string, effect: string, seconds: number, colors?: string[] }} EventSpec
 *  at: 'plaza:<projectKey>' (that village's plaza), 'actor:<actorId>' (follows the actor), 'pr:<prId>' (its berth),
 *  'obj:<objectId>' (the centre of a world object's footprint, or of a lot drawn as a green).
 *  effect: 'burst' (confetti), 'ring' (expanding ring), 'site:<objId>' (scaffolds over that object), 'anim:<name>'
 *  (an actor pose: idle walk hammer sit carry wave cheer sleep enter; needs an actor: at).
 *  seconds: (0, 30]. colors: up to 6 CSS hex colours. Unknown shapes are dropped, never thrown on.
 * @typedef {{ time: { now: number }, hash: Function, rng: Function, api: object,
 *   accentOf: (project: string) => string|null,          // the village's accent colour
 *   actorsOf: (project: string) => string[],             // ids of the agents living in that project
 *   newObjects: Array<{ id: string, project: string|null, kind: string, model: string }>,   // objects new in the last world build
 * }} EventsCtx
 *  mod.events(diff: SimEvent[], ctx: EventsCtx) => EventSpec[]. Pure and fast: the engine allows 10 ms per call; a call that
 *  throws or overruns loses only its own specs. Inherited from the nearest mod in the extends chain that defines one.
 */
// END M6-EVENTS
