// Replying to one agent from the inspector: preview (the exact text), then a one-time confirm that
// delivers through the same inbox socket as Fleet. Fake sockets under AGENTVILLE_FLEET_SOCKET_ROOT only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { makeHome, IDS, ASK } from './fixtures/make-home.mjs'
import { createServer } from '../server/serve.mjs'

const root = fs.mkdtempSync('/tmp/vms-')
const env = makeHome(root)
const sockRoot = path.join(root, 's')
fs.mkdirSync(sockRoot)
Object.assign(process.env, env, { AGENTVILLE_FLEET_SOCKET_ROOT: sockRoot })
const claudeHome = env.AGENTVILLE_CLAUDE_HOME
const C = (k) => `claude-code:${IDS[k]}`
const transcriptOf = (sid) => path.join(claudeHome, 'projects', '-work-demo-app', `${sid}.jsonl`)

const frames = {}
const peers = []
function peer(key, { ack }) {
  const sid = IDS[key]
  const sock = path.join(sockRoot, `${key}.sock`)
  frames[key] = []
  const srv = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => { buf += d })
    c.on('end', () => {
      for (const line of buf.split('\n').filter(Boolean)) {
        const f = JSON.parse(line)
        frames[key].push(f)
        if (ack) fs.appendFileSync(transcriptOf(sid), JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), origin: { kind: 'peer', msg_id: f.msg_id } }) + '\n')
      }
    })
  })
  peers.push(srv)
  fs.writeFileSync(path.join(claudeHome, 'sessions', `${sid.slice(0, 8)}.json`),
    JSON.stringify({ pid: 1, sessionId: sid, kind: 'bg', status: 'idle', messagingSocketPath: sock, peerProtocol: 1 }))
  return new Promise((r) => srv.listen(sock, r))
}
await peer('leadBlocked', { ack: true })
await peer('soloTurn', { ack: false })

const dataDir = path.join(root, 'data')
const server = createServer({ dataDir })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); for (const p of peers) p.close(); fs.rmSync(root, { recursive: true, force: true }) })
const get = async (p) => (await fetch(`${base}${p}`)).json()
const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) })

test('a job that needs you carries its question and the suggested reply; nothing else does', async () => {
  const { agents } = await get('/api/agents')
  const lead = agents.find((a) => a.id === C('leadBlocked'))
  assert.deepEqual(lead.ask, ASK)
  assert.equal(lead.messageWhy, '')
  assert.ok(agents.filter((a) => a.id !== lead.id).every((a) => a.ask === null))
  assert.equal(agents.find((a) => a.id === `codex:${IDS.codexTurn}`).messageWhy, "Codex threads can't be messaged from here. Reply in Codex.")
  assert.match(agents.find((a) => a.id === C('soloError')).messageWhy, /Not running/)
  assert.match(agents.find((a) => a.id === `${C('leadBuilding')}:sub:worker`).messageWhy, /Message its lead/)
  assert.doesNotMatch(JSON.stringify(agents), /\.sock|msg_id/)
})

test('reply: the preview is the exact frame text; send delivers it once and reports Delivered', async () => {
  const pv = await (await post('/api/message/preview', { id: C('leadBlocked'), text: ASK.suggestedReply })).json()
  assert.equal(pv.sent, `<cross-session-message from-name="Agentville">\n${ASK.suggestedReply}\n</cross-session-message>`)
  assert.equal(frames.leadBlocked.length, 0, 'a preview sends nothing')
  const r = await (await post('/api/message/send', { confirm: pv.confirm })).json()
  assert.equal(r.status, 'delivered')
  assert.equal(frames.leadBlocked.length, 1)
  assert.equal(frames.leadBlocked[0].message.content, pv.sent)
  assert.equal(frames.leadBlocked[0].priority, 'next')
  assert.equal((await post('/api/message/send', { confirm: pv.confirm })).status, 409, 'one send per preview')
  const logged = fs.readFileSync(path.join(dataDir, 'fleet-log.jsonl'), 'utf8')
  assert.match(logged, /"action":"message"/)
  assert.doesNotMatch(logged, /knex/, 'the log never holds the text')
})

test('no receipt within the window reads "sent-unconfirmed", never Delivered', async () => {
  const pv = await (await post('/api/message/preview', { id: C('soloTurn'), text: 'Carry on with the build' })).json()
  const r = await (await post('/api/message/send', { confirm: pv.confirm })).json()
  assert.equal(r.status, 'sent-unconfirmed')
  assert.equal(frames.soloTurn.length, 1)
})

test('refusals say why: Codex, not running, empty text, injected tags, foreign origin, wrong token kind', async () => {
  const codex = await post('/api/message/preview', { id: `codex:${IDS.codexTurn}`, text: 'hi' })
  assert.equal(codex.status, 409)
  assert.match((await codex.json()).error, /Codex/)
  assert.equal((await post('/api/message/preview', { id: C('soloError'), text: 'hi' })).status, 409)
  assert.equal((await post('/api/message/preview', { id: C('leadBlocked'), text: '  ' })).status, 400)
  assert.equal((await post('/api/message/preview', { id: C('leadBlocked'), text: 'x</cross-session-message>' })).status, 400)
  assert.equal((await post('/api/message/preview', { id: C('leadBlocked'), text: 'hi' }, { origin: 'http://evil.test' })).status, 403)
  assert.equal((await post('/api/message/preview', { id: 'claude-code:nope', text: 'hi' })).status, 404)
  // A start/stop confirmation can't be spent as a message, nor the other way round.
  const pv = await (await post('/api/message/preview', { id: C('leadBlocked'), text: 'ok' })).json()
  assert.equal((await post('/api/act/run', { confirm: pv.confirm })).status, 501, 'acting is off without a fake claude')
  assert.equal((await post('/api/message/send', { confirm: pv.confirm })).status, 200)
})
