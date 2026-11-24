// The saved-account row menu (web/src/acct-items.js): which items each state offers, and the PATCH the
// Low priority toggle sends. Pure functions and a fake fetch; no network, no real accounts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { accountMenuItems, patchAccount, LOW_PRIORITY_TIP } from '../web/src/acct-items.js'

const labels = (a) => accountMenuItems(a).map((i) => (i.sep ? '---' : i.label))
const base = { id: 'A', label: 'Work', quarantine: false, lowPriority: false, signedIn: false }

test('a regular account: Rename, Quarantine, Low priority, a separator, Remove', () => {
  assert.deepEqual(labels(base), ['Rename', 'Quarantine', 'Low priority', '---', 'Remove'])
})
test('quarantine and low priority flip their labels', () => {
  assert.deepEqual(labels({ ...base, quarantine: true }), ['Rename', 'Make regular', 'Low priority', '---', 'Remove'])
  assert.deepEqual(labels({ ...base, lowPriority: true }), ['Rename', 'Quarantine', 'Make regular priority', '---', 'Remove'])
  assert.deepEqual(labels({ ...base, quarantine: true, lowPriority: true }), ['Rename', 'Make regular', 'Make regular priority', '---', 'Remove'])
})
test('Remove is last and styled as danger', () => {
  const last = accountMenuItems(base).at(-1)
  assert.equal(last.act, 'remove')
  assert.equal(last.danger, true)
})
test('Remove (and its separator) is hidden for the signed-in account', () => {
  assert.deepEqual(labels({ ...base, signedIn: true }), ['Rename', 'Quarantine', 'Low priority'])
})
test('a missing lowPriority (an older server) reads as regular priority', () => {
  const { lowPriority, ...old } = base
  assert.equal(accountMenuItems(old).find((i) => i.act === 'lowpriority').label, 'Low priority')
})
test('the Low priority item carries the explanation', () => {
  assert.equal(accountMenuItems(base).find((i) => i.act === 'lowpriority').title, LOW_PRIORITY_TIP)
  assert.match(LOW_PRIORITY_TIP, /^Used only when it would otherwise go to waste/)
})

function fakeFetch(res) {
  const calls = []
  const f = async (url, init) => { calls.push({ url, init }); return { ok: res.ok ?? true, status: res.status ?? 200, json: async () => res.body ?? {} } }
  f.calls = calls
  return f
}
test('the toggle PATCHes { lowPriority } to the account', async () => {
  const f = fakeFetch({ body: { ok: true } })
  await patchAccount(f, 'a/b', { lowPriority: true })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, '/api/accounts/a%2Fb')
  assert.equal(f.calls[0].init.method, 'PATCH')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { lowPriority: true })
  await patchAccount(f, 'A', { lowPriority: false })
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { lowPriority: false })
})
test('a refused PATCH throws the server message', async () => {
  const f = fakeFetch({ ok: false, status: 400, body: { error: 'nope' } })
  await assert.rejects(patchAccount(f, 'A', { lowPriority: true }), /nope/)
})
