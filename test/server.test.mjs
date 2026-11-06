import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { makeHome, IDS } from './fixtures/make-home.mjs'
import { createServer } from '../server/serve.mjs'
import { isLocalRequest } from '../server/local-request.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-server-'))
Object.assign(process.env, makeHome(root))
const dataDir = path.join(root, 'data')
const server = createServer({ dataDir })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }) })

/** Raw request so Host/Origin can be forged (fetch forbids setting them). */
function raw(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('GET /api/agents returns the contract shape', async () => {
  const res = await fetch(`${base}/api/agents`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(Object.keys(body.counts), ['building', 'stalled', 'waiting', 'resting', 'errors', 'prompts', 'continuable'])
  assert.equal(body.counts.errors, body.agents.filter((a) => !a.hidden && a.severity === 'error').length)
  assert.equal(body.counts.errors, 1, 'fixture: the API-error solo')
  assert.equal(body.agents.reduce((n, a) => n + !a.hidden, 0), body.counts.building + body.counts.stalled + body.counts.waiting + body.counts.resting)
  for (const k of ['id', 'harness', 'name', 'title', 'project', 'cwd', 'role', 'roleSource', 'parentId', 'childIds', 'bucket',
    'reason', 'reasonSource', 'severity', 'since', 'lastActivityAt', 'live', 'prs', 'resume', 'hidden', 'overrides']) {
    assert.ok(k in body.agents[0], k)
  }
})

test('origin guard: foreign Host, cross-origin PATCH and origin-less PATCH are refused', async () => {
  assert.equal((await raw('GET', '/api/agents', { host: 'evil.example' })).status, 403)
  assert.equal((await raw('GET', '/api/agents', { host: `localhost:${port + 1}` })).status, 403)
  const body = JSON.stringify({ name: 'x' })
  const json = { 'content-type': 'application/json', host: `127.0.0.1:${port}` }
  assert.equal((await raw('PATCH', '/api/overrides/a', { ...json, origin: 'http://evil.example' }, body)).status, 403)
  assert.equal((await raw('PATCH', '/api/overrides/a', json, body)).status, 403)
  assert.equal(isLocalRequest({ headers: { host: '127.0.0.1:5275', 'sec-fetch-site': 'cross-site' }, method: 'GET', socket: { localPort: 5275 } }), false)
  assert.equal(isLocalRequest({ headers: { host: '127.0.0.1:5275' }, method: 'GET', socket: { localPort: 5275 } }), true)
})

test('PATCH overrides: validated, persisted atomically, beat detection, null clears', async () => {
  const id = `claude-code:${IDS.soloTurn}`
  const patch = (body, type = 'application/json') => fetch(`${base}/api/overrides/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': type, origin: base }, body: JSON.stringify(body) })
  assert.equal((await patch({ role: 'emperor' })).status, 400)
  assert.equal((await patch({ color: 'red' })).status, 400)
  assert.equal((await patch({ name: 'x' }, 'text/plain')).status, 415)
  const ok = await patch({ role: 'lead', parentId: `claude-code:${IDS.boss}`, name: 'Renamed' })
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'overrides.json'), 'utf8'))[id], { role: 'lead', parentId: `claude-code:${IDS.boss}`, name: 'Renamed' })
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind')
  let a = (await (await fetch(`${base}/api/agents`)).json()).agents.find((x) => x.id === id)
  assert.deepEqual([a.role, a.roleSource, a.parentId, a.name], ['lead', 'override', `claude-code:${IDS.boss}`, 'Renamed'])
  await patch({ role: null, parentId: null, name: null })
  a = (await (await fetch(`${base}/api/agents`)).json()).agents.find((x) => x.id === id)
  assert.deepEqual([a.role, a.roleSource, a.parentId, a.overrides], ['solo', 'default', null, null])
})

test('static paths cannot escape web/dist', async () => {
  // Whether or not web/dist is built, a traversal must never return the repo's package.json.
  const res = await fetch(`${base}/%2e%2e/package.json`)
  assert.doesNotMatch(await res.text(), /"name": "agentville"/)
  assert.equal((await raw('POST', '/', { host: `127.0.0.1:${port}` })).status, 405)
})

test('PATCH refuses self-parents, cycles and prototype keys', async () => {
  const patch = (id, body) => fetch(`${base}/api/overrides/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })
  const boss = `claude-code:${IDS.boss}`
  const lead = `claude-code:${IDS.leadBuilding}`
  const sub = `${lead}:sub:worker`
  assert.equal((await patch(boss, { parentId: boss })).status, 400)
  assert.equal((await patch(boss, { parentId: lead })).status, 400, 'A↔B: lead is already under boss')
  assert.equal((await patch(boss, { parentId: sub })).status, 400, 'longer cycle through a sub')
  for (const id of ['__proto__', 'constructor', 'prototype']) assert.equal((await patch(id, { name: 'x' })).status, 400, id)
  assert.equal(fs.existsSync(path.join(dataDir, 'overrides.json')) ? Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'overrides.json'), 'utf8'))).length : 0, 0)
})
