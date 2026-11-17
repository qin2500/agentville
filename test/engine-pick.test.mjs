// M3 hits: per-slice hit list (render/hits.js) and depth-correct picking (render/pick.js), from the brief's spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHits, actorRect, depthOfKey } from '../web/src/engine/render/hits.js';
import { pick, imageAlphaAt } from '../web/src/engine/render/pick.js';
import { sortKey, feetKey, LAYER } from '../web/src/engine/render/depth.js';
import { toScreen } from '../web/src/engine/core/coords.js';

const toCss = (x, y) => [x + 400, y + 300];           // camera at 0,0, zoom 1, 800x600 view
const css = (wx, wy) => toCss(wx, wy);
// A building slice: one 16 px strip, `depth` = its key's depth row, rect at world (dx, dy) sw x sh.
const slice = (oid, depth, dx, dy, sw = 16, sh = 48, extra = {}) => ({
  key: sortKey(depth, 0, LAYER.OBJECT, Math.floor(dx / 16)), col: Math.floor(dx / 16), depth,
  sx: 0, sy: 0, sw, sh, dx, dy, img: { tag: oid, width: sw, height: sh }, oid, hit: 'house', obj: { id: oid }, z: 20, ...extra });
// An actor item as the renderer builds it (drawn, interpolated feet x, y; sprite 20x22 with the feet pivot at 10,18).
const actorItem = (id, x, y, extra = {}) => {
  const p = toScreen(x, y);
  return { key: feetKey(x, y, LAYER.ACTOR), actor: { id, kind: 'agent', x, y }, x, y, oid: id, hit: 'agent', z: 0, p,
    img: { width: 20, height: 22 }, w: 20, h: 22, pivot: { x: 10, y: 18 }, ...extra };
};
const sorted = items => items.slice().sort((a, b) => a.key - b.key);   // back to front, as merged
const opaque = () => true;

test('buildHits: one hit per slice, actor rect from pivot and drawn size, front to back', () => {
  const a = slice('b', 6, 0, -40), b = slice('b', 6, 16, -40), v = actorItem('v', 3.5, 4.5);
  const hits = buildHits(sorted([a, b, v]), toCss);
  assert.deepEqual(hits.map(h => h.id), ['v', 'b', 'b']);
  const p = toScreen(3.5, 4.5);
  const [x0, y0] = css(Math.round(p.sx - 10), Math.round(p.sy - 18));
  assert.deepEqual(hits[0].rect, [x0, y0, x0 + 20, y0 + 22]);
  assert.deepEqual(actorRect(v), [Math.round(p.sx - 10), Math.round(p.sy - 18), Math.round(p.sx - 10) + 20, Math.round(p.sy - 18) + 22]);
  assert.equal(hits[0].key, v.key);
  for (const h of hits.slice(1)) assert.equal(h.kind, 'house');
  assert.deepEqual(hits[1].rect, [...css(16, -40), ...css(32, 8)]);
  assert.equal(hits[1].src.img.tag, 'b');
});

test('buildHits: items without hit make no hit; actor without sprite gets a 16x24 box', () => {
  const prop = { ...slice('p', 9, 0, -10), hit: undefined };
  const v = { key: feetKey(1.5, 1.5), actor: { id: 'c' }, x: 1.5, y: 1.5, oid: 'c', hit: 'agent' };
  const hits = buildHits(sorted([prop, v]), toCss);
  assert.deepEqual(hits.map(h => h.id), ['c']);
  const p = toScreen(1.5, 1.5);
  assert.deepEqual(hits[0].rect, [...css(Math.round(p.sx - 8), Math.round(p.sy - 24)), ...css(Math.round(p.sx - 8) + 16, Math.round(p.sy))]);
  assert.equal(hits[0].occluded, true, 'a prop drawn after it still occludes');
});

test("a point on a building's transparent corner, with nothing behind, picks nothing", () => {
  const s = slice('b', 6, 0, -48);
  const hits = buildHits([s], toCss);
  const [x, y] = css(1, -47);   // top-left corner pixel of the strip
  // the art is transparent in the top-left 4x4 corner, opaque elsewhere
  const alphaAt = imageAlphaAt({ read: (img, u, v) => (u < 4 && v < 4 ? 0 : 255) });
  assert.equal(pick(hits, x, y, { alphaAt }), null);
  assert.equal(pick(hits, x, y)?.id, 'b', 'without alphaAt the slice rect is the hit area');
  const [mx, my] = css(8, -20);
  assert.equal(pick(hits, mx, my, { alphaAt })?.id, 'b', 'an opaque pixel picks the building');
});

test('a transparent slice pixel falls through to the slice behind it', () => {
  const back = slice('far', 4, 0, -60, 16, 60), front = slice('near', 8, 0, -30, 16, 30, { oid: 'near' });
  const hits = buildHits(sorted([back, front]), toCss);
  assert.deepEqual(hits.map(h => h.id), ['near', 'far']);
  const [x, y] = css(4, -28);
  const alphaAt = (h) => h.id !== 'near';
  assert.equal(pick(hits, x, y, { alphaAt }).id, 'far');
});

test('two overlapping slices pick the front one', () => {
  const back = slice('far', 4, 0, -60, 16, 60), front = slice('near', 8, 0, -30, 16, 30);
  const hits = buildHits(sorted([front, back]), toCss);
  const [x, y] = css(8, -10);
  assert.equal(pick(hits, x, y).id, 'near');
  assert.equal(pick(hits, x, y, { alphaAt: opaque }).id, 'near');
  const [ux, uy] = css(8, -50);
  assert.equal(pick(hits, ux, uy).id, 'far', 'above the front slice only the back one is there');
});

test('villager standing in front of a building wall picks the villager', () => {
  // building cell (3, 3): depth 6. Villager on the centre of (3, 4): depth 7, drawn over the wall
  const p = toScreen(3.5, 4.5);
  const wall = slice('house', 6, Math.round(p.sx) - 16, Math.round(p.sy) - 80, 32, 72);
  const v = actorItem('v', 3.5, 4.5);
  assert.ok(v.key > wall.key);
  const hits = buildHits(sorted([wall, v]), toCss);
  assert.equal(hits[0].id, 'v');
  assert.ok(!hits[0].occluded);
  const [x, y] = css(p.sx, p.sy - 8);
  assert.equal(pick(hits, x, y, { alphaAt: opaque }).id, 'v');
  const [wx, wy] = css(p.sx, p.sy - 60);
  assert.equal(pick(hits, wx, wy, { alphaAt: opaque }).id, 'house', 'above the villager the wall is picked');
});

test('villager behind a building (occluded, x-rayed) picks the villager', () => {
  // villager on the centre of (3, 2): depth 5, behind the building cell (5, 5) at depth 10 whose tall slice hides it
  const p = toScreen(3.5, 2.5);
  const tower = slice('tower', 10, Math.round(p.sx) - 16, Math.round(p.sy) - 60, 32, 100);
  const v = actorItem('v', 3.5, 2.5);
  const hits = buildHits(sorted([tower, v]), toCss);
  assert.deepEqual(hits.map(h => h.id), ['tower', 'v']);
  const vh = hits.find(h => h.id === 'v');
  assert.equal(vh.occluded, true);
  assert.ok(depthOfKey(tower.key) - depthOfKey(vh.key) > 1, 'far behind: only the x-ray rule can make it win');
  const [x, y] = css(p.sx, p.sy - 8);
  assert.equal(pick(hits, x, y, { alphaAt: opaque }).id, 'v');
  assert.equal(pick(hits, x, y).id, 'v');
  const [tx, ty] = css(p.sx, p.sy + 30);
  assert.equal(pick(hits, tx, ty, { alphaAt: opaque }).id, 'tower', 'outside the villager rect the tower wins');
});

test('tie rule: an agent at most one depth row behind the winning slice wins, further back does not', () => {
  const s = { id: 's', kind: 'house', rect: [0, 0, 100, 100], key: sortKey(10, 0, LAYER.OBJECT, 0), src: { img: {}, sx: 0, sy: 0, sw: 100, sh: 100 } };
  const near = { id: 'n', kind: 'agent', rect: [10, 10, 30, 40], key: sortKey(9, 3, LAYER.ACTOR, 0) };
  const same = { id: 'm', kind: 'agent', rect: [10, 10, 30, 40], key: sortKey(10, 0, LAYER.ACTOR, -1) - 8192 };
  const far = { id: 'f', kind: 'agent', rect: [10, 10, 30, 40], key: sortKey(8, 3, LAYER.ACTOR, 0) };
  assert.equal(pick([s, near], 20, 20).id, 'n');
  assert.equal(pick([s, same], 20, 20).id, 'm');
  assert.equal(pick([s, far], 20, 20).id, 's');
  assert.equal(pick([s, { ...far, occluded: true }], 20, 20).id, 'f', 'x-rayed agents always win');
  assert.equal(pick([s, near], 50, 50).id, 's', 'the agent rect must contain the point');
  assert.equal(pick([s, { ...near, kind: 'ship' }], 20, 20).id, 's', 'only agents win ties');
});

test('pick: empty list, misses and bad points', () => {
  assert.equal(pick([], 1, 1), null);
  assert.equal(pick(null, 1, 1), null);
  assert.equal(pick([{ id: 'a', kind: 'agent', rect: [0, 0, 10, 10], key: 0 }], 20, 20), null);
  assert.equal(pick([{ id: 'a', kind: 'agent', rect: [0, 0, 10, 10], key: 0 }], NaN, 1), null);
});

test('imageAlphaAt maps the CSS point to the source pixel (zoomed rect) and treats failures as opaque', () => {
  const seen = [];
  const at = imageAlphaAt({ threshold: 16, read: (img, u, v) => { seen.push([u, v]); return 10; } });
  const h = { rect: [100, 100, 132, 196], src: { img: {}, sx: 16, sy: 4, sw: 16, sh: 48 } };   // drawn at 2x
  assert.equal(at(h, 110, 120), false);
  assert.deepEqual(seen[0], [16 + 5, 4 + 10]);
  const boom = imageAlphaAt({ read: () => { throw new Error('tainted'); } });
  assert.equal(boom(h, 110, 120), true);
  assert.equal(imageAlphaAt()({ rect: [0, 0, 1, 1], src: { img: null } }, 0, 0), true);
  // the default reader uses a canvas-like img's pixels
  const data = new Uint8ClampedArray(4 * 4); data[3] = 255;                       // 2x2 image: only (0,0) opaque
  const img = { width: 2, height: 2, getContext: () => ({ getImageData: () => ({ data }) }) };
  const def = imageAlphaAt();
  const hh = { rect: [0, 0, 2, 2], src: { img, sx: 0, sy: 0, sw: 2, sh: 2 } };
  assert.equal(def(hh, 0.5, 0.5), true);
  assert.equal(def(hh, 1.5, 1.5), false);
});
