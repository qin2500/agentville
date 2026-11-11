/**
 * The terminal view's split layout (web/src/mux-model.js) and its Ghostty pop-out script
 * (server/ghostty-layout.mjs). Pure: nothing here runs osascript or opens a window.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as M from '../web/src/mux-model.js'
import { normalizeLayout, ghosttyLayoutScript, ghosttyLayoutLaunch, MAX_PANES } from '../server/ghostty-layout.mjs'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)
// A: left half; B over C on the right.
const abc = () => M.insert(M.insert(M.leaf('A'), 'A', 'B', 'right'), 'B', 'C', 'bottom')

test('insert: each side splits the target pane in half, in Ghostty’s directions', () => {
  assert.deepEqual(M.insert(M.leaf('A'), 'A', 'B', 'right'), { dir: 'row', ratio: 0.5, a: { id: 'A' }, b: { id: 'B' } })
  assert.deepEqual(M.insert(M.leaf('A'), 'A', 'B', 'left'), { dir: 'row', ratio: 0.5, a: { id: 'B' }, b: { id: 'A' } })
  assert.deepEqual(M.insert(M.leaf('A'), 'A', 'B', 'top'), { dir: 'column', ratio: 0.5, a: { id: 'B' }, b: { id: 'A' } })
  assert.deepEqual(M.insert(M.leaf('A'), 'A', 'B', 'bottom'), { dir: 'column', ratio: 0.5, a: { id: 'A' }, b: { id: 'B' } })
  assert.deepEqual(M.insert(null, 'X', 'A', 'left'), { id: 'A' })
  assert.throws(() => M.insert(M.leaf('A'), 'A', 'B', 'middle'))
})

test('insert nests without limit, only inside the target pane, and never mutates its input', () => {
  const t = abc()
  assert.deepEqual(t, { dir: 'row', ratio: 0.5, a: { id: 'A' }, b: { dir: 'column', ratio: 0.5, a: { id: 'B' }, b: { id: 'C' } } })
  let deep = M.leaf('p0')
  for (let i = 1; i < 30; i++) deep = M.insert(deep, `p${i - 1}`, `p${i}`, i % 2 ? 'right' : 'bottom')
  assert.equal(M.count(deep), 30)
  assert.deepEqual(M.leaves(deep), Array.from({ length: 30 }, (_, i) => `p${i}`))
  const frozen = JSON.stringify(t)
  M.insert(t, 'C', 'D', 'left'); M.remove(t, 'B'); M.resize(t, 'b', 0.7); M.equalize(t)
  assert.equal(JSON.stringify(t), frozen)
})

test('insert: an agent already shown moves (it is never in two panes); dropping on itself does nothing', () => {
  const t = abc()
  assert.equal(M.insert(t, 'A', 'A', 'left'), t)
  const moved = M.insert(t, 'A', 'C', 'top')
  assert.deepEqual(M.leaves(moved).sort(), ['A', 'B', 'C'])
  assert.deepEqual(moved, { dir: 'row', ratio: 0.5, a: { dir: 'column', ratio: 0.5, a: { id: 'C' }, b: { id: 'A' } }, b: { id: 'B' } })
  // Moving the target's only sibling beside it: the pair re-forms.
  assert.deepEqual(M.insert(M.insert(M.leaf('A'), 'A', 'B', 'right'), 'A', 'B', 'top'), { dir: 'column', ratio: 0.5, a: { id: 'B' }, b: { id: 'A' } })
})

test('remove: the sibling takes the whole area; the last pane leaves an empty layout', () => {
  const t = M.resize(abc(), '', 0.3)
  assert.deepEqual(M.remove(t, 'A'), { dir: 'column', ratio: 0.5, a: { id: 'B' }, b: { id: 'C' } })
  assert.deepEqual(M.remove(t, 'B'), { dir: 'row', ratio: 0.3, a: { id: 'A' }, b: { id: 'C' } })
  assert.equal(M.remove(t, 'nope'), t)
  assert.equal(M.remove(M.leaf('A'), 'A'), null)
  assert.equal(M.remove(M.remove(M.remove(t, 'A'), 'B'), 'C'), null)
})

test('replace shows another agent in the same pane; one already shown swaps places', () => {
  const t = abc()
  assert.deepEqual(M.leaves(M.replace(t, 'B', 'Z')), ['A', 'Z', 'C'])
  assert.deepEqual(M.leaves(M.replace(t, 'A', 'C')), ['C', 'B', 'A'])
  assert.equal(M.replace(t, 'nope', 'Z'), t)
})

test('resize clamps so no pane collapses; nudge moves the nearest divider along that axis', () => {
  const t = abc()
  assert.equal(M.resize(t, '', 0.25).ratio, 0.25)
  assert.equal(M.resize(t, '', 0).ratio, M.MIN_RATIO)
  assert.equal(M.resize(t, '', 5).ratio, M.MAX_RATIO)
  assert.equal(M.resize(t, 'b', 0.8).b.ratio, 0.8)
  assert.equal(M.resize(t, 'a', 0.8), t) // a leaf: not a split
  assert.equal(M.resize(t, 'zz', 0.8), t)
  // C's nearest row divider is the root; its nearest column divider is B|C.
  assert.equal(M.nudge(t, 'C', 'right', 0.1).ratio, 0.6)
  near(M.nudge(t, 'C', 'up', 0.1).b.ratio, 0.4)
  assert.equal(M.nudge(t, 'A', 'down'), t) // no column split above A
  assert.equal(M.splitAbove(t, 'C', 'column'), 'b')
  assert.equal(M.pathTo(t, 'C'), 'bb')
})

test('equalize gives every pane along an axis the same size (Ghostty equalize_splits)', () => {
  // A | B | C (nested rows): A gets a third.
  const three = M.insert(M.insert(M.leaf('A'), 'A', 'B', 'right'), 'B', 'C', 'right')
  const eq = M.equalize(M.resize(M.resize(three, '', 0.9), 'b', 0.2))
  near(eq.ratio, 1 / 3)
  near(eq.b.ratio, 0.5)
  const r = M.rects(eq)
  for (const id of ['A', 'B', 'C']) near(r.get(id).w, 1 / 3)
  // A row over a column: the column counts as one pane along the row.
  near(M.equalize(M.resize(abc(), '', 0.2)).ratio, 0.5)
  assert.equal(M.equalize(null), null)
})

test('rects tile the unit square; neighbor and cycle move focus like goto_split', () => {
  const t = M.resize(abc(), '', 0.4)
  const r = M.rects(t)
  assert.deepEqual(r.get('A'), { x: 0, y: 0, w: 0.4, h: 1 })
  near(r.get('B').x, 0.4); near(r.get('B').w, 0.6); near(r.get('B').h, 0.5)
  near(r.get('C').y, 0.5)
  const area = [...r.values()].reduce((s, x) => s + x.w * x.h, 0)
  near(area, 1)
  assert.equal(M.neighbor(t, 'A', 'right'), 'B') // both B and C touch A; B is first by distance then alignment (tie → first)
  assert.equal(M.neighbor(t, 'B', 'down'), 'C')
  assert.equal(M.neighbor(t, 'C', 'up'), 'B')
  assert.equal(M.neighbor(t, 'C', 'left'), 'A')
  assert.equal(M.neighbor(t, 'A', 'left'), null)
  assert.equal(M.neighbor(t, 'A', 'up'), null)
  assert.equal(M.cycle(t, 'C', 1), 'A')
  assert.equal(M.cycle(t, 'A', -1), 'C')
  assert.equal(M.cycle(M.leaf('A'), 'A', 1), null)
})

test('drop zones: the nearest edge of the pane under the pointer', () => {
  assert.equal(M.dropSide(0.1, 0.5), 'left')
  assert.equal(M.dropSide(0.9, 0.5), 'right')
  assert.equal(M.dropSide(0.5, 0.05), 'top')
  assert.equal(M.dropSide(0.5, 0.95), 'bottom')
  assert.equal(M.dropSide(0.3, 0.2), 'top')
  assert.deepEqual(M.sideRect('right'), { x: 0.5, y: 0, w: 0.5, h: 1 })
})

test('serialize / parse round-trip; parse rejects what is not a layout', () => {
  const t = M.resize(abc(), 'b', 0.7)
  assert.deepEqual(M.parse(JSON.parse(M.serialize(t))), t)
  assert.equal(M.parse(null), null)
  assert.equal(M.parse({ dir: 'diagonal', ratio: 0.5, a: { id: 'A' }, b: { id: 'B' } }), null)
  assert.equal(M.parse({ dir: 'row', ratio: 0.5, a: { id: 'A' }, b: { id: 'A' } }), null) // twice
  assert.equal(M.parse({ dir: 'row', ratio: 0.5, a: { id: 'A' } }), null)
  assert.equal(M.parse({ dir: 'row', ratio: 'x', a: { id: 'A' }, b: { id: 'B' } }).ratio, 0.5)
  assert.equal(M.parse({ dir: 'row', ratio: -3, a: { id: 'A' }, b: { id: 'B' } }).ratio, M.MIN_RATIO)
  let deep = { id: 'x' }
  for (let i = 0; i < 40; i++) deep = { dir: 'row', ratio: 0.5, a: deep, b: { id: `y${i}` } }
  assert.equal(M.parse(deep), null)
})

// ---------- the Ghostty pop-out ----------
const GHOSTTY = '/Applications/Ghostty.app/Contents/MacOS/ghostty'

test('normalizeLayout: the server checks the page’s layout (shape, duplicates, pane cap)', () => {
  assert.deepEqual(normalizeLayout({ dir: 'row', ratio: 9, a: { id: 'A', extra: 1 }, b: { id: 'B' } }), { dir: 'row', ratio: 0.92, a: { id: 'A' }, b: { id: 'B' } })
  for (const bad of [null, [], 'x', { id: '' }, { dir: 'row', a: { id: 'A' } }, { dir: 'row', ratio: 0.5, a: { id: 'A' }, b: { id: 'A' } }]) {
    assert.throws(() => normalizeLayout(bad), (e) => e.status === 400)
  }
  let many = { id: 'p0' }
  for (let i = 1; i <= MAX_PANES; i++) many = { dir: 'row', ratio: 0.5, a: many, b: { id: `p${i}` } }
  assert.throws(() => normalizeLayout(many), /At most/)
})

test('the script rebuilds the tree depth first: split right/down, ratio applied before the sides are split', () => {
  // A | (B over C), A at 40%, B at 70% of the right side; focus C.
  const tree = { dir: 'row', ratio: 0.4, a: { id: 'A' }, b: { dir: 'column', ratio: 0.7, a: { id: 'B' }, b: { id: 'C' } } }
  const { lines, order } = ghosttyLayoutScript(tree, { focus: 'C', cellW: 8, cellH: 17, width: 1000, height: 600 })
  assert.deepEqual(order, ['A', 'B', 'C'])
  const s = lines.map((l) => l.trim())
  const idx = (x) => { const i = s.indexOf(x); assert.ok(i >= 0, `missing: ${x}\n${s.join('\n')}`); return i }
  // Each pane's cwd and command come from argv slots, never from the source.
  idx('set initial working directory of cfg1 to item 2 of argv'); idx('set command of cfg1 to item 3 of argv')
  idx('set initial working directory of cfg3 to item 6 of argv'); idx('set command of cfg3 to item 7 of argv')
  const win = idx('set win to new window with configuration cfg1')
  const root = idx('set t2 to split t1 direction right with configuration cfg2')
  // Root: 40% → the divider moves left by 10% of the window width (k = 1000 * -0.1 * 1000).
  const rootSize = idx('set d to (W * -100000) div 1000000')
  idx('if d < 0 then perform action ("resize_split:left," & (0 - d)) on t1')
  const inner = idx('set t3 to split t2 direction down with configuration cfg3')
  // B|C: the full height, 70% → down by 20% of H.
  const innerSize = idx('set d to (H * 200000) div 1000000')
  idx('if d > 0 then perform action ("resize_split:down," & d) on t2')
  const focus = idx('focus t3')
  assert.ok(win < root && root < rootSize && rootSize < inner && inner < innerSize && innerSize < focus)
  // The window is measured (stty on the first terminal's tty) before any split, with the fallback first.
  assert.ok(idx('set W to 1000') < idx('set sz to do shell script "/bin/stty -f " & quoted form of tty1 & " size"'))
  idx('if nr > 2 and nc > 10 then')
  idx('set W to nc * 800 div 100')
  idx('set H to nr * 1700 div 100')
  assert.equal(s.at(-2), 'return "village-ai-window-created"')
})

test('the script: nested ratios use each split’s own share of the window; a lone pane has no splits', () => {
  // (A | B) over C: the A|B divider spans the top 30% of the height but the full width.
  const tree = { dir: 'column', ratio: 0.3, a: { dir: 'row', ratio: 0.75, a: { id: 'A' }, b: { id: 'B' } }, b: { id: 'C' } }
  const s = ghosttyLayoutScript(tree).lines.map((l) => l.trim())
  // Root: split t1 down for C (t3), then the top (A) splits right for B (t2).
  assert.ok(s.indexOf('set t3 to split t1 direction down with configuration cfg3') < s.indexOf('set t2 to split t1 direction right with configuration cfg2'))
  assert.ok(s.includes('set d to (H * -200000) div 1000000'))
  assert.ok(s.includes('set d to (W * 250000) div 1000000'))
  // A right-hand pane of a 60% split: its own row split uses 40% of the width.
  const t2 = { dir: 'row', ratio: 0.6, a: { id: 'A' }, b: { dir: 'row', ratio: 0.25, a: { id: 'B' }, b: { id: 'C' } } }
  assert.ok(ghosttyLayoutScript(t2).lines.some((l) => l.trim() === 'set d to (W * -100000) div 1000000'))
  // Equal splits need no resize; one pane is just a window.
  const even = ghosttyLayoutScript({ dir: 'row', ratio: 0.5, a: { id: 'A' }, b: { id: 'B' } }).lines.join('\n')
  assert.ok(!even.includes('resize_split'))
  const one = ghosttyLayoutScript({ id: 'A' }).lines.join('\n')
  assert.ok(!one.includes('split t') && !one.includes('focus t'))
})

test('the launch passes cwd and command as arguments, quoted exactly as Open in Ghostty quotes them', () => {
  const nasty = "/tmp/it's $(touch nope); x"
  const tree = { dir: 'row', ratio: 0.5, a: { id: 'A' }, b: { id: 'B' } }
  const cmds = new Map([['A', { argv: ['/bin/claude', 'attach', 'abcd1234'], cwd: nasty }], ['B', { argv: ['/bin/codex', 'resume', "x'y"], cwd: '/w' }]])
  const l = ghosttyLayoutLaunch(GHOSTTY, tree, cmds, { focus: 'B' })
  assert.equal(l.executable, '/usr/bin/osascript')
  assert.equal(l.app, 'Ghostty')
  const firstArg = l.args.findIndex((a, i) => l.args[i - 1] !== '-e' && a !== '-e')
  const tail = l.args.slice(firstArg)
  assert.deepEqual(tail, ['/Applications/Ghostty.app', nasty, "'/bin/claude' 'attach' 'abcd1234'", '/w', `'/bin/codex' 'resume' 'x'"'"'y'`])
  // No session value is in the source.
  const source = l.args.filter((_, i) => l.args[i - 1] === '-e').join('\n')
  for (const v of ['abcd1234', 'touch nope', '/bin/claude', '/w"']) assert.ok(!source.includes(v), v)
  assert.equal(ghosttyLayoutLaunch('/usr/bin/kitty', tree, cmds), null)
  assert.throws(() => ghosttyLayoutLaunch(GHOSTTY, tree, new Map()), /No command/)
})

test('the script’s numbers are clamped integers whatever the page sends', () => {
  const s = ghosttyLayoutScript({ dir: 'row', ratio: 0.3, a: { id: 'A' }, b: { id: 'B' } }, { cellW: 'x', cellH: 1e9, width: -5, height: NaN }).lines.join('\n')
  assert.match(s, /set W to 200\b/)
  assert.match(s, /set H to 800\b/)
  assert.match(s, /\* 800 div 100/)
  assert.match(s, /\* 8000 div 100/)
})
