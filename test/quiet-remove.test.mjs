/** Agents quiet for over QUIET_REMOVE_DAYS leave the app (server/classify.mjs dropQuiet). Pure. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { build, dropQuiet, QUIET_REMOVE_DAYS } from '../server/classify.mjs'

const NOW = 1_800_000_000_000
const DAY = 24 * 3600e3
const fact = (id, days, extra = {}) => ({ id, harness: 'claude-code', kind: 'session', name: id, project: 'demo', lastActivityAt: NOW - days * DAY, lifecycle: 'idle', ...extra })

test('quiet agents are removed; live and Important ones stay; 11 days out, 9 days in', () => {
  assert.equal(QUIET_REMOVE_DAYS, 10)
  const facts = [
    fact('old', 30),
    fact('old-live', 30, { live: true, lifecycle: 'running' }),
    fact('old-important', 30),
    fact('eleven', 11, { harness: 'codex', kind: 'thread' }),
    fact('nine', 9),
  ]
  const { kept, removed } = dropQuiet(facts, { 'old-important': { important: true } }, NOW)
  assert.deepEqual(kept.map((a) => a.id), ['old-live', 'old-important', 'nine'])
  assert.deepEqual([...removed].sort(), ['eleven', 'old'])
})

test('a kept child whose parent was removed shows as top-level', () => {
  const facts = [fact('boss', 20), fact('child', 20, { kind: 'job', parentId: 'boss', live: true, lifecycle: 'running' })]
  const { kept } = dropQuiet(facts, {}, NOW)
  const [child] = build(kept, {}, NOW)
  assert.equal(child.id, 'child')
  assert.equal(child.parentId, null)
})
