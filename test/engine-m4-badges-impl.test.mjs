import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeKind, layoutBadges, drawBadges, BADGE_W, BADGE_H } from '../web/src/engine/overlay/badges.js';
import { selectionMarks, drawMarks } from '../web/src/engine/render/marks.js';

const hit = (id, x = 100, y = 100) => ({ id, kind: 'agent', rect: [x, y, x + 16, y + 24] });
const fakeCanvas = () => { const calls = []; return { calls, getContext: () => new Proxy({}, { get: (t, k) => (...a) => calls.push([k, ...a]), set: () => true }) }; };

test('[vil.status-badges] kinds follow bucket, severity and prompt', () => {
  assert.equal(badgeKind({ bucket: 'stalled', severity: 'error' }), 'error');
  assert.equal(badgeKind({ bucket: 'stalled', prompt: 'ok?' }), 'click');
  assert.equal(badgeKind({ bucket: 'stalled' }), 'need');
  assert.equal(badgeKind({ status: { bucket: 'waiting' } }), 'wait');
  assert.equal(badgeKind({ bucket: 'building' }), 'build');
  assert.equal(badgeKind({ bucket: 'idle' }), null);
  assert.equal(badgeKind(null), null);
});

test('[vil.status-badges] layout is max(2, zoom) css px per badge pixel, centred above the head', () => {
  const byId = new Map([['a', { bucket: 'stalled' }], ['b', { bucket: 'idle' }]]);
  for (const [zoom, s] of [[1, 2], [2, 2], [3, 3]]) {
    const L = layoutBadges([hit('a'), hit('b')], byId, { zoom });
    assert.equal(L.length, 1);
    assert.equal(L[0].r - L[0].l, BADGE_W * s); assert.equal(L[0].b - L[0].t, BADGE_H * s);
    assert.equal((L[0].l + L[0].r) / 2, 108); assert.equal(L[0].b, 98);
  }
});

test('[vil.status-badges] drawBadges blits each sprite at device scale', () => {
  const calls = [], ctx = { imageSmoothingEnabled: true, drawImage: (...a) => calls.push(a) };
  const mk = () => fakeCanvas(); const cc = (w, h) => Object.assign(mk(), { width: w, height: h });
  drawBadges(ctx, [{ id: 'a', kind: 'error', l: 10, t: 20, r: 48, b: 66, f: 0 }], { dpr: 2, zoom: 1, createCanvas: cc });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1), [20, 40, BADGE_W * 4, BADGE_H * 4]);
  assert.equal(ctx.imageSmoothingEnabled, true);
});

test('[vil.badges-hidden-bubbles-off] bubbles off keeps only hover, selected and cursor', () => {
  const byId = { a: { bucket: 'waiting' }, b: { bucket: 'building' }, c: { bucket: 'stalled' } };
  const hits = [hit('a'), hit('b'), hit('c')];
  assert.equal(layoutBadges(hits, byId, { zoom: 1, bubbles: true }).length, 3);
  assert.deepEqual(layoutBadges(hits, byId, { zoom: 1, bubbles: false }).length, 0);
  assert.deepEqual(layoutBadges(hits, byId, { zoom: 1, bubbles: false, keep: new Set(['b']) }).map(b => b.id), ['b']);
});

const world = { objects: new Map([['h1', { id: 'h1', kind: 'building', tx: 10, ty: 10, w: 3, h: 2 }]]) };

test('[vil.selected-indoors-ghost-at-door] indoors selected actor gets a ghost drawn at the door at half alpha', () => {
  const a = { id: 's', home: 'h1', flags: 8 | 2, x: 11, y: 11 };
  const m = selectionMarks({ world, actors: [a], selected: 's' });
  assert.equal(m.ghost.id, 's'); assert.equal(m.marker, undefined);
  const calls = []; const g = { image: (...x) => calls.push(['image', ...x]), rect: (...x) => calls.push(['rect', ...x]), poly: (...x) => calls.push(['poly', ...x]) };
  const img = { width: 16, height: 24 };
  drawMarks(g, m, { entryOf: () => ({ x: 12, y: 12 }), frameOf: () => ({ img }) });
  const im = calls.find(c => c[0] === 'image');
  assert.equal(im[10], 0.5);
  assert.equal(im[6], -8);    // door tile (12,12): toScreen sx = 0, pivot x = 8
  assert.equal(im[7], 192 - 24);
});

test('[bld.selected-home-outline] outline appears for indoors or crowd, not for a walking selection', () => {
  const walk = { id: 's', home: 'h1', flags: 2, x: 5, y: 5 };
  assert.equal(selectionMarks({ world, actors: [walk], selected: 's' }).outline, undefined);
  const crowd = selectionMarks({ world, actors: [walk], selected: 's', crowd: new Set(['s']) });
  assert.deepEqual(crowd.outline, { id: 'h1', tx: 10, ty: 10, w: 3, h: 2 });
  const polys = []; drawMarks({ poly: (p, c) => polys.push([p, c]), rect() {}, image() {} }, crowd, {});
  assert.equal(polys.length, 4);
  assert.ok(polys.every(([, c]) => c === '#eaf2ff'));
});

test('[vil.selection-marker-rims] selected outdoor villager gets the marker glyph above its head', () => {
  const m = selectionMarks({ world, actors: [{ id: 's', flags: 2, x: 4, y: 4 }], selected: 's' });
  assert.deepEqual(m.marker, { id: 's', x: 4, y: 4 });
  const rects = []; drawMarks({ rect: (...a) => rects.push(a), poly() {}, image() {} }, m, {});
  assert.ok(rects.length >= 15);
  assert.ok(rects.some(r => r[4] === '#eaf2ff') && rects.some(r => r[4] === '#140f1c'));
  assert.deepEqual(selectionMarks({ world, actors: [], selected: 'x' }), {});
});
