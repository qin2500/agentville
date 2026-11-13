// Actor sprites for the engine renderer (agents, townsfolk, critters).
// The classic village draws its people from the Ninja Adventure sheets (16x16 frames, columns = facing down/up/left/
// right, rows 0-3 = walk cycle, row 4 = action) as "stickers" (1px ink outline + light rim, world.js rimmed()). This
// module builds the same stickers once per (look, facing, row, selected), scaled 1.25x nearest-neighbour to the engine's
// 32x16 tile (the classic projection is 0.8 of it), and caches them in its own small map: a few hundred frames at most,
// so actors never compete with buildings for the SpriteCache's per-frame raster budget.
//
//   createActorArt({ base?, loadImage?, createCanvas? }) -> {
//     load() -> Promise                 loads the sheets (idempotent); frame() returns null until they are in
//     ready: boolean
//     lookOf(actor) -> string|null      sheet name for an actor (null: not drawn by this module, e.g. carts)
//     frame(actor, { selected }) -> { img, pivot:{x,y} } | null   pivot = the feet point in img px
//     stats() -> { frames, looks }
//   }
// Agents: boss -> Sultan2, sub -> a ninja (by parent), others -> a villager look by id (classic world.js rule).
// Townsfolk: a villager look by a.look.seed. Critters: Cat / Chicken (2-frame strips facing right; mirrored left).
import { hash } from '../core/rng.js';
import { createCanvas as rasterCanvas } from '../art/raster.js';

export const LOOKS = ['Villager2', 'Woman', 'OldMan', 'Villager4', 'Hunter', 'Princess', 'Villager3', 'Boy', 'Monk2', 'Villager5', 'OldMan3'];
export const NINJAS = ['NinjaBlue', 'NinjaRed', 'NinjaYellow', 'NinjaGreen', 'NinjaMasked', 'NinjaDark', 'NinjaLeaf', 'NinjaGray'];
export const BOSS = 'Sultan2';
export const SCALE = 1.25;
const CRITTERS = { cat: 'Cat', chicken: 'Chicken' };
const FILES = Object.fromEntries([
  ...[BOSS, ...LOOKS, ...NINJAS].map(k => [k, `actors/${k}.png`]),
  ...Object.values(CRITTERS).map(k => [k, `animals/${k}.png`]),
]);
// engine facing (sim/actor.js faceFrom): 0 SE (toward the viewer), 1 SW, 2 NW, 3 NE -> sheet column 0 down, 1 up, 2 left, 3 right
const COL = [0, 2, 1, 3];

const defaultBase = () => `${(typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/'}assets/ninja-adventure/`;
function defaultLoad(src) {
  return new Promise((ok, no) => {
    if (typeof Image === 'undefined') { no(new Error('no Image')); return; }
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => no(new Error(`actor sheet ${src} failed`));
    im.src = src;
  });
}

/** Row of the sheet for an actor's anim + frame (classic: walk rows 0-3, hammer alternates 0/4). */
export function rowOf(a) {
  const f = a.frame | 0;
  if (a.anim === 'walk' || a.anim === 'carry') return f % 4;
  if (a.anim === 'hammer') return f % 2 ? 4 : 0;
  return 0;
}
export const colOf = a => COL[(a.face | 0) & 3] ?? 0;

export function lookOf(a) {
  if (!a) return null;
  if (a.kind === 'critter') return CRITTERS[a.species] || CRITTERS.chicken;
  if (a.kind === 'agent') {
    const role = a.input?.role ?? a.status?.role ?? a.role;
    if (role === 'boss' || a.input?.crown) return BOSS;
    if (role === 'sub') return NINJAS[hash(a.parent ?? a.input?.parent ?? a.id) % NINJAS.length];
    return LOOKS[hash(a.id) % LOOKS.length];
  }
  if (a.kind === 'folk') {
    const s = Number.isFinite(a.look?.seed) ? a.look.seed : hash(a.id);
    return LOOKS[Math.abs(s | 0) % LOOKS.length];
  }
  return null;
}

export function createActorArt({ base = defaultBase(), loadImage = defaultLoad, createCanvas = rasterCanvas } = {}) {
  const IMG = {};
  const frames = new Map();
  let loading = null, ready = false;

  function load() {
    if (loading) return loading;
    loading = Promise.all(Object.entries(FILES).map(([k, f]) => loadImage(base + f).then(im => { IMG[k] = im; }, () => {})))
      .then(() => { ready = true; });
    return loading;
  }

  /** Classic sticker (world.js rimmed) at 1x, with a soft ground shadow, then scaled by SCALE (nearest). */
  function sticker(look, col, row, sel, flip) {
    const im = IMG[look];
    const critter = look === 'Cat' || look === 'Chicken';
    const sx = critter ? col * 16 : col * 16, sy = critter ? 0 : row * 16;
    const W = 20, H = 22;                       // 16x16 frame + 2px rim each side + 2px for the shadow below the feet
    const c1 = createCanvas(W, H), g = c1.getContext('2d');
    g.imageSmoothingEnabled = false;
    const blit = (ctx, dx, dy) => {
      if (!flip) { ctx.drawImage(im, sx, sy, 16, 16, dx, dy, 16, 16); return; }
      ctx.save(); ctx.translate(dx + 16, dy); ctx.scale(-1, 1); ctx.drawImage(im, sx, sy, 16, 16, 0, 0, 16, 16); ctx.restore();
    };
    const sil = (color, pad) => {
      const c = createCanvas(16 + pad * 2, 16 + pad * 2), s = c.getContext('2d');
      for (let dy = -pad; dy <= pad; dy++) for (let dx = -pad; dx <= pad; dx++) if (Math.abs(dx) + Math.abs(dy) <= pad + (pad > 1 ? 1 : 0)) blit(s, pad + dx, pad + dy);
      s.globalCompositeOperation = 'source-in'; s.fillStyle = color; s.fillRect(0, 0, c.width, c.height);
      return c;
    };
    // shadow under the feet (classic agents), then rim, ink outline and the frame
    g.fillStyle = 'rgba(16, 10, 24, 0.45)';
    g.beginPath(); g.ellipse(10, 17.5, critter ? 5 : 6, 2.2, 0, 0, Math.PI * 2); g.fill();
    if (sel) g.drawImage(sil('#ffffff', 2), 0, 0);
    else { g.globalAlpha = 0.55; g.drawImage(sil('#fff4dc', 2), 0, 0); g.globalAlpha = 1; }
    g.drawImage(sil('#140f1c', 1), 1, 1);
    blit(g, 2, 2);
    const w2 = Math.round(W * SCALE), h2 = Math.round(H * SCALE);
    const c2 = createCanvas(w2, h2), g2 = c2.getContext('2d');
    g2.imageSmoothingEnabled = false;
    g2.drawImage(c1, 0, 0, W, H, 0, 0, w2, h2);
    return { img: c2, pivot: { x: Math.round(10 * SCALE), y: Math.round(18 * SCALE) } };   // feet: frame bottom centre
  }

  function frame(a, { selected = false } = {}) {
    if (!ready) return null;
    const look = lookOf(a);
    if (!look || !IMG[look]) return null;
    let col, row, flip = false;
    if (look === 'Cat' || look === 'Chicken') {
      col = a.anim === 'idle' || a.anim === 'sit' || a.anim === 'sleep' ? 0 : (a.frame | 0) % 2; row = 0;
      flip = (a.face | 0) === 1 || (a.face | 0) === 2;   // strips face right; SW / NW are mirrored
    } else { col = colOf(a); row = rowOf(a); }
    const k = `${look}|${col}|${row}|${flip ? 1 : 0}|${selected ? 1 : 0}`;
    let f = frames.get(k);
    if (!f) { f = sticker(look, col, row, selected, flip); frames.set(k, f); }
    return f;
  }

  return {
    load, frame, lookOf,
    get ready() { return ready; },
    stats: () => ({ frames: frames.size, looks: Object.keys(IMG).length }),
  };
}
