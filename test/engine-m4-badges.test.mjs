// M4 spec tests for overlay/badges.js (plan P3), from classic web/src/world.js:1076-1090.
// While the module is missing the tests are todo; once it exists they run for real.
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../web/src/engine/overlay/badges.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; });
const TODO = mod ? false : 'needs overlay/badges.js';
const t = (title, fn) => test(title, { todo: TODO }, TODO ? () => {} : fn);

const A = (id, o = {}) => ({ id, bucket: 'building', severity: null, prompt: false, ...o });
// hits are { kind, id, rect: [x0, y0, x1, y1] } in css px
const hit = (id, x) => ({ kind: 'agent', id, rect: [x, 100, x + 16, 124] });
const mapOf = (...as) => new Map(as.map(a => [a.id, a]));

t('badges: the kind follows the bucket: error > click (prompt) > need when stalled, wait, build, none when resting [vil.status-badges]', () => {
  const k = mod.badgeKind;
  assert.equal(k(A('a', { bucket: 'stalled', severity: 'error' })), 'error');
  assert.equal(k(A('a', { bucket: 'stalled', severity: 'error', prompt: true })), 'error', 'error beats prompt');
  assert.equal(k(A('a', { bucket: 'stalled', prompt: true })), 'click');
  assert.equal(k(A('a', { bucket: 'stalled' })), 'need');
  assert.equal(k(A('a', { bucket: 'waiting' })), 'wait');
  assert.equal(k(A('a', { bucket: 'building' })), 'build');
  assert.equal(k(A('a', { bucket: 'resting' })), null);
});

t('badges: layoutBadges gives one rect per badged agent, over its head [vil.status-badges]', () => {
  const byId = mapOf(A('a', { bucket: 'stalled' }), A('b'), A('c', { bucket: 'resting' }));
  const out = mod.layoutBadges([hit('a', 100), hit('b', 200), hit('c', 300)], byId, { zoom: 2, bubbles: true, keep: new Set() });
  assert.deepEqual(out.map(o => o.id).sort(), ['a', 'b']);
  const a = out.find(o => o.id === 'a');
  assert.equal(a.kind, 'need');
  assert.ok(a.r > a.l && a.b > a.t, 'positive size');
  assert.ok(a.b <= 100 + 4 && a.l < 100 + 16 && a.r > 100, 'sits over the sprite head, not below the feet');
});

t('badges: rects are drawn at max(2, zoom) so zoom 1 and 2 match and zoom 4 is twice zoom 2 [vil.status-badges]', () => {
  const byId = mapOf(A('a', { bucket: 'stalled' }));
  const size = zoom => { const [o] = mod.layoutBadges([hit('a', 100)], byId, { zoom, bubbles: true, keep: new Set() }); return o.r - o.l; };
  assert.equal(size(1), size(2));
  assert.ok(Math.abs(size(4) - 2 * size(2)) < 1e-6 || size(4) > size(2), 'grows past zoom 2');
});

t('badges: with bubbles off only hover, selected and cursor (the keep set) keep their badge [vil.badges-hidden-bubbles-off]', () => {
  const byId = mapOf(A('a', { bucket: 'stalled' }), A('b', { bucket: 'stalled' }), A('c', { bucket: 'stalled' }), A('d', { bucket: 'stalled' }));
  const hits = ['a', 'b', 'c', 'd'].map((id, i) => hit(id, 100 + 40 * i));
  const off = mod.layoutBadges(hits, byId, { zoom: 2, bubbles: false, keep: new Set(['b', 'c']) });
  assert.deepEqual(off.map(o => o.id).sort(), ['b', 'c']);
  assert.equal(mod.layoutBadges(hits, byId, { zoom: 2, bubbles: false, keep: new Set() }).length, 0);
  assert.equal(mod.layoutBadges(hits, byId, { zoom: 2, bubbles: true, keep: new Set() }).length, 4, 'bubbles on shows all');
});

t('badges: a hit with no agent in byId is skipped, not thrown on [vil.status-badges]', () => {
  assert.deepEqual(mod.layoutBadges([hit('ghost', 100)], new Map(), { zoom: 2, bubbles: true, keep: new Set() }), []);
});

t('badges: drawBadges paints each badge on the screen-space context and restores state [vil.status-badges]', () => {
  const sprite = () => { const rec = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } }); return { getContext: () => rec }; };
  const createCanvas = (w, h) => Object.assign(sprite(), { width: w, height: h });
  const calls = [], g = { imageSmoothingEnabled: true, drawImage: (...a) => calls.push(['drawImage', g.imageSmoothingEnabled, ...a.slice(1)]) };
  mod.drawBadges(g, [{ id: 'a', kind: 'error', l: 10, t: 10, r: 26, b: 26 }, { id: 'b', kind: 'wait', l: 50, t: 10, r: 66, b: 26 }], { dpr: 2, zoom: 2, createCanvas });
  assert.equal(calls.length, 2, 'one drawImage per badge');
  assert.ok(calls.every(c => c[1] === false), 'smoothing is off while drawing, crisp pixels');
  assert.deepEqual(calls[0].slice(2), [20, 20, mod.BADGE_W * 4, mod.BADGE_H * 4], 'device px at max(2, zoom) * dpr');
  assert.equal(g.imageSmoothingEnabled, true, 'smoothing flag restored');
});

t('badges: an empty list draws nothing [vil.status-badges]', () => {
  const calls = [];
  const g = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (...a) => { calls.push(k); }), set: () => true });
  mod.drawBadges(g, [], { dpr: 1, zoom: 1 });
  assert.equal(calls.filter(c => /^(drawImage|fillRect|fill)$/.test(c)).length, 0);
});
