// S5 sim/represent.js: declarative behaviour/represent seams (village-mods.md §3.2, design v2 §4.2). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectStore } from '../web/src/engine/core/objects.js';
import { representAgent, resolvePlace, validateBehaviour, ENGINE_BEHAVIOUR, BEHAVIOUR_KEYS } from '../web/src/engine/sim/represent.js';

// Real seam modules when this branch has them (after merge into engine); else spec-shaped stand-ins.
const tryImport = async p => { try { return await import(p); } catch { return null; } };
const slotsMod = await tryImport('../web/src/engine/nav/slots.js');
const artMod = await tryImport('../web/src/engine/mod/art-view.js');
const fantasy = await tryImport('../mods/agentville.fantasy/represent.js');

function fakeSlots(world) {   // N4 seam: claim / release / nearestFree (+ all, heldBy)
  const slots = new Map(), owner = new Map(), held = new Map();
  for (const o of world.objects.values()) for (const kind of ['stand', 'work', 'sit', 'vend']) for (const s of o.anchors?.[kind] || []) {
    const subs = kind === 'stand' ? [0, 1, 2, 3] : [s.sub | 0];
    for (const sub of subs) { const id = `${o.id}:${kind}:${s.tx},${s.ty}:${sub}`; slots.set(id, { id, tx: s.tx, ty: s.ty, sub, kind }); }
  }
  return {
    claim(id, actor) { const s = slots.get(typeof id === 'string' ? id : id?.id); if (!s) return null; const c = owner.get(s.id);
      if (c !== undefined && c !== actor) return null; if (c === actor) return s; this.release(actor); owner.set(s.id, actor); held.set(actor, s.id); return s; },
    release(actor) { const id = held.get(actor); if (id !== undefined) { held.delete(actor); owner.delete(id); } },
    nearestFree(x, y, kind) { let b = null, bd = Infinity; for (const s of slots.values()) { if ((kind && s.kind !== kind) || owner.has(s.id)) continue;
      const d = (s.tx - x) ** 2 + (s.ty - y) ** 2; if (d < bd) { b = s; bd = d; } } return b; },
    all: () => [...slots.values()], heldBy: a => (held.has(a) ? slots.get(held.get(a)) : null),
  };
}
const createSlots = slotsMod?.createSlots || fakeSlots;
const artView = artMod?.artView || (o => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !['data', 'agentId', 'item', 'serverId'].includes(k)))));

const B = (id, tx, ty, data, extra = {}) => ({ id, kind: 'building', model: 'timber', tx, ty, w: 2, h: 2, z: 20, walk: 'block', styleKey: 's', variant: 0,
  door: { tx: tx + 1, ty: ty + 2, face: 'S' }, anchors: { stand: [{ tx: tx + 1, ty: ty + 2, sub: 0, face: 0 }] }, project: 'p', data, ...extra });
// server ids live in data.agentId (S-1, S-2); the opaque ids the mod/sim see are a-1, a-2; homeOf maps between them.
function world() {
  const objects = new ObjectStore();
  objects.add(B('lot:p:1', 0, 0, { item: 'home:S-1', owner: 'home', agentId: 'S-1' }, { anchors: { stand: [{ tx: 1, ty: 2, sub: 0, face: 0 }], work: [{ tx: 3, ty: 2, sub: 0, face: 0 }] } }));
  objects.add(B('lot:p:2', 6, 0, { item: 'home:S-2', owner: 'home', agentId: 'S-2' }));
  objects.add(B('lot:p:3', 0, 6, { item: 'pr:p#7', owner: 'pr', pr: 'p#7', building: true },
    { anchors: { work: [0, 1, 2, 3].map(i => ({ tx: i, ty: 9, sub: 0, face: 0 })) } }));
  objects.add({ id: 'prop:p:bench:0', kind: 'prop', model: 'bench', tx: 3, ty: 4, w: 1, h: 1, z: 8, walk: 'block', styleKey: 's', variant: 0,
    anchors: { sit: [{ tx: 3, ty: 5, sub: 0, face: 0 }, { tx: 4, ty: 5, sub: 1, face: 0 }] } });
  objects.add({ id: 'prop:far:bench:0', kind: 'prop', model: 'bench', tx: 60, ty: 60, w: 1, h: 1, z: 8, walk: 'block', styleKey: 's', variant: 0,
    anchors: { sit: [{ tx: 60, ty: 61, sub: 0, face: 0 }] } });
  // C1: venue:<id> resolves through world.venues only (the world.dock fallback is gone); tx/ty = the site anchor
  return { objects, square: { x: -4, y: -20, w: 9, h: 5 },
    venues: { dock: { id: 'dock', kind: 'harbour', tx: 0, ty: 40, rect: { x: -22, y: 37, w: 49, h: 17 }, level: 1, nodes: {}, berths: [] } } };
}
const HOME = { 'a-1': 'lot:p:1', 'a-2': 'lot:p:2' };
const homeOf = id => HOME[id] ?? null;
const agent = (o = {}) => ({ id: 'a-1', name: 'n', project: 'p', parent: null, status: 'working', needs: null, role: 'worker', crown: false,
  important: false, stopped: false, harness: 'claude', prs: [], ...o });
const PRS = [{ id: 'p#7', state: 'building' }, { id: 'p#8', state: 'loading' }, { id: 'p#9', state: 'merged' }];

// ---------------------------------------------------------------- engine defaults implement §4.2

test('engine defaults (empty mod) follow the §4.2 table', () => {
  const r = (o, ctx = { prs: PRS }) => representAgent(agent(o), {}, ctx);
  assert.equal(r({ status: 'working', prs: ['p#7'] }).place, 'pr.site');
  assert.equal(r({ status: 'working', prs: ['p#7'] }).pose, 'hammer');
  assert.equal(r({ status: 'working' }).place, 'anchor:work');
  assert.equal(r({ status: 'working', prs: ['p#9'] }).place, 'anchor:work', 'merged PR is not a live site');
  const w = r({ status: 'waiting' });
  assert.equal(w.place, 'anchor:sit'); assert.equal(w.pose, 'sit'); assert.deepEqual(w.idleEvery, [6, 10]);
  for (const o of [{ status: 'stalled' }, { status: 'stalled', needs: 'permission' }, { status: 'error' }]) {
    const s = r(o);
    assert.equal(s.place, 'home.forecourt'); assert.equal(s.walk, false); assert.equal(s.fixed, true); assert.equal(s.face, 0);
  }
  assert.equal(r({ status: 'stalled', needs: 'question' }).key, 'stalled:prompt');
  assert.equal(r({ status: 'stalled' }).key, 'stalled:attention');
  assert.equal(r({ status: 'error' }).key, 'stalled:error');
  const rest = r({ status: 'resting' });
  assert.equal(rest.indoors, true); assert.equal(rest.walk, false);
  const porter = r({ status: 'resting', prs: ['p#8'] });
  assert.equal(porter.key, 'resting:prs-loading'); assert.equal(porter.place, 'home.forecourt'); assert.equal(porter.pose, 'idle');
  const imp = r({ status: 'resting', important: true });
  assert.equal(imp.place, 'home.forecourt'); assert.equal(imp.indoors, false); assert.equal(imp.ghost, true);
  assert.equal(r({ status: 'resting', stopped: true }).ghost, true);
});

test('snapshot-shaped agents (bucket, severity, prompt, sub) map the same way', () => {
  const r = o => representAgent({ id: 'x', ...o }, {});
  assert.equal(r({ bucket: 'building', prs: [{ id: 'p#7', live: true }] }).key, 'working');
  assert.equal(r({ bucket: 'building' }).key, 'building');
  assert.equal(r({ bucket: 'stalled', severity: 'error' }).key, 'stalled:error');
  assert.equal(r({ bucket: 'stalled', prompt: 'plan' }).key, 'stalled:prompt');
  assert.equal(r({ bucket: 'resting', prs: [{ id: 'p#8', state: 'loading' }] }).key, 'resting:prs-loading');
  assert.equal(r({ bucket: 'waiting', sub: true }).sub, true);
});

test('sub-agents take the sub place and look but their own bucket pose; stalled subs still never walk', () => {
  const mod = { behaviour: { sub: { place: 'anchor:stand', pose: 'stand', idle: [], look: 'ninja', walk: true }, waiting: { place: 'anchor:sit', pose: 'sit', idle: [], walk: true } } };
  const s = representAgent(agent({ role: 'sub', status: 'waiting', parent: 'a-1' }), mod);
  assert.equal(s.place, 'anchor:stand'); assert.equal(s.pose, 'sit'); assert.equal(s.look, 'ninja'); assert.equal(s.sub, true); assert.equal(s.parent, 'a-1');
  const st = representAgent(agent({ role: 'sub', status: 'stalled' }), mod);
  assert.equal(st.walk, false); assert.equal(st.fixed, true); assert.equal(st.indoors, false);
});

// ---------------------------------------------------------------- mod data

test('mod.behaviour overrides field by field; lookup chains fall back (stalled:prompt -> stalled)', () => {
  const mod = { behaviour: { waiting: { place: 'venue:square', pose: 'chat', idle: ['nod'], walk: true }, stalled: { place: 'home.forecourt', pose: 'jump', idle: [], walk: false } } };
  const w = representAgent(agent({ status: 'waiting' }), mod);
  assert.equal(w.place, 'venue:square'); assert.equal(w.pose, 'chat'); assert.deepEqual(w.idle, ['nod']);
  assert.deepEqual(w.idleEvery, [6, 10], 'missing field comes from the engine default');
  assert.equal(representAgent(agent({ status: 'stalled', needs: 'dialog' }), mod).pose, 'jump');
  assert.equal(representAgent(agent({ status: 'error' }), mod).pose, 'jump');
});

test('a mod cannot make a stalled or error agent walk', () => {
  const mod = { behaviour: { 'stalled:error': { place: 'venue:square', pose: 'run', idle: [], walk: true } } };
  const s = representAgent(agent({ status: 'error' }), mod);
  assert.equal(s.walk, false); assert.equal(s.fixed, true);
});

test('validation: unknown place kind -> home.forecourt + lint; bad fields fall back + lint; non-objects dropped', () => {
  const beh = { waiting: { place: 'teleport:moon', pose: 'Bad Pose!', idle: 'x', idleEvery: [5, 1], walk: 'yes' }, working: 3, zzz: { place: 'pr.site' } };
  const { behaviour, lint } = validateBehaviour(beh);
  assert.equal(behaviour.waiting.place, 'home.forecourt');
  assert.equal(behaviour.working, undefined);
  const kinds = lint.map(l => l.kind);
  for (const k of ['behaviour-place', 'behaviour-pose', 'behaviour-idle', 'behaviour-idleEvery', 'behaviour-walk', 'behaviour-entry', 'behaviour-key']) assert.ok(kinds.includes(k), k);
  const ctxLint = [];
  const s = representAgent(agent({ status: 'waiting' }), { behaviour: beh }, { lint: ctxLint });
  assert.equal(s.place, 'home.forecourt'); assert.equal(s.pose, ENGINE_BEHAVIOUR.waiting.pose); assert.equal(s.walk, true);
  representAgent(agent({ status: 'waiting' }), { behaviour: beh }, { lint: ctxLint });
  assert.equal(ctxLint.length, lint.length, 'table lint reported once per lint array');
  assert.equal(validateBehaviour(beh), validateBehaviour(beh), 'cached per object');
});

test('ActorSpec is plain data (structuredClone round-trips)', () => {
  const s = representAgent(agent({ status: 'waiting' }), { represent: { agent: 'villager', boss: { model: 'villager', hat: 'crown' } } });
  assert.deepEqual(structuredClone(s), s);
  assert.equal(s.model, 'villager'); assert.equal(s.hat, null);
  const boss = representAgent(agent({ role: 'boss', crown: true }), { represent: { agent: 'villager', boss: { model: 'villager', hat: 'crown' } } });
  assert.equal(boss.hat, 'crown');
});

test('fantasy BEHAVIOUR/REPRESENT data drives the spec', { skip: !fantasy && 'mods/agentville.fantasy/represent.js not on this branch' }, () => {
  const mod = { behaviour: fantasy.BEHAVIOUR, represent: fantasy.REPRESENT };
  const lint = [];
  for (const [o, place] of [[{ status: 'working', prs: ['p#7'] }, 'pr.site'], [{ status: 'working' }, 'anchor:work'], [{ status: 'waiting' }, 'anchor:sit'],
    [{ status: 'stalled' }, 'home.forecourt'], [{ status: 'resting', prs: ['p#8'] }, 'venue:dock']]) {
    assert.equal(representAgent(agent(o), mod, { prs: PRS, lint }).place, place, JSON.stringify(o));
  }
  assert.equal(representAgent(agent({ role: 'sub', status: 'working' }), mod, { prs: PRS }).look, 'ninja');
  assert.deepEqual(lint.filter(l => l.kind !== 'represent-shape'), [], 'fantasy data validates clean');
});

// ---------------------------------------------------------------- the code hook

test('represent.agent hook sees only opaque ids and artView objects; its output is sanitised', () => {
  let seen = null;
  const w = world();
  const mod = { represent: { agent(a, ctx) { seen = { a, ctx }; return { model: 'robot', look: 'chrome', pose: 'dance', place: 'nowhere:x', tint: '#11aa22', evil: () => 1, walk: 'no' }; } } };
  const lint = [];
  const s = representAgent({ ...agent({ status: 'waiting' }), serverId: 'S-1', sessionId: 'raw', cwd: '/secret' }, mod, { world: w, homeOf, artView, lint });
  assert.equal(seen.a.id, 'a-1');
  for (const k of ['serverId', 'sessionId', 'cwd']) assert.equal(k in seen.a, false, k);
  assert.ok(Object.isFrozen(seen.a));
  assert.equal(seen.ctx.home.id, 'lot:p:1');
  assert.equal('data' in seen.ctx.home, false, 'home is an artView copy, no data/agentId');
  assert.ok(!JSON.stringify(seen).includes('S-1'), 'no server id reaches the hook');
  assert.equal(s.model, 'robot'); assert.equal(s.look, 'chrome'); assert.equal(s.pose, 'dance'); assert.equal(s.tint, '#11aa22');
  assert.equal(s.place, 'home.forecourt'); assert.equal(s.walk, true);
  assert.equal('evil' in s, false);
  assert.ok(lint.some(l => l.kind === 'behaviour-place'));
  assert.deepEqual(structuredClone(s), s);
});

test('a throwing hook gives engine defaults and a lint', () => {
  const lint = [];
  const s = representAgent(agent({ status: 'waiting' }), { represent: { agent() { throw new Error('boom'); } } }, { lint });
  assert.equal(s.place, 'anchor:sit');
  assert.ok(lint.some(l => l.kind === 'represent-hook'));
});

// ---------------------------------------------------------------- resolvePlace

test('home.forecourt: the home door via ctx.homeOf, a stand slot reserved', () => {
  const w = world(), slots = createSlots(w);
  const r = resolvePlace('home.forecourt', { id: 'act-1', agentId: 'a-1' }, w, { homeOf, slots });
  assert.equal(r.tx, 1); assert.equal(r.ty, 2); assert.equal(r.slotKind, 'stand'); assert.equal(r.fallback, undefined);
  const r2 = resolvePlace('home.forecourt', { id: 'act-x', agentId: 'a-1' }, w, { homeOf, slots });
  assert.notEqual(r2.sub, r.sub, 'a second actor gets another sub-slot on the same tile');
  assert.equal(resolvePlace('home.forecourt', { id: 'act-9', agentId: 'a-unknown' }, w, { homeOf, slots }), null);
});

test('unknown place strings resolve as home.forecourt', () => {
  const r = resolvePlace('moon:base', { id: 'act-1', agentId: 'a-1' }, world(), { homeOf });
  assert.deepEqual([r.tx, r.ty, r.slotKind], [1, 2, 'stand']);
});

test('pr.site: the PR site work anchors (<= 4 actors), then the forecourt', () => {
  const w = world(), slots = createSlots(w), seen = new Set();
  for (let i = 0; i < 4; i++) {
    const r = resolvePlace('pr.site', { id: `act-${i}`, agentId: 'a-1', prs: ['p#7'] }, w, { homeOf, slots });
    assert.equal(r.slotKind, 'work'); assert.equal(r.ty, 9); seen.add(`${r.tx},${r.ty}`);
  }
  assert.equal(seen.size, 4);
  const r5 = resolvePlace('pr.site', { id: 'act-5', agentId: 'a-1', prs: ['p#7'] }, w, { homeOf, slots });
  assert.equal(r5.fallback, true); assert.equal(r5.place, 'home.forecourt'); assert.deepEqual([r5.tx, r5.ty], [1, 2]);
  const none = resolvePlace('pr.site', { id: 'act-6', agentId: 'a-2', prs: [] }, w, { homeOf, slots });
  assert.equal(none.fallback, true); assert.deepEqual([none.tx, none.ty], [7, 2]);
  const via = resolvePlace('pr.site', { id: 'act-7', agentId: 'a-2', prs: ['q'] }, w, { homeOf, prSiteOf: () => 'lot:p:3', slots: createSlots(w) });
  assert.equal(via.slotKind, 'work');
});

test('anchor:<kind> near home, nearest free, stable while held; too far -> forecourt', () => {
  const w = world(), slots = createSlots(w);
  const a = resolvePlace('anchor:sit', { id: 'act-1', agentId: 'a-1' }, w, { homeOf, slots });
  assert.deepEqual([a.tx, a.ty, a.slotKind], [3, 5, 'sit']);
  assert.deepEqual(resolvePlace('anchor:sit', { id: 'act-1', agentId: 'a-1' }, w, { homeOf, slots }).slotId, a.slotId, 'idempotent');
  const b = resolvePlace('anchor:sit', { id: 'act-2', agentId: 'a-1' }, w, { homeOf, slots });
  assert.deepEqual([b.tx, b.ty], [4, 5]);
  const c = resolvePlace('anchor:sit', { id: 'act-3', agentId: 'a-1' }, w, { homeOf, slots });
  assert.equal(c.fallback, true, 'the far bench (60,61) is out of range');
  const work = resolvePlace('anchor:work', { id: 'act-4', agentId: 'a-1' }, w, { homeOf, slots });
  assert.deepEqual([work.tx, work.ty, work.slotKind], [3, 2, 'work']);
});

test('anchor for a sub-agent searches round the parent home', () => {
  const w = world(), slots = createSlots(w);
  const r = resolvePlace('anchor:stand', { id: 'sub-1', agentId: 'a-sub', parent: 'a-2' }, w, { homeOf, slots });
  assert.deepEqual([r.tx, r.ty, r.slotKind], [7, 2, 'stand']);
});

test('venue:square and venue:dock resolve; unknown venue -> forecourt', () => {
  const w = world();
  const sq = resolvePlace('venue:square', { id: 'act-1', agentId: 'a-1' }, w, { homeOf });
  assert.deepEqual([sq.tx, sq.ty], [0, -18]);
  const dk = resolvePlace('venue:dock', { id: 'act-1', agentId: 'a-1' }, w, { homeOf, slots: createSlots(w) });
  assert.deepEqual([dk.tx, dk.ty, dk.slotKind], [0, 40, 'stand']);
  const nope = resolvePlace('venue:moon', { id: 'act-1', agentId: 'a-1' }, w, { homeOf });
  assert.equal(nope.fallback, true);
});

test('without slots or homeOf: plain scans still resolve (no reservation)', () => {
  const w = world();
  for (const o of w.objects.values()) if (o.data?.agentId) o.data.agentId = o.data.agentId.replace('S-', 'a-');   // ids happen to match
  const r = resolvePlace('anchor:sit', { id: 'act-1', agentId: 'a-1' }, w);
  assert.deepEqual([r.tx, r.ty], [3, 5]);
  const p = resolvePlace('pr.site', { id: 'act-1', agentId: 'a-1', prs: ['p#7'] }, w);
  assert.equal(p.slotKind, 'work');
});

test('end to end: spec from representAgent feeds resolvePlace', () => {
  const w = world(), slots = createSlots(w);
  const spec = representAgent(agent({ status: 'working', prs: ['p#7'] }), {}, { prs: PRS });
  const r = resolvePlace(spec.place, { id: 'act-1', ...spec }, w, { homeOf, slots });
  assert.equal(r.slotKind, 'work'); assert.equal(r.ty, 9);
  assert.ok(BEHAVIOUR_KEYS.includes(spec.key));
});

test('POSE_ANIM is the identity over ANIMS; animOf(pose, mod) maps mod pose names through represent.poses', async () => {
  const { POSE_ANIM, animOf, isAnim } = await import('../web/src/engine/sim/represent.js');
  const { ANIMS } = await import('../web/src/engine/sim/actor.js');
  assert.deepEqual(Object.keys(POSE_ANIM), [...ANIMS]);
  for (const [k, v] of Object.entries(POSE_ANIM)) assert.equal(k, v);
  const mod = { represent: { poses: { saw: 'hammer', 'wave-both': 'wave', 'carry-crate': 'carry', junk: 'not-an-anim' } } };
  assert.equal(animOf('saw', mod), 'hammer'); assert.equal(animOf('wave-both', mod), 'wave'); assert.equal(animOf('carry-crate', mod), 'carry');
  assert.equal(animOf('saw'), 'idle', 'no mod: the engine knows no mod pose names');
  assert.equal(animOf('junk', mod), 'idle'); assert.equal(animOf('no-such-pose', mod), 'idle');
  assert.equal(animOf('hammer', mod), 'hammer'); assert.equal(isAnim('sleep'), true); assert.equal(isAnim('stand'), false);
});
