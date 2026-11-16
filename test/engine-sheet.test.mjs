// M6 P6: the six-styles fixture validates, and the engine art sheet builds its pages with stubs (no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPages, pageNames, FAMILIES, folkActors, folkAnims } from '../web/src/dev/engine-sheet.js';
import { viewFromFixture } from '../web/src/engine/snapshot.js';

const fx = JSON.parse(fs.readFileSync(new URL('../e2e/fixtures/engine/six-styles.json', import.meta.url), 'utf8'));

test('six-styles: one project per family, each with a boss, a sub and several agents', () => {
  assert.equal(fx.v, 1);
  assert.equal(fx.projects.length, 6);
  assert.deepEqual(fx.projects.map(p => p.style.family).sort(), [0, 1, 2, 3, 4, 5]);
  for (const p of fx.projects) {
    const as = fx.agents.filter(a => a.project === p.name);
    assert.ok(as.some(a => a.role === 'boss'), `${p.name} boss`);
    assert.ok(as.some(a => a.role === 'sub' && as.some(b => b.id === a.parentId)), `${p.name} sub with a parent`);
    assert.ok(as.length >= 5, `${p.name} agents`);
    assert.ok(p.prs.length >= 12 && p.agentsEver >= 60 && p.transcriptBytes >= 300e6, `${p.name} town-tier numbers`);
  }
  assert.equal(new Set(fx.agents.map(a => a.id)).size, fx.agents.length);
  const v = viewFromFixture(fx);
  assert.equal(v.agents.length, fx.agents.length);
  assert.equal(v.projects.length, 6);
});

const canvas = (w, h) => {
  const calls = [];
  const g = new Proxy({}, { get: (t, k) => (k === 'calls' ? calls : (...a) => { calls.push(k); }), set: () => true });
  return { width: w, height: h, getContext: () => g, calls };
};

test('engine sheet: pages build with stubbed art, with and without anchors, and survive throwing art', () => {
  const img = canvas(64, 80);
  const deps = {
    rasterize: (m, s, o) => { if (m === 'barn') throw new Error('boom'); return { img, bounds: { x: 0, y: 0, w: 64, h: 80 }, pivot: { x: 32, y: 10 }, anchors: { door: { x: 30, y: 70 }, windows: [{ x: 10, y: 40 }] } }; },
    styleFor: (n, o) => ({ family: o.family, accent: '#c46a42' }),
    actorArt: { mode: 'sheet', frame: a => (a.face === 3 ? null : { img: canvas(20, 22), pivot: { x: 10, y: 18 } }) },
    mod: { actors: { anims: { walk: { frames: 4 }, idle: { frames: 1 } } } },
    createCanvas: canvas,
  };
  for (const anchors of [false, true]) {
    const pages = buildPages(deps, { night: false, anchors });
    const names = pages.map(p => p.name);
    for (const f of FAMILIES) assert.ok(names.some(n => n.startsWith(`family-${f}`)), f);
    assert.ok(names.some(n => n.startsWith('folk-walk')) && names.some(n => n.startsWith('folk-idle')));
    assert.ok(names.includes('events'));
    assert.equal(new Set(names).size, names.length, 'page names unique');
    for (const p of pages) assert.ok(p.canvas.width > 0 && p.canvas.height > 0);
  }
});

test('engine sheet: no actor art and no event fx still give the building and events pages', () => {
  const pages = buildPages({ rasterize: () => null, styleFor: () => null, actorArt: null, mod: null, createCanvas: canvas });
  assert.equal(pages.filter(p => p.name.startsWith('folk')).length, 0);
  assert.ok(pages.some(p => p.name === 'events'));
  assert.equal(pageNames().length, 8);
});

test('engine sheet: folk stand-ins and anims', () => {
  assert.ok(folkActors().some(r => r.a.input?.role === 'boss') && folkActors().some(r => r.a.kind === 'folk'));
  assert.deepEqual(folkAnims(null), [['idle', 1], ['walk', 4]]);
  assert.deepEqual(folkAnims({ actors: { anims: { run: { frames: 6 } } } }), [['run', 6]]);
});

test('engine sheet: the events page draws a sample of every effect kind with the real event-fx', async () => {
  const eventFx = await import('../web/src/engine/render/event-fx.js');
  const { EVENT_SAMPLES, EVENT_PHASES } = await import('../web/src/dev/engine-sheet.js');
  const rects = [];
  const mk = (w, h) => { const g = new Proxy({}, { get: (t, k) => (k === 'fillRect' ? (...a) => rects.push(a) : () => {}), set: () => true }); return { width: w, height: h, getContext: () => g }; };
  const pages = buildPages({ rasterize: () => null, styleFor: () => null, actorArt: null, mod: { events: () => [] }, eventFx, createCanvas: mk });
  assert.ok(pages.some(p => p.name === 'events'));
  assert.deepEqual(EVENT_SAMPLES.map(s => eventFx.parseEffect(s.spec.effect)?.type).sort(), ['anim', 'burst', 'ring', 'site']);
  assert.ok(EVENT_PHASES.every(p => p > 0 && p < 1));
  assert.ok(rects.length > 40, 'burst, ring and site pixels were drawn');
});
