// M3 x-ray: occlusion from the slices actually drawn in front, at the drawn (interpolated) position, silhouettes
// clipped to the occluders through gfx.silhouette (one offscreen mask). Spec: design §3.6 + the M3 brief.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createXray, MAX_XRAY, ALPHA_SELECTED, ALPHA_OTHER } from '../web/src/engine/render/xray.js';
import { createGfx, silhouettePixels } from '../web/src/engine/render/gfx-canvas2d.js';
import { sortKey, feetKey, LAYER } from '../web/src/engine/render/depth.js';
import { toScreen } from '../web/src/engine/core/coords.js';

const xray = createXray({ world: { objects: new Map(), grid: null } });
const slice = (oid, depth, dx, dy, sw = 32, sh = 100, layer = LAYER.OBJECT) => ({
  key: sortKey(depth, 0, layer, Math.floor(dx / 16)), sx: 0, sy: 0, sw, sh, dx, dy, img: { tag: oid }, oid, obj: { id: oid } });
const item = (id, x, y, actor = {}) => ({ key: feetKey(x, y, LAYER.ACTOR), x, y, p: toScreen(x, y), actor: { id, x, y, flags: 1, ...actor },
  img: { tag: 'spr:' + id, width: 20, height: 22 }, w: 20, h: 22, pivot: { x: 10, y: 18 } });
const recGfx = () => { const calls = []; return { calls, silhouette: o => { calls.push(['sil', o]); return true; }, rect: (...a) => calls.push(['rect', ...a]) }; };
// a tower at depth 10 covering the screen around (3.5, 2.5)
const P = toScreen(3.5, 2.5);
const tower = slice('tower', 10, Math.round(P.sx) - 16, Math.round(P.sy) - 60);

test('occluded: judged from slices drawn in front of the drawn sprite rect', () => {
  const behind = item('b', 3.5, 2.5);
  assert.equal(xray.occluded(behind.actor, { item: behind, slices: [tower] }), true);
  const front = item('f', 6.5, 6.5);   // depth 12, drawn after the tower
  assert.equal(xray.occluded(front.actor, { item: front, slices: [{ ...tower, dx: Math.round(toScreen(6.5, 6.5).sx) - 16, dy: Math.round(toScreen(6.5, 6.5).sy) - 60 }] }), false);
  const away = item('w', -5.5, 2.5);   // far to the left: no overlap
  assert.equal(xray.occluded(away.actor, { item: away, slices: [tower] }), false);
  const decal = slice('road', 10, tower.dx, tower.dy, 32, 100, LAYER.GROUND_PROP);
  assert.equal(xray.occluded(behind.actor, { item: behind, slices: [decal] }), false, 'ground props never hide anyone');
});

test('x-ray uses the interpolated (drawn) position, not raw actor x, y', () => {
  // the sim says the actor is already far away (x 20), the frame draws it between ticks at 3.5, 2.5
  const it = item('m', 3.5, 2.5, { x: 20.5, y: 2.5, px: 3.5, py: 2.5 });
  const g = recGfx();
  assert.equal(xray.draw(g, {}, [it], [tower]), 1);
  const o = g.calls[0][1];
  assert.equal(o.dx, Math.round(P.sx - 10));
  assert.equal(o.dy, Math.round(P.sy - 18));
  assert.equal(o.img.tag, 'spr:m', 'the drawn sprite is the silhouette shape');
  assert.deepEqual([o.sw, o.sh], [20, 22]);
  // and the raw position (x 20.5) is not behind the tower: as a raw item it is not occluded
  const raw = item('m', 20.5, 2.5);
  assert.equal(xray.draw(recGfx(), {}, [raw], [tower]), 0);
});

test('silhouette is clipped to only the slices in front of that actor', () => {
  const behindTower = slice('back', 2, tower.dx, tower.dy);   // drawn before the actor: not an occluder
  const farAway = slice('other', 12, tower.dx + 500, tower.dy);
  const g = recGfx();
  xray.draw(g, {}, [item('b', 3.5, 2.5)], [behindTower, tower, farAway]);
  const clips = g.calls[0][1].clips;
  assert.deepEqual(clips.map(c => c.img.tag), ['tower']);
  assert.deepEqual([clips[0].dx, clips[0].dy, clips[0].sw, clips[0].sh], [tower.dx, tower.dy, 32, 100]);
});

test('alpha: selected 0.9, others 0.5; selected drawn first; ghosts and indoors skipped', () => {
  const g = recGfx();
  const n = xray.draw(g, {}, [item('o', 3.5, 2.5), item('s', 3.5, 2.5, { flags: 3 }), item('gh', 3.5, 2.5, { flags: 1 | 16 }), item('in', 3.5, 2.5, { indoors: true })], [tower]);
  assert.equal(n, 2);
  assert.deepEqual(g.calls.map(c => [c[1].img.tag, c[1].alpha]), [['spr:s', ALPHA_SELECTED], ['spr:o', ALPHA_OTHER]]);
  assert.equal(ALPHA_SELECTED, 0.9); assert.equal(ALPHA_OTHER, 0.5);
});

test('cap 32, the selected actor survives the cap, inputs not mutated', () => {
  const items = Array.from({ length: 50 }, (_, i) => item('x' + i, 3.5, 2.5));
  items.push(item('sel', 3.5, 2.5, { selected: true }));
  const snap = JSON.stringify(items), slices = [tower], sSnap = JSON.stringify(slices);
  const g = recGfx();
  assert.equal(xray.draw(g, {}, items, slices), MAX_XRAY);
  assert.equal(MAX_XRAY, 32);
  assert.equal(g.calls.length, 32);
  assert.equal(g.calls[0][1].img.tag, 'spr:sel');
  assert.equal(JSON.stringify(items), snap);
  assert.equal(JSON.stringify(slices), sSnap);
});

test('a gfx without silhouette (or one that cannot make the mask) gets rim + fill rects at the drawn rect', () => {
  const g = { calls: [], rect(...a) { this.calls.push(a); } };
  assert.equal(xray.draw(g, {}, [item('b', 3.5, 2.5)], [tower]), 1);
  assert.equal(g.calls.length, 2);
  assert.equal(g.calls[1][0], Math.round(P.sx - 10) + 2);
  const g2 = { calls: [], silhouette: () => false, rect(...a) { this.calls.push(a); } };
  xray.draw(g2, {}, [item('b', 3.5, 2.5)], [tower]);
  assert.equal(g2.calls.length, 2);
});

test('legacy fallbacks still work: occluded(actor) without slices, 3-argument draw', () => {
  assert.equal(xray.occluded({ x: 1, y: 1 }), false);
  assert.equal(xray.occluded(null, { slices: [tower] }), false);
  assert.equal(xray.draw(recGfx(), {}, [{ x: 1, y: 1, flags: 1 }]), 0);
});

// ---- gfx-canvas2d silhouette, against recording fake contexts
function fakeCtx(calls, tag) {
  return new Proxy({ globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, fillStyle: '' }, {
    get(t, k) { return k in t ? t[k] : (...a) => { calls.push([tag, k, ...a]); }; },
    set(t, k, v) { t[k] = v; calls.push([tag, 'set:' + k, v]); return true; },
  });
}
function fakeGfx({ mask = true } = {}) {
  const calls = [], made = [];
  const canvas = { width: 0, height: 0, clientWidth: 800, clientHeight: 600, getContext: () => fakeCtx(calls, 'main') };
  const maskCtx = () => {
    const c = fakeCtx(calls, 'mask');
    c.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    c.putImageData = (im, x, y) => { calls.push(['mask', 'putImageData', im, x, y]); };
    return c;
  };
  const makeCanvas = (w, h) => { if (!mask) return null; const c = { width: w, height: h, tag: 'mask', getContext: maskCtx }; made.push(c); return c; };
  const g = createGfx(canvas, { makeCanvas });
  g.begin(1, { x: 0, y: 0, z: 2 });
  calls.length = 0;
  return { g, calls, made };
}
// a raw RGBA buffer the alpha cache reads directly: w x h, opaque where fill(x, y)
const raw = (w, h, fill = () => true) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fill(x, y)) data[(y * w + x) * 4 + 3] = 255;
  return { width: w, height: h, data };
};

test('gfx.silhouette: one atlas canvas, reused; one upload per batch; each blit lands on the actor rect plus the 1 px rim', () => {
  const { g, calls, made } = fakeGfx();
  const o = { img: raw(20, 22), sx: 0, sy: 0, sw: 20, sh: 22, dx: 10, dy: 20, color: '#010203', rim: '#ffffff', alpha: 0.6,
    clips: [{ img: raw(16, 40), sx: 0, sy: 0, sw: 16, sh: 40, dx: 8, dy: 10 }, { img: raw(32, 40), sx: 16, sy: 0, sw: 16, sh: 40, dx: 24, dy: 10 }] };
  assert.equal(g.silhouette(o), true);
  assert.equal(g.silhouette(o), true);
  assert.equal(made.length, 1, 'the atlas canvas is made once and reused');
  assert.equal(calls.filter(c => c[1] === 'putImageData').length, 2, 'one upload per call');
  const blit = calls.filter(c => c[0] === 'main' && c[1] === 'drawImage');
  assert.equal(blit.length, 2);
  assert.equal(blit[0][2], made[0]);
  assert.deepEqual(blit[0].slice(7), [9, 19, 22, 24], 'lands on the actor rect plus the 1 px rim, in world px');
  // a batch of three: one upload, three blits from distinct atlas cells
  calls.length = 0;
  const r = g.silhouettes([o, { ...o, dx: 40 }, { ...o, dx: 70 }]);
  assert.deepEqual(r, [true, true, true]);
  assert.equal(calls.filter(c => c[1] === 'putImageData').length, 1);
  const cells = calls.filter(c => c[0] === 'main' && c[1] === 'drawImage').map(c => c.slice(3, 5).join(','));
  assert.equal(new Set(cells).size, 3);
});

test('silhouette pixels: colour inside the sprite, rim on its 1 px ring, only where a clip covers, scaled by alpha', () => {
  const W = 6, H = 6, px = new Uint8ClampedArray(W * H * 4);
  // a 4x4 opaque sprite at world (10, 10); the clip covers world x < 12 only
  const o = { img: raw(4, 4), sx: 0, sy: 0, sw: 4, sh: 4, dx: 10, dy: 10, color: '#ff0000', rim: 'rgba(0,0,255,0.5)', alpha: 0.5,
    clips: [{ img: null, sx: 0, sy: 0, sw: 2 + 1, sh: 10, dx: 9, dy: 5 }] };
  assert.equal(silhouettePixels(o, W, H, px, 0, 0, W), true);
  const at = (x, y) => [...px.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
  assert.deepEqual(at(1, 1), [255, 0, 0, 128], 'inside the sprite and the clip: the fill colour at alpha 0.5');
  assert.deepEqual(at(0, 1), [0, 0, 255, 64], 'the ring left of the sprite: the rim colour, its own alpha times 0.5');
  assert.equal(at(0, 0)[3], 0, 'a corner of the ring has no 4-neighbour inside the sprite');
  assert.equal(at(3, 1)[3], 0, 'outside the clip: nothing');
  assert.equal(silhouettePixels({ ...o, color: 'not a colour' }, W, H, px, 0, 0, W), false, 'an unreadable colour falls back');
});

test('gfx.silhouette: no offscreen canvas -> false; nothing to clip -> no-op', () => {
  const { g, calls } = fakeGfx({ mask: false });
  assert.equal(g.silhouette({ img: null, sx: 0, sy: 0, sw: 4, sh: 4, dx: 0, dy: 0, color: 'red', alpha: 0.6, clips: [{ img: null, sw: 4, sh: 4, dx: 0, dy: 0 }] }), false);
  assert.equal(g.silhouette({ sw: 4, sh: 4, dx: 0, dy: 0, alpha: 0.6, clips: [] }), true);
  assert.equal(calls.filter(c => c[1] === 'drawImage').length, 0);
});

test('night dims the silhouette colour and rim; day keeps them; the actor stays drawn (always findable)', () => {
  const colour = night => { const g = recGfx(); const n = xray.draw(g, {}, [item('o', 3.5, 2.5, { color: '#c8c8c8' })], [tower], { night }); assert.equal(n, 1); return g.calls[0][1]; };
  const day = colour(0), dark = colour(1);
  assert.equal(day.color, '#c8c8c8');
  assert.equal(dark.color, '#646464', 'full night: colour at half brightness');
  assert.ok(dark.rim.startsWith('rgba(128,128,128,') && day.rim.startsWith('rgba(255,255,255,'));
  assert.equal(dark.alpha, day.alpha, 'alpha unchanged: still readable behind the building');
  assert.ok(+/,([\d.]+)\)$/.exec(day.rim)[1] <= ALPHA_OTHER * 0.55 + 0.01, 'day rim is subtle');
});
