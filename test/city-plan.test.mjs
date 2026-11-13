/** Growing towns: the pure settlement planner (web/src/city-plan.js). Written from the spec. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TIERS, GROUND, WALKABLE, tierFor, capacityFor, planSettlement } from '../web/src/city-plan.js'

const TIER_LIST = [0, 1, 2, 3]
const LOTS = [0, 1, 4, 12, 40, 120]
const SEEDS = [1, 7, 12345]

const tileOf = (plan, x, y) => plan.ground[y * plan.w + x]
const inPlot = (plan, x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < plan.w && y < plan.h
const footprints = (plan) => [...plan.lots, ...plan.civic]
const doorTile = (it) => [it.x + Math.floor(it.doorX / 16), it.y + it.h]
const civicHas = (plan, re) => plan.civic.some((c) => re.test(c.id) || re.test(c.look || ''))
const propKinds = (plan) => new Set(plan.props.map((p) => p.kind))
const groundSet = (plan) => new Set(plan.ground)
const area = (plan) => plan.w * plan.h
const key = (x, y) => x + ',' + y

test('tierFor thresholds and monotonicity', () => {
  assert.equal(tierFor(0), 0)
  assert.equal(tierFor(1), 0)
  assert.equal(tierFor(11), 0)
  assert.equal(tierFor(12), 1)
  assert.equal(tierFor(39), 1)
  assert.equal(tierFor(40), 2)
  assert.equal(tierFor(199), 2)
  assert.equal(tierFor(200), 3)
  assert.equal(tierFor(7000), 3)
  let prev = 0
  for (let g = 0; g <= 8000; g++) {
    const t = tierFor(g)
    assert.ok(t >= prev, `tierFor must not decrease at ${g}`)
    assert.ok(t >= 0 && t <= 3)
    prev = t
  }
  assert.equal(TIERS.length, 4)
  assert.deepEqual(TIERS.slice(), ['hamlet', 'village', 'town', 'city'])
})

test('capacityFor covers the need and is bucketed', () => {
  for (const t of TIER_LIST) {
    let same = 0
    let total = 0
    for (let n = 0; n <= 300; n++) {
      const c = capacityFor(t, n)
      assert.ok(c >= n, `capacityFor(${t}, ${n}) = ${c} must be >= ${n}`)
      assert.ok(capacityFor(t, n + 1) >= c, 'capacity must not shrink as need grows')
      total++
      if (capacityFor(t, n + 1) === c) same++
    }
    assert.ok(same / total > 0.6, `tier ${t}: capacity should be bucketed (${same}/${total} steps equal)`)
  }
})

test('GROUND and WALKABLE constants match the spec', () => {
  assert.equal(GROUND.NONE, 0)
  assert.equal(GROUND.GRASS, 1)
  assert.equal(GROUND.STREET, 2)
  assert.equal(GROUND.FLOWERS, 15)
  for (const c of [GROUND.STREET, GROUND.LANE, GROUND.PLAZA, GROUND.MARKET, GROUND.YARD, GROUND.BRIDGE]) assert.ok(WALKABLE.has(c))
  for (const c of [GROUND.GRASS, GROUND.FIELD, GROUND.WATER, GROUND.WALL, GROUND.NONE]) assert.ok(!WALKABLE.has(c))
})

for (const tier of TIER_LIST) {
  for (const lots of LOTS) {
    for (const seed of SEEDS) {
      test(`planSettlement invariants: tier ${tier}, ${lots} lots, seed ${seed}`, () => {
        const plan = planSettlement({ tier, seed, lots })
        const again = planSettlement({ tier, seed, lots })

        // deterministic
        assert.deepEqual({ ...plan, ground: Array.from(plan.ground) }, { ...again, ground: Array.from(again.ground) })

        assert.equal(plan.tier, tier)
        assert.ok(plan.lots.length >= lots, 'enough lots')
        assert.ok(plan.cap >= lots)
        assert.equal(plan.ground.length, plan.w * plan.h)
        for (let i = 0; i < plan.ground.length; i++) assert.notEqual(plan.ground[i], GROUND.NONE, `NONE tile at index ${i}`)

        // footprints in bounds, no overlap
        const owner = new Map()
        for (const it of footprints(plan)) {
          assert.ok(it.w > 0 && it.h > 0)
          assert.ok(inPlot(plan, it.x, it.y) && inPlot(plan, it.x + it.w - 1, it.y + it.h - 1), `${it.id} out of bounds`)
          for (let y = it.y; y < it.y + it.h; y++) {
            for (let x = it.x; x < it.x + it.w; x++) {
              assert.ok(!owner.has(key(x, y)), `${it.id} overlaps ${owner.get(key(x, y))}`)
              owner.set(key(x, y), it.id)
            }
          }
        }
        const ids = footprints(plan).map((i) => i.id)
        assert.equal(new Set(ids).size, ids.length, 'ids unique')

        // doors
        const doors = new Set()
        for (const it of footprints(plan)) {
          if (it.doorX === undefined && plan.civic.includes(it)) continue
          const [dx, dy] = doorTile(it)
          assert.ok(inPlot(plan, dx, dy), `${it.id} door tile outside plot`)
          assert.ok(WALKABLE.has(tileOf(plan, dx, dy)), `${it.id} door tile not walkable`)
          doors.add(key(dx, dy))
        }

        // gates
        assert.ok(plan.gates.length >= 1, 'at least one gate')
        for (const [gx, gy] of plan.gates) {
          assert.ok(inPlot(plan, gx, gy))
          assert.ok(gx === 0 || gy === 0 || gx === plan.w - 1 || gy === plan.h - 1, 'gate on the plot edge')
          assert.ok(WALKABLE.has(tileOf(plan, gx, gy)), 'gate walkable')
        }

        // connectivity: every walkable tile reaches a gate
        const seen = new Set()
        const queue = []
        for (const [gx, gy] of plan.gates) { seen.add(key(gx, gy)); queue.push([gx, gy]) }
        while (queue.length) {
          const [x, y] = queue.pop()
          for (const [ax, ay] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
            if (!inPlot(plan, ax, ay) || seen.has(key(ax, ay)) || !WALKABLE.has(tileOf(plan, ax, ay))) continue
            seen.add(key(ax, ay))
            queue.push([ax, ay])
          }
        }
        for (let y = 0; y < plan.h; y++) {
          for (let x = 0; x < plan.w; x++) {
            if (WALKABLE.has(tileOf(plan, x, y))) assert.ok(seen.has(key(x, y)), `walkable tile ${x},${y} not connected to a gate`)
          }
        }

        // props
        for (const p of plan.props) {
          assert.ok(p.x >= 0 && p.y >= 0 && p.x <= plan.w && p.y <= plan.h, `prop ${p.kind} out of bounds`)
          const tx = Math.floor(p.x)
          const ty = Math.floor(p.y)
          if (inPlot(plan, tx, ty)) {
            assert.ok(!owner.has(key(tx, ty)), `prop ${p.kind} on footprint ${owner.get(key(tx, ty))}`)
            assert.ok(!doors.has(key(tx, ty)), `prop ${p.kind} on a door tile`)
          }
        }

        // plaza
        assert.ok(plan.plaza.w > 0 && plan.plaza.h > 0)
        assert.ok(plan.plaza.x >= 0 && plan.plaza.y >= 0 && plan.plaza.x + plan.plaza.w <= plan.w && plan.plaza.y + plan.plaza.h <= plan.h, 'plaza inside plot')

        // lot order: rank L first
        if (plan.lots.length) assert.equal(plan.lots[0].rank, 'L')
      })
    }
  }
}

test('hamlet character: windmill or barn, field ground', () => {
  for (const seed of SEEDS) {
    const plan = planSettlement({ tier: 0, seed, lots: 4 })
    assert.ok(civicHas(plan, /windmill|barn/), 'windmill or barn')
    assert.ok(groundSet(plan).has(GROUND.FIELD), 'FIELD ground')
  }
})

test('village character: chapel', () => {
  for (const seed of SEEDS) assert.ok(civicHas(planSettlement({ tier: 1, seed, lots: 12 }), /chapel/))
})

test('town character: fountain and a paved square or market', () => {
  for (const seed of SEEDS) {
    const plan = planSettlement({ tier: 2, seed, lots: 40 })
    assert.ok(propKinds(plan).has('fountain'), 'fountain prop')
    const g = groundSet(plan)
    assert.ok(g.has(GROUND.PLAZA) || g.has(GROUND.MARKET), 'PLAZA or MARKET ground')
  }
})

test('city character: wall civic items and a cathedral', () => {
  for (const seed of SEEDS) {
    const plan = planSettlement({ tier: 3, seed, lots: 120 })
    assert.ok(civicHas(plan, /^wall|wall$|walltower|wall/), 'wall civic items')
    assert.ok(plan.civic.some((c) => /wall/.test(c.id) || /wall/.test(c.look || '')))
    assert.ok(civicHas(plan, /cathedral/), 'cathedral')
  }
})

test('plots grow with capacity', () => {
  for (const tier of TIER_LIST) {
    const small = planSettlement({ tier, seed: 3, lots: 1 })
    const big = planSettlement({ tier, seed: 3, lots: 120 })
    assert.ok(area(big) > area(small), `tier ${tier}: 120 lots should have a bigger plot than 1`)
    assert.ok(big.lots.length > small.lots.length)
  }
  const c12 = planSettlement({ tier: 3, seed: 5, lots: 12 })
  const c120 = planSettlement({ tier: 3, seed: 5, lots: 120 })
  assert.ok(area(c120) > area(c12), 'city with 120 lots bigger than with 12')
})

test('same capacity bucket gives the same plan', () => {
  for (const tier of TIER_LIST) {
    for (let n = 1; n < 60; n++) {
      if (capacityFor(tier, n) !== capacityFor(tier, n + 1)) continue
      const a = planSettlement({ tier, seed: 9, lots: n })
      const b = planSettlement({ tier, seed: 9, lots: n + 1 })
      assert.deepEqual(Array.from(a.ground), Array.from(b.ground))
      assert.equal(a.lots.length, b.lots.length)
      assert.equal(a.w, b.w)
      assert.equal(a.h, b.h)
    }
  }
})

test('perf: city with 250 lots plans in under 30 ms', () => {
  planSettlement({ tier: 3, seed: 1, lots: 250 })
  const runs = 5
  const t0 = performance.now()
  for (let i = 0; i < runs; i++) planSettlement({ tier: 3, seed: 1, lots: 250 })
  const avg = (performance.now() - t0) / runs
  assert.ok(avg < 30, `average ${avg.toFixed(1)} ms`)
})
