/** City v5: no identical neighbours (web/src/variety.js). Written from the spec. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickVariants } from '../web/src/variety.js'
import { planSettlement } from '../web/src/city-plan.js'

const hGap = (a, b) => Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w)
const vGap = (a, b) => Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h)
const areNeighbours = (a, b) =>
  (a.y === b.y && hGap(a, b) <= 3) || (a.x === b.x && vGap(a, b) <= 4)

function checkNeighbours(lots, map, label) {
  for (let i = 0; i < lots.length; i++) {
    for (let j = i + 1; j < lots.length; j++) {
      const a = lots[i]
      const b = lots[j]
      if (!areNeighbours(a, b)) continue
      const va = map.get(a.id)
      const vb = map.get(b.id)
      assert.notEqual(va % 4, vb % 4, `${label}: ${a.id} and ${b.id} share massing ${va % 4}`)
      assert.notEqual(va, vb, `${label}: ${a.id} and ${b.id} share variant ${va}`)
    }
  }
}

// A dense grid with lots of row and column neighbours.
function gridLots(cols, rows, w = 3, h = 3, gapX = 1, gapY = 2) {
  const lots = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      lots.push({ id: `L${r}_${c}`, x: c * (w + gapX), y: r * (h + gapY), w, h })
    }
  }
  return lots
}

test('empty lots give an empty Map', () => {
  const m = pickVariants([], 'proj')
  assert.ok(m instanceof Map)
  assert.equal(m.size, 0)
})

test('deterministic for the same lots and key', () => {
  const lots = gridLots(10, 6)
  const a = pickVariants(lots, 'alpha')
  const b = pickVariants(lots.map((l) => ({ ...l })), 'alpha')
  assert.deepEqual([...a.entries()], [...b.entries()])
})

test('one integer 0..15 entry per lot', () => {
  const lots = gridLots(12, 10)
  const m = pickVariants(lots, 'alpha')
  assert.equal(m.size, lots.length)
  for (const l of lots) {
    assert.ok(m.has(l.id), `missing ${l.id}`)
    const v = m.get(l.id)
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 15, `bad variant ${v} for ${l.id}`)
  }
})

test('row neighbours differ in variant and variant % 4', () => {
  const lots = []
  for (let i = 0; i < 40; i++) lots.push({ id: 'r' + i, x: i * 4, y: 5, w: 3, h: 3 }) // gap 1
  for (let i = 0; i < 20; i++) lots.push({ id: 's' + i, x: i * 6, y: 20, w: 3, h: 3 }) // gap 3
  const m = pickVariants(lots, 'rows')
  checkNeighbours(lots, m, 'rows')
})

test('column neighbours differ in variant and variant % 4', () => {
  const lots = []
  for (let i = 0; i < 40; i++) lots.push({ id: 'c' + i, x: 7, y: i * 5, w: 3, h: 3 }) // gap 2
  for (let i = 0; i < 20; i++) lots.push({ id: 'd' + i, x: 30, y: i * 7, w: 3, h: 3 }) // gap 4
  const m = pickVariants(lots, 'cols')
  checkNeighbours(lots, m, 'cols')
})

test('dense grid satisfies the neighbour rule for several keys', () => {
  const lots = gridLots(15, 10)
  for (const key of ['a', 'b', 'project-x', '', 'ünï']) {
    checkNeighbours(lots, pickVariants(lots, key), `grid/${key}`)
  }
})

test('far-apart lots are unconstrained (still valid values)', () => {
  const lots = [
    { id: 'a', x: 0, y: 0, w: 3, h: 3 },
    { id: 'b', x: 100, y: 50, w: 3, h: 3 },
  ]
  const m = pickVariants(lots, 'far')
  assert.equal(m.size, 2)
  for (const v of m.values()) assert.ok(Number.isInteger(v) && v >= 0 && v <= 15)
})

test('a different key gives a different assignment for some lots', () => {
  const lots = gridLots(10, 6)
  const a = pickVariants(lots, 'key-one')
  const b = pickVariants(lots, 'key-two')
  const diff = lots.filter((l) => a.get(l.id) !== b.get(l.id)).length
  assert.ok(diff > 0, 'keys produced identical assignments')
})

test('300 lots resolve quickly (loose bound)', () => {
  const lots = gridLots(20, 15)
  assert.equal(lots.length, 300)
  pickVariants(lots, 'warm')
  const t0 = performance.now()
  const m = pickVariants(lots, 'timing')
  const ms = performance.now() - t0
  assert.equal(m.size, 300)
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`)
})

for (const [tier, name] of [[2, 'town'], [3, 'city']]) {
  test(`real ${name} plans satisfy the neighbour rule`, () => {
    for (const seed of [1, 7, 12345]) {
      const plan = planSettlement({ tier, seed, lots: tier === 2 ? 60 : 250 })
      assert.ok(plan.lots.length > 0, 'plan has lots')
      const m = pickVariants(plan.lots, `proj-${seed}`)
      assert.equal(m.size, plan.lots.length)
      for (const l of plan.lots) {
        const v = m.get(l.id)
        assert.ok(Number.isInteger(v) && v >= 0 && v <= 15)
      }
      checkNeighbours(plan.lots, m, `${name}/${seed}`)
      assert.deepEqual(
        [...pickVariants(plan.lots, `proj-${seed}`).entries()],
        [...m.entries()],
      )
    }
  })
}
