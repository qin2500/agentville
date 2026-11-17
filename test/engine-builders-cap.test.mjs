import './support/ensure-mods-index.mjs';
// vil.builders-cap-4-per-site: a PR site offers at most 4 hammering spots; further builders wait at their own yard, never hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildWorld } = await import('../web/src/engine/world/build.js');
const { addSiteWork } = await import('../web/src/engine/world/site-work.js');
const { resolveMod } = await import('../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./engine-support/world-views.mjs');
const { createSlots } = await import('../web/src/engine/nav/slots.js');
const { resolvePlace } = await import('../web/src/engine/sim/represent.js');

const fx = loadFixture('citydemo.json'), f = fx && (fx.frames ? fx.frames[0] : fx);
const skip = f ? false : 'citydemo.json missing';
function build() {
  const { input, serverId } = toWorldInput(viewFromFixture(f), { seed: 7, salt: '7' });
  return { input, world: buildWorld(input, { v: 1, seed: 7, blocks: {}, lots: {} }, { now: f.now, seed: 7, serverId }) };
}
const inside = (o, s) => s.tx >= o.tx && s.tx < o.tx + o.w && s.ty >= o.ty && s.ty < o.ty + o.h;

test('[vil.builders-cap-4-per-site] after build every PR site has at most 4 work anchors outside its footprint, on standable tiles', { skip }, () => {
  const { world } = build();
  const sites = [...world.objects.values()].filter(o => o.kind === 'building' && o.data?.owner === 'pr');
  assert.ok(sites.length > 0, 'fixture has PR sites');
  let full = 0;
  for (const o of sites) {
    const w = o.anchors?.work || [];
    assert.ok(w.length <= 4, `${o.id} has ${w.length}`);
    if (w.length === 4) full++;
    assert.equal(new Set(w.map(s => `${s.tx},${s.ty}`)).size, w.length, 'distinct tiles');
    for (const s of w) {
      assert.ok(!inside(o, s), `${o.id} work anchor inside footprint`);
      assert.equal(world.grid.get('occ', s.tx, s.ty), 0);
      assert.ok(world.grid.get('cost', s.tx, s.ty) < 255);
    }
  }
  assert.ok(full > 0, 'at least one site keeps all 4 spots');
});

test('[vil.builders-cap-4-per-site] 6 builders on one site: 4 hammer on distinct work anchors, 2 wait at their own yard', { skip }, () => {
  const { world } = build();
  const site = [...world.objects.values()].find(o => o.kind === 'building' && o.data?.owner === 'pr' && o.anchors?.work?.length === 4);
  assert.ok(site);
  const homes = [...world.objects.values()].filter(o => o.data?.owner === 'home' && o.door && o.anchors?.stand);
  assert.ok(homes.length >= 6);
  const slots = createSlots(world);
  const homeOf = id => homes[Number(id.slice(1))];
  const out = Array.from({ length: 6 }, (_, i) => {
    const actor = { id: `b${i}`, agentId: `b${i}`, prs: ['pr1'] };
    return { actor, r: resolvePlace('pr.site', actor, world, { slots, homeOf, prSiteOf: () => site }) };
  });
  const hammer = out.filter(x => x.r.slotKind === 'work' && !x.r.fallback);
  const yard = out.filter(x => x.r.fallback);
  assert.equal(hammer.length, 4);
  assert.equal(yard.length, 2);
  assert.equal(new Set(hammer.map(x => x.r.slotId)).size, 4, 'distinct slots');
  for (const x of hammer) assert.ok(!inside(site, x.r), 'outside the footprint');
  for (const x of yard) { assert.equal(x.r.slotKind, 'stand'); assert.equal(x.r.objId, homeOf(x.actor.id).id, 'own forecourt'); }
});

test('addSiteWork: no mod.siteWork is a no-op; a throwing or bad answer leaves the site bare', () => {
  const grid = { inBounds: () => true, get: (layer) => (layer === 'cost' ? 1 : 0) };
  const mk = () => new Map([['s', { id: 's', kind: 'building', tx: 5, ty: 5, w: 2, h: 2, data: { owner: 'pr' } }]]);
  for (const siteWork of [undefined, () => { throw new Error('x'); }, () => 'nope', () => [{ tx: 'a' }]]) {
    const objs = mk(); addSiteWork(grid, objs, { siteWork });
    assert.equal(objs.get('s').anchors, undefined);
  }
  const objs = mk(); addSiteWork(grid, objs, resolveMod());
  assert.equal(objs.get('s').anchors.work.length, 4);
});
