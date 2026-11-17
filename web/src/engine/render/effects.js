// Engine render: town dressing and ambient effects (M4 P4). Chimney smoke, zZ, fountain sparkle, a V of birds, falling
// leaves, wave glints, forge and hammer sparks, the stalled bob. Everything is a pure function of t (seconds) and the
// world: no Math.random, no clock. Cheap: static sources are indexed once, per frame only the ones in view are drawn,
// and every effect has a hard cap. Drawn through the Gfx interface (rect / poly / image) in 1x world screen px.
import { toScreen } from '../core/coords.js';
import { drawFlags, ridgeFlags, accentEdges, accentsOf, drawAccentEdges } from './accent.js';

// parity: bld.chimney-smoke-sources
// parity: bld.smoke-puff-cap
// parity: bld.zzz-resting-homes-night
// parity: amb.fountain-sparkle
// parity: amb.bird-v-every-40s
// parity: amb.falling-leaves
// parity: world.wave-glints
// parity: vil.stalled-bob
// parity: vil.pose-hammer-sparks-badge
export const CAPS = Object.freeze({ puffs: 6, zzz: 8, sparkles: 24, leaves: 14, glints: 400, sparks: 16 });
export const BIRD_EVERY = 40, BIRD_CROSS = 16;

const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const fract = x => x - Math.floor(x);
const statusOf = a => a?.input?.bucket ?? a?.input?.status ?? a?.status?.bucket ?? a?.bucket;
const inView = (r, x, y, m = 24) => !r || (x >= r[0] - m && x <= r[2] + m && y >= r[1] - m && y <= r[3] + m);

/** Stalled bob: a small hop, two px, every ~1.2 s with a settle; every other agent stands still. -> {dx, dy} (px). */
export function actorOffset(actor, t) {
  const s = statusOf(actor);
  if (s !== 'stalled' && actor?.state !== 'stalled') return { dx: 0, dy: 0 };
  const ph = (hash(String(actor.id ?? '')) % 100) / 100, u = fract(t / 1.2 + ph);
  return { dx: 0, dy: u < 0.5 ? -Math.round(Math.sin(u * 2 * Math.PI) * 2) : 0 };
}

const Z = [[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]];   // a 3x3 pixel Z
function sparkle(g, x, y, k, col) {
  const a = Math.round(x), b = Math.round(y);
  g.rect(a, b, 1, 1, col);
  if (k > 0.5) { g.rect(a - 1, b, 3, 1, col); g.rect(a, b - 1, 1, 3, col); }
}

/**
 * createEffects({ world, mod, entryOf?, accents? }) -> { draw(g, cam, gview, frame), flags?, edges }
 * frame: { t (s), night (0..1), actors }. entryOf(obj) -> sprite entry ({anchors:{chimney,ridge,windows}, pivot}) lets
 * smoke, zZ and flags sit on the drawn roof; without it they use the footprint centre. With entryOf, ridge flags and
 * the plot accent edges are drawn here too (set `flags: false` / `edges: false` to leave them to the caller).
 */
export function createEffects({ world, mod, entryOf = null, accents = null, flags: wantFlags = true, edges: wantEdges = true } = {}) {
  const acc = accents ?? accentsOf(world);
  const edges = accentEdges(world, acc);
  const objs = world?.objects ? [...(typeof world.objects.values === 'function' ? world.objects.values() : world.objects)] : [];
  const buildings = [], trees = [], fountains = [], forges = [];
  for (const o of objs) {
    const cx = o.tx + (o.w || 1) / 2, cy = o.ty + (o.h || 1) / 2;
    if (o.kind === 'building') { const p = toScreen(cx, cy, o.z || 30); buildings.push({ o, id: String(o.id), x: p.sx, y: p.sy, h: hash(String(o.id)) }); if (/forge|smith/.test(o.model || '')) forges.push(buildings.at(-1)); }
    else if (o.model === 'fountain') { const p = toScreen(cx, cy, o.z || 24); fountains.push({ id: String(o.id), x: p.sx, y: p.sy, h: hash(String(o.id)) }); }
    else if (o.kind === 'tree' && o.model !== 'pine' && hash(String(o.id)) % 5 === 0) { const p = toScreen(cx, cy, 34); trees.push({ x: p.sx, y: p.sy, h: hash(String(o.id)) }); }
  }
  const ld = world?.layoutData ?? {}, rawWaves = ld.waves ?? ld.data?.waves ?? [];
  const waves = rawWaves.map(([x, y]) => { const p = toScreen(x + 0.5, y + 0.5); return { x: p.sx, y: p.sy, h: hash(`${x},${y}`) }; });
  const anchor = (b, k) => {   // roof point of a building in world screen px
    const e = entryOf?.(b.o), a = e?.anchors?.[k] ?? (k === 'window' ? e?.anchors?.windows?.[0] : null);
    if (a && e.pivot) { const n = toScreen(b.o.tx, b.o.ty); return { x: n.sx + a.x - e.pivot.x, y: n.sy + a.y - e.pivot.y }; }
    return { x: b.x, y: b.y - (k === 'window' ? 4 : 0) };
  };

  let last = { puffs: 0, birds: false };   // what the last draw put on screen (stats())
  function draw(g, cam, gview, frame = {}) {
    last = { puffs: 0, birds: false };
    const t = Number.isFinite(frame.t) ? frame.t : 0, r = gview?.rect;
    // Map zoom draws them all as well: the same village, smaller (every effect is capped, CAPS)
    if (wantEdges) drawAccentEdges(g, edges, gview);
    // wave glints: a short pale dash that wanders along the swell and twinkles
    let n = 0;
    for (const w of waves) {
      if (n >= CAPS.glints) break;
      if (!inView(r, w.x, w.y, 8)) continue;
      const k = (t * 0.9 + (w.h % 17) / 4) % 4;
      if (k > 1.2) continue;
      const ox = (Math.floor(t * 3 + (w.h % 16)) % 12) - 6;
      g.rect(Math.round(w.x + ox), Math.round(w.y + ((w.h >> 4) % 5) - 2), k < 0.6 ? 4 : 2, 1, k < 0.6 ? 'rgba(235,248,255,0.8)' : 'rgba(200,230,250,0.5)');
      n++;
    }
    // who is where: home object id -> {hammer, resting}
    const state = new Map(), hammerers = [];
    for (const a of frame.actors || []) {
      if (a.home == null) continue;
      const s = statusOf(a), id = String(a.home);
      const cur = state.get(id) || {};
      if (a.anim === 'hammer') { cur.hammer = true; hammerers.push(a); }
      if (s === 'resting') cur.resting = true;
      state.set(id, cur);
    }
    // chimney smoke: hammering homes first, then resting homes, then a few townspeople's houses; <= 6 puffs in all
    const src = [];
    for (const b of buildings) {
      if (!inView(r, b.x, b.y, 40)) continue;
      const s = state.get(b.id);
      const rank = s?.hammer ? 0 : s?.resting ? 1 : (!s && b.h % 4 === 0 ? 2 : 3);
      if (rank < 3) src.push({ b, rank });
    }
    src.sort((a, b) => a.rank - b.rank || a.b.h - b.b.h);
    const per = Math.max(1, Math.min(3, Math.floor(CAPS.puffs / Math.max(1, src.length))));
    let puffs = 0;
    for (const { b, rank } of src) {
      if (puffs >= CAPS.puffs) break;
      const a = anchor(b, 'chimney'), life = rank === 0 ? 2.4 : 3.6;
      for (let i = 0; i < per && puffs < CAPS.puffs; i++, puffs++) {
        const u = fract(t / life + i / per + (b.h % 97) / 97);
        const x = a.x + Math.sin(u * 5 + b.h) * 2 + u * 7, y = a.y - u * 18, s = u < 0.3 ? 2 : u < 0.7 ? 3 : 4, al = (1 - u) * (rank === 0 ? 0.8 : 0.55);
        g.rect(Math.round(x - s / 2), Math.round(y - s / 2), s, s, `rgba(238,236,246,${al.toFixed(2)})`);
      }
    }
    last.puffs = puffs;
    // zZ over resting homes at night
    if ((frame.night ?? 0) >= 0.5) {
      let zn = 0;
      for (const b of buildings) {
        if (zn >= CAPS.zzz) break;
        if (!state.get(b.id)?.resting || !inView(r, b.x, b.y, 30)) continue;
        const w = anchor(b, 'window');
        for (let i = 0; i < 2; i++) {
          const u = fract(t / 3 + i / 2 + (b.h % 13) / 13), al = Math.sin(u * Math.PI);
          const col = `rgba(225,232,255,${al.toFixed(2)})`, x = Math.round(w.x + 4 + u * 8 + i * 2), y = Math.round(w.y - 6 - u * 14);
          for (const [dx, dy] of Z) g.rect(x + dx, y + dy, 1, 1, col);
        }
        zn++;
      }
    }
    // fountain sparkle: glints on the spray, four spots twinkling out of step
    let sp = 0;
    for (const f of fountains) {
      if (!inView(r, f.x, f.y, 30)) continue;
      for (let i = 0; i < 4 && sp < CAPS.sparkles; i++, sp++) {
        const k = fract(t * 1.1 + i / 4 + (f.h % 11) / 11);
        if (k > 0.45) continue;
        const ang = i * 1.7 + f.h, rad = 6 + (i % 2) * 5;
        sparkle(g, f.x + Math.cos(ang) * rad, f.y - 4 + Math.sin(ang) * rad * 0.5, k < 0.22 ? 1 : 0, 'rgba(220,248,255,0.95)');
      }
    }
    // falling leaves near trees: drift down and sway, then restart
    let ln = 0;
    for (const tr of trees) {
      if (ln >= CAPS.leaves) break;
      if (!inView(r, tr.x, tr.y, 20)) continue;
      const u = fract(t / 7 + (tr.h % 53) / 53);
      if (u > 0.8) continue;
      const v = u / 0.8, x = tr.x + 6 + Math.sin(v * 9 + tr.h) * 5 + v * 5, y = tr.y - 4 + v * 30;
      g.rect(Math.round(x), Math.round(y), 2, 1, ['#d9a23c', '#c4642c', '#8fb84a'][tr.h % 3]);
      ln++;
    }
    // hammer sparks (beat every 0.6 s) at the hammering agent, and forge sparks over forges
    let sk = 0;
    const burst = (x, y, h, k) => {
      for (let i = 0; i < 4 && sk < CAPS.sparks; i++, sk++) {
        const a = -0.4 - i * 0.55 + (h % 5) * 0.05, d = k * 9;
        g.rect(Math.round(x + Math.cos(a) * d * (i % 2 ? -1 : 1)), Math.round(y + Math.sin(a) * d + k * k * 5), 1, 1, k < 0.5 ? '#ffe07a' : '#ff9a3c');
      }
    };
    for (const a of hammerers) {
      const p = toScreen(a.x, a.y);
      if (!inView(r, p.sx, p.sy, 20)) continue;
      const k = fract(t / 0.6 + (hash(String(a.id)) % 10) / 10);
      if (k < 0.7) burst(p.sx + 7, p.sy - 8, hash(String(a.id)), k / 0.7);
    }
    for (const f of forges) {
      if (!inView(r, f.x, f.y, 20)) continue;
      const k = fract(t / 0.9 + (f.h % 9) / 9);
      if (k < 0.7) burst(f.x + 6, f.y - 4, f.h, k / 0.7);
    }
    // a V of birds crosses the view every 40 s, west to east, a little higher each time
    const cyc = Math.floor(t / BIRD_EVERY), u = (t - cyc * BIRD_EVERY) / BIRD_CROSS;
    if (u >= 0 && u < 1 && r) {
      last.birds = true;
      const bx = r[0] - 40 + u * (r[2] - r[0] + 80), by = r[1] + (r[3] - r[1]) * (0.18 + 0.1 * ((cyc * 7) % 5) / 4);
      for (let i = 0; i < 7; i++) {
        const side = i % 2 ? 1 : -1, rank = Math.ceil(i / 2), x = Math.round(bx - rank * 7), y = Math.round(by + side * rank * 4 + Math.sin(t * 2 + rank) * 1.5);
        const up = Math.floor(t * 5 + i) % 2 === 0;
        g.rect(x - 2, y + (up ? -1 : 1), 2, 1, '#3a2f52'); g.rect(x, y, 1, 1, '#3a2f52'); g.rect(x + 1, y + (up ? -1 : 1), 2, 1, '#3a2f52');
      }
    }
    // flags on home ridges, in the village accent
    if (wantFlags && entryOf) {
      const homes = [];
      for (const b of buildings) if ((state.has(b.id) || b.o.data?.agentId != null) && inView(r, b.x, b.y, 60)) homes.push(b.o);
      drawFlags(g, ridgeFlags(homes, entryOf, acc, true), t, gview);
    }
  }
  /** { puffs, birds }: smoke puffs and whether the V of birds was on screen in the last draw. */
  const stats = () => ({ ...last });
  return { draw, edges, accents: acc, stats };
}
