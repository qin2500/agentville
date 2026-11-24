/**
 * Spec tests for docs/providers-design.md sections 2.4 and 3.4: handoff de-dupe key and note limits.
 * The createHandoffs constructor and its methods are not fixed by the spec beyond the name, so the engine
 * tests are only the ones that can be stated through buildNote/notePrompt and the ledger file format.
 * Waiting on P11 (note) and P12 (engine).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { tryLoad } from './support/spec-load.mjs'

const note = await tryLoad('../server/handoff-note.mjs')
const engine = await tryLoad('../server/handoff.mjs')
const noteOpts = note ? {} : { todo: 'waiting on P11' }
const engOpts = engine ? {} : { todo: 'waiting on P12' }

const hid = (agentId, episodeId) => crypto.createHash('sha256').update(agentId + episodeId).digest('hex').slice(0, 16)

test('spec formula: hid is 16 hex chars, stable per (agent, episode), different otherwise', () => {
  const a = hid('claude:abc', 'claude-100')
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(a, hid('claude:abc', 'claude-100'))
  assert.notEqual(a, hid('claude:abc', 'claude-200'))
  assert.notEqual(a, hid('claude:abd', 'claude-100'))
})

test('createHandoffs is exported as a function', engOpts, () => {
  assert.equal(typeof engine.createHandoffs, 'function')
})

test('buildNote and notePrompt are exported functions', noteOpts, () => {
  assert.equal(typeof note.buildNote, 'function')
  assert.equal(typeof note.notePrompt, 'function')
})

const ev = (role, text, at = 1) => ({ role, at, text })

test('buildNote: includes the first user prompt and the changed files', noteOpts, () => {
  const n = note.buildNote([ev('user', 'Fix the parser bug'), ev('assistant', 'On it')], { files: ['src/parser.js'], changed: ['src/parser.js'] }, { name: 'job', cwd: '/w' })
  const s = typeof n === 'string' ? n : JSON.stringify(n)
  assert.match(s, /Fix the parser bug/)
  assert.match(s, /src\/parser\.js/)
})

test('buildNote: user prompts are cut to 600 characters', noteOpts, () => {
  const n = note.buildNote([ev('user', 'x'.repeat(5000))], {}, {})
  const s = typeof n === 'string' ? n : JSON.stringify(n)
  assert.ok(!s.includes('x'.repeat(601)))
  assert.ok(s.includes('x'.repeat(100)))
})

test('buildNote: assistant texts are cut to 800 characters and only the last 3 are kept', noteOpts, () => {
  const evs = [1, 2, 3, 4].map((i) => ev('assistant', String(i).repeat(2000), i))
  const n = note.buildNote(evs, {}, {})
  const s = typeof n === 'string' ? n : JSON.stringify(n)
  assert.ok(!s.includes('1'.repeat(50)), 'oldest dropped')
  assert.ok(s.includes('4'.repeat(100)))
  assert.ok(!s.includes('4'.repeat(801)))
})

test('buildNote: open todo items are listed', noteOpts, () => {
  const n = note.buildNote([ev('user', 'go'), { role: 'tool', at: 2, tool: { name: 'TodoWrite', files: [], done: true }, todo: [{ text: 'write docs', done: false }, { text: 'ship it', done: true }] }], {}, {})
  const s = typeof n === 'string' ? n : JSON.stringify(n)
  assert.match(s, /write docs/)
})

test('buildNote: an interrupted tool is called out', noteOpts, () => {
  const n = note.buildNote([ev('user', 'go')], {}, { interrupted: { tool: 'Bash' } })
  const s = typeof n === 'string' ? n : JSON.stringify(n)
  assert.match(s, /Bash/)
})

test('notePrompt: never longer than max', noteOpts, () => {
  const text = typeof note.buildNote([ev('user', 'y'.repeat(100000))], {}, {}) === 'string' ? note.buildNote([ev('user', 'y'.repeat(100000))], {}, {}) : 'y'.repeat(100000)
  for (const max of [2000, 6000]) assert.ok(note.notePrompt(text, max).length <= max)
})
