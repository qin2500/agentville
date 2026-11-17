// Classic-parity helpers for the engine entry (M4 integrator). Pure, no DOM: node tests import it.
// - the villageDebug() compat shape the e2e specs read (classic village.js debug(): view, hits, badges, clusters, items,
//   townWater, outdoors, homes, walkers, iso)
// - night by local time, the aria-label summary, the 8 fps loop policy, the keyboard bucket order.
import { toScreen } from '../core/coords.js';

const WATER_GROUND_OK = 201;   // grid.js LAYOUT_GROUND.VENUE: a venue site stands over water on purpose

// parity: night.amount-by-local-time
/** Classic night amount: 20:00-06:00 full, ramps 18-20 and 06-08. `param` is ?night ('1' | '0' | null). */
export function nightAmount(param, date = new Date()) {
  if (param != null) return param === '1' ? 1 : 0;
  const hr = date.getHours() + date.getMinutes() / 60;
  return hr >= 20 || hr < 6 ? 1 : hr >= 18 ? (hr - 18) / 2 : hr < 8 ? (8 - hr) / 2 : 0;
}
/** Day phase 0..1 (0 = midnight) the lighting veil takes: ?night=1 is midnight, else the local clock. */
export function dayPhase(param, date = new Date()) {
  if (param === '1') return 0;
  return (date.getHours() + date.getMinutes() / 60) / 24;
}

// parity: debug.night-param
/** What ?night means to the frame: { night 0..1, phase } (phase null by day: no lighting pass). */
export function nightFrame(param, date = new Date()) {
  const night = nightAmount(param, date);
  return { night, phase: night > 0 ? dayPhase(param, date) : null };
}

const BUCKET_NAME = { stalled: 'Stalled', waiting: 'Waiting', building: 'Building', resting: 'Resting' };
const ROLE_NAME = { boss: 'Boss', lead: 'Lead', sub: 'Subagent', solo: 'Solo' };
// parity: aria.summary-label
/** Classic updateAria(): counts, plus the keyboard-cursor agent. */
export function ariaSummary({ loading = false, total = 0, counts = {}, cursor = null } = {}) {
  let label = loading ? 'Village: loading' : !total ? 'Village: no agents'
    : `Village: ${counts.stalled ?? 0} stalled, ${counts.waiting ?? 0} waiting, ${counts.building ?? 0} building`;
  if (cursor) label += `. ${cursor.name}, ${ROLE_NAME[cursor.role] || cursor.role}, ${BUCKET_NAME[cursor.bucket] || cursor.bucket}. Press Enter to select.`;
  return label;
}

// parity: aria.dataset-art-villages-zoom
/** data-art: 'ready' once the building art and the character sheets are in; 'failed' when either could not load. */
export function artState(stats) {
  if (!stats) return 'loading';
  if (stats.artFailed || (stats.actorArt === true && stats.actorLooks === 0)) return 'failed';
  return stats.artReady && stats.actorArt !== false ? 'ready' : 'loading';
}

export const FPS = 8;
// parity: loop.fps-8-on-demand
/** Next frame: 'raf' (a camera tween or sprites streaming in), a delay in ms (8 fps while animating), or null (on demand). */
export function nextFrame({ active = true, tweening = false, streaming = false, animating = false } = {}) {
  if (!active) return null;
  if (tweening || streaming) return 'raf';
  return animating ? 1000 / FPS : null;
}

const ORDER = { stalled: 0, waiting: 1, building: 2, resting: 3 };
// parity: inp.keyboard-cycle-by-bucket
/** Keyboard ←/→ order: the shown agents (server order) sorted by bucket, stalled first; only those on the map. */
export function bucketOrder(agents, placed = () => true) {
  return agents.map((a, i) => [a, i]).filter(([a]) => !a.hidden && placed(a.id))
    .sort((x, y) => (ORDER[x[0].bucket] ?? 9) - (ORDER[y[0].bucket] ?? 9) || x[1] - y[1]).map(([a]) => a.id);
}

/** Classic Map-plate counts per project: { need, error, prompt, wait } (stalled split by error / prompt / need). */
export function projectCounts(agents) {
  const out = new Map();
  for (const a of agents || []) {
    if (a.hidden) continue;
    const k = a.project || '—', c = out.get(k) || { need: 0, error: 0, prompt: 0, wait: 0 };
    if (a.bucket === 'stalled') c[a.severity === 'error' ? 'error' : a.prompt ? 'prompt' : 'need']++;
    else if (a.bucket === 'waiting') c.wait++;
    out.set(k, c);
  }
  return out;
}

const waterSet = mod => new Set((mod?.terrain?.classes || []).filter(c => c.water).map(c => c.code));
function isWater(world, water, x, y) {
  const g = world.grid;
  return water.has(g.get('terrain', x, y)) && g.get('ground', x, y) !== WATER_GROUND_OK;
}

// parity: debug.villagedebug
/** Water tiles inside the box spanning every block and the square (0 = one town). */
export function townWater(world, mod = world?.mod) {
  if (!world?.grid) return null;
  const rs = [world.square, ...(world.villages || []).map(v => v.block)].filter(Boolean);
  if (!rs.length) return 0;
  const water = waterSet(mod);
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
  const x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h));
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (isWater(world, water, x, y)) n++;
  return n;
}

/** Classic item kind of a world object: home | pr | house | civic (buildings), decor (a block's props), else null. */
export function itemKind(o) {
  if (o.kind === 'building') {
    const ow = o.data?.owner;
    if (ow === 'home' || ow === 'pr' || ow === 'house') return ow;
    return String(o.id).startsWith('civic:') ? 'civic' : 'house';
  }
  if (o.kind === 'prop' && o.project && !o.data?.wild && !o.data?.venue) return 'decor';
  return null;
}

/** Classic debug().items: { id, kind, x, y, w, h, village, building, wet, ... } in tiles. Owned lots carry their item id
 *  ('home:<agent>', 'pr:<project>#<n>') so ids follow the owner, as classic. */
export function debugItems(world, mod = world?.mod) {
  if (!world?.objects) return [];
  const water = waterSet(mod), out = [];
  for (const o of world.objects.values()) {
    const kind = itemKind(o);
    if (!kind) continue;
    let wet = 0;
    for (let j = o.ty; j < o.ty + (o.h || 1); j++) for (let i = o.tx; i < o.tx + (o.w || 1); i++) if (isWater(world, water, i, j)) wet++;
    out.push({ id: o.data?.item ?? o.id, object: o.id, kind, x: o.tx, y: o.ty, w: o.w || 1, h: o.h || 1, village: o.project ?? null,
      building: !!o.data?.building, look: o.model, lot: o.lot ?? null, agentId: o.data?.agentId ?? null, wet });
  }
  return out;
}

/** Server ids of the agents with a home on the map. */
export const debugHomes = world => (world?.objects ? [...world.objects.values()].filter(o => o.kind === 'building' && o.data?.owner === 'home').map(o => o.data.agentId) : []);

const INDOORS = 8;
/** Agent actors standing outdoors, as server ids. */
export const debugOutdoors = (actors, toServer) => actors.filter(a => a.kind === 'agent' && !((a.flags | 0) & INDOORS)).map(a => toServer(a.id) ?? a.id);

/** Classic hits: agent hits only, in canvas css px, server ids, with pose and home. */
export function debugHits(hits, actorOf, toServer, hostKinds = null) {
  const out = [], seen = new Set();
  for (const h of hits || []) {
    // host panel hits (a venue, a token the host opens a panel for): the kind, the rect and its centre; one per object
    if (hostKinds?.has?.(h.kind)) {
      const k = `${h.kind}:${h.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const [x0, y0, x1, y1] = h.rect;
      out.push({ kind: h.kind, id: h.id, x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
      continue;
    }
    if (h.kind !== 'agent' || seen.has(h.id)) continue;
    seen.add(h.id);
    const a = actorOf(h.id), [x0, y0, x1, y1] = h.rect;
    out.push({ id: toServer(h.id) ?? h.id, x: x0, y: y0, w: x1 - x0, h: y1 - y0, pose: a?.anim ?? null, home: a?.home ?? null, occluded: !!h.occluded });
  }
  return out;
}

/** Critter walkers for the facing e2e: { id, kind (species), x (screen px), t, facing 'R'|'L', moving }. */
export function debugWalkers(actors, t) {
  const out = [];
  for (const a of actors) {
    if (a.kind !== 'critter') continue;
    const f = (a.face | 0) & 3;
    const s = toScreen(a.x, a.y);
    out.push({ id: a.id, kind: a.species ?? a.kind, x: +s.sx.toFixed(3), y: +s.sy.toFixed(3), t, facing: f === 0 || f === 3 ? 'R' : 'L', moving: a.anim === 'walk' });
  }
  return out;
}

/** debug.clusters from placed labels (the Map plates). */
export const debugClusters = placed => (placed || []).filter(p => p.counts).map(p => ({ name: p.text, ...p.counts, x: p.rect.l, y: p.rect.t, w: p.rect.r - p.rect.l, h: p.rect.b - p.rect.t }));

/** "proj#123" -> 123 (a PR number for the zoom-3 tags). */
export const prNumber = pr => { const m = /#(\d+)$/.exec(String(pr ?? '')); return m ? +m[1] : null; };

// parity: debug.citydemo
// parity: debug.citytier
/** The engine's dev params: ?citydemo=1, ?citytier=N (clamped by the mod), ?citystyle=N, ?seed=N, ?t=<sec>, ?night, ?grid. */
export function devParams(search) {
  const p = new URLSearchParams(search || ''), num = k => (p.get(k) != null && p.get(k) !== '' && Number.isFinite(+p.get(k)) ? +p.get(k) : null);
  const tier = num('citytier');
  return { demo: p.get('citydemo') === '1', tier: tier == null ? null : Math.max(0, Math.round(tier)), style: num('citystyle'),
    seed: num('seed') == null ? null : num('seed') >>> 0, t: num('t'), night: p.get('night'), grid: p.get('grid') };
}
