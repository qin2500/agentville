import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLinesMatching } from '../server/fsutil.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'va-fastload-'))
const opts = { prefixes: ['{"type":"pr-link"', '{"type":"ai-title"'], needles: ['--bg', 'backgrounded ·'] }

test('readLinesMatching decodes only wanted lines, across chunk boundaries, and resumes from its offset', async () => {
  const file = path.join(tmp, 't.jsonl')
  const filler = (n) => JSON.stringify({ type: 'assistant', text: 'x'.repeat(n) })
  const lines = [filler(10), '{"type":"pr-link","prUrl":"u"}', filler(9_000_000), '{"type":"user","cmd":"claude --bg"}', '{"type":"ai-title","aiTitle":"héllo"}', filler(5), '{"type":"user","o":"backgrounded · abcd1234"}']
  fs.writeFileSync(file, lines.join('\n') + '\n{"type":"pr-link","partial')
  const got = []
  const end = await readLinesMatching(file, 0, opts, (l) => got.push(JSON.parse(l)))
  assert.deepEqual(got.map((r) => r.prUrl || r.cmd || r.aiTitle || r.o), ['u', 'claude --bg', 'héllo', 'backgrounded · abcd1234'])
  assert.equal(end, Buffer.byteLength(lines.join('\n') + '\n'))
  fs.appendFileSync(file, '-title"}\n{"type":"pr-link","prUrl":"v"}\n')
  const more = []
  await readLinesMatching(file, end, opts, (l) => more.push(l))
  assert.equal(more.length, 2) // the line that was cut off is read whole now, then the new one
  assert.match(more[0], /partial-title/)
  assert.match(more[1], /"v"/)
})
