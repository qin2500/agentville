import './support/ensure-mods-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createActorArt, drawSparkle } = await import('../web/src/engine/render/actor-art.js');
const { copyAgentFields, AGENT_FIELDS } = await import('../web/src/engine/snapshot.js');
const { HARNESS_NAME } = await import('../web/src/ui.js');

const fakeCanvas = (w, h) => { const ctx = new Proxy({}, { get: (t, k) => t[k] ?? (() => {}), set: (t, k, v) => (t[k] = v, true) }); return { width: w, height: h, getContext: () => ctx }; };
const PARTS = { body: { layer: 1, draw(g) { g.rect(4, 10, 8, 8, 'c'); } } };
const mod = { id: 't', actors: { parts: PARTS, anims: { idle: { frames: 1 } }, lookOf: () => ({ parts: ['body'], palette: { c: '#3a6ea5' } }), fallback: { looks: ['A'], subs: [], boss: null, critters: {} } } };
const art = createActorArt({ mod, createCanvas: fakeCanvas, search: '', store: { get: (k, d) => d, set() {} } });
const actor = provider => ({ id: 'a', kind: 'agent', face: 0, anim: 'idle', frame: 0, input: { provider } });

test('gemini agents get a marked, taller frame with its own key; others are untouched', () => {
  const plain = art.frame(actor(null)), gem = art.frame(actor('gemini'));
  assert.ok(gem.h > plain.h && gem.pivot.y > plain.pivot.y);
  assert.notEqual(art.frameKey(actor('gemini')), art.frameKey(actor(null)));
  assert.equal(art.frame(actor('gemini')), gem, 'cached');
});
test('sparkle draws pixels; provider survives the snapshot copy; label exists', () => {
  let n = 0; drawSparkle({ fillRect() { n++; }, set fillStyle(v) {} }, 0, 0);
  assert.ok(n > 20);
  assert.ok(AGENT_FIELDS.includes('provider'));
  assert.equal(copyAgentFields({ id: 'x', provider: 'gemini' }).provider, 'gemini');
  assert.equal(HARNESS_NAME['gemini-cli'], 'Gemini (Antigravity)');
});
