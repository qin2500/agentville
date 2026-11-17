// M4 spec tests for render/marks.js (plan P3), from classic web/src/world.js:1132 and actor-art.js sticker rim.
// While the module is missing the tests are todo; once it exists they run for real.
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../web/src/engine/render/marks.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; });
const TODO = mod ? false : 'needs render/marks.js';
const t = (title, fn) => test(title, { todo: TODO }, TODO ? () => {} : fn);

// Actors are described by the flags the sim sets (actor.js FLAGS: INDOORS 8, SELECTED 2, GHOST 16) and a tile position.
const FLAGS = { VISIBLE: 1, SELECTED: 2, OCCLUDED: 4, INDOORS: 8, GHOST: 16 };
const actor = (id, o = {}) => ({ id, x: 10.5, y: 12.5, z: 0, flags: FLAGS.VISIBLE, home: 'h1', homeId: 'h1', ...o });
// world.objects is a Map id -> object with tile origin tx, ty and footprint w, h
const world = { objects: new Map([['h1', { id: 'h1', kind: 'home', tx: 8, ty: 8, w: 4, h: 4 }]]) };
const marks = (o) => mod.selectionMarks({ world, actors: [actor('a'), actor('b')], selected: null, crowd: new Set(), ...o });

t('marks: nothing is selected, nothing is marked [vil.selection-marker-rims]', () => {
  const m = marks({});
  assert.ok(!m.ghost && !m.outline);
});

t('marks: a selected outdoor agent has no ghost and no home outline [vil.selected-indoors-ghost-at-door] [bld.selected-home-outline]', () => {
  const m = marks({ selected: 'a' });
  assert.ok(!m.ghost, 'no ghost while visible outdoors');
  assert.ok(!m.outline, 'no outline while outdoors');
});

t('marks: a selected agent who is indoors gets a ghost at the door [vil.selected-indoors-ghost-at-door]', () => {
  const m = marks({ selected: 'a', actors: [actor('a', { flags: FLAGS.INDOORS, visible: false })] });
  assert.ok(m.ghost, 'ghost present');
  assert.equal(m.ghost.id, 'a');
  assert.equal(m.ghost.home.id, 'h1', 'ghost is tied to the actor home, whose door drawMarks resolves');
  assert.ok(Number.isFinite(m.ghost.tx) && Number.isFinite(m.ghost.ty), 'ghost has a home tile');
  const d = Math.hypot(m.ghost.tx - 10, m.ghost.ty - 12);
  assert.ok(d < 5, `ghost is near the home (8..12), got ${m.ghost.tx},${m.ghost.ty}`);
});

t('marks: a selected agent who is indoors gets the home outline [bld.selected-home-outline]', () => {
  const m = marks({ selected: 'a', actors: [actor('a', { flags: FLAGS.INDOORS })] });
  assert.ok(m.outline, 'outline present');
  assert.equal(m.outline.id ?? m.outline.home ?? m.outline.object, 'h1');
});

t('marks: a selected agent in the crowd also gets ghost and outline [bld.selected-home-outline] [vil.selected-indoors-ghost-at-door]', () => {
  const m = marks({ selected: 'a', actors: [actor('a')], crowd: new Set(['a', 'b']) });
  assert.ok(m.outline, 'outline for a crowd member');
  assert.equal(m.outline.id, 'h1');
  assert.ok(!m.marker, 'no marker above a folded agent');
});

t('marks: a selected id with no actor produces no marks and does not throw [vil.selected-indoors-ghost-at-door]', () => {
  assert.doesNotThrow(() => marks({ selected: 'nobody' }));
  const m = marks({ selected: 'nobody' });
  assert.ok(!m.ghost && !m.outline);
});

t('marks: drawMarks paints the ghost and outline, nothing for an empty set [vil.selected-indoors-ghost-at-door] [bld.selected-home-outline] [vil.selection-marker-rims]', () => {
  const calls = [];
  // Gfx has rect / poly / image only
  const g = { rect: (...a) => calls.push(['rect', ...a]), poly: (...a) => calls.push(['poly', ...a]), image: (...a) => calls.push(['image', ...a]) };
  const entryOf = () => ({ x: 10, y: 12 });
  mod.drawMarks(g, {}, { entryOf });
  assert.equal(calls.length, 0, 'empty marks draw nothing');
  const m = marks({ selected: 'a', actors: [actor('a', { flags: FLAGS.INDOORS })] });
  mod.drawMarks(g, m, { entryOf });
  assert.equal(calls.filter(c => c[0] === 'poly').length, 4, 'four outline edges around the home');
  assert.equal(calls.filter(c => c[0] === 'rect').length, 1, 'a faded box ghost when there is no sprite');
  calls.length = 0;
  const img = { width: 16, height: 24 };
  mod.drawMarks(g, m, { entryOf, frameOf: () => ({ img }) });
  assert.ok(calls.some(c => c[0] === 'image' && c[1] === img), 'ghost uses the selected sprite when given');
  calls.length = 0;
  mod.drawMarks(g, marks({ selected: 'a' }), { entryOf });
  assert.ok(calls.filter(c => c[0] === 'rect').length > 0, 'the marker glyph is painted above a selected outdoor agent');
});
