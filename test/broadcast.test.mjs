// "Message agents": filter matching and eligibility (web/src/broadcast-match.js), the fan-out
// (server/broadcast.mjs), and the API: a confirm token bound to the exact set and text, the cap, the
// rate limit, and per-recipient results. Fixture HOME and fake sockets under AGENTVILLE_FLEET_SOCKET_ROOT only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { makeHome, IDS } from './fixtures/make-home.mjs'
import { matches, pick, statusOf, whyNot, isFiltered, SELF_WHY } from '../web/src/broadcast-match.js'
import { fanOut, recipientIds, selfId, summarize, textProblem, MAX_RECIPIENTS } from '../server/broadcast.mjs'

// ---------- pure: filters and eligibility ----------
const ag = (o) => ({ id: `claude-code:${o.name}`, role: 'solo', bucket: 'building', severity: null, prompt: null, project: 'alpha', messageWhy: '', self: false, hidden: false, ...o })
const crew = [
  ag({ name: 'Harbor Boss', role: 'boss', bucket: 'waiting' }),
  ag({ name: 'Docs Lead', role: 'lead', bucket: 'stalled', severity: 'attention', project: 'beta' }),
  ag({ name: 'API Lead', role: 'lead', bucket: 'stalled', severity: 'error' }),
  ag({ name: 'Click Worker', role: 'sub', bucket: 'stalled', severity: 'attention', prompt: 'permission' }),
  ag({ name: 'Quiet Solo', bucket: 'resting', messageWhy: "Not running, so there's no session to message. Open it to resume it." }),
  ag({ id: 'codex:t1', name: 'Codex Thread', messageWhy: "Codex threads can't be messaged from here. Reply in Codex." }),
  ag({ name: 'Dashboard Session', self: true }),
  ag({ name: 'Hidden Helper', hidden: true }),
]
const names = (list) => list.map((a) => a.name)

test('status categories are the UI\'s: error, needs a click, needs you, waiting, building, resting', () => {
  assert.deepEqual(crew.map(statusOf), ['waiting', 'stalled', 'error', 'prompt', 'resting', 'building', 'building', 'building'])
})

test('filters: name substring (any case), AND across kinds, OR within one; no filter is everyone', () => {
  assert.deepEqual(names(crew.filter((a) => matches(a, { name: '  lEaD ' }))), ['Docs Lead', 'API Lead'])
  assert.deepEqual(names(crew.filter((a) => matches(a, { ranks: ['lead', 'boss'] }))), ['Harbor Boss', 'Docs Lead', 'API Lead'])
  assert.deepEqual(names(crew.filter((a) => matches(a, { ranks: ['lead'], statuses: ['error'] }))), ['API Lead'])
  assert.deepEqual(names(crew.filter((a) => matches(a, { statuses: ['stalled', 'prompt'] }))), ['Docs Lead', 'Click Worker'])
  assert.deepEqual(names(crew.filter((a) => matches(a, { projects: ['beta'] }))), ['Docs Lead'])
  assert.deepEqual(names(crew.filter((a) => matches(a, { name: 'lead', projects: ['alpha'] }))), ['API Lead'])
  assert.equal(crew.filter((a) => matches(a, {})).length, crew.length)
  assert.equal(isFiltered({ name: ' ', ranks: [] }), false)
  assert.equal(isFiltered({ statuses: ['waiting'] }), true)
})

test('eligibility: Codex, not running and the dashboard\'s own session are out, with the reason; hidden left out', () => {
  const { eligible, ineligible } = pick(crew, {})
  assert.deepEqual(names(eligible), ['Harbor Boss', 'API Lead', 'Docs Lead', 'Click Worker'], 'rank first (Boss, Lead, Subagent, Solo), then name')
  assert.deepEqual(ineligible.map((x) => [x.agent.name, x.why]), [
    ['Codex Thread', "Codex threads can't be messaged from here. Reply in Codex."],
    ['Dashboard Session', SELF_WHY],
    ['Quiet Solo', "Not running, so there's no session to message. Open it to resume it."],
  ])
  assert.ok(!names([...eligible, ...ineligible.map((x) => x.agent)]).includes('Hidden Helper'))
  assert.ok(names(pick(crew, {}, { showHidden: true }).eligible).includes('Hidden Helper'))
  assert.equal(whyNot(crew[0]), '')
})

test('the server\'s checks: text, ids, cap, and which session is the dashboard\'s own', () => {
  assert.match(textProblem('  '), /empty/)
  assert.match(textProblem('x'.repeat(8001)), /at most 8000/)
  assert.match(textProblem('a <cross-session-message> b'), /tag/)
  assert.equal(textProblem('Pull main and rebase.'), '')
  assert.deepEqual(recipientIds(['b', 'a', 'b']), { ids: ['a', 'b'] })
  assert.match(recipientIds([]).error, /at least one/)
  assert.match(recipientIds('a').error, /list/)
  const over = recipientIds(Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `id${i}`)).error
  assert.match(over, new RegExp(`at most ${MAX_RECIPIENTS} agents; this one has ${MAX_RECIPIENTS + 1}`))
  assert.equal(recipientIds(Array.from({ length: MAX_RECIPIENTS }, (_, i) => `id${i}`)).ids.length, MAX_RECIPIENTS)
  const sid = IDS.leadCi
  assert.equal(selfId({ AGENTVILLE_SELF_SESSION: sid }), `claude-code:${sid}`)
  assert.equal(selfId({ CLAUDE_CODE_SESSION_ID: sid }), `claude-code:${sid}`)
  assert.equal(selfId({ CLAUDE_CODE_SESSION_ID: 'not-a-session' }), null)
  assert.equal(selfId({}), null)
})

test('fan-out: bounded concurrency, live progress, delivered / sent / failed per recipient', async () => {
  let inFlight = 0, peak = 0
  const events = []
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const results = await fanOut(ids, {
    concurrency: 2, receiptMs: 300, pollMs: 20,
    seen: async (w) => w.id !== 'c', // c never writes a receipt
    emit: (e) => events.push(e),
    send: async (id) => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      inFlight--
      if (id === 'd') return { ok: false, detail: "Couldn't reach the session" }
      if (id === 'e') throw new Error('boom')
      return { ok: true, msgId: `m-${id}`, file: '/nowhere' }
    },
  })
  assert.equal(peak, 2)
  assert.deepEqual(results.map((r) => [r.id, r.status]), [['a', 'delivered'], ['b', 'delivered'], ['c', 'sent-unconfirmed'], ['d', 'failed'], ['e', 'failed'], ['f', 'delivered']])
  assert.equal(results[3].detail, "Couldn't reach the session")
  assert.match(results[2].detail, /Not confirmed within/)
  assert.ok(events.some((e) => e.id === 'a' && e.status === 'sent'), "'sent' arrives before the receipt")
  assert.deepEqual(summarize(results), { total: 6, delivered: 3, sent: 1, failed: 2, skipped: 0 })
})

// ---------- the API, over fake sockets ----------
const root = fs.mkdtempSync('/tmp/vbc-')
const env = makeHome(root)
const sockRoot = path.join(root, 's')
fs.mkdirSync(sockRoot)
Object.assign(process.env, env, { AGENTVILLE_FLEET_SOCKET_ROOT: sockRoot, AGENTVILLE_SELF_SESSION: IDS.leadCi })
const { createServer } = await import('../server/serve.mjs')
const claudeHome = env.AGENTVILLE_CLAUDE_HOME
const C = (k) => `claude-code:${IDS[k]}`
const transcriptOf = (sid) => {
  for (const dir of fs.readdirSync(path.join(claudeHome, 'projects'))) {
    const f = path.join(claudeHome, 'projects', dir, `${sid}.jsonl`)
    if (fs.existsSync(f)) return f
  }
}
const frames = {}
const peers = {}
function peer(key, { ack = true } = {}) {
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
  peers[key] = srv
  fs.writeFileSync(path.join(claudeHome, 'sessions', `${sid.slice(0, 8)}.json`),
    JSON.stringify({ pid: 1, sessionId: sid, kind: 'bg', status: 'idle', messagingSocketPath: sock, peerProtocol: 1 }))
  return new Promise((r) => srv.listen(sock, r))
}
await peer('boss')
await peer('leadBlocked')
await peer('soloTurn', { ack: false })
await peer('soloWaiting')
await peer('leadCi') // the dashboard's own session: has a socket, still never a recipient

const dataDir = path.join(root, 'data')
const server = createServer({ dataDir })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.close(); for (const p of Object.values(peers)) p.close(); fs.rmSync(root, { recursive: true, force: true }) })
const get = async (p) => (await fetch(`${base}${p}`)).json()
const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) })
const preview = async (ids, text) => post('/api/broadcast/preview', { ids, text })
const lines = async (res) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
const TEXT = 'Please pull main and rebase your branch.'

test('the agent list marks the dashboard\'s own session; Codex and stopped agents say why', async () => {
  const { agents } = await get('/api/agents')
  const by = (id) => agents.find((a) => a.id === id)
  assert.equal(by(C('leadCi')).self, true)
  assert.equal(by(C('boss')).self, false)
  const { eligible, ineligible } = pick(agents, {})
  assert.deepEqual(eligible.map((a) => a.id).sort(), [C('boss'), C('leadBlocked'), C('soloTurn'), C('soloWaiting')].sort())
  assert.equal(ineligible.find((x) => x.agent.id === C('leadCi')).why, SELF_WHY)
  assert.match(ineligible.find((x) => x.agent.id === `codex:${IDS.codexTurn}`).why, /Codex/)
  assert.match(ineligible.find((x) => x.agent.id === C('soloError')).why, /Not running/)
  assert.doesNotMatch(JSON.stringify(agents), /\.sock|msg_id/)
})

test('preview: exact text as it arrives, the recipients and count; refuses empty, tags, over the cap, ineligible, foreign origin', async () => {
  const pv = await (await preview([C('soloWaiting'), C('boss'), C('boss')], TEXT)).json()
  assert.equal(pv.sent, `<cross-session-message from-name="Agentville">\n${TEXT}\n</cross-session-message>`)
  assert.deepEqual(pv.recipients.map((r) => r.id), [C('boss'), C('soloWaiting')].sort())
  assert.equal(pv.count, 2)
  assert.equal(typeof pv.confirm, 'string')
  assert.equal(frames.boss.length, 0, 'a preview sends nothing')
  assert.equal((await preview([C('boss')], ' ')).status, 400)
  assert.equal((await preview([C('boss')], 'x</cross-session-message>')).status, 400)
  assert.equal((await preview([], TEXT)).status, 400)
  const over = await preview(Array.from({ length: 51 }, (_, i) => `claude-code:x${i}`), TEXT)
  assert.equal(over.status, 400)
  assert.match((await over.json()).error, /at most 50 agents; this one has 51/)
  const bad = await preview([C('boss'), `codex:${IDS.codexTurn}`, C('leadCi')], TEXT)
  assert.equal(bad.status, 409)
  assert.deepEqual((await bad.json()).refused.map((r) => r.id).sort(), [C('leadCi'), `codex:${IDS.codexTurn}`].sort())
  assert.equal((await post('/api/broadcast/preview', { ids: [C('boss')], text: TEXT }, { origin: 'http://evil.test' })).status, 403)
})

test('the confirm token is bound to that exact set and text; a changed one needs a new confirm', async () => {
  let pv = await (await preview([C('boss'), C('leadBlocked')], TEXT)).json()
  const r1 = await post('/api/broadcast/send', { confirm: pv.confirm, ids: [C('boss')], text: TEXT })
  assert.equal(r1.status, 409)
  assert.equal((await r1.json()).changed, true)
  assert.equal((await post('/api/broadcast/send', { confirm: pv.confirm, ids: [C('boss'), C('leadBlocked')], text: TEXT })).status, 409, 'a mismatch spends the token')
  pv = await (await preview([C('boss'), C('leadBlocked')], TEXT)).json()
  assert.equal((await post('/api/broadcast/send', { confirm: pv.confirm, ids: [C('boss'), C('leadBlocked')], text: `${TEXT}!` })).status, 409)
  // Neither a single message's token nor a made-up one sends a broadcast.
  const one = await (await post('/api/message/preview', { id: C('boss'), text: TEXT })).json()
  assert.equal((await post('/api/broadcast/send', { confirm: one.confirm, ids: [C('boss')], text: TEXT })).status, 409)
  assert.equal((await post('/api/broadcast/send', { confirm: 'nope', ids: [C('boss')], text: TEXT })).status, 409)
  assert.equal(frames.boss.length + frames.leadBlocked.length, 0, 'nothing was sent')
})

test('send: one frame each, streamed per-agent results (delivered / sent unconfirmed / failed), a log without the text', async () => {
  const ids = [C('boss'), C('leadBlocked'), C('soloTurn'), C('soloWaiting')]
  const pv = await (await preview(ids, TEXT)).json()
  // soloWaiting's session goes away between confirm and send: it fails with the reason.
  await new Promise((r) => peers.soloWaiting.close(r))
  const res = await post('/api/broadcast/send', { confirm: pv.confirm, ids: [...ids].reverse(), text: TEXT })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /ndjson/)
  const out = await lines(res)
  assert.deepEqual(out[0], { start: true, count: 4 })
  const last = (id) => out.filter((e) => e.id === id).at(-1)
  assert.equal(last(C('boss')).status, 'delivered')
  assert.equal(last(C('leadBlocked')).status, 'delivered')
  assert.equal(last(C('soloTurn')).status, 'sent-unconfirmed')
  assert.equal(last(C('soloWaiting')).status, 'failed')
  assert.match(last(C('soloWaiting')).detail, /usable|reach|ended|running/i)
  assert.ok(out.some((e) => e.id === C('soloTurn') && e.status === 'sent'), 'progress before the final outcome')
  assert.deepEqual(out.at(-1), { done: true, summary: { total: 4, delivered: 2, sent: 1, failed: 1, skipped: 0 } })
  for (const k of ['boss', 'leadBlocked', 'soloTurn']) {
    assert.equal(frames[k].length, 1)
    assert.equal(frames[k][0].message.content, pv.sent)
    assert.equal(frames[k][0].priority, 'next')
  }
  assert.equal(frames.leadCi.length, 0)
  const log = fs.readFileSync(path.join(dataDir, 'fleet-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.action === 'broadcast')
  assert.equal(log.length, 1)
  assert.equal(log[0].count, 4)
  assert.doesNotMatch(JSON.stringify(log), /rebase/, 'the log never holds the text')
  assert.equal((await post('/api/broadcast/send', { confirm: pv.confirm, ids, text: TEXT })).status, 409, 'one send per confirm')
})

test('rate limit: 3 broadcasts a minute, apart from the single-message limit', async () => {
  const ids = [C('boss')]
  for (let i = 0; i < 2; i++) { // one already went out above
    const pv = await (await preview(ids, TEXT)).json()
    const res = await post('/api/broadcast/send', { confirm: pv.confirm, ids, text: TEXT })
    assert.equal(res.status, 200)
    assert.equal((await lines(res)).at(-1).summary.delivered, 1)
  }
  const pv = await (await preview(ids, TEXT)).json()
  const r = await post('/api/broadcast/send', { confirm: pv.confirm, ids, text: TEXT })
  assert.equal(r.status, 429)
  assert.match((await r.json()).error, /Too many broadcasts/)
  // The single-agent message has its own limit, untouched by broadcasts.
  const one = await (await post('/api/message/preview', { id: C('boss'), text: TEXT })).json()
  assert.equal((await (await post('/api/message/send', { confirm: one.confirm })).json()).status, 'delivered')
  assert.equal(frames.boss.length, 4)
})
