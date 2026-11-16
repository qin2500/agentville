import test from 'node:test';
import assert from 'node:assert/strict';
import { labelCands, layoutLabels, labelBlockers } from '../web/src/engine/overlay/labels.js';
import { createLabelLayer } from '../web/src/engine/overlay/dom-labels.js';

const ag = (id, o = {}) => ({ id, name: id, bucket: 'building', rect: { x: 100, y: 100, w: 16 }, ...o });
const keys = c => c.map(x => x.key);
const VP = { w: 1000, h: 800 };

test('[lbl.village-signs] signs show at every zoom with the village name', () => {
  for (const zoom of [0.5, 1, 3]) {
    const c = labelCands({ zoom, villages: [{ name: 'demo', accent: '#c96442', x: 300, y: 300 }] });
    assert.deepEqual(keys(c), ['v:demo']);
    assert.equal(c[0].cls, 'sign');
  }
});

test('[lbl.map-plates-counts] Map plates carry counts, only at zoom < 1', () => {
  const counts = { prompt: 1, error: 2, need: 0, wait: 12 };
  const v = [{ name: 'a', accent: '#111', x: 300, y: 300, counts }];
  const m = labelCands({ zoom: 0.5, villages: v })[0];
  assert.equal(m.cls, 'sign plate');
  assert.deepEqual(m.parts, [['prompt', 1], ['error', 2], ['waiting', 12]]);
  assert.equal(labelCands({ zoom: 1, villages: v })[0].cls, 'sign');
  const placed = layoutLabels([m], [], VP);
  assert.equal(placed.length, 1);
  assert.deepEqual(placed[0].counts, counts);
  assert.ok(placed[0].rect.b - placed[0].rect.t === 48);
});

test('[lbl.map-plates-counts] plates with errors outrank quiet ones; hover outranks all', () => {
  const v = [
    { name: 'quiet', x: 0, y: 0, counts: { prompt: 0, error: 0, need: 0, wait: 1 } },
    { name: 'bad', x: 0, y: 0, counts: { prompt: 0, error: 1, need: 0, wait: 0 } },
    { name: 'none', x: 0, y: 0 },
  ];
  let p = [...labelCands({ zoom: 0.5, villages: v })].sort((a, b) => a.pri - b.pri);
  assert.deepEqual(p.map(c => c.key), ['v:bad', 'v:quiet', 'v:none']);
  p = labelCands({ zoom: 0.5, villages: v, hoverVil: 'none' }).sort((a, b) => a.pri - b.pri);
  assert.equal(p[0].key, 'v:none');
});

test('[lbl.dom-labels-priority-slide] selected beats cursor beats hover beats stalled; keys are t:<serverId>', () => {
  const agents = [ag('s1', { bucket: 'stalled' }), ag('h'), ag('c'), ag('sel')];
  const c = labelCands({ zoom: 2, agents, selected: 'sel', cursor: 'c', hover: 'h' });
  const by = Object.fromEntries(c.map(x => [x.key, x]));
  assert.ok(by['t:sel'].pri < by['t:c'].pri && by['t:c'].pri < by['t:h'].pri && by['t:h'].pri < by['t:s1'].pri);
  assert.equal(by['t:sel'].cls, 'tag sel');
  assert.equal(by['t:s1'].cls, 'tag st');
  assert.equal(labelCands({ zoom: 2, agents: [ag('e', { bucket: 'stalled', severity: 'error' })] })[0].cls, 'tag er');
  assert.equal(labelCands({ zoom: 2, agents: [ag('p', { bucket: 'stalled', prompt: 'permission' })] })[0].cls, 'tag pr');
  assert.deepEqual(keys(labelCands({ zoom: 0.9, agents })), []);
});

test('[lbl.dom-labels-priority-slide] overlapping lower-priority tag slides sideways when a neighbour is offset, drops when fully covered', () => {
  const mk = (id, pri) => ({ key: `t:${id}`, pri, cls: 'tag', text: 'abcdefgh', x: 200, y: 100, dy: -1, center: false });
  const b = mk('b', 4); b.x = 250;
  const placed = layoutLabels([mk('a', 0), b], [], VP);
  assert.equal(placed.length, 2);
  assert.equal(placed[0].left, 200);
  assert.notEqual(placed[1].left, 250);
  // the same spot is a full overlap: slides all collide, so it drops
  assert.equal(layoutLabels([mk('a', 0), mk('b', 4)], [], VP).length, 1);
  for (const p of placed) for (const q of placed) if (p !== q) assert.ok(p.rect.r <= q.rect.l || q.rect.r <= p.rect.l);
  // a non-agent tag cannot slide: it is skipped
  const crowd = { key: 'c:x', pri: 6, cls: 'tag', text: '#3', x: 200, y: 100, dy: 0 };
  assert.equal(layoutLabels([mk('a', 0), crowd], [], VP).length, 1);
});

test('[lbl.dom-labels-priority-slide] priority 0 is never blocked; offscreen tags are culled; badges block others', () => {
  const t = (id, pri, x = 200) => ({ key: `t:${id}`, pri, cls: 'tag', text: 'name', x, y: 100, dy: 0 });
  assert.deepEqual(layoutLabels([t('a', 0), t('b', 0)], [], VP).map(p => p.key), ['t:a', 't:b']);
  assert.equal(layoutLabels([t('a', 0, -500)], [], VP).length, 0);
  const badge = { id: 'other', l: 190, t: 80, r: 210, b: 98 };
  const own = { id: 'a', l: 190, t: 80, r: 210, b: 98 };
  const withOther = layoutLabels([t('a', 4)], [badge], VP)[0];
  assert.notEqual(withOther.left, 200);
  assert.equal(layoutLabels([t('a', 4)], [own], VP)[0].left, 200);
});

test('[lbl.dom-labels-priority-slide] labelBlockers uses badges at zoom >= 1 only', () => {
  const a = [ag('x', { badge: { l: 1, t: 2, r: 3, b: 4 } }), ag('y')];
  assert.deepEqual(labelBlockers(a, 2), [{ id: 'x', l: 1, t: 2, r: 3, b: 4 }]);
  assert.deepEqual(labelBlockers(a, 0.5), []);
});

test('[lbl.pr-numbers-zoom3] PR numbers only at zoom >= 3', () => {
  const prs = [{ id: 'p1', pr: 42, x: 50, y: 50 }];
  assert.deepEqual(keys(labelCands({ zoom: 2.9, prs })), []);
  const c = labelCands({ zoom: 3, prs });
  assert.equal(c[0].text, '#42'); assert.equal(c[0].cls, 'tag prt');
});

test('[lbl.crowd-tags] no crowd tags; indoors-selected gets its own sel tag', () => {
  const c = labelCands({ zoom: 2, crowds: [{ id: 'h', n: 4, x: 1, y: 2 }],
    indoorsSel: { id: 'a1', name: 'Ada', x: 5, y: 5 }, selected: 'a1' });
  assert.deepEqual(c.map(x => x.text), ['Ada (indoors)']);
  assert.equal(c.find(x => x.key === 't:a1').cls, 'tag sel');
});

test('[lbl.alt-shows-all-tags] Alt adds every agent tag; without it only stalled/hover/selected', () => {
  const agents = [ag('a'), ag('b'), ag('c', { bucket: 'stalled' })];
  assert.deepEqual(keys(labelCands({ zoom: 2, agents })), ['t:c']);
  assert.deepEqual(keys(labelCands({ zoom: 2, agents, alt: true })).sort(), ['t:a', 't:b', 't:c']);
});

test('[lbl.dom-labels-priority-slide] bubbles off keeps only hover/selected/cursor/hoverVil', () => {
  const agents = [ag('a', { bucket: 'stalled' }), ag('b', { bucket: 'stalled' }), ag('c', { bucket: 'stalled' })];
  const c = labelCands({ zoom: 2, agents, bubbles: false, hover: 'a', selected: 'b', villages: [{ name: 'v', x: 0, y: 0 }, { name: 'w', x: 0, y: 0 }], hoverVil: 'w' });
  assert.deepEqual(keys(c).sort(), ['t:a', 't:b', 'v:w']);
});

// ---- DOM layer with a minimal fake element ----
function fakeDoc() {
  const mk = () => {
    const props = new Map(), kids = [];
    const n = { dataset: {}, className: '', textContent: '', innerHTML: '', children: kids, parent: null, writes: 0,
      style: { getPropertyValue: k => props.get(k) || '', setProperty: (k, v) => props.set(k, v) },
      append(c) { c.parent = n; kids.push(c); }, remove() { const i = n.parent.children.indexOf(n); n.parent.children.splice(i, 1); },
      ownerDocument: null };
    n.ownerDocument = { createElement: mk };
    return n;
  };
  return mk();
}

test('[lbl.dom-labels-priority-slide] createLabelLayer reuses keyed nodes and removes stale ones', () => {
  const el = fakeDoc(), layer = createLabelLayer(el);
  const p = (key, text, left) => ({ key, cls: 'tag', text, left, top: 10, rect: {} });
  layer.render([p('t:a', 'A', 5.4), p('t:b', 'B', 9)]);
  const [na, nb] = el.children;
  assert.equal(na.dataset.key, 't:a'); assert.equal(na.style.left, '5px');
  layer.render([p('t:a', 'A2', 7), p('t:c', 'C', 1)]);
  assert.equal(el.children.length, 2);
  assert.equal(el.children[0], na); assert.equal(na.textContent, 'A2'); assert.equal(na.style.left, '7px');
  assert.ok(!el.children.includes(nb));
  layer.clear(); assert.equal(el.children.length, 0);
});

test('[lbl.map-plates-counts] plate html escapes names and renders counts; plain label uses textContent', () => {
  const el = fakeDoc(), layer = createLabelLayer(el, { icon: k => `<svg data-k="${k}"/>` });
  layer.render([{ key: 'v:x', cls: 'sign plate', text: '<img onerror=x>', accent: '#abc', left: 1, top: 2, rect: {},
    parts: [['error', 2], ['waiting', 11]] }]);
  const n = el.children[0];
  assert.ok(!n.innerHTML.includes('<img'));
  assert.ok(n.innerHTML.includes('&lt;img onerror=x&gt;'));
  assert.ok(n.innerHTML.includes('k-error') && n.innerHTML.includes('2') && n.innerHTML.includes('11'));
  assert.equal(n.style.getPropertyValue('--accent'), '#abc');
  layer.render([{ key: 'v:x', cls: 'sign', text: '<b>', left: 1, top: 2, rect: {} }]);
  assert.equal(n.textContent, '<b>'); assert.equal(n.dataset.html, undefined);
});
