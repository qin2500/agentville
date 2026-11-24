import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNote, notePrompt } from '../server/handoff-note.mjs'

const events = [
  { role: 'user', at: 1, text: 'Add a login page' },
  { role: 'assistant', at: 2, text: 'Starting.' },
  { role: 'tool', at: 3, tool: { name: 'Edit', files: ['src/login.js'], done: true } },
  { role: 'tool', at: 4, tool: { name: 'Read', files: ['src/readonly.js'], done: true } },
  { role: 'assistant', at: 5, todo: [{ text: 'Form', done: true }, { text: 'Tests', done: false }] },
  { role: 'user', at: 6, text: 'x'.repeat(900) },
  { role: 'assistant', at: 7, text: 'Form is done, tests next.' },
]
const changes = { files: [{ path: 'src/a.js', add: 3, del: 1 }, { path: 'new.txt', untracked: true }] }

test('note has all sections and merges files', () => {
  const n = buildNote(events, changes, { name: 'job1', id: 'abc', transcriptPath: '/t.jsonl', interrupted: { tool: 'Bash' } })
  for (const h of ['## Task', '## Done', '## Changed files', '## Last state', '## Left', '## Pointers']) assert.ok(n.includes(h), h)
  assert.ok(n.includes('Add a login page'))
  assert.ok(n.includes('src/a.js (+3 -1)') && n.includes('new.txt (new)') && n.includes('src/login.js (edited)'))
  assert.ok(!n.split('## Last state')[0].includes('readonly.js'))
  assert.ok(n.includes('Form') && n.includes('TODO: Tests'))
  assert.ok(n.includes('`Bash` call was still running'))
  assert.ok(!n.includes('x'.repeat(601)))
})

test('empty input still builds', () => {
  const n = buildNote([], null, {})
  assert.ok(n.includes('## Task') && n.includes('(none found)'))
})

test('lead note lists children and subagents', () => {
  const n = buildNote(events, null, { children: [{ oldId: 'o1', newId: 'n1' }], subagents: [{ description: 'scan repo' }] })
  assert.ok(n.includes('o1 is now n1') && n.includes('scan repo'))
})

test('notePrompt respects max', () => {
  const n = buildNote(events, changes, {})
  const p = notePrompt(n, 1000, { notePath: 'handoffs/x.md' })
  assert.ok(p.length <= 500)
  assert.ok(p.includes('handoffs/x.md'))
  assert.equal(notePrompt('short', 5000).endsWith('short'), true)
})
