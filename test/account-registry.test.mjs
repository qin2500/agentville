import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccountRegistry } from '../server/account-registry.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agv-reg-'))
const row = (id, extra = {}) => ({ id, label: id, ...extra })

test('missing provider reads as claude; other providers are filtered', async () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'accounts.json'), JSON.stringify([row('aaaaaaaa'), row('gemini-bbbbbbbb', { provider: 'gemini' })]))
  const r = createAccountRegistry({ dataDir: d })
  assert.deepEqual((await r.loadMeta('claude')).map((a) => a.id), ['aaaaaaaa'])
  assert.deepEqual((await r.loadMeta('gemini')).map((a) => a.id), ['gemini-bbbbbbbb'])
})

test('first save migrates with one backup, and keeps the other provider', async () => {
  const d = tmp()
  const f = path.join(d, 'accounts.json')
  const orig = JSON.stringify([row('aaaaaaaa')])
  fs.writeFileSync(f, orig)
  const r = createAccountRegistry({ dataDir: d })
  await r.saveMeta('gemini', [row('gemini-cccccccc')])
  assert.equal(fs.readFileSync(f + '.pre-providers', 'utf8'), orig)
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.deepEqual(rows.map((a) => [a.id, a.provider]), [['aaaaaaaa', 'claude'], ['gemini-cccccccc', 'gemini']])
  await r.saveMeta('claude', [])
  assert.equal(fs.readFileSync(f + '.pre-providers', 'utf8'), orig) // not overwritten
  assert.deepEqual((await r.loadMeta('gemini')).map((a) => a.id), ['gemini-cccccccc'])
  if (process.platform !== 'win32') assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600')
})

test('concurrent writers of different providers do not drop rows', async () => {
  const d = tmp()
  const r1 = createAccountRegistry({ dataDir: d })
  const r2 = createAccountRegistry({ dataDir: d })
  await Promise.all([r1.saveMeta('claude', [row('aaaaaaaa')]), r2.saveMeta('gemini', [row('gemini-dddddddd')])])
  assert.equal((await r1.loadMeta('claude')).length, 1)
  assert.equal((await r1.loadMeta('gemini')).length, 1)
})

test('no file reads as empty', async () => {
  assert.deepEqual(await createAccountRegistry({ dataDir: tmp() }).loadMeta('claude'), [])
})
