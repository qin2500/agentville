import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGeminiAccounts, GEMINI_MISSING_MESSAGE } from '../server/gemini/accounts.mjs'

test('addStart with no gemini bin is a 409 gemini_missing and leaves no pending state', async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agv-gemini-missing-'))
  const g = createGeminiAccounts({ dataDir })
  await assert.rejects(g.accounts.addStart({ bin: null }), (e) => {
    assert.equal(e.status, 409)
    assert.deepEqual(e.body, { error: 'gemini_missing', message: GEMINI_MISSING_MESSAGE })
    assert.match(e.message, /npm install -g @google\/gemini-cli/)
    return true
  })
  const root = path.join(dataDir, 'accounts', 'gemini')
  const left = await fsp.readdir(root).catch(() => [])
  assert.deepEqual(left.filter((n) => n === 'pending-add.json' || n.startsWith('h-')), [])
  // A second click is not "already in progress".
  const ok = await g.accounts.addStart({ bin: '/opt/bin/gemini' })
  assert.ok(ok.home)
})
