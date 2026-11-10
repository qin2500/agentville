// The server's headless copy of a terminal (server/term-screen.mjs): what a page attaching gets.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createScreen, validSize } from '../server/term-screen.mjs'

test('validSize: integers within 20×5 … 500×300, else null', () => {
  assert.deepEqual(validSize(80, 24), { cols: 80, rows: 24 })
  assert.deepEqual(validSize('80', 24.4), { cols: 80, rows: 24 })
  for (const [c, r] of [[2, 45], [19, 24], [80, 4], [501, 24], [80, 301], [NaN, 24], [undefined, undefined], [null, 5]]) assert.equal(validSize(c, r), null, `${c}x${r}`)
})

test('a snapshot carries the screen, the alternate screen and the modes serialize leaves out', async () => {
  const s = createScreen({ cols: 40, rows: 10 })
  assert.equal(s.headless, true)
  s.write('history line\r\n')
  // Split mid-sequence, as PTY reads split: the mode parser must not miss it.
  s.write('\x1b[?1049h\x1b[?1000h\x1b[?10')
  s.write('06h\x1b[?25l\x1b[?2004hALT SCREEN')
  const snap = await s.snapshot()
  assert.match(snap, /history line/)
  assert.ok(snap.includes('\x1b[?1049h'), 'alternate screen')
  assert.ok(snap.includes('ALT SCREEN'))
  for (const m of ['\x1b[?1000h', '\x1b[?1006h', '\x1b[?2004h', '\x1b[?25l']) assert.ok(snap.includes(m), JSON.stringify(m))
  // Leaving the alternate screen and the modes: none of them is restored.
  s.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049lback')
  const after = await s.snapshot()
  for (const m of ['\x1b[?1049h', '\x1b[?1000h', '\x1b[?1006h', '\x1b[?25l']) assert.ok(!after.includes(m), JSON.stringify(m))
  s.dispose()
})

test('a resize reflows the scrollback instead of keeping lines drawn for the old width', async () => {
  const s = createScreen({ cols: 20, rows: 5 })
  s.write(`${'abcdefghij'.repeat(4)}\r\n`)
  s.resize(60, 5)
  const snap = await s.snapshot()
  assert.ok(snap.includes('abcdefghij'.repeat(4)), JSON.stringify(snap))
  s.dispose()
})
