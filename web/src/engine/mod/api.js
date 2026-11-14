// The mod API, MOD0 subset (docs/village-mods.md §3, §6.1).
// MOD0 = the seams only: bundled trusted mods run in-process; no sandbox, no data packs yet. Every world rule the
// engine used to hard-code reaches it through a ResolvedMod.
export const API_VERSION = 1;
/** Ground codes 0..199 belong to the mod's terrain table; 200..255 are the engine's (grid.js LAYOUT_GROUND). */
export const MOD_CODE_MAX = 199;

/** Additive v1 capabilities. A mod asks `ctx.api.has(name)` before relying on one. Every name listed here is wired:
 *  layout (hooks.layout), terrain.classes (TerrainTable.classes), scatter.at (hooks.scatter per tile), represent.pr,
 *  represent.project, venues (mod.venues + LayoutResult.venues), persist (PersistDecl). */
export const FEATURES = Object.freeze(['layout', 'terrain.classes', 'scatter.at', 'represent.pr', 'represent.project', 'venues', 'persist']);

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
 *    review: null|'approved'|'changes'|'pending', size: { additions: number, deletions: number, files: number } }>,
 *  env: { night: number, reduceMotion: boolean, zoom: number },
 * }} WorldInput
 *
 * PR ids are `<projectKey>#<number>`. MOD0: prs[] holds the project's PR history (the classic rule: the server's
 * per-project list, else what its agents list now); state 'building' = live, 'merged' = not live.
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
 *
 * @typedef {{ x: number, y: number, dist: number, park: boolean, terrain: number,
 *   terrainAt: (dx: number, dy: number) => number, canPlace: boolean }} ScatterTile
 *  dist: 0..8 tiles from anything built, 9 = farther. canPlace: lattice tile, 2x2 cell free, not covered.
 * @typedef {{ terrain?: number, model?: string, variant?: number }} ScatterPick
 *  hooks.scatter(tile: ScatterTile, draw: (k: number) => number, ctx: ModCtx) => ScatterPick|null, called for every
 *  unbuilt tile whose class `grows`; draw(k) = rand(seed, mod.id, 'scatter', x, y, k).
 *
 * @typedef {{ as: 'lot'|'venue'|'none', model?: string, venue?: string, tint?: string }} PrSpec
 *  venue: a VenueDef kind. mod.represent.pr: { building?, loading?, merged?, closed?: PrSpec } (data) or (prView, ctx) => PrSpec.
 *  The data table merges per state over the parent's: a state the child names replaces the parent's whole PrSpec.
 * @typedef {{ label?: string, model?: string, accent?: string }} ProjectSpec
 *  label: a template of at most 40 characters, `{name}` is the project name.
 *  mod.represent.project: ProjectSpec (data) or (projectView, ctx) => ProjectSpec.
 * @typedef {{
 *   level: (load: { prs: number, states: { building: number, loading: number, merged: number, closed: number } },
 *           prev: number|null, ctx: ModCtx) => number,   // an integer 0..16; prev: the level persisted for this site
 *   plan: (req: { site: VenueSite, level: number }, ctx: ModCtx) => { objects: object[], nodes: Record<string, { tx: number, ty: number }>,
 *          berths: Array<{ id: string, tx: number, ty: number, face: 0|1|2|3 }> },
 *   assign?: (prIds: string[], berths: object[], prev: Record<string, string>, ctx: ModCtx) => Record<string, string>,
 * }} VenueDef
 *  mod.venues: Record<kind, VenueDef> (functions allowed: trusted, in-process). assign defaults to stable first-free.
 *  plan is memoised on kind + level + site; objects outside site.rect, and nodes/berths outside the world, are dropped
 *  with lint. world.venues[siteId] = { id, kind, tx, ty, rect, level, nodes, berths }; resolvePlace('venue:<siteId>')
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
 *  planSettlement?: (req: { tier: number, seed: number, lots: number, crowns: number, style: object }, ctx: ModCtx) => object,
 *  style?: (projectKey: string, ctx: ModCtx, preset?: object) => { key: string, accent?: string },
 *  layout?: (input: LayoutInput, ctx: ModCtx) => LayoutResult,
 *  scatter?: (tile: ScatterTile, draw: (k: number) => number, ctx: ModCtx) => ScatterPick|null,
 * }} ModHooks
 *
 * @typedef {{
 *  id: string, name: string, version: string, apiVersion: number, chain: string[],
 *  rules: { layout: { square: { x: number, y: number, w: number, h: number }, gap: number, accents: string[],
 *            searchX: number, searchY: number, aspect: number, reserveMs: number }, holdMs: number },
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
