/**
 * "Pop out layout": the terminal view's split layout (web/src/mux-model.js) as one Ghostty window
 * with the same splits, built through Ghostty's native AppleScript API (1.3+; see Ghostty.sdef).
 *
 * The script is generated per layout, but nothing from a session ever goes into its source: each
 * pane's working directory and command reach it as osascript arguments (`item N of argv`), exactly
 * as server/ghostty-window.applescript takes them. The source holds only what this module makes:
 * variable names, split directions from a fixed set, and integers.
 *
 * Construction, depth first: the window opens on the first pane; a split node over the terminal
 * holding its area splits it right (row) or down (column), the new terminal taking the first pane
 * of the second side; the ratio is applied at once, while both sides are single terminals, so
 * Ghostty's resize_split moves exactly that divider; then each side is built the same way.
 *
 * Ratios: resize_split moves a divider by points, and Ghostty does not say how big its window is.
 * The script reads the first terminal's rows and columns (`stty -f <its tty> size`) and multiplies by
 * the cell size the page measured in its own xterm (the same 13-point monospace font by default);
 * if that read fails it falls back to the size of the page's terminal area. Approximate by design.
 */
import { shQuote } from './terminal.mjs'

export const MAX_PANES = 16
const MAX_DEPTH = 24
const MIN_RATIO = 0.08, MAX_RATIO = 0.92

/** A layout from the page, checked: leaves `{ id }`, splits `{ dir, ratio, a, b }`; throws a 400. */
export function normalizeLayout(raw) {
  const seen = new Set()
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 })
  const rec = (n, depth) => {
    if (!n || typeof n !== 'object' || Array.isArray(n) || depth > MAX_DEPTH) throw bad('Invalid layout')
    if (typeof n.id === 'string') {
      if (!n.id || n.id.length > 200) throw bad('Invalid layout')
      if (seen.has(n.id)) throw bad('An agent can be in the layout only once')
      seen.add(n.id)
      if (seen.size > MAX_PANES) throw bad(`At most ${MAX_PANES} panes can pop out together`)
      return { id: n.id }
    }
    if (n.dir !== 'row' && n.dir !== 'column') throw bad('Invalid layout')
    const r = Number(n.ratio)
    return { dir: n.dir, ratio: Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : 0.5, a: rec(n.a, depth + 1), b: rec(n.b, depth + 1) }
  }
  return rec(raw, 0)
}

export const layoutLeaves = (n, out = []) => {
  if (n.id !== undefined) out.push(n.id)
  else { layoutLeaves(n.a, out); layoutLeaves(n.b, out) }
  return out
}

const int = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.round(Math.min(hi, Math.max(lo, Number(v)))) : d)

/**
 * The AppleScript (as lines) that rebuilds `tree` in a new Ghostty window, and the order its
 * argument slots follow. `focus`: the id of the pane to focus at the end.
 * `metrics`: { cellW, cellH } (points per cell) and { width, height } (the fallback window size).
 * argv the script expects: [bundlePath, cwd₁, command₁, cwd₂, command₂, …] in `order`.
 */
export function ghosttyLayoutScript(tree, { focus = null, cellW = 8, cellH = 17, width = 1200, height = 800 } = {}) {
  const order = layoutLeaves(tree)
  const slot = new Map(order.map((id, i) => [id, i + 1])) // pane number: variables cfgN / tN
  const first = (n) => (n.id !== undefined ? n.id : first(n.a))
  // Integers only in the source: hundredths of a point per cell, whole points of fallback size.
  const cw100 = int(cellW * 100, 200, 4000, 800), ch100 = int(cellH * 100, 400, 8000, 1700)
  const W0 = int(width, 200, 10000, 1200), H0 = int(height, 150, 10000, 800)

  const L = []
  const say = (indent, s) => L.push('    '.repeat(indent) + s)
  say(0, 'on run argv')
  say(1, 'set bundlePath to item 1 of argv')
  say(1, `set W to ${W0}`)
  say(1, `set H to ${H0}`)
  say(1, 'using terms from application "Ghostty"')
  say(2, 'tell application bundlePath')
  order.forEach((id, i) => {
    const n = i + 1
    say(3, `set cfg${n} to new surface configuration`)
    say(3, `set initial working directory of cfg${n} to item ${2 * n} of argv`)
    say(3, `set command of cfg${n} to item ${2 * n + 1} of argv`)
  })
  say(3, 'set win to new window with configuration cfg1')
  say(3, 'set t1 to focused terminal of selected tab of win')
  say(3, 'set tty1 to tty of t1')
  say(2, 'end tell')
  say(1, 'end using terms from')
  // Outside the tell: Standard Additions run in this script, not in Ghostty.
  say(1, 'try')
  say(2, 'delay 0.4')
  say(2, 'set sz to do shell script "/bin/stty -f " & quoted form of tty1 & " size"')
  say(2, 'set nr to (word 1 of sz) as integer')
  say(2, 'set nc to (word 2 of sz) as integer')
  // A terminal not laid out yet reports 0 × 0: keep the fallback then.
  say(2, 'if nr > 2 and nc > 10 then')
  say(3, `set H to nr * ${ch100} div 100`)
  say(3, `set W to nc * ${cw100} div 100`)
  say(2, 'end if')
  say(1, 'end try')
  say(1, 'using terms from application "Ghostty"')
  say(2, 'tell application bundlePath')
  // fw, fh: this node's share of the window, in thousandths.
  const build = (n, fw, fh) => {
    if (n.id !== undefined) return
    const holder = slot.get(first(n.a)), fresh = slot.get(first(n.b))
    const row = n.dir === 'row'
    say(3, `set t${fresh} to split t${holder} direction ${row ? 'right' : 'down'} with configuration cfg${fresh}`)
    // Both sides are single terminals now: resize_split on either moves this divider.
    const k = Math.round((row ? fw : fh) * (n.ratio - 0.5) * 1000) // points = W (or H) * k / 1e6
    if (k !== 0) {
      say(3, `set d to (${row ? 'W' : 'H'} * ${k}) div 1000000`)
      say(3, `if d > 0 then perform action ("resize_split:${row ? 'right' : 'down'}," & d) on t${holder}`)
      say(3, `if d < 0 then perform action ("resize_split:${row ? 'left' : 'up'}," & (0 - d)) on t${holder}`)
    }
    const ra = Math.round(n.ratio * 1000) / 1000
    build(n.a, row ? Math.round(fw * ra) : fw, row ? fh : Math.round(fh * ra))
    build(n.b, row ? Math.round(fw * (1 - ra)) : fw, row ? fh : Math.round(fh * (1 - ra)))
  }
  build(tree, 1000, 1000)
  if (focus && slot.has(focus) && order.length > 1) say(3, `focus t${slot.get(focus)}`)
  say(2, 'end tell')
  say(1, 'end using terms from')
  say(1, 'return "village-ai-window-created"')
  say(0, 'end run')
  return { lines: L, order }
}

/**
 * The osascript launch for runAppleScript (terminal.mjs): the generated source as -e lines, then the
 * bundle and each pane's cwd and command. `commands`: Map id -> { argv, cwd } from openCommand or
 * the running PTY, never from the page. Commands are quoted exactly as "Open in Ghostty" quotes them.
 */
export function ghosttyLayoutLaunch(executable, tree, commands, metrics = {}) {
  const suffix = '/Contents/MacOS/ghostty'
  if (!executable.endsWith(suffix) || !executable.slice(0, -suffix.length).endsWith('.app')) return null
  const bundle = executable.slice(0, -suffix.length)
  const { lines, order } = ghosttyLayoutScript(tree, metrics)
  const args = []
  for (const line of lines) args.push('-e', line)
  args.push(bundle)
  for (const id of order) {
    const c = commands.get(id)
    if (!c) throw new Error(`No command for ${id}`)
    args.push(c.cwd, c.argv.map(shQuote).join(' '))
  }
  return { executable: '/usr/bin/osascript', args, app: 'Ghostty' }
}
