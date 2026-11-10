/**
 * What a terminal shows, kept on the server: a headless xterm that is fed every byte the PTY
 * prints and is resized with it. A page that (re-)attaches gets a snapshot of it — the screen, the
 * scrollback reflowed to the current width, the alternate screen when an app is in it, and the
 * modes the app set (mouse tracking and its encoding, bracketed paste, cursor keys…) — instead of
 * a replay of raw output, which loses the modes once its start is trimmed away (the wheel then
 * stops reaching an app that tracks the mouse) and redraws output meant for other widths.
 * Without @xterm/headless it falls back to replaying the last `fallbackBytes` of raw output.
 */
import { createRequire } from 'node:module'

export const MIN_COLS = 20
export const MIN_ROWS = 5
export const MAX_COLS = 500
export const MAX_ROWS = 300

/** A size a terminal may be given, as integers, or null: nothing below a usable minimum. */
export function validSize(cols, rows) {
  const c = Math.round(Number(cols)), r = Math.round(Number(rows))
  return c >= MIN_COLS && c <= MAX_COLS && r >= MIN_ROWS && r <= MAX_ROWS ? { cols: c, rows: r } : null
}

let lib
function load() {
  if (lib !== undefined) return lib
  try {
    const require = createRequire(import.meta.url)
    lib = { Terminal: require('@xterm/headless').Terminal, SerializeAddon: require('@xterm/addon-serialize').SerializeAddon }
  } catch { lib = null }
  return lib
}

// DEC private modes the serializer does not carry: cursor visibility, the mouse encodings (an
// app that asked for SGR reports would otherwise get X10 ones), focus events and alternate scroll.
const EXTRA = [25, 1004, 1005, 1006, 1015, 1016, 1007]
const DEFAULT_ON = new Set([25])
const MODE = /\x1b\[\?([\d;]+)([hl])/g
const PARTIAL = /\x1b(?:\[(?:\?[\d;]*)?)?$/

export function createScreen({ cols = 100, rows = 30, scrollback = 3000, fallbackBytes = 200 * 1024 } = {}) {
  const L = load()
  const modes = new Map()
  let carry = ''
  function track(d) {
    const s = carry + d
    for (const m of s.matchAll(MODE)) for (const n of m[1].split(';')) if (EXTRA.includes(+n)) modes.set(+n, m[2] === 'h')
    carry = PARTIAL.exec(s.slice(-64))?.[0] || ''
  }
  const extras = () => EXTRA.filter((n) => modes.has(n) && modes.get(n) !== DEFAULT_ON.has(n))
    .map((n) => `\x1b[?${n}${modes.get(n) ? 'h' : 'l'}`).join('')

  if (!L) {
    let chunks = [], size = 0
    return {
      headless: false,
      write(d) { chunks.push(d); size += d.length; while (size > fallbackBytes && chunks.length > 1) size -= chunks.shift().length },
      resize() {},
      snapshot: async () => chunks.join(''),
      dispose() { chunks = [] },
    }
  }
  const term = new L.Terminal({ cols, rows, scrollback, allowProposedApi: true })
  const ser = new L.SerializeAddon()
  term.loadAddon(ser)
  return {
    headless: true,
    write(d) { track(d); term.write(d) },
    resize(c, r) { if (c !== term.cols || r !== term.rows) term.resize(c, r) },
    /**
     * Resolves once everything written so far is parsed, with the state as of exactly then (it is
     * taken inside the write callback, before any later output is parsed).
     */
    snapshot: () => new Promise((resolve) => { term.write('', () => resolve(ser.serialize() + extras())) }),
    dispose() { term.dispose() },
  }
}
