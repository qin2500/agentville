/** v2 thin growth (M7, city-plan.js "LINK FORMAT"): a re-plan with `grow` nests the old plan in one corner of
 * the new plot and grows only away from it. Same nesting rule as v1 (decor never shrinks, every old item keeps its tile
 * relative to `nest`), plus: tagged links replay, old untagged links replay byte-identically, mixed chains replay, and the
 * growth is thin. Written from the rule, not the planner's internals. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { GROUND, WALKABLE, planSettlement, parseChain } from '../web/src/city-plan.js'

const SEEDS = [1, 2, 7, 12345, 'demo-app', 'busy', 'citydemo', 'x']
const PATHS = [
  [[0, 3], [1, 12], [2, 40], [3, 120]],
  [[0, 8], [0, 14], [1, 14], [1, 30], [2, 30], [3, 60]],
  [[1, 6], [2, 15], [2, 50], [3, 40]],
  [[0, 1], [2, 44], [3, 200]],
  [[1, 20], [1, 9], [3, 33]],
  [[2, 24], [3, 47], [3, 99]],
]
const CORNERS = ['se', 'sw', 'ne', 'nw']
const TAG = { se: 'a', sw: 'b', ne: 'c', nw: 'd' }
// room that fits only `corner` (every other corner has none)
const only = (corner) => ({ [corner]: Array(200).fill(500) })

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

test('thin growth nests in every corner along every path: each plan contains the one before, decor never shrinks', () => {
  for (const seed of SEEDS) for (const path of PATHS) for (const corner of CORNERS) {
    let prev = planSettlement({ tier: path[0][0], seed, lots: path[0][1] })
    for (const [tier, lots] of path.slice(1)) {
      const label = `seed ${seed} ${corner} ${prev.chain} -> tier ${tier} lots ${lots}`
      const next = planSettlement({ tier, seed, lots, from: prev.chain, grow: { room: only(corner) } })
      assert.equal(next.tier, tier, label)
      assertSound(next, lots, label)
      if (next.chain === prev.chain) { assert.deepEqual(next, prev, label); continue }
      assertNested(prev, next, label)
      assert.match(next.chain.split('>').pop(), new RegExp(`^${tier}\\.\\d+${TAG[corner]}$`), `${label}: the link names its corner`)
      // the old plan sits in the corner opposite the growth
      const { dx, dy } = next.nest
      assert.equal(dx, corner.endsWith('e') ? 0 : next.w - prev.w, `${label}: x corner`)
      assert.equal(dy, corner.startsWith('s') ? 0 : next.h - prev.h, `${label}: y corner`)
      if (tier > prev.tier) for (const re of LOOKS[tier]) assert.ok(next.civic.some((c) => re.test(c.look)), `${label}: a new tier brings its ${re}`)
      // the chain alone replays it (no room needed), and so does the grow call
      assert.deepEqual(planSettlement({ tier, seed, lots: 1, from: next.chain }), next, `${label}: replays from its chain`)
      assert.deepEqual(planSettlement({ tier, seed, lots, from: prev.chain, grow: { room: only(corner) } }), next, `${label}: deterministic`)
      prev = next
    }
  }
})

test('thin growth is thin: a cap step grows one side by one band, a tier-up adds the civic band and only the width it needs', () => {
  for (const seed of SEEDS) for (const t of [0, 1, 2, 3]) for (const lots of [1, 6, 20]) {
    const a = planSettlement({ tier: t, seed, lots })
    // cap step: one more lot than it has
    const b = planSettlement({ tier: t, seed, lots: a.lots.length + 1, from: a.chain, grow: {} })
    const sw = t >= 2 ? 2 : 1, HB = 6 + sw
    assert.equal(b.w, a.w, `${seed} t${t}: a cap step keeps the width`)
    assert.equal(b.h - a.h, sw + HB + 1, `${seed} t${t}: a cap step adds a street, one band and the edge`)
    if (t === 3) continue
    const c = planSettlement({ tier: t + 1, seed, lots, from: a.chain, grow: {} })
    const v1 = planSettlement({ tier: t + 1, seed, lots, from: a.chain })
    assert.ok(c.w * c.h < v1.w * v1.h, `${seed} t${t}->${t + 1}: thinner than the v1 ring (${c.w}x${c.h} vs ${v1.w}x${v1.h})`)
    assert.ok(c.h - a.h <= sw + 12 + 1, `${seed} t${t}->${t + 1}: one civic band deep (${a.h} -> ${c.h})`)
    assert.ok(c.w === a.w || c.w <= 56, `${seed} t${t}->${t + 1}: wider only to fit the civic band (${a.w} -> ${c.w})`)
  }
})

test('the corner with room wins; with room nowhere (or no room given) it is south-east', () => {
  const a = planSettlement({ tier: 1, seed: 3, lots: 8 })
  const pick = (room) => planSettlement({ tier: 2, seed: 3, lots: 8, from: a.chain, grow: { room } }).chain.slice(-1)
  assert.equal(pick(undefined), 'a')
  assert.equal(pick({}), 'a')
  assert.equal(pick({ se: [-1], sw: [], ne: [0], nw: [-1] }), 'a', 'nothing fits')
  for (const c of CORNERS) assert.equal(pick(only(c)), TAG[c], c)
  // the most vertical slack wins
  assert.equal(pick({ se: Array(100).fill(30), nw: Array(100).fill(60) }), 'd')
  assert.equal(pick({ sw: Array(100).fill(60), se: Array(100).fill(60) }), 'a', 'ties go a, b, c, d')
  assert.equal(pick({ nw: Array(100).fill(60), ne: Array(100).fill(60) }), 'c', 'ties go a, b, c, d')
})

test('parseChain reads tagged links; old links read as before; unknown or leading tags are unreadable', () => {
  assert.deepEqual(parseChain('0.2>1.0>2.13'), [[0, 2], [1, 0], [2, 13]])
  assert.deepEqual(parseChain('0.2>1.0a>2.13>3.0d'), [[0, 2], [1, 0, 'a'], [2, 13], [3, 0, 'd']])
  for (const bad of ['0.2a', '0.2>1.0z', '0.2>1.0A', '0.2>1.0abcd', '0.2>1.a', '1.0c>0.3']) assert.equal(parseChain(bad), null, bad)
})

// golden hashes for v2 chains (same serialisation as test/city-plan-golden.test.mjs). Updating one re-lays-out saved towns
// that grew under v2: only on purpose, with the maintainers' agreement.
const stable = v => Array.isArray(v) ? `[${v.map(stable)}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`)}}` : JSON.stringify(v)
const hash = p => createHash('sha256').update(stable(p)).digest('hex').slice(0, 16)
const GOLDEN = {
  '0.0>1.0a>2.0d>3.1b': 'c7d72cf9321498a2',
  '0.1>0.0c>1.0>2.0a>2.2>3.0b': '9b3e0c4bb7ddfef8',
  '2.0>2.0b>3.0c>3.1a': '5cba777ef1a821e5',
}
for (const [chain, want] of Object.entries(GOLDEN)) test(`golden v2 plan hash: ${chain}`, () => {
  const tier = Number(chain.split('>').pop()[0])
  const p = planSettlement({ tier, seed: 7, lots: 1, from: chain })
  assert.equal(p.chain, chain)
  assert.equal(hash(p), want, `${chain}: plan changed (towns grown under v2 would move)`)
})

test('a mixed v1/v2 chain replays identically, and its v1 prefix is byte-identical to the v1-only plan', () => {
  for (const seed of SEEDS) {
    const v1 = planSettlement({ tier: 2, seed, lots: 20, from: planSettlement({ tier: 1, seed, lots: 6, from: '0.0' }).chain })
    const mixed = planSettlement({ tier: 3, seed, lots: 30, from: v1.chain, grow: { room: only('nw') } })
    assert.deepEqual(mixed.nest.plan, v1, `${seed}: the v1 prefix is the v1 plan`)
    const again = planSettlement({ tier: 3, seed, lots: 1, from: mixed.chain })
    assert.deepEqual(again, mixed, `${seed}: replays`)
    const more = planSettlement({ tier: 3, seed, lots: mixed.lots.length + 1, from: mixed.chain })   // v1 again after v2
    assertNested(mixed, more, `${seed}: v1 after v2`)
    assert.deepEqual(planSettlement({ tier: 3, seed, lots: 1, from: more.chain }), more, `${seed}: v1-after-v2 replays`)
  }
})
