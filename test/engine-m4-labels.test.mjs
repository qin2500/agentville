// M4 spec tests for overlay/labels.js and overlay/dom-labels.js (plan P2), from classic web/src/village.js:248-318.
// While the modules are missing the tests are todo; once they exist they run for real.
import test from 'node:test';
import assert from 'node:assert/strict';

const load = p => import(p).catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; });
const L = await load('../web/src/engine/overlay/labels.js');
const D = await load('../web/src/engine/overlay/dom-labels.js');
const TODO = L ? false : 'needs overlay/labels.js';
const TODO_DOM = D ? false : 'needs overlay/dom-labels.js';
const t = (title, fn) => test(title, { todo: TODO }, TODO ? () => {} : fn);
const td = (title, fn) => test(title, { todo: TODO_DOM }, TODO_DOM ? () => {} : fn);

const VIEW = { w: 1000, h: 600 };
const rectAt = (cx, top) => ({ l: cx - 6, t: top, r: cx + 10, b: top + 20, x: cx - 6, y: top, w: 16, h: 20, cx, top });
const ag = (id, o = {}) => ({ id, name: `Agent ${id}`, bucket: 'building', severity: null, prompt: false, since: 0, rect: rectAt(100 + 120 * (id.charCodeAt(0) - 97), 300), ...o });
const base = (o = {}) => ({ zoom: 2, agents: [], villages: [], prs: [], crowds: [], indoorsSel: null, selected: null, cursor: null, hover: null, hoverVil: null, alt: false, bubbles: true, ...o });
const place = (o, blockers = []) => L.layoutLabels(L.labelCands(base(o)), blockers, VIEW);
const keys = placed => placed.map(p => p.key);
const find = (placed, key) => placed.find(p => p.key === key);
const rectOf = p => p.rect || { l: p.left, t: p.top, r: p.left, b: p.top };
const overlap = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

t('labels: a stalled agent gets a tag; others stay hidden until Alt [lbl.dom-labels-priority-slide] [lbl.alt-shows-all-tags]', () => {
  const agents = [ag('a', { bucket: 'stalled' }), ag('b'), ag('c', { bucket: 'resting' })];
  const p = place({ agents });
  assert.deepEqual(keys(p).filter(k => k.startsWith('t:')), ['t:a']);
  const alt = place({ agents, alt: true });
  assert.deepEqual(keys(alt).filter(k => k.startsWith('t:')).sort(), ['t:a', 't:b', 't:c']);
});

t('labels: the tag class says why: sel, er (error), pr (prompt), st (stalled) [lbl.dom-labels-priority-slide]', () => {
  const agents = [ag('a', { bucket: 'stalled', severity: 'error' }), ag('b', { bucket: 'stalled', prompt: true }), ag('c', { bucket: 'stalled' }), ag('d')];
  const p = place({ agents, selected: 'd' });
  const cls = k => find(p, k).cls.split(/\s+/);
  assert.ok(cls('t:a').includes('er') && cls('t:a').includes('tag'));
  assert.ok(cls('t:b').includes('pr'));
  assert.ok(cls('t:c').includes('st'));
  assert.ok(cls('t:d').includes('sel'));
});

t('labels: priority is selected > cursor > hover > stalled: a crowded spot keeps the higher one [lbl.dom-labels-priority-slide]', () => {
  // three agents on exactly the same spot: only room for the best, the rest slide or drop
  const same = id => ag(id, { bucket: 'stalled', rect: rectAt(500, 300) });
  const agents = [same('a'), same('b'), same('c'), same('d')];
  const p = place({ agents, selected: 'd', cursor: 'c', hover: 'b' });
  const centre = k => { const q = find(p, k); return q && rectOf(q); };
  assert.ok(find(p, 't:d'), 'selected always placed');
  const d = centre('t:d');
  for (const k of ['t:a', 't:b', 't:c']) { const q = centre(k); if (q) assert.ok(!overlap(q, d), `${k} must not cover the selected tag`); }
});

t('labels: a lower-priority tag that would overlap a placed one is skipped or slid to the side, never stacked [lbl.dom-labels-priority-slide]', () => {
  const agents = [ag('a', { bucket: 'stalled', rect: rectAt(500, 300) }), ag('b', { bucket: 'stalled', rect: rectAt(505, 300) })];
  const p = place({ agents });
  const r = p.map(rectOf);
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) assert.ok(!overlap(r[i], r[j]), 'no two labels overlap');
});

t('labels: a blocker (a badge) stops other agents tags but not its own agent [lbl.dom-labels-priority-slide]', () => {
  const a = ag('a', { bucket: 'stalled', rect: rectAt(500, 300), badge: [490, 280, 510, 300] });
  const p = place({ agents: [a] }, [{ id: 'a', l: 480, t: 270, r: 520, b: 305 }]);
  assert.ok(find(p, 't:a'), 'own badge never blocks its own tag');
  const b = ag('b', { bucket: 'stalled', rect: rectAt(500, 300) });
  const q = place({ agents: [b] }, [{ id: 'zzz', l: 400, t: 250, r: 600, b: 330 }]);
  const tb = find(q, 't:b');
  if (tb) assert.ok(!overlap(rectOf(tb), { l: 400, t: 250, r: 600, b: 330 }), 'slid clear of a neighbour badge');
});

t('labels: the tag slides off to either side before being dropped [lbl.dom-labels-priority-slide]', () => {
  // A narrow badge blocks the head spot; the tag slides to a side where it clears it (classic slide is half a tag plus 12 px).
  const blocker = { id: 'zzz', l: 495, t: 280, r: 505, b: 300 };
  const p = place({ agents: [ag('a', { bucket: 'stalled', rect: rectAt(500, 300) })] }, [blocker]);
  const tag = find(p, 't:a');
  assert.ok(tag, 'slid aside rather than dropped');
  assert.notEqual(tag.left, 500, 'moved off the head spot');
  assert.ok(!overlap(rectOf(tag), blocker), 'clear of the blocker');
  // Blocked on both sides: dropped.
  const wide = place({ agents: [ag('a', { bucket: 'stalled', rect: rectAt(500, 300) })] }, [{ id: 'zzz', l: 300, t: 280, r: 700, b: 300 }]);
  assert.ok(!find(wide, 't:a'), 'dropped when no side is free');
});

t('labels: offscreen tags are dropped [lbl.dom-labels-priority-slide]', () => {
  const p = place({ agents: [ag('a', { bucket: 'stalled', rect: rectAt(-500, 300) }), ag('b', { bucket: 'stalled', rect: rectAt(500, 300) })] });
  assert.ok(!find(p, 't:a'));
  assert.ok(find(p, 't:b'));
});

t('labels: a village sign shows the village name in its accent [lbl.village-signs]', () => {
  const p = place({ zoom: 2, villages: [{ name: 'Oakhaven', accent: '#c0392b', x: 500, y: 200, counts: {} }] });
  const s = find(p, 'v:Oakhaven');
  assert.ok(s, 'sign placed');
  assert.ok(s.cls.split(/\s+/).includes('sign'));
  assert.equal(s.text, 'Oakhaven');
  assert.equal(s.accent, '#c0392b');
});

t('labels: at Map zoom a village with counts is one plate with its counts [lbl.map-plates-counts]', () => {
  const counts = { prompt: 2, error: 1, stalled: 3, waiting: 4, need: 3, wait: 4 };
  const p = place({ zoom: 0.5, villages: [{ name: 'Oakhaven', accent: '#c0392b', x: 500, y: 200, counts }] });
  const s = find(p, 'v:Oakhaven');
  assert.ok(s && s.cls.includes('plate'), 'plate class');
  assert.ok(s.counts, 'carries the counts');
  assert.deepEqual(s.parts.map(([k, n]) => [k, n]), [['prompt', 2], ['error', 1], ['stalled', 3], ['waiting', 4]], 'counts in plate order');
  assert.equal(s.text, 'Oakhaven');
  assert.ok(!keys(p).some(k => k.startsWith('t:')), 'no agent tags at Map zoom');
});

t('labels: Map plates with errors outrank quiet ones when they collide [lbl.map-plates-counts]', () => {
  const v = (name, counts) => ({ name, accent: '#444', x: 500, y: 200, counts });
  const p = place({ zoom: 0.5, villages: [v('Quiet', {}), v('Noisy', { error: 3, prompt: 0, need: 0, wait: 0, stalled: 0, waiting: 0 })] });
  assert.ok(find(p, 'v:Noisy'));
  const q = find(p, 'v:Quiet');
  if (q) assert.ok(!overlap(rectOf(q), rectOf(find(p, 'v:Noisy'))));
});

t('labels: hovering a village shows its plate even with bubbles off [lbl.map-plates-counts] [lbl.dom-labels-priority-slide]', () => {
  const villages = [{ name: 'A', accent: '#111', x: 200, y: 200, counts: {} }, { name: 'B', accent: '#111', x: 700, y: 200, counts: {} }];
  const p = place({ zoom: 0.5, villages, bubbles: false, hoverVil: 'B' });
  assert.deepEqual(keys(p), ['v:B']);
});

t('labels: PR numbers show from zoom 3 only [lbl.pr-numbers-zoom3]', () => {
  const prs = [{ id: 'p1', pr: 42, x: 400, y: 300 }, { id: 'p2', pr: 7, x: 700, y: 300 }];
  const lo = place({ zoom: 2, prs });
  assert.ok(!keys(lo).some(k => k.startsWith('p:')), 'none at zoom 2');
  const hi = place({ zoom: 3, prs });
  const pk = keys(hi).filter(k => k.startsWith('p:'));
  assert.equal(pk.length, 2);
  assert.equal(find(hi, pk[0]).text.startsWith('#'), true);
  assert.ok(find(hi, pk[0]).cls.includes('prt'));
});

t('labels: a crowded home draws no "+N more" tag, every agent keeps its own label [lbl.crowd-tags]', () => {
  const p = place({ crowds: [{ id: 'h1', n: 3, x: 500, y: 400 }] });
  assert.ok(!p.some(q => q.key.startsWith('c:') || /more/.test(q.text)), 'no crowd tag');
});

t('labels: the selected agent who is indoors gets a tag saying where [lbl.crowd-tags]', () => {
  const a = ag('a', { rect: null });
  const p = place({ agents: [a], selected: 'a', indoorsSel: { id: 'a', name: 'Agent a', x: 500, y: 400 } });
  const s = find(p, 't:a');
  assert.ok(s && /indoors/.test(s.text) && s.cls.includes('sel'));
});

t('labels: bubbles off keeps only hover, selected and cursor [lbl.dom-labels-priority-slide]', () => {
  const agents = [ag('a', { bucket: 'stalled' }), ag('b', { bucket: 'stalled' }), ag('c', { bucket: 'stalled' }), ag('d', { bucket: 'stalled' })];
  const p = place({ agents, bubbles: false, hover: 'a', selected: 'b', cursor: 'c' });
  assert.deepEqual(keys(p).sort(), ['t:a', 't:b', 't:c']);
});

t('labels: a placed label has the contract fields (key, cls, text, left, top, rect) [lbl.dom-labels-priority-slide]', () => {
  const p = place({ agents: [ag('a', { bucket: 'stalled' })] });
  const s = find(p, 't:a');
  for (const f of ['key', 'cls', 'text', 'left', 'top', 'rect']) assert.ok(f in s, f);
  assert.equal(typeof s.left, 'number');
});

// ---- DOM layer: a tiny fake DOM ----
function fakeDom() {
  const mk = () => {
    const el = { children: [], dataset: {}, style: { _p: {}, setProperty(k, v) { this._p[k] = v; }, getPropertyValue(k) { return this._p[k] || ''; } }, className: '', textContent: '', innerHTML: '',
      append(...c) { for (const x of c) { x.parent = el; el.children.push(x); } }, remove() { if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el); } };
    return el;
  };
  globalThis.document = globalThis.document || { createElement: mk };
  return { root: mk(), mk };
}

td('dom-labels: render creates .tag/.sign elements keyed by data-key and removes stale ones [lbl.dom-labels-priority-slide] [lbl.village-signs]', () => {
  const { root } = fakeDom();
  const layer = D.createLabelLayer(root);
  const pl = (key, cls, text, extra = {}) => ({ key, cls, text, left: 10, top: 20, rect: { l: 0, t: 0, r: 20, b: 10 }, ...extra });
  layer.render([pl('t:abc', 'tag st', 'Agent'), pl('v:Oak', 'sign', 'Oak', { accent: '#abc' })]);
  assert.equal(root.children.length, 2);
  const tag = root.children.find(c => c.dataset.key === 't:abc');
  assert.equal(tag.className, 'tag st');
  assert.equal(tag.textContent, 'Agent');
  assert.equal(tag.style.left, '10px');
  const sign = root.children.find(c => c.dataset.key === 'v:Oak');
  assert.equal(sign.style.getPropertyValue('--accent'), '#abc');
  layer.render([pl('t:abc', 'tag st', 'Agent')]);
  assert.equal(root.children.length, 1, 'the sign was removed');
  assert.equal(root.children[0], tag, 'the same element is reused');
});

td('dom-labels: a plate renders its html so the counts show [lbl.map-plates-counts]', () => {
  const { root } = fakeDom();
  const layer = D.createLabelLayer(root);
  layer.render([{ key: 'v:Oak', cls: 'sign plate', text: 'Oak', parts: [['error', 1]], counts: { error: 1 }, left: 5, top: 5, rect: { l: 0, t: 0, r: 5, b: 5 } }]);
  assert.match(root.children[0].innerHTML, /<b>Oak<\/b>/);
  assert.match(root.children[0].innerHTML, /k-error/);
});
