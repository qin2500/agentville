// Hit list (design §6.3) and the slice/actor screen geometry it shares with x-ray (§3.6). Pure, no DOM.
//
//   buildHits(merged, toCss) -> Hit[]   front to back (reverse of the renderer's draw order)
//     merged: the renderer's back-to-front list. Slice items { key, oid, hit, obj, z, img, sx, sy, sw, sh, dx, dy } and
//     actor items { key, actor, x, y, oid, hit, z, p?, img?, pivot? } (x, y = the drawn, interpolated feet; p =
//     toScreen(x, y); img/pivot = the sprite actually drawn). Items without `hit` (props, trees, critters) make no
//     hit but still occlude.
//     Hit = { id, kind, rect: [x0, y0, x1, y1] CSS px, key, z }
//       slice hits add src: { img, sx, sy, sw, sh } (the source rect the slice draws, for pixel-alpha picking);
//       actor hits add occluded: true when a slice drawn after the actor overlaps its sprite rect (x-ray); a non-agent
//       actor hit (a hull) also gets src (its whole sprite), so pick.js reads its pixels as it does a slice's.
//     One hit per slice (a building with five strips gives five hits, all with the building's id), so the empty air
//     beside a tower is not the tower's.
//
//     opts.index: a sliceIndex() of the slices to judge occlusion by (the list has only actors, its slices are elsewhere)
//
//   mergeHits(a, b) -> Hit[]   two front-to-back hit lists into one; on equal keys b's come first. buildHits of a
//     static list and of the actors (b) merge to exactly buildHits(mergeSorted([static, actors])).
//
//   actorRect(item) -> [x0, y0, x1, y1]   1x world screen px of the drawn sprite (renderer rounds the same way)
//   sliceRect(slice) -> [x0, y0, x1, y1]
//   sliceIndex(slices) -> index            column buckets (16 px strips) of the occluding slices
//   occludersOf(index, item) -> slice[]    slices with a greater key whose rect overlaps the actor's sprite rect
import { toScreen } from '../core/coords.js';
import { feetKey, LAYER, SUB_STEPS, LAYER_SLOTS, COL_SLOTS } from './depth.js';

const STRIP = 16;
const ROW = SUB_STEPS * LAYER_SLOTS * COL_SLOTS;   // key distance of one depth row
const LAYER_UNIT = COL_SLOTS;

/** Depth row of a packed sort key (depth.js sortKey). */
export const depthOfKey = key => Math.floor(key / ROW);
/** Layer field of a packed sort key. */
export const layerOfKey = key => ((Math.floor(key / LAYER_UNIT) % LAYER_SLOTS) + LAYER_SLOTS) % LAYER_SLOTS;

/** Drawn sprite rect of an actor item, 1x world px. Falls back to a 16x24 box with the pivot at its bottom centre. */
export function actorRect(it) {
  const p = it.p || toScreen(it.x, it.y);
  const w = it.img?.width ?? it.w ?? 16, h = it.img?.height ?? it.h ?? 24;
  const px = it.pivot?.x ?? w / 2, py = it.pivot?.y ?? h;
  const x0 = Math.round(p.sx - px), y0 = Math.round(p.sy - py);
  return [x0, y0, x0 + w, y0 + h];
}

export const sliceRect = s => [s.dx, s.dy, s.dx + s.sw, s.dy + s.sh];

const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const keyOf = it => (Number.isFinite(it.key) ? it.key : feetKey(it.x, it.y, LAYER.ACTOR));

/** Column buckets of the slices that can hide an actor: everything above the ground-prop layer. */
export function sliceIndex(slices) {
  const cols = new Map();
  for (const s of slices || []) {
    if (!s || s.actor || !(s.sw > 0 && s.sh > 0)) continue;
    if (layerOfKey(s.key) === LAYER.GROUND_PROP) continue;    // flat decals and floor props never hide anyone
    const r = sliceRect(s), e = { s, r, key: s.key };
    for (let c = Math.floor(r[0] / STRIP), c1 = Math.floor((r[2] - 1) / STRIP); c <= c1; c++) {
      let b = cols.get(c); if (!b) cols.set(c, b = []);
      b.push(e);
    }
  }
  return { cols, src: slices };
}

/** Slices drawn after the actor (greater key) whose rect overlaps its drawn sprite rect. */
export function occludersOf(index, it, rect = actorRect(it)) {
  const out = [], k = keyOf(it), c0 = Math.floor(rect[0] / STRIP), c1 = Math.floor((rect[2] - 1) / STRIP);
  const seen = c1 > c0 ? new Set() : null;   // a wide slice sits in several buckets
  for (let c = c0; c <= c1; c++) {
    const b = index.cols.get(c); if (!b) continue;
    for (const e of b) {
      if (e.key <= k || !overlaps(e.r, rect)) continue;
      if (seen) { if (seen.has(e)) continue; seen.add(e); }
      out.push(e.s);
    }
  }
  return out;
}

function cssRect(toCss, r) {
  const [a0, b0] = toCss(r[0], r[1]), [a1, b1] = toCss(r[2], r[3]);
  return [a0, b0, a1, b1];
}

/** @returns {Array<{ id, kind, rect: number[], key: number, z: number, src?: object, occluded?: boolean }>} */
export function buildHits(merged, toCss, { index: given = null } = {}) {
  const out = [];
  if (!merged || !merged.length) return out;
  let index = given;
  for (let i = merged.length - 1; i >= 0; i--) {
    const it = merged[i];
    if (!it || !it.hit) continue;
    if (it.actor) {
      const r = actorRect(it);
      if (!index) index = sliceIndex(merged.filter(m => m && !m.actor));
      const h = { id: it.oid, kind: it.hit, rect: cssRect(toCss, r), key: keyOf(it), z: it.z ?? 0 };
      if (occludersOf(index, it, r).length) h.occluded = true;
      // a non-agent actor (a hull on a berth) is picked by its pixels like a slice: its sprite is mostly air (sails,
      // rigging, water round the hull), and that air must fall through to the deck or the hull behind it
      if (it.hit !== 'agent' && it.img && it.img.width > 0 && it.img.height > 0) h.src = { img: it.img, sx: 0, sy: 0, sw: it.img.width, sh: it.img.height };
      out.push(h);
    } else {
      if (!(it.sw > 0 && it.sh > 0)) continue;
      out.push({ id: it.oid, kind: it.hit, rect: cssRect(toCss, sliceRect(it)), key: it.key, z: it.z ?? 0,
        src: { img: it.img, sx: it.sx, sy: it.sy, sw: it.sw, sh: it.sh } });
    }
  }
  return out;
}

export function mergeHits(a, b) {
  const out = new Array(a.length + b.length);
  let i = 0, j = 0, o = 0;
  while (i < a.length && j < b.length) out[o++] = b[j].key >= a[i].key ? b[j++] : a[i++];
  while (i < a.length) out[o++] = a[i++];
  while (j < b.length) out[o++] = b[j++];
  return out;
}
