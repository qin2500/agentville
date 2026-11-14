import './support/ensure-mods-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { pickWorld, loadWorlds, worldPickerHtml, applyWorld, engineActive, DEFAULT_WORLD, WORLD_KEY } = await import('../web/src/worlds.js');
const { listMods } = await import('../web/src/engine/mod/registry.js');

const IDS = ['agentville.base', 'agentville.fantasy'];
const mem = (init = {}) => { const m = new Map(Object.entries(init)); return { get: (k, d) => (m.has(k) ? JSON.parse(m.get(k)) : d), set: (k, v) => m.set(k, JSON.stringify(v)), raw: m }; };

test('pickWorld never throws and falls back to the default', () => {
  for (const bad of ['Foo', '', '../x', 'a.b.demo', 'x'.repeat(500), null, undefined, 7, {}, [], '__proto__'])
    assert.equal(pickWorld(bad, undefined, IDS), DEFAULT_WORLD);
  assert.equal(pickWorld('nope.unknown', 'also.unknown', IDS), DEFAULT_WORLD);
  assert.equal(pickWorld(undefined, undefined, undefined), DEFAULT_WORLD);
  assert.equal(pickWorld('agentville.base', undefined, null), DEFAULT_WORLD);
});

test('pickWorld: param wins over stored; an invalid param falls through to stored', () => {
  assert.equal(pickWorld('agentville.base', 'agentville.fantasy', IDS), 'agentville.base');
  assert.equal(pickWorld(undefined, 'agentville.base', IDS), 'agentville.base');
  assert.equal(pickWorld('Foo', 'agentville.base', IDS), 'agentville.base');
});

test('loadWorlds lists the bundled worlds and caches the promise', async () => {
  const a = loadWorlds();
  assert.equal(a, loadWorlds());
  const worlds = await a;
  assert.deepEqual(worlds.map(w => w.id), listMods().map(m => m.id));
  assert.ok(worlds.some(w => w.id === DEFAULT_WORLD));
  assert.ok(worlds.every(w => typeof w.name === 'string' && w.name));
});

test('worldPickerHtml builds a select with the current world selected and escapes', () => {
  const esc = s => String(s).replace(/</g, '&lt;');
  const html = worldPickerHtml({ current: 'agentville.base', worlds: [{ id: 'agentville.base', name: 'Base' }, { id: 'a.b', name: '<b>' }], esc });
  assert.match(html, /<select data-set="world">/);
  assert.match(html, /<option value="agentville.base" selected>Base<\/option>/);
  assert.match(html, /<option value="a.b">&lt;b>/);
  assert.equal((html.match(/selected/g) || []).length, 1);
});

test('applyWorld persists va.world.mod and reloads once', () => {
  const s = mem(); let n = 0;
  applyWorld('agentville.base', s, () => n++);
  assert.equal(s.get(WORLD_KEY), 'agentville.base');
  assert.equal(n, 1);
});

test('?world= wins for the session without writing va.world.mod', () => {
  const s = mem({ [WORLD_KEY]: JSON.stringify('agentville.fantasy') });
  assert.equal(pickWorld('agentville.base', s.get(WORLD_KEY), IDS), 'agentville.base');
  assert.equal(s.get(WORLD_KEY), 'agentville.fantasy');
});

test('engineActive follows ?engine, then va.engine', () => {
  assert.equal(engineActive('', mem()), false);
  assert.equal(engineActive('?engine=2', mem()), true);
  assert.equal(engineActive('?engine=1', mem({ 'va.engine': 2 })), false);
  assert.equal(engineActive('', mem({ 'va.engine': 2 })), true);
});
