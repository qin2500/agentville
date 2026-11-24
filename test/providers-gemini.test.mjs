import test from 'node:test'
import assert from 'node:assert/strict'
import gemini from '../server/providers/gemini.mjs'
import { assertAdapter } from '../server/providers/contract.mjs'

test('gemini adapter conforms and degrades without its modules', async () => {
  assertAdapter(gemini)
  assert.deepEqual(gemini.sessionEnv, ['GEMINI_SESSION_ID', 'AGENTVILLE_AGENT_ID'])
  assert.equal(gemini.capabilities.usage, 'estimate')
  const a = await gemini.available()
  assert.equal(typeof a.ok, 'boolean')
  if (!a.ok) assert.ok(a.why)
  assert.equal(gemini.isLimitText('429 RESOURCE_EXHAUSTED'), true)
  assert.deepEqual(await gemini.run({ kind: 'start', args: [], cwd: '/' }).then((r) => r.ok || r.error.length > 0), true)
})
