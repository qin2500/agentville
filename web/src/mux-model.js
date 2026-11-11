// The split layout of the terminal view (term.js), as in Ghostty: a binary tree whose leaves are
// agents and whose inner nodes split their area in two. Pure: no DOM, so it is tested in node.
//
//   leaf:  { id }                                   one agent's terminal
//   split: { dir: 'row' | 'column', ratio, a, b }   row: a left of b; column: a above b.
//                                                   ratio is a's share of the area (0..1).
//
// Every function returns a new tree and leaves its input alone. An agent appears at most once (it
// has one PTY and one xterm, so it can only be drawn in one place); `null` is the empty layout.

export const MIN_RATIO = 0.08, MAX_RATIO = 0.92;
export const MAX_DEPTH = 24;
/** Which edge of a pane a drop lands on, and the split that makes. */
export const SIDES = {
  left: { dir: 'row', first: true },
  right: { dir: 'row', first: false },
  top: { dir: 'column', first: true },
  bottom: { dir: 'column', first: false },
};

const clampRatio = r => Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number.isFinite(r) ? r : 0.5));
export const isLeaf = n => !!n && typeof n.id === 'string';
export const leaf = id => ({ id });

/** The agent ids, left to right / top to bottom (depth first, a before b). */
export function leaves(n, out = []) {
  if (!n) return out;
  if (isLeaf(n)) out.push(n.id);
  else { leaves(n.a, out); leaves(n.b, out); }
  return out;
}
export const has = (n, id) => leaves(n).includes(id);
export const count = n => leaves(n).length;

/** Put `id` beside the pane showing `target`, on `side` of it; the two share its area equally. */
export function insert(tree, target, id, side) {
  const s = SIDES[side];
  if (!s) throw new Error(`Unknown side: ${side}`);
  if (!tree) return leaf(id);
  if (target === id) return tree; // dropped on itself: nothing to do
  // An agent already shown moves: it leaves its old place first.
  const base = has(tree, id) ? remove(tree, id) : tree;
  if (!base) return leaf(id);
  if (!has(base, target)) return base;
  const rec = n => {
    if (isLeaf(n)) {
      if (n.id !== target) return n;
      const fresh = leaf(id);
      return { dir: s.dir, ratio: 0.5, a: s.first ? fresh : n, b: s.first ? n : fresh };
    }
    return { ...n, a: rec(n.a), b: rec(n.b) };
  };
  return rec(base);
}

/** Take a pane out: its sibling takes the whole of their split's area. The last one leaves null. */
export function remove(tree, id) {
  if (!tree) return null;
  if (isLeaf(tree)) return tree.id === id ? null : tree;
  const a = remove(tree.a, id), b = remove(tree.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

/** Show `next` where `prev` is (the same pane, another agent). `next` already shown elsewhere moves here. */
export function replace(tree, prev, next) {
  if (!tree || prev === next || !has(tree, prev)) return tree;
  if (has(tree, next)) {
    // Both shown: they swap places, so nothing else moves.
    const rec = n => (isLeaf(n) ? (n.id === prev ? leaf(next) : n.id === next ? leaf(prev) : n) : { ...n, a: rec(n.a), b: rec(n.b) });
    return rec(tree);
  }
  const rec = n => (isLeaf(n) ? (n.id === prev ? leaf(next) : n) : { ...n, a: rec(n.a), b: rec(n.b) });
  return rec(tree);
}

/** The split at `path` ('' is the root; 'a'/'b' steps down), or null. */
export function at(tree, path) {
  let n = tree;
  for (const step of path) {
    if (!n || isLeaf(n) || (step !== 'a' && step !== 'b')) return null;
    n = n[step];
  }
  return n;
}

/** Set the ratio of the split at `path` (clamped so no pane collapses). */
export function resize(tree, path, ratio) {
  const n = at(tree, path);
  if (!n || isLeaf(n)) return tree;
  const rec = (m, i) => {
    if (i === path.length) return { ...m, ratio: clampRatio(ratio) };
    return { ...m, [path[i]]: rec(m[path[i]], i + 1) };
  };
  return rec(tree, 0);
}

/** The path to the split nearest above `id` along `dir` ('row' or 'column'), or null. */
export function splitAbove(tree, id, dir) {
  const route = pathTo(tree, id);
  if (route == null) return null;
  for (let i = route.length - 1; i >= 0; i--) {
    const p = route.slice(0, i);
    if (at(tree, p).dir === dir) return p;
  }
  return null;
}
/** The 'a'/'b' steps from the root down to the pane showing `id`, or null. */
export function pathTo(tree, id, path = '') {
  if (!tree) return null;
  if (isLeaf(tree)) return tree.id === id ? path : null;
  return pathTo(tree.a, id, path + 'a') ?? pathTo(tree.b, id, path + 'b');
}

/**
 * Move the divider next to `id` by `delta` (a fraction of that split's area) the way Ghostty's
 * resize_split does: 'left'/'right' move the nearest row divider, 'up'/'down' the nearest column one.
 */
export function nudge(tree, id, direction, delta = 0.05) {
  const dir = direction === 'left' || direction === 'right' ? 'row' : 'column';
  const p = splitAbove(tree, id, dir);
  if (p == null) return tree;
  const sign = direction === 'right' || direction === 'down' ? 1 : -1;
  return resize(tree, p, at(tree, p).ratio + sign * delta);
}

/**
 * Ghostty's equalize_splits: every pane along an axis gets the same size. A split's share is the
 * number of panes its first side has along the split's own direction.
 */
export function equalize(tree) {
  const weight = (n, dir) => (isLeaf(n) ? 1 : n.dir === dir ? weight(n.a, dir) + weight(n.b, dir) : 1);
  const rec = n => {
    if (isLeaf(n)) return n;
    const wa = weight(n.a, n.dir), wb = weight(n.b, n.dir);
    return { ...n, ratio: clampRatio(wa / (wa + wb)), a: rec(n.a), b: rec(n.b) };
  };
  return tree && rec(tree);
}

/** Each pane's rectangle in the unit square: Map id -> { x, y, w, h }. */
export function rects(tree, box = { x: 0, y: 0, w: 1, h: 1 }, out = new Map()) {
  if (!tree) return out;
  if (isLeaf(tree)) { out.set(tree.id, box); return out; }
  if (tree.dir === 'row') {
    const w = box.w * tree.ratio;
    rects(tree.a, { x: box.x, y: box.y, w, h: box.h }, out);
    rects(tree.b, { x: box.x + w, y: box.y, w: box.w - w, h: box.h }, out);
  } else {
    const h = box.h * tree.ratio;
    rects(tree.a, { x: box.x, y: box.y, w: box.w, h }, out);
    rects(tree.b, { x: box.x, y: box.y + h, w: box.w, h: box.h - h }, out);
  }
  return out;
}

/**
 * The pane next to `id` in a direction ('left' | 'right' | 'up' | 'down'), as Ghostty's goto_split:
 * of the panes beyond that edge that overlap it across, the nearest, then the one most in line.
 */
export function neighbor(tree, id, direction) {
  const R = rects(tree);
  const me = R.get(id);
  if (!me) return null;
  const eps = 1e-9;
  const horiz = direction === 'left' || direction === 'right';
  let best = null, bestKey = null;
  for (const [other, r] of R) {
    if (other === id) continue;
    let gap;
    if (direction === 'left') gap = me.x - (r.x + r.w);
    else if (direction === 'right') gap = r.x - (me.x + me.w);
    else if (direction === 'up') gap = me.y - (r.y + r.h);
    else if (direction === 'down') gap = r.y - (me.y + me.h);
    else return null;
    if (gap < -eps) continue;
    const overlap = horiz ? Math.min(me.y + me.h, r.y + r.h) - Math.max(me.y, r.y) : Math.min(me.x + me.w, r.x + r.w) - Math.max(me.x, r.x);
    if (overlap <= eps) continue;
    const off = horiz ? Math.abs((r.y + r.h / 2) - (me.y + me.h / 2)) : Math.abs((r.x + r.w / 2) - (me.x + me.w / 2));
    const key = [gap, off];
    if (!bestKey || key[0] < bestKey[0] - eps || (Math.abs(key[0] - bestKey[0]) <= eps && key[1] < bestKey[1])) { best = other; bestKey = key; }
  }
  return best;
}

/** The pane before / after `id` in reading order, wrapping around (Ghostty's goto_split:previous/next). */
export function cycle(tree, id, step) {
  const ids = leaves(tree);
  const i = ids.indexOf(id);
  if (i < 0 || ids.length < 2) return null;
  return ids[(i + step + ids.length) % ids.length];
}

/**
 * The drop zone under a point of a pane (x, y as fractions of its width and height): its nearest
 * edge, measured in the pane's own proportions, as Ghostty splits the pane into four triangles.
 */
export function dropSide(x, y) {
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return Object.keys(d).reduce((m, k) => (d[k] < d[m] ? k : m), 'left');
}
/** The half of a pane a drop on `side` would give the new terminal, as a unit rectangle of the pane. */
export function sideRect(side) {
  return { left: { x: 0, y: 0, w: 0.5, h: 1 }, right: { x: 0.5, y: 0, w: 0.5, h: 1 }, top: { x: 0, y: 0, w: 1, h: 0.5 }, bottom: { x: 0, y: 0.5, w: 1, h: 0.5 } }[side];
}

/** A layout from untrusted JSON (storage, a message), checked; null if it isn't one. */
export function parse(raw, { maxPanes = 64 } = {}) {
  const seen = new Set();
  const rec = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH) throw new Error('bad');
    if (typeof n.id === 'string') {
      if (!n.id || n.id.length > 200 || seen.has(n.id)) throw new Error('bad');
      seen.add(n.id);
      if (seen.size > maxPanes) throw new Error('bad');
      return leaf(n.id);
    }
    if (n.dir !== 'row' && n.dir !== 'column') throw new Error('bad');
    return { dir: n.dir, ratio: clampRatio(Number(n.ratio)), a: rec(n.a, depth + 1), b: rec(n.b, depth + 1) };
  };
  try { return rec(raw, 0); } catch { return null; }
}
export const serialize = tree => JSON.stringify(tree);
