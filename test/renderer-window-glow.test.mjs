// Home windows glow at night when the home agent rests: the renderer feeds statusOf into lighting from frame.actors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../web/src/engine/render/renderer.js';
import { createLighting } from '../web/src/engine/render/lighting.js';

const LAYER = { GROUND_PROP: 0, OBJECT: 1, ACTOR: 2, CARRIED: 3, EFFECT: 4 };
const home = (id, agentId, tx) => ({ id, kind: 'building', model: 'cottage', tx, ty: 0, w: 1, h: 1, z: 20, walk: 'block', styleKey: 's', variant: 0, agentId });

function setup(objects) {
  const seen = { lights: null, statusOfCalls: 0 };
  const gfx = { begin() {}, clear() {}, end() {}, image() {}, rect() {}, poly() {}, setComposite() {}, size: () => ({ w: 800, h: 600 }) };
  class SpriteCache { get() { return null; } pump() {} }
  const deps = {
    LAYER, sortKey: (d, s, l, c) => ((d * 4 + s) * 8 + l) * 4096 + (c + 2048), mergeSorted: l => l.flat().sort((a, b) => a.key - b.key), SpriteCache,
    spriteKey: o => o.model, placeholder: o => ({ img: { width: 8, height: 8 }, bounds: { x: 0, y: 0, w: 8, h: 8 }, pivot: { x: 4, y: 8 }, slices: [] }),
    sliceSprite: () => [], rasterize: () => ({}), artView: o => ({ ...o }),
    createGround: () => ({ drawChunks() {}, chunkKeys: () => [], invalidate() {} }),
    createLighting: ({ world, statusOf }) => {
      const L = createLighting({ world, statusOf: id => { seen.statusOfCalls++; return statusOf(id); } });
      return { setTime: t => L.setTime(t), lights(objs, actors) { seen.lights = L.lights(objs, actors); return seen.lights; }, draw() {} };
    },
    createXray: () => ({ occluded: () => false, fadeFor: () => 1, draw() {} }),
    effects: { draw() {} }, badges: { draw() {} },
  };
  const r = createRenderer({ canvas: {}, gfx, mod: {}, deps });
  r.setWorld({ objects: new Map(objects.map(o => [o.id, o])), version: 1 });
  return { r, seen };
}
const frame = actors => ({ cam: { x: 0, y: 0, z: 1 }, view: { cssW: 800, cssH: 600, dpr: 1 }, actors, t: 0, night: 1, mode: 'town' });
// actors carry their HOME object id (a.home), never the server id
const ag = (id, status, hm) => ({ id, kind: 'agent', home: hm, x: 50, y: 50, face: 0, flags: 0, input: { status } });

test('resting home agent lights its windows at night; working one does not', () => {
  const { r, seen } = setup([home('h1', 'a', 0), home('h2', 'b', 1)]);
  r.draw(frame([ag('a', 'resting', 'h1'), ag('b', 'working', 'h2')]));
  const w = seen.lights.filter(l => l.kind === 'window');
  assert.ok(w.length >= 1);
  assert.ok(w.every(l => l.id.startsWith('h1#')));
});

test('status falls back to status.bucket; unknown agent stays dark', () => {
  const { r, seen } = setup([home('h1', 'a', 0), home('h2', 'zz', 1)]);
  r.draw(frame([{ id: 'a', kind: 'agent', home: 'h1', x: 50, y: 50, flags: 0, status: { bucket: 'resting' } }]));
  assert.ok(seen.lights.some(l => l.id.startsWith('h1#')));
  assert.ok(!seen.lights.some(l => l.id.startsWith('h2#')));
});

test('statusOf is a map lookup: one call per home building, not per actor', () => {
  const homes = Array.from({ length: 5 }, (_, i) => home('h' + i, 'a' + i, i));
  const { r, seen } = setup(homes);
  const actors = Array.from({ length: 300 }, (_, i) => ag('a' + i, 'resting', 'h' + (i % 5)));
  r.draw(frame(actors));
  assert.equal(seen.statusOfCalls, 5);
});

test('statuses refresh each frame', () => {
  const { r, seen } = setup([home('h1', 'a', 0)]);
  r.draw(frame([ag('a', 'resting', 'h1')]));
  assert.ok(seen.lights.some(l => l.kind === 'window'));
  r.draw(frame([ag('a', 'working', 'h1')]));
  assert.ok(!seen.lights.some(l => l.kind === 'window'));
});
