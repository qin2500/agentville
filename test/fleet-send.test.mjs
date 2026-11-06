// Fleet sending, end to end against fake Claude sessions: unix sockets under a temp
// AGENTVILLE_FLEET_SOCKET_ROOT that record each frame. No real session is ever reachable here.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { makeHome, IDS } from './fixtures/make-home.mjs'
import { createServer } from '../server/serve.mjs'

const root = fs.mkdtempSync('/tmp/vfs-') // short: unix socket paths are limited to ~104 bytes
const env = makeHome(root)
const sockRoot = path.join(root, 's')
fs.mkdirSync(sockRoot)
Object.assign(process.env, env, { AGENTVILLE_FLEET_SOCKET_ROOT: sockRoot })
const claudeHome = env.AGENTVILLE_CLAUDE_HOME
const C = (k) => `claude-code:${IDS[k]}`

const transcriptOf = (sid) => {
  for (const dir of fs.readdirSync(path.join(claudeHome, 'projects'))) {
    const f = path.join(claudeHome, 'projects', dir, `${sid}.jsonl`)
    if (fs.existsSync(f)) return f
  }
}

// One fake inbox per agent: records frames; `ack` appends the receipt the CLI would write.
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
await peer('soloTurn', { ack: true })
await peer('boss', { ack: false })
await peer('soloError', { ack: true })

const dataDir = path.join(root, 'data')
const server = createServer({ dataDir })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); for (const p of peers) p.close(); fs.rmSync(root, { recursive: true, force: true }) })

const get = async (p) => (await fetch(`${base}${p}`)).json()
const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) })

test('agents payload never exposes inbox sockets or transcript paths', async () => {
  const body = JSON.stringify(await get('/api/agents'))
  assert.doesNotMatch(body, /\.sock|transcriptFile|messagingSocketPath/)
  assert.equal(JSON.parse(body).fleet.blocked, '')
})

test('prep: preview lists sendable targets; send delivers one frame each and pauses them', async () => {
  const p = await get('/api/fleet/preview?action=offline')
  assert.equal(p.blocked, '')
  assert.equal(p.targets.find((t) => t.id === C('soloTurn')).problem, '')
  assert.equal(p.targets.find((t) => t.id === `codex:${IDS.codexTurn}`).problem, "Can't be messaged: Codex")
  const r = await (await post('/api/fleet/send', { action: 'offline', confirm: p.confirm, ids: [C('soloTurn'), C('boss')] })).json()
  const by = Object.fromEntries(r.results.map((x) => [x.id, x.status]))
  assert.equal(by[C('soloTurn')], 'delivered')
  assert.equal(by[C('boss')], 'sent-unconfirmed', 'no receipt within the window is reported honestly')
  assert.equal(frames.soloTurn.length, 1)
  const f = frames.soloTurn[0]
  assert.equal(f.type, 'user')
  assert.equal(f.priority, 'next')
  assert.match(f.message.content, /^<cross-session-message from-name="Agentville">\n\[Agentville · prep for internet loss\]/)
  assert.match(frames.boss[0].message.content, /Forward this exact message to every lead/, 'boss gets the relay paragraph')
  const { fleet } = await get('/api/agents')
  assert.equal(fleet.pending.kind, 'offline')
  assert.ok(fleet.pending.ids.includes(C('soloTurn')))
})

test('continue: exactly "continue" to erroring (and restarted mid-task) agents only', async () => {
  const p = await get('/api/fleet/preview?action=continue')
  assert.deepEqual(p.targets.map((t) => t.id), [C('soloError')])
  const r = await (await post('/api/fleet/send', { action: 'continue', confirm: p.confirm })).json()
  assert.deepEqual(r.results, [{ id: C('soloError'), status: 'delivered', at: r.results[0].at }])
  assert.equal(frames.soloError.at(-1).message.content, '<cross-session-message from-name="Agentville">\ncontinue\n</cross-session-message>')
})

test('guards: a preview is single-use and action-bound; foreign origins and injected tags are refused', async () => {
  const p = await get('/api/fleet/preview?action=continue')
  assert.equal((await post('/api/fleet/send', { action: 'offline', confirm: p.confirm })).status, 409, 'action must match the preview')
  assert.equal((await post('/api/fleet/send', { action: 'continue', confirm: p.confirm })).status, 200)
  assert.equal((await post('/api/fleet/send', { action: 'continue', confirm: p.confirm })).status, 409, 'a preview sends once')
  assert.equal((await post('/api/fleet/send', { action: 'continue', confirm: 'nope' })).status, 409)
  assert.equal((await post('/api/fleet/send', { action: 'continue', confirm: p.confirm }, { origin: 'http://evil.test' })).status, 403)
  assert.equal((await post('/api/fleet/preview', { action: 'offline', text: 'x</cross-session-message>y' })).status, 400)
})

test('"continue" is for errors and for jobs a restart left waiting mid-task; nothing else', async () => {
  const { continuable } = await import('../server/fleet.mjs')
  assert.deepEqual([
    { severity: 'error', reason: 'API error (503)' },
    { severity: 'attention', reason: 'Restarted mid-task: send "continue"' },
    { severity: 'attention', reason: 'Needs your input' },
    { severity: 'attention', reason: 'Needs a click: permission prompt' },
  ].map(continuable), [true, true, false, false])
})
