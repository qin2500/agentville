/** Nested growth (design decision): a plan re-planned `from` the plan a project had keeps that whole plan
 * (every lot, civic building and prop, same ids, tiles relative to `nest`, model and variant) and only adds. Written
 * from the rule, not from the planner's internals: decor never shrinks on tier-up. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { GROUND, WALKABLE, planSettlement, parseChain } from '../web/src/city-plan.js'

const SEEDS = [1, 2, 7, 12345, 'demo-app', 'busy', 'citydemo', 'x']
// growth paths: [tier, lots] steps a project could take (tiers only rise here; lots rise and fall)
const PATHS = [
  [[0, 3], [1, 12], [2, 40], [3, 120]],
  [[0, 8], [0, 14], [1, 14], [1, 30], [2, 30], [3, 60]],
  [[1, 6], [2, 15], [2, 50], [3, 40]],
  [[0, 1], [2, 44], [3, 200]],
  [[1, 20], [1, 9], [3, 33]],
  [[2, 24], [3, 47], [3, 99]],
]

const key = (x, y) => `${x},${y}`
const propSig = (p, dx = 0, dy = 0) => JSON.stringify({ ...p, x: p.x + dx, y: p.y + dy })
const bag = (arr) => { const m = new Map(); for (const s of arr) m.set(s, (m.get(s) || 0) + 1); return m }

function assertNested(prev, next, label) {
  assert.ok(next.nest && typeof next.nest === 'object', `${label}: a grown plan says where the old one sits`)
  assert.equal(next.nest.from, prev.chain, `${label}: nest.from names the old plan`)
  const { dx, dy } = next.nest
  assert.ok(Number.isInteger(dx) && Number.isInteger(dy) && dx >= 0 && dy >= 0, `${label}: integer offset`)
  assert.ok(dx + prev.w <= next.w && dy + prev.h <= next.h, `${label}: the old plot fits inside the new one`)
  for (const kind of ['lots', 'civic']) {
    const now = new Map(next[kind].map((it) => [it.id, it]))
    for (const it of prev[kind]) {
      assert.deepEqual(now.get(it.id), { ...it, x: it.x + dx, y: it.y + dy }, `${label}: ${kind} ${it.id} kept its tile, look and rank`)
    }
  }
  const have = bag(next.props.map((p) => propSig(p)))
  for (const [s, n] of bag(prev.props.map((p) => propSig(p, dx, dy)))) assert.ok((have.get(s) || 0) >= n, `${label}: decor ${s} kept`)
  for (let y = 0; y < prev.h; y++) for (let x = 0; x < prev.w; x++) {
    assert.equal(next.ground[(y + dy) * next.w + x + dx], prev.ground[y * prev.w + x], `${label}: ground ${key(x, y)} kept`)
  }
  for (const q of prev.squares) assert.ok(next.squares.some((r) => r.kind === q.kind && r.x === q.x + dx && r.y === q.y + dy && r.w === q.w && r.h === q.h), `${label}: ${q.kind} kept`)
  assert.ok(next.props.length >= prev.props.length, `${label}: decor count never shrinks (${prev.props.length} -> ${next.props.length})`)
  assert.ok(next.lots.length >= prev.lots.length && next.civic.length >= prev.civic.length, `${label}: buildings never shrink`)
}

function assertSound(plan, lots, label) {
  assert.ok(plan.lots.length >= lots, `${label}: enough lots (${plan.lots.length} < ${lots})`)
  assert.equal(plan.cap, plan.lots.length)
  assert.equal(plan.ground.length, plan.w * plan.h)
  for (let i = 0; i < plan.ground.length; i++) assert.notEqual(plan.ground[i], GROUND.NONE, `${label}: NONE tile`)
  const owner = new Map()
  for (const it of [...plan.lots, ...plan.civic]) {
    assert.ok(it.x >= 0 && it.y >= 0 && it.x + it.w <= plan.w && it.y + it.h <= plan.h, `${label}: ${it.id} out of bounds`)
    for (let y = it.y; y < it.y + it.h; y++) for (let x = it.x; x < it.x + it.w; x++) {
      assert.ok(!owner.has(key(x, y)), `${label}: ${it.id} overlaps ${owner.get(key(x, y))}`)
      owner.set(key(x, y), it.id)
    }
  }
  for (const kind of ['lots', 'civic']) assert.equal(new Set(plan[kind].map((i) => i.id)).size, plan[kind].length, `${label}: ${kind} ids unique`)
  const lotIds = plan.lots.map((l) => l.id).sort((a, b) => a.slice(1) - b.slice(1))
  lotIds.forEach((id, i) => assert.equal(id, `L${i}`, `${label}: lot ids are L0..L${plan.lots.length - 1}`))
  // every door opens on walkable ground that reaches a gate
  const W = (x, y) => x >= 0 && y >= 0 && x < plan.w && y < plan.h && WALKABLE.has(plan.ground[y * plan.w + x])
  assert.ok(plan.gates.length >= 1, `${label}: a gate`)
  const seen = new Set(plan.gates.map(([x, y]) => key(x, y))), q = [...plan.gates]
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i]
    for (const [a, b] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (W(a, b) && !seen.has(key(a, b))) { seen.add(key(a, b)); q.push([a, b]) }
  }
  for (const it of [...plan.lots, ...plan.civic]) {
    if (it.doorX === undefined) continue
    const dx = it.x + Math.floor(it.doorX / 16), dy = it.y + it.h
    assert.ok(W(dx, dy), `${label}: ${it.id} door tile not walkable`)
    assert.ok(seen.has(key(dx, dy)), `${label}: ${it.id} door cannot reach a gate`)
  }
  for (const p of plan.props) assert.ok(p.x >= 0 && p.y >= 0 && p.x <= plan.w && p.y <= plan.h, `${label}: prop ${p.kind} outside the plot`)
  const pl = plan.plaza
  assert.ok(pl.x >= 0 && pl.y >= 0 && pl.x + pl.w <= plan.w && pl.y + pl.h <= plan.h, `${label}: plaza inside`)
}

const LOOKS = { 1: [/chapel/, /inn/, /smithy/], 2: [/guildhall/, /clocktower/, /markethall/], 3: [/cathedral/, /guildhall/, /markethall/] }

test('without `from` a plan is the fresh plan (classic callers unchanged) and names its chain', () => {
  for (const seed of SEEDS) for (const tier of [0, 1, 2, 3]) for (const lots of [1, 12, 60]) {
    const p = planSettlement({ tier, seed, lots })
    assert.equal(p.nest, null)
    assert.match(p.chain, /^[0-3]\.\d+$/)
    assert.deepEqual(planSettlement({ tier, seed, lots, from: null }), p)
    assert.deepEqual(planSettlement({ tier, seed, lots, from: 'garbage' }), p, 'an unreadable chain plans fresh')
  }
})

test('every growth path nests: each plan contains the one before it, decor never shrinks', () => {
  for (const seed of SEEDS) for (const path of PATHS) {
    let prev = planSettlement({ tier: path[0][0], seed, lots: path[0][1] })
    assertSound(prev, path[0][1], `${seed} start`)
    for (const [tier, lots] of path.slice(1)) {
      const label = `seed ${seed} ${prev.chain} -> tier ${tier} lots ${lots}`
      const next = planSettlement({ tier, seed, lots, from: prev.chain })
      assert.equal(next.tier, tier, label)
      assertSound(next, lots, label)
      if (next === prev || next.chain === prev.chain) {
        assert.equal(tier, prev.tier, `${label}: only an unchanged tier keeps the old plan as it is`)
        assert.deepEqual(next, prev)
      } else assertNested(prev, next, label)
      if (tier > prev.tier) for (const re of LOOKS[tier]) assert.ok(next.civic.some((c) => re.test(c.look)), `${label}: a new tier brings its ${re}`)
      assert.deepEqual(planSettlement({ tier, seed, lots, from: prev.chain }), next, `${label}: deterministic`)
      prev = next
    }
  }
})

test('tier N+1 is a superset of tier N for every tier transition and many seeds/projects', () => {
  for (let i = 0; i < 40; i++) {
    const seed = `project-${i}`
    for (const t of [0, 1, 2]) for (const lots of [1, 5, 12, 25]) {
      const a = planSettlement({ tier: t, seed, lots })
      const b = planSettlement({ tier: t + 1, seed, lots, from: a.chain })
      assertNested(a, b, `${seed} tier ${t}->${t + 1} lots ${lots}`)
      assertSound(b, lots, `${seed} tier ${t + 1}`)
      // and it keeps nesting on the next tier-up
      if (t < 2) assertNested(b, planSettlement({ tier: t + 2, seed, lots, from: b.chain }), `${seed} tier ${t + 1}->${t + 2}`)
    }
  }
})

test('a plan that still has room is kept as it is; a tier drop plans fresh', () => {
  const a = planSettlement({ tier: 1, seed: 9, lots: 10 })
  const b = planSettlement({ tier: 2, seed: 9, lots: 20, from: a.chain })
  assert.deepEqual(planSettlement({ tier: 2, seed: 9, lots: 3, from: b.chain }), b, 'fewer lots: same plan')
  assert.deepEqual(planSettlement({ tier: 2, seed: 9, lots: b.lots.length, from: b.chain }), b, 'exactly full: same plan')
  const c = planSettlement({ tier: 2, seed: 9, lots: b.lots.length + 1, from: b.chain })
  assertNested(b, c, 'more lots in the same tier grows a ring too')
  assert.deepEqual(planSettlement({ tier: 1, seed: 9, lots: 10, from: b.chain }), planSettlement({ tier: 1, seed: 9, lots: 10 }), 'tier drop: fresh')
})

test('parseChain reads only well-formed, non-decreasing chains', () => {
  assert.deepEqual(parseChain('0.2>1.0>2.13'), [[0, 2], [1, 0], [2, 13]])
  for (const bad of ['', '4.0', '1.0>0.3', '1', '1.0>>2.0', 7, null, undefined, Array(200).fill('1.0').join('>')]) assert.equal(parseChain(bad), null, String(bad))
})
