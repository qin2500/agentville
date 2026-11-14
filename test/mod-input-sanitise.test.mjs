// village-mods.md §3.1 (WorldInput allow-list + "never contains") and §6.1 item 2. Written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toWorldInput } from '../web/src/engine/mod/input.js';
import { API_VERSION } from '../web/src/engine/mod/api.js';
import { canaryView, CANARIES, RAW_IDS, NOW } from './mod-support/views.mjs';

const make = (salt = 'salt-A', extra = {}) => { const { view, ids } = canaryView(); return { ids, r: toWorldInput(view, { seed: 5, salt, ...extra }) }; };
const byName = (r, ids, key) => r.input.agents.find(a => a.id === r.opaqueId(ids[key]));

test('§3.1 no canary string and no raw server id survives', () => {
  const { r } = make();
  const s = JSON.stringify(r.input);
  for (const c of CANARIES) assert.ok(!s.includes(c), `leaked canary ${c}`);
  for (const id of RAW_IDS) assert.ok(!s.includes(id), `leaked raw id ${id}`);
  assert.ok(!/sess-/.test(s) && !/https?:/.test(s) && !/\/Users\//.test(s));
});

test('§3.1 opaque ids: stable per salt, different across salts, serverId maps back', () => {
  const { ids, r } = make('salt-A'), again = make('salt-A'), other = make('salt-B');
  for (const raw of Object.values(ids)) {
    const o = r.opaqueId(raw);
    assert.equal(typeof o, 'string');
    assert.notEqual(o, raw);
    assert.equal(again.r.opaqueId(raw), o);
    assert.notEqual(other.r.opaqueId(raw), o);
    assert.equal(r.serverId(o), raw);
  }
  assert.equal(r.serverId('not-an-opaque-id'), undefined);
  assert.equal(new Set(r.input.agents.map(a => a.id)).size, r.input.agents.length, 'ids unique');
});

test('§3.1 parent: opaque id of a known agent, null when the server no longer has it', () => {
  const { ids, r } = make();
  assert.equal(byName(r, ids, 'lead').parent, r.opaqueId(ids.boss));
  assert.equal(byName(r, ids, 'sub').parent, r.opaqueId(ids.lead));
  assert.equal(byName(r, ids, 'orphan').parent, null);
  assert.equal(byName(r, ids, 'boss').parent, null);
});

test('§3.1 status derived from bucket and severity', () => {
  const { ids, r } = make();
  assert.equal(byName(r, ids, 'solo').status, 'working');
  assert.equal(byName(r, ids, 'wait').status, 'waiting');
  assert.equal(byName(r, ids, 'err').status, 'error');
  assert.equal(byName(r, ids, 'stall').status, 'stalled');
  assert.equal(byName(r, ids, 'rest').status, 'resting');
});

test('§3.1 needs is the enum key (or null), role solo becomes worker', () => {
  const { ids, r } = make();
  assert.equal(byName(r, ids, 'boss').needs, 'permission');
  assert.equal(byName(r, ids, 'wait').needs, 'question');
  assert.equal(byName(r, ids, 'solo').needs, null);
  assert.equal(byName(r, ids, 'solo').role, 'worker');
  assert.equal(byName(r, ids, 'boss').role, 'boss');
  assert.equal(byName(r, ids, 'lead').role, 'lead');
  assert.equal(byName(r, ids, 'sub').role, 'sub');
});

test('§3.1 allowed fields: names (agent, project) pass; agent shape is exactly the allow-list', () => {
  const { ids, r } = make();
  const a = byName(r, ids, 'solo');
  assert.equal(a.name, 'Name solo'.replace('solo', 'solo'));
  assert.equal(a.project, 'alpha');
  assert.deepEqual(Object.keys(a).sort(), ['crown', 'harness', 'id', 'important', 'lastActive', 'name', 'needs', 'parent', 'project', 'prs', 'role', 'since', 'status', 'stopped'].sort());
  assert.ok(['claude', 'codex', 'other'].includes(a.harness));
  assert.equal(typeof a.since, 'number');
  assert.equal(typeof a.lastActive, 'number');
  assert.ok(Array.isArray(a.prs));
});

test('§3.1 top level: apiVersion, now, seed, env, projects', () => {
  const { r } = make('s', { env: { night: 0.5, reduceMotion: true, zoom: 2 } });
  const i = r.input;
  assert.equal(i.apiVersion, API_VERSION);
  assert.equal(i.now, NOW);
  assert.equal(i.seed, 5);
  assert.ok(i.env && typeof i.env === 'object');
  for (const k of ['night', 'reduceMotion', 'zoom']) assert.ok(k in i.env, `env.${k}`);
  assert.equal(i.env.night, 0.5);
  const p = i.projects.find(p => p.name === 'alpha');
  assert.ok(p, 'project present by display name');
  assert.equal(typeof p.key, 'string');
  assert.equal(typeof p.accent, 'string');
  for (const k of ['prsEver', 'prsLive', 'agentsEver', 'agentsNow', 'transcriptMB']) assert.equal(typeof p.stats[k], 'number', `stats.${k}`);
});

test('§3.1 PR ids are <projectKey>#<number>, titles allowed, no hrefs', () => {
  const { r } = make();
  const proj = r.input.projects.find(p => p.name === 'alpha');
  assert.ok(r.input.prs.length >= 2);
  for (const pr of r.input.prs) {
    assert.equal(pr.id, `${proj.key}#${pr.number}`);
    assert.equal(pr.project, proj.key);
    assert.ok(['building', 'loading', 'merged', 'closed'].includes(pr.state));
    assert.equal(typeof pr.title, 'string');
    for (const k of Object.keys(pr)) assert.ok(!/href|url/i.test(k), `pr field ${k}`);
  }
  assert.equal(r.input.prs.find(p => p.number === 7).state, 'building');
  assert.equal(r.input.prs.find(p => p.number === 8).state, 'merged');
});

test('§3.1 deep-frozen: mutation throws or is ignored, at every depth', () => {
  const { r } = make();
  const frozen = o => {
    assert.ok(Object.isFrozen(o), 'object not frozen');
    for (const v of Object.values(o)) if (v && typeof v === 'object') frozen(v);
  };
  frozen(r.input);
  const before = JSON.stringify(r.input);
  assert.throws(() => { 'use strict'; r.input.agents[0].name = 'x'; }, TypeError);
  assert.throws(() => { 'use strict'; r.input.agents.push({}); }, TypeError);
  assert.throws(() => { 'use strict'; r.input.env.night = 9; }, TypeError);
  assert.equal(JSON.stringify(r.input), before);
});
