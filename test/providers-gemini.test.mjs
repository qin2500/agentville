import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import gemini, { agyDirs, AGY_MISSING, MODES } from '../server/providers/gemini.mjs'
import { assertAdapter } from '../server/providers/contract.mjs'

test('gemini adapter drives agy: conforms, label, no switcher, no yolo', async () => {
  assertAdapter(gemini)
  assert.equal(gemini.id, 'gemini')
  assert.equal(gemini.label, 'Gemini (Antigravity)')
  assert.equal(gemini.switcher, null)
  assert.equal(gemini.capabilities.accounts, true)
  assert.deepEqual(gemini.sessionEnv, ['AGENTVILLE_AGENT_ID'])
  assert.deepEqual(MODES, ['', 'auto', 'plan'])
  const a = await gemini.available()
  assert.equal(typeof a.ok, 'boolean')
  if (!a.ok) assert.ok(a.why)
  assert.equal(gemini.isLimitText('429 RESOURCE_EXHAUSTED'), true)
  assert.deepEqual(await gemini.run({ kind: 'start', args: [], cwd: '/' }).then((r) => r.ok || r.error.length > 0), true)
  assert.match(AGY_MISSING, /curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/)
})

test('agy is looked up in ~/.local/bin and %LOCALAPPDATA%\\agy\\bin', () => {
  assert.deepEqual(agyDirs({ platform: 'darwin', home: '/home/u' }), [path.join('/home/u', '.local', 'bin')])
  assert.equal(agyDirs({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U' } })[0], path.join('C:\\L', 'agy', 'bin'))
})

test('startPlan maps old mode names to the default and refuses yolo', () => {
  const tmp = process.cwd()
  const p = gemini.startPlan({ cwd: tmp, prompt: 'hi', permissionMode: 'auto_edit' })
  assert.equal(p.mode, '')
  assert.ok(p.args.includes('accept-edits') || p.args.length > 0)
  assert.equal(gemini.startPlan({ cwd: tmp, prompt: 'hi', permissionMode: 'auto' }).mode, 'auto')
  assert.throws(() => gemini.startPlan({ cwd: tmp, prompt: 'hi', permissionMode: 'yolo' }), /Unknown permission mode/)
  assert.match(gemini.display(p), /^agy -p hi --output-format stream-json --mode accept-edits$/)
})
