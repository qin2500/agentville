// Engine v2 depth ordering (design §3.2, §3.3 layer 3). OWNER: R1. Pure, no DOM.
//
// One packed sort key per drawable in the World layer:
//   key = ((depth * 4 + sub) * 8 + layer) * 4096 + (col + 2048)
// depth = x + y of the frontmost footprint cell (statics) or floor(feet x + y) (actors),
// sub   = quarter-tile position along the depth diagonal (0..3; statics use 0),
// layer = LAYER bias at equal depth/sub, col = x - y screen column.
// Ascending key = back-to-front. It is a total order on (depth, sub, layer, col): no graph, no cycles.
//
// Range: every field is an integer and |key| < 2^53 for |depth| up to ~2^31, so keys are exact in float64.
// For a world up to ±2048 tiles: depth in [-4096, 4096] -> |key| <= ((4096*4+3)*8+7)*4096+4095 ≈ 5.4e8.
// The col field holds 4096 values, col in [-2048, 2047]; col is CLAMPED into it so a far column can never
// bleed into the next layer/sub/depth slot (ordering on depth, sub, layer stays exact). In a ±2048 world
// col = x - y can reach ±4096; such far columns tie with the clamp edge and fall back to merge stability.
// Within one 16-px column (the slice unit) that never matters.
// Sizing (checked 2026-11-13): the largest fixture (e2e stress.json, grid 358x303 at ox -181, oy -161) spans
// col -322..337 and depth -342..317, so 4096 col slots are 6x headroom; the field is NOT widened (the seam stays).
// Slice.col (render/slice.js) is the 16-px screen strip index k (sx in [16k, 16k+16)), which is within one of the
// tile column x - y, so the same range applies.

export const LAYER = Object.freeze({ GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 });

export const SUB_STEPS = 4, LAYER_SLOTS = 8, COL_SLOTS = 4096, COL_BIAS = 2048;
export const COL_MIN = -COL_BIAS, COL_MAX = COL_SLOTS - COL_BIAS - 1;
export const CHUNK = 16;

const clampInt = (v, lo, hi) => {
  v = Math.round(v);
  return v < lo ? lo : v > hi ? hi : v;
};

/** Packed total-order key. depth: integer (floored if not); sub 0..3; layer 0..7; col clamped to [-2048, 2047].
 *  @returns {number} exact integer in float64 */
export function sortKey(depth, sub, layer, col) {
  const d = Math.floor(depth);
  const s = clampInt(sub, 0, SUB_STEPS - 1);
  const l = clampInt(layer, 0, LAYER_SLOTS - 1);
  const c = clampInt(col, COL_MIN, COL_MAX);
  return ((d * SUB_STEPS + s) * LAYER_SLOTS + l) * COL_SLOTS + (c + COL_BIAS) + 0;   // + 0: no -0
}

/** Key for an actor whose feet are at float tile (x, y): depth = floor(x+y), sub = quarter of the fraction,
 *  col = round(x - y). Negative coordinates floor correctly (sub is always 0..3). */
export function actorKey(x, y, layer = LAYER.ACTOR) {
  const s = x + y;
  const d = Math.floor(s);
  let sub = Math.floor((s - d) * SUB_STEPS);
  if (sub > SUB_STEPS - 1) sub = SUB_STEPS - 1;   // guards float edge (s - d) * 4 rounding to 4
  return sortKey(d, sub, layer, Math.round(x - y));
}

/** Key for an actor whose FEET are at float tile (x, y), where the centre of tile (tx, ty) is (tx + .5, ty + .5)
 *  (nav paths, slots and sim positions all use that convention). A static cell's depth is x + y of its north
 *  corner, so the comparable point for feet is (x - .5, y - .5): an actor on the centre of cell (a, b) gets depth
 *  a + b, exactly the depth of a static on that cell. Without the shift an actor on the centre of the cell just
 *  behind a building cell would tie its depth and win on layer bias, drawing over the wall in front of it.
 *  The renderer uses this; actorKey stays the raw corner-space form. */
export function feetKey(x, y, layer = LAYER.ACTOR) {
  return actorKey(x - 0.5, y - 0.5, layer);
}

/** 16x16 chunk of a tile (floor division, negative-safe). */
export function chunkOf(tx, ty) {
  return { cx: Math.floor(tx / CHUNK) + 0, cy: Math.floor(ty / CHUNK) + 0 };
}

// Reusable heap scratch, grown on demand: no allocation per item, none per call once warm.
let heapList = new Int32Array(16), heapPos = new Int32Array(16);

/** k-way merge of arrays each sorted ascending by `.key`. Stable: equal keys come out by list index, then by
 *  position in that list. Allocates only the output array (pass `out` to reuse one; it is truncated first).
 *  @template {{ key: number }} T @param {T[][]} lists @param {T[]} [out] @returns {T[]} */
export function mergeSorted(lists, out) {
  const k = lists ? lists.length : 0;
  let total = 0, nonEmpty = 0, only = -1;
  for (let i = 0; i < k; i++) {
    const n = lists[i] ? lists[i].length : 0;
    if (n) { total += n; nonEmpty++; only = i; }
  }
  if (out) out.length = total; else out = new Array(total);
  if (nonEmpty === 0) return out;
  if (nonEmpty === 1) {
    const L = lists[only];
    for (let j = 0; j < total; j++) out[j] = L[j];
    return out;
  }
  if (heapList.length < nonEmpty) {
    let cap = heapList.length;
    while (cap < nonEmpty) cap *= 2;
    heapList = new Int32Array(cap); heapPos = new Int32Array(cap);
  }
  const hl = heapList, hp = heapPos;
  // (key, listIndex) lexicographic: list index breaks ties; position within a list is monotone by construction.
  const less = (a, b) => {
    const ka = lists[hl[a]][hp[a]].key, kb = lists[hl[b]][hp[b]].key;
    return ka < kb || (ka === kb && hl[a] < hl[b]);
  };
  const swap = (a, b) => {
    const tl = hl[a]; hl[a] = hl[b]; hl[b] = tl;
    const tp = hp[a]; hp[a] = hp[b]; hp[b] = tp;
  };
  const down = (i, n) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && less(l, m)) m = l;
      if (r < n && less(r, m)) m = r;
      if (m === i) return;
      swap(i, m); i = m;
    }
  };
  let n = 0;
  for (let i = 0; i < k; i++) if (lists[i] && lists[i].length) { hl[n] = i; hp[n] = 0; n++; }
  for (let i = (n >> 1) - 1; i >= 0; i--) down(i, n);
  let o = 0;
  while (n > 0) {
    const L = lists[hl[0]];
    out[o++] = L[hp[0]];
    if (++hp[0] >= L.length) { n--; if (n > 0) { hl[0] = hl[n]; hp[0] = hp[n]; } }
    if (n > 1) down(0, n);
  }
  return out;
}
