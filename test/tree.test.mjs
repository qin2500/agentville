/** The Tree view's model and layout (web/src/tree-model.js). Pure: no DOM, no server. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTree, layout, outline, family, groupKey, SOLO_KEY, DIM } from '../web/src/tree-model.js'

const ag = (id, o = {}) => ({ id, name: o.name || id, role: 'solo', bucket: 'building', project: 'alpha', parentId: null, live: true, ...o })
const ids = (nodes) => nodes.map((n) => n.id)
/**
 * Connector ends that lead nowhere: an end of a segment that neither touches another segment nor
 * sits on the edge of a laid-out card. Every connector must end on a card that is drawn.
 */
function looseEnds(L) {
  const segs = (L.path.match(/M[^M]+/g) || []).map((s) => s.match(/-?[\d.]+/g).map(Number))
  const cards = [...L.items.values()].filter((it) => it.kind === 'node')
  const on = (x, y, [x1, y1, x2, y2]) => Math.abs((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) < 0.5 &&
    x >= Math.min(x1, x2) - 0.5 && x <= Math.max(x1, x2) + 0.5 && y >= Math.min(y1, y2) - 0.5 && y <= Math.max(y1, y2) + 0.5
  const onCard = (x, y) => cards.some((c) => x >= c.x - 0.5 && x <= c.x + c.w + 0.5 && y >= c.y - 0.5 && y <= c.y + c.h + 0.5 &&
    (Math.abs(x - c.x) < 0.5 || Math.abs(x - c.x - c.w) < 0.5 || Math.abs(y - c.y) < 0.5 || Math.abs(y - c.y - c.h) < 0.5))
  const bad = []
  segs.forEach((g, i) => {
    for (const [x, y] of [[g[0], g[1]], [g[2], g[3]]]) {
      if (onCard(x, y)) continue
      if (segs.some((h, j) => j !== i && on(x, y, h))) continue
      bad.push(`${x},${y}`)
    }
  })
  return bad
}

test('parents become trees; roots are grouped by project; reports nest under their parent', () => {
  const m = buildTree([
    ag('boss', { role: 'boss' }), ag('lead', { role: 'lead', parentId: 'boss' }), ag('w1', { role: 'sub', parentId: 'lead' }),
    ag('w2', { role: 'sub', parentId: 'lead' }), ag('other', { role: 'lead', project: 'beta' }), ag('o1', { role: 'sub', parentId: 'other', project: 'beta' }),
  ])
  assert.deepEqual(m.groups.map((g) => g.key), [groupKey('alpha'), groupKey('beta')])
  const [alpha] = m.groups
  assert.deepEqual(ids(alpha.roots), ['boss'])
  assert.deepEqual(ids(alpha.roots[0].kids), ['lead'])
  assert.deepEqual(ids(alpha.roots[0].kids[0].kids), ['w1', 'w2'])
  assert.equal(m.nodes.get('w1').depth, 3)
  assert.equal(m.nodes.get('boss').total, 3)
})

test('crowned teams come first: groups with a boss lead, bosses lead within a project', () => {
  const m = buildTree([
    ag('lead', { role: 'lead', project: 'beta' }), ag('k', { role: 'sub', parentId: 'lead', project: 'beta' }),
    ag('l2', { role: 'lead' }), ag('k2', { role: 'sub', parentId: 'l2' }),
    ag('boss', { role: 'boss' }), ag('k3', { role: 'lead', parentId: 'boss' }),
  ])
  assert.deepEqual(m.groups.map((g) => g.project), ['alpha', 'beta'])
  assert.deepEqual(ids(m.groups[0].roots), ['boss', 'l2'])
})

test('orphans whose parent is missing or hidden are roots; a parent loop is broken, never lost', () => {
  const m = buildTree([
    ag('orphan', { parentId: 'gone' }),            // parent not in the list (hidden, or never seen)
    ag('kid', { parentId: 'orphan' }),
    ag('self', { parentId: 'self' }),              // points at itself
    ag('x', { parentId: 'y' }), ag('y', { parentId: 'x' }), // a loop (two overrides)
  ])
  assert.ok(m.nodes.has('orphan') && m.nodes.has('kid') && m.nodes.has('self') && m.nodes.has('x') && m.nodes.has('y'))
  const alpha = m.groups.find((g) => g.kind === 'project')
  assert.deepEqual(ids(alpha.roots).sort(), ['orphan', 'x'])
  assert.deepEqual(ids(m.nodes.get('x').kids), ['y'])
  assert.deepEqual(ids(m.groups.find((g) => g.kind === 'solo').roots), ['self'])
})

test('solo agents with no reports go to one Solo group at the end; resting solos fold into a pill', () => {
  const m = buildTree([
    ag('s1'), ag('lead', { role: 'lead', project: 'beta' }), ag('k', { role: 'sub', parentId: 'lead', project: 'beta' }),
    ag('s2', { project: 'gamma', bucket: 'waiting' }), ag('s3', { bucket: 'resting', live: false }), ag('s4', { bucket: 'resting', live: false }),
  ])
  const last = m.groups[m.groups.length - 1]
  assert.equal(last.key, SOLO_KEY)
  assert.equal(m.groups.filter((g) => g.kind === 'project').length, 1) // solos never make a project band
  assert.deepEqual(ids(last.roots), ['s1', 's2'])
  assert.deepEqual(last.pill, { n: 2, teams: 2, open: false })
  const open = buildTree([ag('s1'), ag('s3', { bucket: 'resting' })], { open: new Set([SOLO_KEY]) })
  assert.deepEqual(ids(open.groups[0].roots), ['s1', 's3'])
})

test('resting subtrees collapse into "+N resting" on their parent, counting every descendant; a pill opens', () => {
  const agents = [
    ag('boss', { role: 'boss' }),
    ag('live', { role: 'lead', parentId: 'boss' }),
    ag('r1', { role: 'lead', parentId: 'boss', bucket: 'resting' }), ag('r1a', { role: 'sub', parentId: 'r1', bucket: 'resting' }), ag('r1b', { role: 'sub', parentId: 'r1', bucket: 'resting' }),
    ag('r2', { role: 'lead', parentId: 'boss', bucket: 'resting' }),
    // a resting lead with someone awake under it stays visible: the chain of command is kept
    ag('rl', { role: 'lead', parentId: 'boss', bucket: 'resting' }), ag('rlk', { role: 'sub', parentId: 'rl', bucket: 'building' }),
  ]
  const m = buildTree(agents)
  const boss = m.nodes.get('boss')
  assert.deepEqual(ids(boss.kids), ['live', 'rl'])
  assert.deepEqual(boss.pill, { n: 4, teams: 2, open: false })
  assert.ok(!m.nodes.has('r1a'))
  const o = buildTree(agents, { open: new Set(['boss']) })
  assert.deepEqual(ids(o.nodes.get('boss').kids), ['live', 'r1', 'r2', 'rl'])
  assert.deepEqual(o.nodes.get('r1').pill, { n: 2, teams: 2, open: false }) // nested pills stay folded
  const all = buildTree(agents, { allOpen: true })
  assert.ok(all.nodes.has('r1a') && all.nodes.has('r1b'))
  assert.deepEqual(new Set(all.pills), new Set(['boss', 'r1']))
})

test('a fully resting root team folds into its project heading; collapsing a node hides its reports', () => {
  const agents = [
    ag('lead', { role: 'lead' }), ag('k', { role: 'sub', parentId: 'lead' }), ag('k2', { role: 'sub', parentId: 'k' }),
    ag('old', { role: 'lead', bucket: 'resting' }), ag('oldk', { role: 'sub', parentId: 'old', bucket: 'resting' }),
  ]
  const m = buildTree(agents)
  const g = m.groups[0]
  assert.deepEqual(ids(g.roots), ['lead'])
  assert.deepEqual(g.pill, { n: 2, teams: 1, open: false })
  const c = buildTree(agents, { collapsed: new Set(['lead']) })
  const lead = c.nodes.get('lead')
  assert.equal(lead.collapsed, true)
  assert.equal(lead.hidden, 2)
  assert.deepEqual(lead.kids, [])
  assert.ok(!c.nodes.has('k'))
  const o = buildTree(agents, { open: new Set([groupKey('alpha')]) })
  assert.deepEqual(ids(o.groups[0].roots), ['lead', 'old'])
})

test('filters keep the chain of command: ancestors of matches stay, marked ctx; no pills while filtering', () => {
  const agents = [
    ag('boss', { role: 'boss', name: 'Boss' }), ag('lead', { role: 'lead', parentId: 'boss', name: 'Lead' }),
    ag('hit', { role: 'sub', parentId: 'lead', name: 'needle', bucket: 'resting' }), ag('miss', { role: 'sub', parentId: 'lead', name: 'other' }),
    ag('solo', { name: 'needle too' }), ag('nobody', { name: 'zzz' }),
  ]
  const m = buildTree(agents, { matches: (a) => a.name.includes('needle') })
  assert.ok(m.filtering)
  assert.deepEqual([...m.nodes.keys()].sort(), ['boss', 'hit', 'lead', 'solo'])
  assert.equal(m.nodes.get('boss').ctx, true)
  assert.equal(m.nodes.get('lead').ctx, true)
  assert.equal(m.nodes.get('hit').ctx, false) // a resting match shows; it is not folded into a pill
  assert.equal(m.nodes.get('lead').pill, null)
  assert.deepEqual(ids(m.groups[m.groups.length - 1].roots), ['solo'])
})

test('rank orders siblings stably, whatever order the payload has', () => {
  const r = { a: 2, b: 0, c: 1 }
  const m = buildTree([ag('p', { role: 'lead' }), ag('a', { parentId: 'p' }), ag('b', { parentId: 'p' }), ag('c', { parentId: 'p' })], { rank: (x) => r[x.id] ?? -1 })
  assert.deepEqual(ids(m.nodes.get('p').kids), ['b', 'c', 'a'])
})

test('family gives parent, children and siblings; outline lists heads then depth-first rows', () => {
  const m = buildTree([ag('l', { role: 'lead' }), ag('k1', { parentId: 'l' }), ag('k2', { parentId: 'l' }), ag('s')])
  assert.deepEqual(family(m, 'k1'), { parent: 'l', kids: [], prev: null, next: 'k2' })
  assert.deepEqual(family(m, 'l'), { parent: groupKey('alpha'), kids: ['k1', 'k2'], prev: null, next: null })
  assert.deepEqual(family(m, groupKey('alpha')), { parent: null, kids: ['l'], prev: null, next: SOLO_KEY })
  const rows = outline(m)
  assert.deepEqual(rows.map((r) => `${r.id}@${r.level}`), [`${groupKey('alpha')}@1`, 'l@2', 'k1@3', 'k2@3', `${SOLO_KEY}@1`, 's@2'])
})

test('layout: parents sit above their reports; leaf reports stack in columns; edges are orthogonal', () => {
  const many = Array.from({ length: 100 }, (_, i) => ag(`w${i}`, { role: 'sub', parentId: 'boss' }))
  const m = buildTree([ag('boss', { role: 'boss' }), ...many, ag('l', { role: 'lead', project: 'beta' }), ag('a', { parentId: 'l', project: 'beta' }), ag('b', { parentId: 'l', project: 'beta' })])
  const L = layout(m, { wrap: 1400 })
  const boss = L.items.get('boss'), w0 = L.items.get('w0')
  assert.ok(w0.y > boss.y + DIM.H)
  assert.ok(L.width < 3000, `100 leaf reports stay compact (width ${L.width})`)
  const ys = new Set(many.map((w) => L.items.get(w.id).y))
  assert.ok(ys.size > 3, 'stacked in rows')
  // side-by-side children: a and b on one row, centred under l
  const l = L.items.get('l'), a = L.items.get('a'), b = L.items.get('b')
  assert.equal(a.y, b.y)
  assert.ok(Math.abs((a.x + b.x + DIM.W) / 2 - (l.x + DIM.W / 2)) <= 1)
  // no overlaps among cards
  const boxes = [...L.items.values()].filter((it) => it.kind === 'node')
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const p = boxes[i], q = boxes[j]
    assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y, 'cards overlap')
  }
  for (const s of L.path.match(/M[^M]+/g)) {
    const [x1, y1, x2, y2] = s.match(/-?[\d.]+/g).map(Number)
    assert.ok(x1 === x2 || y1 === y2, `diagonal segment ${s}`)
  }
})

test('1,000 agents build and lay out quickly', () => {
  const agents = []
  for (let b = 0; b < 8; b++) {
    agents.push(ag(`b${b}`, { role: 'boss', project: `p${b % 4}` }))
    for (let l = 0; l < 6; l++) {
      agents.push(ag(`b${b}l${l}`, { role: 'lead', parentId: `b${b}`, project: `p${b % 4}`, bucket: l ? 'resting' : 'building' }))
      for (let w = 0; w < 18; w++) agents.push(ag(`b${b}l${l}w${w}`, { role: 'sub', parentId: `b${b}l${l}`, project: `p${b % 4}`, bucket: w < 2 && !l ? 'waiting' : 'resting' }))
    }
  }
  while (agents.length < 1000) agents.push(ag(`s${agents.length}`, { bucket: agents.length % 5 ? 'resting' : 'building' }))
  const t0 = performance.now()
  for (let i = 0; i < 10; i++) layout(buildTree(agents, { allOpen: true }), { wrap: 1400 })
  const per = (performance.now() - t0) / 10
  assert.ok(per < 50, `build + layout took ${per.toFixed(1)} ms`)
  const folded = buildTree(agents)
  assert.ok(folded.shown < 200, `folded by default (${folded.shown} shown)`)
})

test('every connector ends on a laid-out card, whatever is folded, filtered or resting; siblings close up', () => {
  // the e2e fixture's shape: a boss, three awake leads (one with two reports), a resting lead, solos
  const agents = [
    ag('boss', { role: 'boss', bucket: 'waiting' }),
    ag('db', { role: 'lead', parentId: 'boss', bucket: 'stalled' }), ag('ci', { role: 'lead', parentId: 'boss', bucket: 'waiting' }),
    ag('api', { role: 'lead', parentId: 'boss' }), ag('rev', { role: 'sub', parentId: 'api', bucket: 'waiting' }), ag('te', { role: 'sub', parentId: 'api' }),
    ag('docs', { role: 'lead', parentId: 'boss', bucket: 'resting' }),
    ag('s1', { bucket: 'stalled' }), ag('s2', { bucket: 'resting' }),
  ]
  const cases = {
    default: {}, expanded: { allOpen: true }, pillOpen: { open: new Set(['boss']) },
    apiFolded: { collapsed: new Set(['api']) }, bossFolded: { collapsed: new Set(['boss']) },
    filtered: { matches: (a) => a.id === 'te' }, filteredLead: { matches: (a) => a.id === 'ci' },
  }
  for (const [name, o] of Object.entries(cases)) {
    const m = buildTree(agents, o)
    const L = layout(m, { wrap: 1400 })
    assert.deepEqual(looseEnds(L), [], `${name}: connectors to nothing`)
    // one item per shown node, nothing laid out for what isn't shown
    assert.deepEqual([...L.items.keys()].filter((k) => L.items.get(k).kind === 'node').sort(), [...m.nodes.keys()].sort(), name)
    // side-by-side siblings: exactly HGAP apart, centred under their parent
    for (const n of m.nodes.values()) {
      if (n.kids.length < 2 || n.kids.length > 3 || n.kids.some((k) => k.kids.length)) continue
      const p = L.items.get(n.id), ks = n.kids.map((k) => L.items.get(k.id))
      const mid = (ks[0].x + ks[ks.length - 1].x + DIM.W) / 2
      assert.ok(Math.abs(mid - (p.x + DIM.W / 2)) <= 1, `${name}: ${n.id}'s reports off-centre`)
    }
  }
  // folding the API lead leaves the boss with exactly three cards in a row, no gap where the team was
  const L = layout(buildTree(agents, { collapsed: new Set(['api']) }), { wrap: 1400 })
  const row = ['db', 'ci', 'api'].map((id) => L.items.get(id)).sort((a, b) => a.x - b.x)
  assert.equal(row[1].x - row[0].x, DIM.W + DIM.HGAP)
  assert.equal(row[2].x - row[1].x, DIM.W + DIM.HGAP)
  // and the big fleet, folded and fully open
  const big = []
  for (let b = 0; b < 4; b++) {
    big.push(ag(`b${b}`, { role: 'boss', project: `p${b % 2}` }))
    for (let l = 0; l < 5; l++) {
      big.push(ag(`b${b}l${l}`, { role: 'lead', parentId: `b${b}`, project: `p${b % 2}`, bucket: l ? 'resting' : 'building' }))
      for (let w = 0; w < 22; w++) big.push(ag(`b${b}l${l}w${w}`, { role: 'sub', parentId: `b${b}l${l}`, project: `p${b % 2}`, bucket: !l && w < 2 ? 'waiting' : 'resting' }))
    }
  }
  for (const o of [{}, { allOpen: true }, { collapsed: new Set(['b0l0']) }]) assert.deepEqual(looseEnds(layout(buildTree(big, o), { wrap: 1400 })), [])
})
