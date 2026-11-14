import test from 'node:test';
import assert from 'node:assert/strict';
import { createLighting, nightOf, MAX_POOLS } from '../web/src/engine/render/lighting.js';

function fakeCtx(log) {
  return { globalCompositeOperation: 'source-over', fillStyle: '', clearRect() {}, fillRect(...a) { log.push(['fill', this.globalCompositeOperation, ...a]); },
    createRadialGradient() { return { addColorStop() {} }; } };
}
function factory(log) { const made = []; const f = (w, h) => { const c = { width: w, height: h, ctx: fakeCtx(log), getContext() { return this.ctx; } }; made.push(c); return c; }; f.made = made; return f; }
function fakeGfx() { const calls = []; return { calls, setComposite: op => calls.push(['op', op]), image: (...a) => calls.push(['image', ...a]), rect() {} }; }
const mk = (id, model, tx, ty, extra = {}) => ({ id, kind: 'prop', model, tx, ty, w: 1, h: 1, z: 0, ...extra });
function world(objs) { return { objects: new Map(objs.map(o => [o.id, o])) }; }
const view = { cssW: 400, cssH: 300, dpr: 1 };
const cam = { x: 10, y: 10, z: 1 };

test('night curve', () => {
  assert.equal(nightOf(0), 1); assert.equal(nightOf(0.5), 0);
  assert.ok(nightOf(19 / 24) > 0 && nightOf(19 / 24) < 1);
});
test('lamps by model name produce lights; windows only when home agent resting', () => {
  const w = world([mk('l1', 'lamp', 5, 5), mk('r1', 'rock', 6, 6), mk('b1', 'timber', 8, 8, { kind: 'building', agentId: 'a', z: 20 }), mk('b2', 'timber', 9, 9, { kind: 'building', agentId: 'b', z: 20 })]);
  const L = createLighting({ world: w, createCanvas: factory([]), statusOf: id => id === 'b1' ? 'resting' : 'working' });
  const ls = L.lights();
  assert.equal(ls.filter(l => l.kind === 'lamp').length, 1);
  assert.equal(ls.filter(l => l.kind === 'window').length, 2);
  assert.ok(ls.every(l => !l.id.startsWith('b2')));
});
test('lightsFor option overrides; lanterns only at night', () => {
  const w = world([mk('x', 'brazier', 5, 5)]);
  const L = createLighting({ world: w, createCanvas: factory([]), lightsFor: o => o.model === 'brazier' ? { r: 50 } : null });
  assert.equal(L.lights().length, 1);
  const actors = new Map([['f', { id: 'f', x: 3, y: 3, lantern: true }]]);
  L.setTime(0.5); assert.equal(L.lights(null, actors).length, 1);
  L.setTime(0); assert.equal(L.lights(null, actors).length, 2);
});
test('day draws nothing; night draws multiply then lighter at quarter resolution', () => {
  const log = [], f = factory(log), g = fakeGfx();
  const L = createLighting({ world: world([mk('l1', 'lamp', 10, 10)]), createCanvas: f });
  L.setTime(0.5); assert.equal(L.draw(g, cam, view), 0); assert.equal(g.calls.length, 0);
  L.setTime(0); assert.equal(L.draw(g, cam, view), 1);
  assert.equal(f.made[0].width, 100); assert.equal(f.made[0].height, 75);
  const ops = g.calls.filter(c => c[0] === 'op').map(c => c[1]);
  assert.deepEqual(ops, ['multiply', 'lighter', 'source-over']);
  assert.ok(log.some(e => e[1] === 'destination-out'));
});
test('pool budget caps at 160, nearest first; rebuild only on change or 4th frame', () => {
  const objs = []; for (let i = 0; i < 300; i++) objs.push(mk('l' + i, 'lamp', 10 + (i % 20) * 0.2, 10 + Math.floor(i / 20) * 0.2));
  const log = [], L = createLighting({ world: world(objs), createCanvas: factory(log) }), g = fakeGfx();
  L.setTime(0); assert.equal(L.draw(g, cam, view), MAX_POOLS);
  const n1 = log.length; L.draw(g, cam, view); assert.equal(log.length, n1); // frame 2 cached
  L.draw(g, cam, view); L.draw(g, cam, view); assert.ok(log.length > n1); // frame 4 rebuilds
});
