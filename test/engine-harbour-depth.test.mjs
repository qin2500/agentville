import './support/ensure-mods-index.mjs';
// Harbour depth order under engine v2 (2026-11-17, "the port is still completely bugged, the sprite layering over there is
// just not right"). Classic dock-art.js is the reference: its piers and quay are ground under every upright, and its
// hulls, lamps, cranes and porters sort among themselves by footprint. One test (or a few) per layering bug, on the real
// tier-4 harbour of the e2e fixture (mods/agentville.fantasy/venues.js plan, ambient/ship.js moorings):
//   1. a hull was one sprite at the depth of its middle: a ship moored EAST of a pier had its bow under the next plank
//      section, and every pier slice deeper than the hull's middle covered it (render/slice.js sliceHull: per strip);
//   2. a pier deck sorted at the front row of its footprint, so a porter or an agent on the back rows of a plank section
//      (and a bollard on it) sank into the planks, and a hull moored west of a pier lay under it (classic: piers are
//      ground; slice.js DECK_SINK);
//   3. hulls in one lane, porters beside hulls, the pier-end lamps: per-strip depth sorts each against the right part;
//   4. a sailing ship (down the fairway, across to the mouth) against the piers and the breakwater, at every point;
//   5. a gull in the air sorted at the water under it, behind sails and masts (classic draws gulls over everything);
//   6. the pier hover outline was drawn over everything, ships and porters included (classic: the deck's own outline);
//   7. a sliced hull still picks by its pixels, one hit per strip, and gets one PR tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrom, loadFixture } from './engine-support/sim-harness.mjs';

const { mooring } = await import('../mods/agentville.fantasy/ambient/ship.js');
const { PIER_ID } = await import('../mods/agentville.fantasy/venues.js');
const { sliceSprite, sliceHull, blockStripDepth, DECK_SINK, isDeck } = await import('../web/src/engine/render/slice.js');
const { sortKey, feetKey, LAYER } = await import('../web/src/engine/render/depth.js');
const { toScreen } = await import('../web/src/engine/core/coords.js');
const { createCraftArt, HULL_LEN } = await import('../web/src/engine/render/craft-art.js');
const { buildHits } = await import('../web/src/engine/render/hits.js');
const { pick } = await import('../web/src/engine/render/pick.js');
const { createRenderer } = await import('../web/src/engine/render/renderer.js');
const { venueOutlines } = await import('../web/src/engine/render/venue-outline.js');

/** A canvas for node: the 2d calls the craft art makes, over one RGBA buffer (as engine-harbour-ui.test.mjs). */
function fakeCanvas(width, height) {
  const d = new Uint8ClampedArray(width * height * 4);
  const g = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData(img, x0, y0) { for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) { const k = (j * img.width + i) * 4, x = x0 + i, y = y0 + j; if (img.data[k + 3] && x >= 0 && y >= 0 && x < width && y < height) d.set(img.data.slice(k, k + 4), (y * width + x) * 4); } },
    getImageData: () => ({ data: d, width, height }),
  };
  return { width, height, getContext: () => g };
}
const art = createCraftArt({ createCanvas: fakeCanvas });

const { world } = buildFrom(loadFixture('harbour.json'));
const V = world.venues.dock;
const objs = [...world.objects.values()].filter(o => o.data?.venue === V.id);
const piers = objs.filter(o => o.model === 'pier'), quay = objs.find(o => o.model === 'quay');
const ROW = 4 * 8 * 4096;   // key distance of one depth row (depth.js)
const depthOf = key => Math.floor(key / ROW);

/** A stand-in sprite for a static: its footprint diamond, `up` px of height above it (only the rects matter here). */
function spriteOf(o, up = (o.z | 0) + 2) {
  const w = o.w || 1, h = o.h || 1, n = toScreen(o.tx, o.ty);
  const x0 = (o.tx - o.ty - h) * 16, x1 = (o.tx + w - o.ty) * 16, y0 = (o.tx + o.ty) * 8 - up, y1 = (o.tx + w + o.ty + h) * 8 + 4;
  return { img: { width: x1 - x0, height: y1 - y0, tag: o.id }, pivot: { x: n.sx - x0, y: n.sy - y0 } };
}
const slicesOf = o => sliceSprite(o, spriteOf(o)).map(s => ({ ...s, oid: o.id, obj: o }));
const deckSlices = [...piers, quay].flatMap(slicesOf);
const ovX = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
const ovR = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const rectOf = s => [s.dx, s.dy, s.dx + s.sw, s.dy + s.sh];

/** A hull at feet (x, y) heading `face`, class `cls`, as the renderer draws it: its real sprite, sliced per strip. */
function hull(x, y, cls = 'cutter', face = 1) {
  const f = art.frame({ kind: 'token', id: 'token:t', item: 't', model: cls, face });
  const p = toScreen(x, y), X0 = Math.round(p.sx - f.pivot.x), Y0 = Math.round(p.sy - f.pivot.y);
  const parts = sliceHull({ x, y, face, len: f.len }, X0, X0 + f.img.width);
  return { f, x, y, X0, Y0, parts, rects: parts.map(q => [q.L, Y0, q.R, Y0 + f.img.height]) };
}
const moored = (b, model) => { const m = mooring({ tx: b.tx, ty: b.ty, berth: b.id, model }); return hull(m.x, m.y, model, b.face); };
const pierBerths = V.berths.filter(b => PIER_ID.test(b.id));
const sideOf = b => (piers.some(p => p.tx === b.tx + 1) ? 'w' : 'e');   // west of its pier, or east

test('the fixture harbour: tier 4, piers and quay are decks, berths on both sides', () => {
  assert.ok(piers.length >= 10 && quay, 'piers and a quay');
  assert.ok(piers.every(isDeck) && isDeck(quay), 'the plan flags them deck (world/venue.js keeps the flag)');
  assert.ok(!objs.filter(o => !['pier', 'quay'].includes(o.model)).some(isDeck), 'nothing else is a deck');
  assert.ok(pierBerths.some(b => sideOf(b) === 'w') && pierBerths.some(b => sideOf(b) === 'e'));
  assert.equal(HULL_LEN.brig, 72 / 16);
});

// ---------------------------------------------------------------- 1. hull per strip

test('sliceHull: one piece per 16-px strip of the sprite, keyed by the frontmost keel point in that strip', () => {
  // a keel along y at column a (x = a + .5): strip k holds keel points with x - y in [k, k + 1), depth 2a - k
  const a = 3, parts = sliceHull({ x: a + 0.5, y: 10, face: 1, len: 4 }, -200, -40);
  assert.deepEqual(parts.map(p => p.col), [-13, -12, -11, -10, -9, -8, -7, -6, -5, -4, -3]);
  for (const p of parts) { assert.equal(p.R - p.L, p.col === -13 || p.col === -3 ? 8 : 16, 'whole strips but the clipped first'); assert.equal(depthOf(p.key), Math.floor(p.depth)); }
  const keel = parts.filter(p => p.col >= -9 && p.col <= -5);   // the keel spans cols 3.5 - 12 .. 3.5 - 8
  for (const p of keel.slice(1, -1)) assert.equal(p.depth, 2 * a - p.col, `strip ${p.col}`);
  // strips past the ends clamp to the end's depth (bowsprit, beam, sails)
  assert.equal(parts[0].depth, parts[1].depth); assert.equal(parts.at(-1).depth, parts.at(-2).depth);
  // a hull on the centre of one cell ties a static on that cell on depth and wins on layer, as any actor does
  const one = sliceHull({ x: 5.5, y: 7.5, face: 1, len: 0.01 }, -40, -24)[0];
  assert.ok(one.key > sortKey(12, 0, LAYER.OBJECT, one.col) && one.key < sortKey(13, 0, LAYER.GROUND_PROP, one.col));
  // along x (face 0/2) the same, mirrored
  const ex = sliceHull({ x: 10, y: 3.5, face: 0, len: 4 }, 16 * 4, 16 * 10);
  assert.ok(ex.every((p, i) => i === 0 || p.depth >= ex[i - 1].depth), 'bow east: depth grows to the right');
});

test('[har.depth-hull-over-pier] a hull moored east of a pier is over the planks along its whole length (its bow was under the next section)', () => {
  let checked = 0, oldWrong = 0;
  for (const b of pierBerths.filter(b => sideOf(b) === 'e')) for (const model of ['cutter', 'brig']) {
    const H = moored(b, model), mid = feetKey(H.x, H.y, LAYER.ACTOR);
    for (const s of deckSlices.filter(s => s.obj.model === 'pier')) {
      // the plank slices' real strip depths (without the deck sink): the hull is in front of its pier on its own merits
      const plain = sortKey(blockStripDepth(s.obj, s.col), 0, LAYER.GROUND_PROP, s.col);
      H.parts.forEach((q, i) => {
        if (!ovR(rectOf(s), H.rects[i])) return;
        checked++;
        assert.ok(q.key > plain, `${model} at ${b.id}, strip ${q.col}: over ${s.oid}`);
        assert.ok(q.key > s.key, 'and over the sunk deck');
        if (mid < plain) oldWrong++;   // one key at the hull's middle: under this plank strip
      });
    }
  }
  assert.ok(checked > 100, `${checked} strip pairs`);
  assert.ok(oldWrong > 0, 'the old single middle key put pier planks over east hulls');
});

// ---------------------------------------------------------------- 2. decks are ground

test('[har.depth-decks-are-ground] every hull moored at a pier, either side, is over every deck slice it overlaps (classic: piers are ground)', () => {
  for (const b of pierBerths) for (const model of ['dinghy', 'cutter', 'brig']) {
    const H = moored(b, model);
    for (const s of deckSlices) H.parts.forEach((q, i) => {
      if (ovR(rectOf(s), H.rects[i])) assert.ok(q.key > s.key, `${model} at ${b.id} (${sideOf(b)}), strip ${q.col}: over ${s.oid}`);
    });
  }
});

test('[har.depth-people-on-decks] a porter anywhere on a pier or the quay is over the planks under and round its feet', () => {
  let sunkBefore = 0, n = 0;
  for (const d of [...piers, quay]) for (let y = d.ty; y < d.ty + d.h; y++) for (let x = d.tx; x < d.tx + d.w; x++) {
    const key = feetKey(x + 0.5, y + 0.5, LAYER.ACTOR), p = toScreen(x + 0.5, y + 0.5), r = [p.sx - 8, p.sy - 24, p.sx + 8, p.sy];
    for (const s of deckSlices) {
      if (!ovR(rectOf(s), r)) continue;
      n++;
      assert.ok(key > s.key, `porter on (${x},${y}) over ${s.oid} strip ${s.col}`);
      if (s.obj === d && key < sortKey(s.depth, 0, LAYER.GROUND_PROP, s.col)) sunkBefore++;
    }
  }
  assert.ok(n > 500);
  assert.ok(sunkBefore > 0, 'with the deck at its front row, porters on the back rows sank into the planks');
});

test('[har.depth-props-on-decks] bollards, lamps, cranes, warehouses and crates stand over the decks', () => {
  for (const o of objs.filter(o => !isDeck(o))) for (const s of slicesOf(o)) for (const d of deckSlices) {
    if (ovR(rectOf(s), rectOf(d))) assert.ok(s.key > d.key, `${o.id} strip ${s.col} over ${d.oid}`);
  }
});

// ---------------------------------------------------------------- 3. hulls, porters and lamps among themselves

test('[har.depth-porter-and-hull] a porter beside an east hull is behind it; beside a west hull, in front of it', () => {
  for (const b of pierBerths) {
    const H = moored(b, 'cutter'), w = sideOf(b) === 'w', x = w ? b.tx + 1 : b.tx - 1, y = Math.floor(H.y);
    const key = feetKey(x + 0.5, y + 0.5, LAYER.ACTOR), p = toScreen(x + 0.5, y + 0.5), r = [p.sx - 8, p.sy - 24, p.sx + 8, p.sy];
    let n = 0;
    H.parts.forEach((q, i) => {
      if (!ovR(r, H.rects[i])) return;
      n++;
      if (w) assert.ok(key > q.key, `porter at (${x},${y}) in front of the west hull at ${b.id}, strip ${q.col}`);
      else assert.ok(key < q.key, `porter at (${x},${y}) behind the east hull at ${b.id}, strip ${q.col}`);
    });
    assert.ok(n > 0, b.id);
  }
});

test('[har.depth-lane] in one lane, the hull further out to sea is over the one inside it wherever they overlap', () => {
  let n = 0;
  for (const b of pierBerths) {
    const next = pierBerths.find(o => o.tx === b.tx && o.ty === b.ty + 3);
    if (!next) continue;
    const A = moored(b, 'cutter'), B = moored(next, 'cutter');
    A.parts.forEach((qa, i) => B.parts.forEach((qb, j) => {
      if (qa.col !== qb.col || !ovR(A.rects[i], B.rects[j])) return;
      n++;
      assert.ok(qb.key > qa.key, `${next.id} over ${b.id} in strip ${qa.col}`);
    }));
  }
  assert.ok(n > 20);
});

test('[har.depth-pier-lamps] a pier-end lamp stands in front of the west hull at the pier head (classic: it covers the hull and sails)', () => {
  let n = 0;
  for (const lamp of objs.filter(o => o.model === 'lamp' && piers.some(p => p.tx === o.tx && o.ty === p.ty + p.h - 1))) {
    const b = pierBerths.filter(o => o.tx === lamp.tx - 1).sort((p, q) => q.ty - p.ty)[0];
    if (!b) continue;
    const H = moored(b, 'brig');
    for (const s of slicesOf(lamp)) H.parts.forEach((q, i) => { if (ovR(rectOf(s), H.rects[i])) { n++; assert.ok(s.key > q.key, `${lamp.id} over ${b.id} strip ${q.col}`); } });
  }
  assert.ok(n > 0);
});

// ---------------------------------------------------------------- 4. sailing

test('[har.depth-sailing] a ship sailing out (down the fairway, across to the mouth) is over every deck at every step, and behind the breakwater in front of it', () => {
  const bw = objs.filter(o => o.model === 'breakwater'), south = bw.find(o => o.w > 1), m = V.nodes.mouth;
  assert.ok(south && m);
  const fair = piers[0].tx - 2 + 0.5, turnY = m.ty + 0.5 - 2;
  const steps = [];
  for (let y = piers[0].ty; y <= turnY; y += 0.25) steps.push([fair, y, 1]);
  for (let x = fair; x <= m.tx + 0.5; x += 0.25) steps.push([x, turnY, 0]);
  let behind = 0;
  for (const [x, y, face] of steps) {
    const H = hull(x, y, 'cutter', face);
    H.parts.forEach((q, i) => {
      for (const s of deckSlices) if (ovR(rectOf(s), H.rects[i])) assert.ok(q.key > s.key, `at (${x},${y}) strip ${q.col} over ${s.oid}`);
      // the south arm of the breakwater lies in front of the course two rows inside the mouth: it covers the hull
      for (const s of slicesOf(south)) if (s.col === q.col && ovR(rectOf(s), H.rects[i])) { behind++; assert.ok(s.key > q.key, `bw.south strip ${q.col} over the hull at (${x},${y})`); }
    });
  }
  assert.ok(behind > 0);
});

// ---------------------------------------------------------------- 5-7. the renderer: gulls, hover outline, hits, tags

function mkRenderer(objects) {
  const ops = [];
  const gfx = {
    begin() {}, clear() {}, end() {}, setComposite() {}, size: () => ({ w: 800, h: 600 }),
    image: (img, ...r) => ops.push(['image', img.tag, ...r]), rect: () => ops.push(['rect']), poly: pts => ops.push(['poly', Math.min(...pts.map(q => q[0]))]),
  };
  // the pier's stand-in covers its 2 x 6 footprint (so each outline strip has the pier's slice in it); others 32 x 16
  class SpriteCache { get(key) { return key === 'pier' ? { img: { tag: key, width: 128, height: 80 }, bounds: { x: 0, y: 0, w: 128, h: 80 }, pivot: { x: 96, y: 8 } } : { img: { tag: key, width: 32, height: 16 }, bounds: { x: 0, y: 0, w: 32, h: 16 }, pivot: { x: 16, y: 0 } }; } pump() {} }
  const craft = {
    kinds: new Set(['token', 'gull']),
    frame: a => (a.kind === 'gull' ? { img: { tag: 'gull', width: 11, height: 7 }, pivot: { x: 5, y: 4 } }
      : { img: { tag: a.id, width: 80, height: 60 }, pivot: { x: 40, y: 50 }, len: HULL_LEN.cutter }),
  };
  const deps = {
    SpriteCache, spriteKey: o => o.model, rasterize: () => ({}), loadClassicArt: null,   // the real artView: what slicing sees
    createGround: () => ({ drawChunks: () => ({}), chunkKeys: () => [], invalidate() {} }),
    createLighting: () => ({ setTime() {}, lights: () => [], draw() {} }),
    createXray: () => ({ occluded: () => false, draw() {} }), effects: { draw() {} }, badges: { draw() {} },
    createCraftArt: () => craft, createActorArt: null, createMapTiles: null, createTileStore: null, createActorAtlas: null, createEffects: null,
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  r.setWorld({ objects: new Map(objects.map(o => [o.id, o])), version: 1, villages: [] });
  return { r, ops };
}
const frame = (o = {}) => ({ cam: { x: 3, y: 3, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors: [], t: 0, night: 0, mode: 'town', ...o });
const VIS = 1;   // FLAGS.VISIBLE

test('[har.depth-renderer] a hull draws strip by strip, a gull last of the world layer, the pier outline under the hull', () => {
  const pier = { id: 'pier', kind: 'venue', model: 'pier', tx: 2, ty: 0, w: 2, h: 6, z: 0, walk: 'floor', deck: true, variant: 0, data: { venue: 'dock' } };
  const crane = { id: 'crane', kind: 'prop', model: 'crane', tx: 6, ty: 6, w: 1, h: 1, z: 46, walk: 'block', variant: 0 };
  const { r, ops } = mkRenderer([pier, crane]);
  const ship = { id: 'token:p#1', kind: 'token', x: 4.5, y: 3, face: 1, flags: VIS };
  const gull = { id: 'gull:1', kind: 'gull', x: 1, y: 1, face: 0, flags: VIS, alt: 20 };
  r.draw(frame({ actors: [gull, ship], hoverPanel: 'dock' }));
  const imgs = ops.map((o, i) => [o, i]).filter(([o]) => o[0] === 'image');
  const strips = imgs.filter(([o]) => o[1] === ship.id);
  assert.ok(strips.length >= 5, `the hull drew in ${strips.length} strips`);
  for (const [o] of strips) assert.ok(o[3] + 0 >= 0 && o[4] <= 16, 'each a strip of at most 16 px of the sprite');
  assert.equal(strips.reduce((s, [o]) => s + o[4], 0), 80, 'the strips make up the whole sprite');
  const last = imgs.at(-1)[0];
  assert.equal(last[1], 'gull', 'the gull is drawn over everything in the world layer');
  const polys = ops.map((o, i) => [o, i]).filter(([o]) => o[0] === 'poly').map(([, i]) => i);
  assert.ok(polys.length > 0, 'the hovered pier is outlined');
  assert.ok(Math.max(...polys) < strips[0][1], 'the outline is drawn before (under) the hull moored at the pier');
  const pierAt = imgs.filter(([o]) => o[1] === 'pier').map(([, i]) => i);
  assert.ok(Math.max(...pierAt) < strips[0][1], 'the pier deck is under the hull too (its deck flag reaches the slicing)');
  // in each strip, the outline is drawn over the deck's own slice there (image op: tag, sx, sy, sw, sh, dx, ...)
  for (const i of polys) {
    const k = Math.floor(ops[i][1] / 16), under = pierAt.find(j => Math.floor(ops[j][6] / 16) === k);
    assert.ok(under !== undefined && under < i, `strip ${k}: the outline over the deck it outlines`);
  }
  // hits: one per strip of the hull, each carrying its own strip of the sprite
  const hits = r.draw(frame({ actors: [ship] })).filter(h => h.kind === 'ship');
  assert.equal(hits.length, strips.length);
  assert.deepEqual(hits.map(h => h.src.sx).sort((a, b) => a - b), [...new Set(hits.map(h => h.src.sx))].sort((a, b) => a - b));
  for (const h of hits) assert.equal(h.rect[2] - h.rect[0], h.src.sw);
});

test('[har.depth-outline-under-hulls] venueOutlines flags a run of decks; its strips sort with the deck', () => {
  const p = (id, ty) => ({ id, kind: 'venue', tx: 0, ty, w: 2, h: 3, walk: 'floor', deck: true, data: { venue: 'dock' } });
  const out = venueOutlines([p('a', 0), p('b', 3), { ...p('c', 0), tx: 7, deck: undefined }]);
  assert.deepEqual(out.map(o => !!o.deck).sort(), [false, true]);
  assert.equal(out.find(o => o.deck).h, 6);
});

test('[har.depth-hull-pixels] a hull strip over the pier picks the ship by its pixels; the air of that strip is the pier', () => {
  const b = pierBerths.find(b => sideOf(b) === 'e'), H = moored(b, 'brig');
  const W = H.f.img.width, Hh = H.f.img.height, alpha = H.f.img.getContext('2d').getImageData(0, 0, W, Hh).data;
  const pierS = deckSlices.filter(s => s.obj.model === 'pier');
  const items = [...pierS.map(s => ({ ...s, hit: 'dock' })), ...H.parts.map((q, i) => ({ key: q.key, clip: [q.L, q.R], lead: i === 0, actor: { id: 'token:p#1', kind: 'token' }, oid: 'token:p#1', hit: 'ship', x: H.x, y: H.y, p: toScreen(H.x, H.y), img: H.f.img, pivot: H.f.pivot }))].sort((p, q) => p.key - q.key);
  const hits = buildHits(items, (x, y) => [x, y]);
  const alphaAt = (h, x, y) => {
    if (h.src.img !== H.f.img) return true;
    const u = Math.floor(h.src.sx + x - h.rect[0]), v = Math.floor(h.src.sy + y - h.rect[1]);
    return alpha[(v * W + u) * 4 + 3] >= 16;
  };
  let solid = 0, air = 0;
  for (let v = 0; v < Hh; v++) for (let u = 0; u < W; u++) {
    const x = H.X0 + u + 0.5, y = H.Y0 + v + 0.5;
    if (!pierS.some(s => ovR(rectOf(s), [x, y, x + 0.1, y + 0.1]))) continue;
    const got = pick(hits, x, y, { alphaAt })?.kind;
    if (alpha[(v * W + u) * 4 + 3] >= 16) { solid++; assert.equal(got, 'ship', `hull pixel (${u},${v})`); } else { air++; assert.equal(got, 'dock', `air (${u},${v})`); }
  }
  assert.ok(solid > 50 && air > 50, `${solid} hull and ${air} air pixels over the pier`);
});

test('deck sink: past any world depth, and the sunk key keeps the strip order among decks', () => {
  assert.ok(DECK_SINK > 8192);
  const a = sliceSprite(piers[0], spriteOf(piers[0])), next = piers.find(p => p.tx === piers[0].tx && p.ty === piers[0].ty + piers[0].h);
  const b = sliceSprite(next, spriteOf(next));
  for (const s of a) for (const t of b) if (s.col === t.col) assert.ok(t.key > s.key, 'the section further out to sea is over the one inside it');
  for (const s of a) assert.ok(s.key < sortKey(-4096, 0, LAYER.GROUND_PROP, 0) + ROW, 'under anything of a +-4096 world');
});
