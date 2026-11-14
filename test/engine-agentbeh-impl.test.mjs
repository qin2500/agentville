// Engine v2 S3: agent behaviour (design §4.2, decision D4), driven through the real world-sim, which owns movement
// (behaviours set a.path; only the sim moves actors). Fake places, straight-line nav, in-memory slots.
import test from 'node:test'
import assert from 'node:assert/strict'
import agent, { behaviourKey, FADE_S, WALK_MAX_S } from '../web/src/engine/sim/behaviours/agent.js'
import { createSim } from '../web/src/engine/sim/world-sim.js'

const INDOORS = 8, GHOST = 16
const DT = 0.1

function fakeSlots(defs) {
  const slots = defs.map((d, i) => ({ id: d.id ?? `s${i}`, tx: d.tx, ty: d.ty, sub: d.sub ?? 0, kind: d.kind ?? 'stand' }))
  const owner = new Map(), held = new Map()
  const api = {
    claim(id, actor) {
      const s = slots.find(x => x.id === (id.id ?? id)); if (!s) return null
      if (owner.has(s.id) && owner.get(s.id) !== actor) return null
      api.release(actor); owner.set(s.id, actor); held.set(actor, s.id); return s
    },
    release(actor) { const id = held.get(actor); if (id !== undefined) { held.delete(actor); owner.delete(id) } },
    nearestFree(x, y, kind) {
      let best = null, bd = Infinity
      for (const s of slots) {
        if (s.kind !== kind || owner.has(s.id)) continue
        const d = (s.tx - x) ** 2 + (s.ty - y) ** 2
        if (d < bd) { bd = d; best = s }
      }
      return best
    },
    heldBy: (actor) => slots.find(s => s.id === held.get(actor)) ?? null,
  }
  return api
}

function straightNav(slots) {
  const calls = []
  return {
    calls, slots,
    path(from, to) {
      calls.push([from, to])
      const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)))
      const out = []
      for (let i = 1; i <= n; i++) out.push(from.x + (to.x - from.x) * i / n, from.y + (to.y - from.y) * i / n)
      return Float32Array.from(out)
    },
  }
}

const SLOTS = [
  { id: 'fc0', tx: 10, ty: 10, sub: 0, kind: 'stand' }, { id: 'fc1', tx: 10, ty: 10, sub: 1, kind: 'stand' },
  { id: 'w0', tx: 16, ty: 10, sub: 0, kind: 'work' }, { id: 'w1', tx: 16, ty: 10, sub: 1, kind: 'work' },
  { id: 'far', tx: 80, ty: 10, sub: 0, kind: 'work' }, { id: 'mid', tx: 40, ty: 10, sub: 0, kind: 'work' },
  { id: 'b0', tx: 10, ty: 14, sub: 0, kind: 'sit' },
]
// places: home forecourt at (10,10); a PR site at (16,10) (6 tiles); a bench at (10,14).
const PLACES = {
  'home.forecourt': { tx: 10, ty: 10, slotKind: 'stand' },
  'pr.site': { tx: 16, ty: 10, slotKind: 'work' },
  'anchor:work': { tx: 16, ty: 10, slotKind: 'work' },
  'anchor:sit': { tx: 10, ty: 14, slotKind: 'sit' },
}
const home = (id, agentId) => [id, { id, kind: 'building', tx: 9, ty: 8, w: 1, h: 1, door: { tx: 10, ty: 10, face: 0 }, data: { owner: 'home', agentId } }]
const world = () => ({ version: 1, objects: new Map([home('h1', 'a1'), home('h2', 'a2'), home('h3', 'b')]), villages: [] })

const ag = (id, status, extra = {}) => ({ id, name: id, project: 'p', parent: null, status, needs: null, role: 'worker', crown: false,
  important: false, stopped: false, harness: 'claude', since: 0, lastActive: 0, prs: [], ...extra })
const input = (agents, env = {}) => ({ apiVersion: 1, now: 0, seed: 1, agents, projects: [{ key: 'p' }], prs: [], env: { night: 0, reduceMotion: false, zoom: 1, ...env } })

/** A sim with agent a1 in `status`; set(status, extra) changes it; run(seconds, each) ticks DT at a time. */
function harness(status, extra = {}, opts = {}) {
  const slots = fakeSlots(SLOTS), nav = straightNav(slots)
  const places = opts.places ?? PLACES
  const sim = createSim({ world: world(), nav, seed: opts.seed ?? 7, mod: opts.mod ?? null,
    onScreen: () => opts.onScreen ?? true, deps: { resolvePlace: (place) => places[place] ?? null, ...opts.deps } })
  let agents = [ag('a1', status, extra), ...(opts.more ?? [])]
  const env = { reduceMotion: !!opts.reduceMotion }
  sim.applySnapshot(input(agents, env))
  const h = {
    sim, slots, nav,
    get a() { return sim.actors.get('a1') },
    set(st, ex = {}) { agents = agents.map(x => (x.id === 'a1' ? ag('a1', st, ex) : x)); sim.applySnapshot(input(agents, env)) },
    run(seconds, each) { for (let t = 0; t < Math.round(seconds / DT); t++) { sim.tick(DT); each?.(h.a, t) } },
  }
  return h
}
const near = (a, tx, ty, r = 1) => Math.abs(a.x - (tx + 0.5)) <= r && Math.abs(a.y - (ty + 0.5)) <= r

test('module has the behaviour shape (init, replan, update)', () => {
  for (const k of ['init', 'replan', 'update']) assert.equal(typeof agent[k], 'function', k)
})

test('status buckets map to the §4.2 rows', () => {
  const mk = (status, extra = {}) => ({ status, ...extra })
  assert.equal(behaviourKey(mk({ bucket: 'working' })), 'building')
  assert.equal(behaviourKey(mk({ bucket: 'working' }, { prs: ['p#1'] })), 'working')
  assert.equal(behaviourKey(mk({ bucket: 'waiting' })), 'waiting')
  assert.equal(behaviourKey(mk({ bucket: 'stalled' })), 'stalled:attention')
  assert.equal(behaviourKey(mk({ bucket: 'stalled', prompt: true })), 'stalled:prompt')
  assert.equal(behaviourKey(mk({ bucket: 'error' })), 'stalled:error')
  assert.equal(behaviourKey(mk({ bucket: 'resting' })), 'resting')
  assert.equal(behaviourKey(mk({ bucket: 'resting', important: true })), 'resting:doorstep')
})

test('first appearance places the agent at its place without walking and claims a slot', () => {
  const h = harness('working', { prs: ['p#1'] })
  const a = h.a
  assert.ok(near(a, 16, 10), `at the PR site, got ${a.x},${a.y}`)
  assert.equal(a.state, 'hold'); assert.equal(a.anim, 'hammer'); assert.equal(a.alpha, 1)
  assert.equal(h.slots.heldBy('a1')?.kind, 'work')
  assert.equal(h.nav.calls.length, 0)
})

test('the behaviour never moves the actor itself: it requests a path and the sim walks it', () => {
  let updates = 0, requested = false
  const spy = { init: agent.init, replan: agent.replan, update(a, dt, ctx) {
    const x = a.x, y = a.y
    agent.update(a, dt, ctx); updates++
    if (a.path) requested = true
    assert.equal(a.x, x); assert.equal(a.y, y)
  } }
  const h = harness('stalled', {}, { deps: { agentBehaviour: spy } })
  const x0 = h.a.x
  h.set('working', { prs: ['p#1'] })
  h.run(1)
  assert.ok(updates > 0 && requested, 'a path was requested')
  assert.ok(h.a.x > x0, 'and the sim moved the actor along it')
})

test('D4: a short on-screen route is walked, then the new pose shows', () => {
  const h = harness('stalled')
  assert.ok(near(h.a, 10, 10))
  h.set('working', { prs: ['p#1'] })
  h.run(DT)
  assert.equal(h.a.state, 'go'); assert.equal(h.a.anim, 'walk'); assert.equal(h.a.alpha, 1)
  let mid = false
  h.run(4, (x) => { if (x.state === 'go' && x.x > 11.5 && x.x < 15.5) mid = true })
  assert.ok(mid, 'passes through intermediate tiles')
  assert.equal(h.a.state, 'hold'); assert.ok(near(h.a, 16, 10)); assert.equal(h.a.anim, 'hammer')
  assert.equal(h.a.face, 0, '+x walk faces SE')
  assert.equal(h.slots.heldBy('a1')?.id.startsWith('w'), true, 'released the forecourt and holds a work slot')
})

function assertFadeTeleport(h, tx, ty) {
  const x0 = h.a.x, y0 = h.a.y
  let sawPartial = false
  const positions = new Set()
  h.run(FADE_S + 0.21, (x) => { positions.add(`${x.x.toFixed(2)},${x.y.toFixed(2)}`); if (x.alpha > 0 && x.alpha < 1) sawPartial = true; assert.notEqual(x.anim, 'walk') })
  assert.ok(near(h.a, tx, ty), `at target ${tx},${ty}, got ${h.a.x},${h.a.y}`)
  assert.equal(h.a.alpha, 1); assert.equal(h.a.state, 'hold')
  assert.ok(sawPartial || positions.size <= 2, 'faded')
  for (const p of positions) { const [x, y] = p.split(',').map(Number); assert.ok((x === +x0.toFixed(2) && y === +y0.toFixed(2)) || near({ x, y }, tx, ty), `no in-between position ${p}`) }
}

test('D4: a route longer than 40 tiles fades (0.3 s) instead of walking', () => {
  const h = harness('stalled', {}, { places: { ...PLACES, 'pr.site': { tx: 80, ty: 10, slotKind: 'work' } } })
  h.set('working', { prs: ['p#1'] })
  assertFadeTeleport(h, 80, 10)
})

test('D4: an off-screen actor fades instead of walking', () => {
  const h = harness('stalled', {}, { onScreen: false })
  h.set('working', { prs: ['p#1'] })
  assertFadeTeleport(h, 16, 10)
})

test('D4: reduced motion snaps straight to the slot with no walk and no fade', () => {
  const h = harness('stalled', {}, { reduceMotion: true })
  h.set('working', { prs: ['p#1'] })
  h.run(DT)
  assert.ok(near(h.a, 16, 10)); assert.equal(h.a.alpha, 1); assert.equal(h.a.state, 'hold'); assert.equal(h.a.frame, 0)
})

test('D4: a walk longer than 6 s is cut short with a fade at the target', () => {
  const h = harness('stalled', {}, { places: { ...PLACES, 'pr.site': { tx: 40, ty: 10, slotKind: 'work' } } })
  h.set('working', { prs: ['p#1'] })
  let t = 0, walkT = 0
  do { h.run(DT); t += DT; if (h.a.anim === 'walk') walkT += DT } while (h.a.state !== 'hold' && t < 30)
  assert.ok(walkT > 0, 'it did start walking (30 tiles <= 40)')
  assert.ok(walkT <= WALK_MAX_S + DT + 1e-6, `walked ${walkT}s`)
  assert.ok(t <= WALK_MAX_S + FADE_S + 0.35, `arrived at ${t}s`)
  assert.ok(near(h.a, 40, 10)); assert.equal(h.a.alpha, 1)
})

test('stalled agents never move once settled, face the viewer and wave every 4 s', () => {
  const h = harness('stalled')
  const x = h.a.x, y = h.a.y; let waves = 0, prev = null
  h.run(60, (s) => {
    assert.equal(s.x, x); assert.equal(s.y, y); assert.equal(s.px, x); assert.equal(s.face, 0); assert.equal(s.state, 'hold')
    if (s.anim === 'wave' && prev !== 'wave') waves++
    prev = s.anim
  })
  assert.ok(waves >= 11 && waves <= 13, `about every 4 s (+1 s wave), got ${waves} in 60 s`)
  assert.equal(h.nav.calls.length, 0, 'never re-plans')
})

test('stalled flavour changes (attention -> prompt -> error) change the pose, never the place', () => {
  const h = harness('stalled')
  const x = h.a.x, y = h.a.y
  h.set('stalled', { needs: 'permission' }); h.run(1)
  assert.equal(h.a.anim, 'wave'); assert.equal(h.a.x, x); assert.equal(h.a.y, y)
  h.set('error'); h.run(10)
  assert.equal(h.a.x, x); assert.equal(h.a.y, y); assert.ok(h.a.fx?.includes('smoke')); assert.notEqual(h.a.anim, 'walk')
  assert.equal(h.nav.calls.length, 0)
})

test('going stalled from far away is readable (at forecourt, standing) within 2 s, by a fade, never a walk', () => {
  for (const [st, ex] of [['stalled', {}], ['stalled', { needs: 'question' }], ['error', {}]]) {
    const h = harness('working', { prs: ['p#1'] })
    h.set(st, ex)
    h.run(2, (s) => assert.notEqual(s.anim, 'walk'))
    assert.ok(near(h.a, 10, 10), `${st} at forecourt`)
    assert.equal(h.a.state, 'hold'); assert.equal(h.a.face, 0); assert.equal(h.a.alpha, 1)
  }
})

test('waiting: sits on a bench with a look-around every 6-10 s and never moves', () => {
  const h = harness('waiting')
  assert.equal(h.slots.heldBy('a1')?.kind, 'sit'); assert.equal(h.a.anim, 'sit')
  const x = h.a.x, y = h.a.y, starts = []; let prev = null
  h.run(80, (s, i) => {
    assert.equal(s.x, x); assert.equal(s.y, y); assert.equal(s.anim, 'sit')
    if (s.cue === 'look-around' && prev !== 'look-around') starts.push(i * DT)
    prev = s.cue
  })
  assert.ok(starts.length >= 6, `looked around ${starts.length} times`)
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1]
    assert.ok(gap >= 6 - 0.11 && gap <= 10 + 1.2 + 0.2, `gap ${gap}`)
  }
})

test('resting goes indoors and frees its slot; an important resting agent stays on the doorstep, faded', () => {
  const h = harness('working', { prs: ['p#1'] }, { more: [ag('b', 'resting', { important: true })] })
  h.set('resting'); h.run(2)
  assert.ok(h.a.flags & INDOORS); assert.equal(h.a.alpha, 0); assert.equal(h.slots.heldBy('a1'), null)
  const b = h.sim.actors.get('b')
  assert.equal(b.flags & INDOORS, 0); assert.ok(b.flags & GHOST); assert.ok(near(b, 10, 10))
  // coming back out: leaves by the door and is visible again
  h.set('stalled'); h.run(2)
  assert.equal(h.a.flags & INDOORS, 0); assert.equal(h.a.alpha, 1); assert.ok(near(h.a, 10, 10))
})

test('two agents never share a slot', () => {
  const h = harness('stalled', {}, { more: [ag('a2', 'stalled')] })
  const a = h.a, b = h.sim.actors.get('a2')
  assert.notEqual(h.slots.heldBy('a1').id, h.slots.heldBy('a2').id)
  assert.ok(a.x !== b.x || a.y !== b.y)
})

test('a mod behaviour table wins over the defaults (walk: false forces a fade even when short)', () => {
  const mod = { behaviour: { working: { place: 'pr.site', pose: 'hammer', idle: [], walk: false } } }
  const h = harness('stalled', {}, { mod })
  h.set('working', { prs: ['p#1'] })
  h.run(DT); assert.notEqual(h.a.anim, 'walk')
  h.run(FADE_S + 0.1, (s) => assert.notEqual(s.anim, 'walk'))
  assert.ok(near(h.a, 16, 10)); assert.equal(h.a.anim, 'hammer')
})

test('fantasy pose names reach the renderer only as §4.1 anim values', () => {
  const mod = { behaviour: { 'stalled:prompt': { place: 'home.forecourt', pose: 'wave-both', idle: [], walk: false },
    building: { place: 'anchor:work', pose: 'saw', idle: ['carry-crate'], idleEvery: [1, 1], walk: true } },
    represent: { poses: { 'wave-both': 'wave', saw: 'hammer', 'carry-crate': 'carry' } } } // pose names are mod vocabulary
  const h = harness('stalled', { needs: 'plan' }, { mod })
  h.run(DT); assert.equal(h.a.anim, 'wave'); assert.equal(h.a.pose, 'wave-both')
  h.set('working'); const seen = new Set()
  h.run(8, (s) => seen.add(s.anim))
  for (const v of seen) assert.ok(['walk', 'hammer', 'carry', 'idle'].includes(v), v)
  assert.ok(seen.has('hammer') && seen.has('carry'), [...seen].join())
})

test('no place for the bucket falls back to the home forecourt', () => {
  const h = harness('waiting', {}, { places: { 'home.forecourt': { tx: 10, ty: 10, slotKind: 'stand' } } })
  assert.ok(near(h.a, 10, 10)); assert.equal(h.a.anim, 'sit')
})

test('deterministic for the same inputs and dt sequence', () => {
  const trace = () => {
    const h = harness('waiting', {}, { seed: 3 }); const out = []
    for (const st of ['working', 'stalled', 'waiting', 'resting', 'error']) {
      h.set(st, st === 'working' ? { prs: ['p#1'] } : {})
      h.run(9, (x) => out.push(`${x.x.toFixed(3)},${x.y.toFixed(3)},${x.anim},${x.cue},${x.alpha},${x.face}`))
    }
    return out.join('|')
  }
  assert.equal(trace(), trace())
})
