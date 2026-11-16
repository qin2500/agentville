// agentville.fantasy folk (M6 P2): paper-doll parts, anims and looks. Pure, node only, no canvas (raw frames).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { default: mod, ACTORS } = await import('../mods/agentville.fantasy/index.js');
const { FOLK_PARTS, FOLK_ANIMS } = await import('../mods/agentville.fantasy/art/folk-parts.js');
const { lookOf } = await import('../mods/agentville.fantasy/art/looks.js');
const { createDoll } = await import('../web/src/engine/art/doll.js');
const { hash } = await import('../web/src/engine/core/rng.js');
const { projectStyle } = await import('../mods/agentville.fantasy/style.js');

const ctx = { hash, api: { version: 1 } };
const doll = createDoll({ size: ACTORS.size, parts: FOLK_PARTS, anims: FOLK_ANIMS });
const view = (o = {}) => ({ id: 'a1', kind: 'agent', role: 'worker', parent: null, crown: false, important: false, project: 'p', status: 'working', species: null, seed: null, seen: 0, ...o });
const style = projectStyle('proj-a', { tier: 1 }, undefined);
const opaque = fr => { let n = 0; for (let i = 3; i < fr.img.data.length; i += 4) if (fr.img.data[i] > 200) n++; return n; };

test('mod wiring: actors has parts, anims, lookOf and the sheet fallback', () => {
  assert.equal(mod.actors, ACTORS);
  assert.ok(Object.keys(ACTORS.parts).length > 30);
  assert.equal(typeof ACTORS.lookOf, 'function');
  assert.ok(ACTORS.fallback.looks.length && ACTORS.fallback.boss);
  const frames = { idle: 2, walk: 4, hammer: 2, carry: 4, sit: 1, wave: 2, cheer: 2, sleep: 1 };
  for (const [k, n] of Object.entries(frames)) assert.equal(ACTORS.anims[k].frames, n, k);
});

test('every anim x facing x frame renders non-empty for workers, boss and sub, with a head row', () => {
  const looks = [lookOf(view({ seen: 3 }), style, ctx), lookOf(view({ seen: 8, role: 'boss' }), style, ctx), lookOf(view({ role: 'sub', parent: 'x' }), style, ctx)];
  for (const look of looks) for (const [anim, d] of Object.entries(FOLK_ANIMS)) for (let f = 0; f < d.frames; f++) for (let face = 0; face < 4; face++) {
    const fr = doll.frame(look, face, anim, f);
    assert.ok(fr && opaque(fr) > 60, `${anim} f${f} face${face}`);
    assert.ok(fr.head.y >= 0);
  }
  assert.deepEqual(doll.stats().missing, []);
});

test('front and back facings differ; walk frames differ', () => {
  const look = lookOf(view({ seen: 5 }), style, ctx);
  const a = doll.frame(look, 0, 'idle', 0).img.data, b = doll.frame(look, 2, 'idle', 0).img.data;
  assert.notDeepEqual([...a], [...b]);
  const w0 = doll.frame(look, 0, 'walk', 0).img.data, w1 = doll.frame(look, 0, 'walk', 1).img.data;
  assert.notDeepEqual([...w0], [...w1]);
});

test('looks are deterministic by seen and vary across ordinals', () => {
  for (let n = 0; n < 50; n++) assert.deepEqual(lookOf(view({ seen: n }), style, ctx), lookOf(view({ id: 'other', seen: n }), style, ctx));
  const keys = new Set(Array.from({ length: 40 }, (_, n) => doll.keyOf(lookOf(view({ seen: n }), style, ctx))));
  assert.ok(keys.size >= 30, `only ${keys.size} distinct looks in 40`);
});

test('folk colours come from the settlement palettes and the accent is the project band', () => {
  for (let n = 0; n < 20; n++) {
    const l = lookOf(view({ seen: n }), style, ctx);
    assert.ok(style.folk.skin.includes(l.palette.skin));
    assert.ok(style.folk.clothes.includes(l.palette.cloth));
    assert.equal(l.palette.trim, style.accent);
  }
});

test('boss wears a crown and a cape in the accent; sub is hooded with a parent-derived colour', () => {
  const boss = lookOf(view({ role: 'boss' }), style, ctx);
  assert.ok(boss.extras.includes('crown') && boss.extras.some(e => e.startsWith('cape')));
  assert.equal(boss.palette.cape, style.accent);
  assert.ok(lookOf(view({ crown: true }), style, ctx).extras.includes('crown'));
  const s1 = lookOf(view({ role: 'sub', parent: 'boss-1', seen: 1 }), style, ctx);
  const s2 = lookOf(view({ role: 'sub', parent: 'boss-1', seen: 9, id: 'z' }), style, ctx);
  assert.ok(s1.extras.includes('ninja'));
  assert.equal(s1.palette.hat, s2.palette.hat);
  const hats = new Set(Array.from({ length: 16 }, (_, i) => lookOf(view({ role: 'sub', parent: `p${i}` }), style, ctx).palette.hat));
  assert.ok(hats.size >= 4);
});

test('lookOf never throws for odd views and styles; critters and carts are not drawn', () => {
  const odd = [null, undefined, 0, 'x', {}, view({ seen: NaN }), view({ seen: -7 }), view({ seen: 1e300 }), view({ seen: 2.5 }), view({ id: undefined }),
    view({ parent: 42, role: 'sub' }), view({ kind: 'folk', seed: 7, seen: 7 })];
  const styles = [null, undefined, {}, { folk: null }, { folk: { palettes: [[1]], clothes: 'x', skin: [], headwear: [null], apron: -2 }, accent: 5 }, style];
  for (const v of odd) for (const s of styles) {
    let l;
    assert.doesNotThrow(() => { l = lookOf(v, s, ctx); });
    assert.doesNotThrow(() => { l = lookOf(v, s, undefined); });
    if (l) { assert.ok(Array.isArray(l.parts) && l.parts.length); assert.ok(doll.frame(l, 0, 'walk', 1)); }
  }
  assert.equal(lookOf(view({ kind: 'critter', species: 'cat' }), style, ctx), null);
  assert.equal(lookOf(view({ kind: 'cart' }), style, ctx), null);
});
