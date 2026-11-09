/**
 * Agentville: static web/dist + a read-only agents API on 127.0.0.1 only.
 * Env: AGENTVILLE_PORT (5275), AGENTVILLE_DATA_DIR, AGENTVILLE_CLAUDE_HOME, AGENTVILLE_CODEX_HOME.
 */
import { logSafely } from './fsutil.mjs'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { isLocalRequest } from './local-request.mjs'
import { defaultDataDir } from './datadir.mjs'
import { build } from './classify.mjs'
import { createStore } from './overrides.mjs'
import { ACTIONS, createFleetStore, currentPending, preview, continuable } from './fleet.mjs'
import { awaitReceipts, deliver, dryRun, inboxProblem, sendingBlocked, wrap } from './inbox.mjs'
import { actionsBlocked, display, forkPlan, knownProjects, MODELS, EFFORTS, MODES, PROMPT_MAX, NAME_MAX, run as runPlan, startPlan, stopPlan } from './actions.mjs'
import { createChanges } from './changes.mjs'
import { createPrStatus } from './prstatus.mjs'
import crypto from 'node:crypto'
import { createProjectStore } from './projects.mjs'
import { createAccount } from './account.mjs'
import { createRestore, restoreBlocked, MESSAGE as RESTORE_MESSAGE } from './restore.mjs'
import { accountsBlocked } from './accounts.mjs'
import { createSpend } from './spend.mjs'
import { buildModels, readDefaults } from './models.mjs'
import { createSampler } from './autoswitch.mjs'
import { createResearch } from './research.mjs'
import { createNetwork } from './network.mjs'
import { detectTerminal, findExecutable, openInTerminal } from './terminal.mjs'
import { createTerminals } from './pty.mjs'
import { canRestartSelf, createUpdater, restartSelf } from './update.mjs'
import * as claude from './claude-code.mjs'
import * as codex from './codex.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'web', 'dist')
const SCAN_TTL_MS = 2000
const HOME = os.homedir()
// Never inside an app bundle; a shell function or alias is invisible here by construction.
const CLAUDE_DIRS = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), path.join(HOME, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
const CODEX_DIRS = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
export const NEVER_STARTED = "This launch failed before it started, so there's no session to open"
const refuse = (status, message) => Object.assign(new Error(message), { status })

/** The argv and cwd to open an agent with, decided only from our own data. Throws a 4xx otherwise. */
export async function openCommand(a) {
  if (!a) throw refuse(404, 'No such agent')
  if (['subagent', 'teammate', 'thread'].includes(a.kind)) throw refuse(409, 'Open its lead instead')
  if (a.neverStarted) throw refuse(409, NEVER_STARTED)
  const cwd = a.cwd && path.isAbsolute(a.cwd) && fs.statSync(a.cwd, { throwIfNoEntry: false })?.isDirectory() ? a.cwd : null
  if (!cwd) throw refuse(409, "Its folder no longer exists")
  if (a.harness === 'codex') {
    const codexBin = await findExecutable('codex', CODEX_DIRS)
    if (!codexBin) throw refuse(409, 'Codex CLI not found')
    return { argv: [codexBin, 'resume', a.id.slice('codex:'.length)], cwd }
  }
  const claudeBin = await findExecutable('claude', CLAUDE_DIRS)
  if (!claudeBin) throw refuse(409, 'Claude Code CLI not found')
  if (a.kind === 'job' && /^[0-9a-f]{8}$/.test(a.jobId || '')) return { argv: [claudeBin, 'attach', a.jobId], cwd }
  // Resuming a session that is already open elsewhere makes a second process on one conversation.
  if (a.live) throw refuse(409, 'Already running in another terminal')
  const sid = a.id.slice('claude-code:'.length)
  if (!/^[0-9a-f-]{36}$/i.test(sid)) throw refuse(409, 'Not a resumable session')
  return { argv: [claudeBin, '--resume', sid], cwd }
}

export { defaultDataDir }

export function createServer({ dataDir = defaultDataDir(), termIdleMs, termEndWaitMs, update = {} } = {}) {
  const store = createStore(dataDir)
  // The built-in terminal (server/pty.mjs): one PTY per agent, the command always from openCommand.
  const terms = createTerminals({ idleMs: termIdleMs, endWaitMs: termEndWaitMs })
  const termActs = []
  const fleetStore = createFleetStore(dataDir)
  // Server-private, never in the API: each live Claude agent's inbox and transcript file.
  let inboxes = new Map()
  let transcriptOf = new Map()
  // Server-private: per agent, its transcript and model settings for /api/models (never sent as is).
  let modelInfo = new Map()
  const plans = new Map() // confirm token -> the previewed plan, valid 2 min, usable once
  const sends = []
  // One agent at a time: a message (inspector reply / compose) or a start, stop or fork. Each is a
  // previewed plan behind a one-time confirm token, like Fleet's.
  const oneOffs = new Map() // confirm token -> { kind, ..., expires }
  const messages = [] // message sends in the last minute
  const runs = [] // starts, stops and forks in the last minute
  let forks = new Map() // server-private: id -> { sid, cwd } a fork would copy
  let titles = [] // server-private: conversation names for search (never prompt text)
  const changes = createChanges()
  const prStatus = createPrStatus(claude.home)
  const projectStore = createProjectStore(dataDir)
  // Usage research log: tokens by model next to every usage reading (see research.mjs).
  const research = createResearch({ dataDir })
  const network = createNetwork({ dataDir })
  // Restore after crash (restore.mjs): the running-set snapshot and the lost crown/Important jobs.
  const restore = createRestore({ dataDir, claudeHome: claude.home })
  const account = createAccount({ dataDir, claudeHome: claude.home, onReading: research.usage, network })
  // Token spend is read when the page asks (every few seconds while it is open) and with each usage sample.
  const spend = createSpend({ dataDir, claudeHome: claude.home, codexHome: codex.home, research })
  const sampler = createSampler({ dataDir, account, network, agents: async () => (await snapshot()).agents })
  // Update check against GitHub's main (update.mjs); restarting needs `server`, so it's looked up late.
  const updater = createUpdater({ restart: canRestartSelf() ? () => restartSelf(server) : null, ...update })
  const startedAt = Date.now()
  const opens = []
  const since = new Map() // id -> { bucket, since }: when it entered its current bucket
  let cached = null
  let inflight = null

  async function scanAll() {
    const now = Date.now()
    const warnings = []
    const sources = { claude: fs.existsSync(claude.home()), codex: fs.existsSync(codex.home()) }
    const results = await Promise.allSettled([sources.claude ? claude.scan(now) : [], sources.codex ? codex.scan(now) : []])
    const facts = []
    let unreadable = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { facts.push(...r.value); unreadable += r.value.unreadable || 0 }
      else warnings.push(`${i ? 'Codex' : 'Claude Code'} scan failed: ${r.reason?.message || r.reason}`)
    })
    if (unreadable) warnings.push(`${unreadable} session file${unreadable === 1 ? '' : 's'} couldn't be read (check file permissions).`)
    if (!sources.claude && !sources.codex) warnings.push(`No agent data found. Looked for Claude Code in ${claude.home()} and Codex in ${codex.home()}.`)
    const fleetData = await fleetStore.load()
    const pending = currentPending(fleetData, now)
    const overrides = await store.load()
    const agents = build(facts, overrides, now, pending)
    const counts = { building: 0, stalled: 0, waiting: 0, resting: 0, errors: 0, prompts: 0, continuable: 0 }
    for (const a of agents) {
      const prev = since.get(a.id)
      if (prev?.bucket === a.bucket) a.since = prev.since
      else if (prev) a.since = now
      since.set(a.id, { bucket: a.bucket, since: a.since })
      if (!a.hidden) { counts[a.bucket]++; if (a.severity === 'error') counts.errors++; if (a.prompt) counts.prompts++; if (continuable(a)) counts.continuable++ }
    }
    inboxes = new Map(facts.map((f) => [f.id, f.inbox || null]))
    transcriptOf = new Map(facts.map((f) => [f.id, f.transcriptFile || null]))
    modelInfo = new Map(facts.map((f) => [f.id, { kind: f.kind, harness: f.harness, parentId: f.parentId || null, file: f.transcriptFile || null, config: f.modelConfig || null }]))
    forks = new Map(facts.filter((f) => f.fork).map((f) => [f.id, f.fork]))
    titles = results.flatMap((r) => (r.status === 'fulfilled' && r.value.titles) || [])
    const byId = new Map(agents.map((a) => [a.id, a]))
    const dirs = new Set()
    for (const a of agents) {
      // Why it can't be messaged from the inspector ('' = it can). Fixed strings only.
      a.messageWhy = messageProblem(a)
      // Changed files in its folder: never for resting agents, and a subagent working in its lead's
      // folder leaves that to the lead.
      const parent = ['subagent', 'teammate', 'thread'].includes(a.kind) && a.parentId && byId.get(a.parentId)
      if (a.bucket !== 'resting' && !a.hidden && a.cwd && !(parent && parent.cwd === a.cwd)) {
        dirs.add(a.cwd)
        a.changes = changes.summary(a.cwd)
      } else a.changes = null
    }
    changes.prune(dirs)
    await prStatus.annotate(agents)
    // Fleet sends to live Claude sessions; `blocked` says why it can't here ('' = it can).
    const fleet = { mode: 'send', blocked: sendingBlocked(), last: fleetData.last, pending: pending && { ...pending, rebootDetected: startedAt > pending.at } }
    // Restore after crash: remember what is running now; report what an earlier boot lost.
    if (sources.claude) {
      await restore.record(agents, now).catch(logSafely)
      const liveIds = new Set(agents.filter((a) => a.live).map((a) => a.id))
      fleet.restore = await restore.summary({ important: (id) => overrides[id]?.important === true, live: (id) => liveIds.has(id), now }).catch(() => null)
    } else fleet.restore = null
    // Which terminal "Open" would use (nothing is opened here); null hides the button.
    const open = { terminal: (await detectTerminal())?.name ?? null }
    const projects = await projectStore.update(agents, now)
    return { serverTime: now, counts, agents, sources, warnings, fleet, open, projects }
  }

  function messageProblem(a) {
    if (a.harness !== 'claude-code') return "Codex threads can't be messaged from here. Reply in Codex."
    if (['subagent', 'teammate', 'thread'].includes(a.kind)) return "Subagents can't be messaged. Message its lead instead."
    if (!a.live) return "Not running, so there's no session to message. Open it to resume it."
    return inboxProblem(inboxes.get(a.id))
  }
  const logFleet = async (entry) => {
    await fsp.mkdir(dataDir, { recursive: true }).catch(() => {})
    await fsp.appendFile(path.join(dataDir, 'fleet-log.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 }).catch(() => {})
  }
  /** ponytail: one global window per kind, single local user. Throws a 429 past `max` a minute. */
  const limit = (list, max, what) => {
    const now = Date.now()
    while (list.length && now - list[0] > 60_000) list.shift()
    if (list.length >= max) throw Object.assign(new Error(`Too many ${what}; wait a minute`), { status: 429 })
    list.push(now)
  }
  const token = (plan) => {
    for (const [k, v] of oneOffs) if (Date.now() > v.expires) oneOffs.delete(k)
    const confirm = crypto.randomUUID()
    oneOffs.set(confirm, { ...plan, expires: Date.now() + 120_000 })
    return confirm
  }
  /** The plan behind a confirm token, once. 409 when it expired, was used, or is another kind. */
  const redeem = (confirm, kinds) => {
    const plan = typeof confirm === 'string' && oneOffs.get(confirm)
    if (!plan || Date.now() > plan.expires || !kinds.includes(plan.kind)) throw Object.assign(new Error('This confirmation has expired. Check it again.'), { status: 409 })
    oneOffs.delete(confirm)
    return plan
  }

  // Polls every few seconds must be cheap: share one scan per SCAN_TTL_MS, never run two at once.
  async function snapshot() {
    if (cached && Date.now() - cached.serverTime < SCAN_TTL_MS) return cached
    inflight ??= scanAll().then((s) => (cached = s)).finally(() => { inflight = null })
    return inflight
  }

  /** Walk up from the proposed parent through the current tree; reaching `id` means a cycle. */
  async function refuseCycle(id, parentId) {
    const parentOf = new Map((await snapshot()).agents.map((a) => [a.id, a.parentId]))
    for (let p = parentId, hops = 0; p && hops < 1000; p = parentOf.get(p), hops++) {
      if (p === id) throw Object.assign(new Error('That parent would create a cycle'), { status: 400 })
    }
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    let size = 0
    const chunks = []
    for await (const c of req) {
      size += c.length
      if (size > 16 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 })
      chunks.push(c)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
  }

  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
  async function serveStatic(req, res, url) {
    let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)))
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return send(res, 403, { error: 'Forbidden' })
    let st = await fsp.stat(file).catch(() => null)
    if (!st?.isFile()) { file = path.join(DIST, 'index.html'); st = await fsp.stat(file).catch(() => null) } // SPA fallback
    if (!st) return send(res, 404, { error: 'web/dist not built. Run npm run build.' })
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).pipe(res)
  }

  /**
   * Built-in terminal → a terminal window, never both at once. The embedded process ends first
   * (and must actually exit), then the window opens with the same server-chosen command.
   */
  async function popout(id) {
    const running = terms.get(id)
    const { argv, cwd } = running || await openCommand((await snapshot()).agents.find((a) => a.id === id))
    const term = await detectTerminal()
    if (!term) return [501, { error: 'No supported terminal' }] // checked first: the embedded one stays
    if (running && !(await terms.end(id, 'popout'))) {
      return [504, { error: "The built-in terminal's process did not exit, so no second one was opened", closed: false }]
    }
    cached = null
    const r = await openInTerminal(term, argv, cwd)
    if (r.ok) return [200, { ok: true, terminal: term.name, closed: !!running }]
    return [502, { error: running ? `${r.error} The built-in terminal was already closed; open it again with Terminal.` : r.error, closed: !!running }]
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local')
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'Method not allowed' })
        return await serveStatic(req, res, url)
      }
      if (!isLocalRequest(req)) return send(res, 403, { error: 'Local requests only' })
      if (url.pathname === '/api/agents' && req.method === 'GET') return send(res, 200, { ...(await snapshot()), term: terms.info() })
      const tm = /^\/api\/term\/([^/]+)(\/popout)?$/.exec(url.pathname)
      if (tm && (req.method === 'POST' || (req.method === 'DELETE' && !tm[2]))) {
        if (req.method === 'POST') {
          if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
          await readBody(req) // the body carries nothing we use: the server decides the command
        }
        const id = decodeURIComponent(tm[1])
        if (req.method === 'DELETE') {
          const was = !!terms.get(id)
          const ended = await terms.end(id, 'stop')
          cached = null
          return ended ? send(res, 200, { stopped: was }) : send(res, 504, { error: "The terminal's process did not exit" })
        }
        // ponytail: one global window, single local user. Starts, re-attaches and pop-outs all count.
        const now = Date.now()
        while (termActs.length && now - termActs[0] > 60_000) termActs.shift()
        if (termActs.length >= 30) return send(res, 429, { error: 'Too many terminal requests; wait a minute' })
        termActs.push(now)
        if (tm[2]) return send(res, ...await popout(id))
        if (!terms.available()) return send(res, 501, { error: 'Built-in terminal unavailable (node-pty did not load). Run npm install.' })
        const running = terms.get(id)
        const agent = (await snapshot()).agents.find((a) => a.id === id)
        // An agent already in our PTY is re-attached; otherwise openCommand decides (and refuses).
        const { argv, cwd } = running || await openCommand(agent)
        const out = terms.open(id, { argv, cwd, kind: argv[1] === 'attach' ? 'attach' : 'resume', name: agent?.name || running?.name || id })
        cached = null
        return send(res, 200, out)
      }
      const m = /^\/api\/overrides\/(.+)$/.exec(url.pathname)
      if (m && req.method === 'PATCH') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const id = decodeURIComponent(m[1])
        const body = await readBody(req)
        if (typeof body?.parentId === 'string' && body.parentId && body.parentId !== id) await refuseCycle(id, body.parentId)
        const override = await store.patch(id, body)
        cached = null
        return send(res, 200, { id, override })
      }
      if (url.pathname === '/api/fleet/preview' && ['GET', 'POST'].includes(req.method)) {
        let action = url.searchParams.get('action')
        let text
        if (req.method === 'POST') {
          if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
          const body = await readBody(req)
          action = body?.action
          text = body?.text
          if (text !== undefined && (typeof text !== 'string' || text.length > 8000)) return send(res, 400, { error: 'text must be a string of at most 8000 characters' })
        }
        if (!ACTIONS.includes(action)) return send(res, 400, { error: 'Unknown action' })
        if (typeof text === 'string' && /cross-session-message/i.test(text)) return send(res, 400, { error: 'text may not contain a cross-session-message tag' })
        const snap = await snapshot()
        const plan = preview({ action, agents: snap.agents, store: await fleetStore.load(), dataDir, text, problemOf: (id) => inboxProblem(inboxes.get(id)) })
        const confirm = crypto.randomUUID()
        for (const [k, v] of plans) if (Date.now() > v.expires) plans.delete(k)
        plans.set(confirm, { action, targets: plan.targets.filter((t) => !t.problem).map((t) => ({ id: t.id, text: t.text })), expires: Date.now() + 120_000 })
        return send(res, 200, { ...plan, confirm, blocked: sendingBlocked() })
      }
      const o = /^\/api\/open\/(.+)$/.exec(url.pathname)
      if (o && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        await readBody(req) // the body carries nothing we use: the server decides the command
        const id = decodeURIComponent(o[1])
        // A second terminal on the same conversation is exactly what the single-process rule forbids.
        if (terms.get(id)) return send(res, 409, { error: 'Running in the built-in terminal; use Pop out' })
        const { argv, cwd } = await openCommand((await snapshot()).agents.find((a) => a.id === id))
        const term = await detectTerminal()
        if (!term) return send(res, 501, { error: 'No supported terminal' })
        // Counted only when a window is actually attempted. ponytail: one global window, single local user.
        const now = Date.now()
        while (opens.length && now - opens[0] > 60_000) opens.shift()
        if (opens.length >= 10) return send(res, 429, { error: 'Too many opens; wait a minute' })
        opens.push(now)
        const r = await openInTerminal(term, argv, cwd)
        return r.ok ? send(res, 200, { ok: true, terminal: term.name }) : send(res, 502, { error: r.error })
      }
      if (url.pathname === '/api/account' && req.method === 'GET') {
        return send(res, 200, await account.status((await snapshot()).agents))
      }
      if (['/api/account/switch', '/api/account/undo'].includes(url.pathname) && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = await readBody(req)
        const out = url.pathname.endsWith('/undo') ? await account.undo() : await account.switchTo(body, (await snapshot()).agents)
        cached = null
        return send(res, 200, out)
      }
      // Saved Claude accounts (server/accounts.mjs). No response ever carries a token.
      if (url.pathname === '/api/accounts' && req.method === 'GET') return send(res, 200, { ...(await account.accounts.list()), network: await network.status() })
      // The network this Mac is on, and marking it as the work Wi-Fi (network.mjs).
      if (url.pathname === '/api/network' && req.method === 'GET') return send(res, 200, await network.status({ fresh: true }))
      if (url.pathname === '/api/network/work' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const out = await network.mark(await readBody(req))
        sampler.enforce() // a quarantine account may now have to go
        return send(res, 200, out)
      }
      if (url.pathname === '/api/accounts/usage' && req.method === 'GET') return send(res, 200, await account.accounts.usage({ fresh: url.searchParams.has('fresh') }))
      const ac = /^\/api\/accounts\/(capture|add\/start|add\/finish|add\/cancel|[A-Za-z0-9-]{8,64})$/.exec(url.pathname)
      if (ac && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.method !== 'DELETE' && !/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = req.method === 'DELETE' ? null : await readBody(req)
        const what = ac[1]
        const accounts = account.accounts
        if (req.method === 'POST' && what === 'capture') return send(res, 200, await accounts.capture(body))
        if (req.method === 'POST' && what === 'add/finish') return send(res, 200, await accounts.addFinish(body))
        if (req.method === 'POST' && what === 'add/cancel') return send(res, 200, await accounts.addCancel())
        if (req.method === 'POST' && what === 'add/start') {
          const out = await accounts.addStart()
          // Opened here, on this request only; the argv is ours, never the page's.
          const bin = process.env.AGENTVILLE_CLAUDE_BIN || await findExecutable('claude', CLAUDE_DIRS)
          const term = bin && await detectTerminal()
          if (!term) return send(res, 200, { ...out, opened: false, ...(!bin && { error: 'Claude Code CLI not found' }) })
          const r = await openInTerminal(term, [bin, 'auth', 'login'], os.homedir())
          return send(res, 200, { ...out, opened: r.ok, terminal: term.name, ...(!r.ok && { error: r.error }) })
        }
        if (req.method === 'PATCH' && !what.includes('/') && what !== 'capture') return send(res, 200, await accounts.rename(what, body))
        if (req.method === 'DELETE' && !what.includes('/') && what !== 'capture') return send(res, 200, await accounts.remove(what))
      }
      if (url.pathname === '/api/spend' && req.method === 'GET') {
        const minutes = [60, 300, 1440, 10080].find((m) => String(m) === url.searchParams.get('minutes')) || 60
        await spend.update()
        return send(res, 200, { serverTime: Date.now(), spend: spend.summary(minutes), projection: await sampler.projection(), autoSwitch: await sampler.info() })
      }
      // The Models view: per agent, the model it is on, what it was told to use, route, context, tokens.
      if (url.pathname === '/api/models' && req.method === 'GET') {
        const snap = await snapshot()
        await spend.update()
        const profile = await account.profile().catch(() => 'personal')
        return send(res, 200, buildModels({
          agents: snap.agents, info: modelInfo, facts: spend.modelFacts, profile,
          defaults: await readDefaults(claude.home()), catchingUp: spend.catchingUp(),
        }))
      }
      if (url.pathname === '/api/autoswitch' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        return send(res, 200, await sampler.setEnabled((await readBody(req))?.enabled))
      }
      // ---- one agent: message it, or start, stop or fork one (README "Acting on agents") ----
      const json = () => { if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected application/json'), { status: 415 }) }
      if (url.pathname === '/api/message/preview' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const text = body?.text
        if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: "The message can't be empty." })
        if (text.length > 8000) return send(res, 400, { error: 'The message can be at most 8000 characters.' })
        if (/cross-session-message/i.test(text)) return send(res, 400, { error: 'The message may not contain a cross-session-message tag.' })
        const a = (await snapshot()).agents.find((x) => x.id === body?.id)
        if (!a) return send(res, 404, { error: 'No such agent' })
        const problem = a.messageWhy || sendingBlocked()
        if (problem) return send(res, 409, { error: problem })
        // Exactly what lands in the session: the text inside the peer-message wrapper.
        return send(res, 200, { id: a.id, name: a.name, text, sent: wrap(text), confirm: token({ kind: 'message', id: a.id, text }) })
      }
      if (url.pathname === '/api/message/send' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const blocked = sendingBlocked()
        if (blocked) return send(res, 501, { error: blocked })
        const plan = redeem(body?.confirm, ['message'])
        limit(messages, 10, 'messages')
        cached = null
        const a = (await snapshot()).agents.find((x) => x.id === plan.id)
        const inbox = inboxes.get(plan.id)
        let out
        if (!a?.live || !inbox) out = { id: plan.id, status: 'failed', detail: 'Session ended' }
        else if (inboxProblem(inbox)) out = { id: plan.id, status: 'failed', detail: inboxProblem(inbox) }
        else if (dryRun()) out = { id: plan.id, status: 'skipped', detail: 'Dry run' }
        else {
          const r = await deliver(inbox, plan.text)
          if (!r.ok) out = { id: plan.id, status: 'failed', detail: r.detail }
          else {
            const seen = await awaitReceipts([{ id: plan.id, msgId: r.msgId, file: transcriptOf.get(plan.id) }])
            out = seen.has(plan.id) ? { id: plan.id, status: 'delivered', at: seen.get(plan.id) } : { id: plan.id, status: 'sent-unconfirmed', detail: 'Not confirmed within 10 s' }
          }
        }
        await logFleet({ at: Date.now(), action: 'message', results: [out] })
        cached = null
        return send(res, 200, out)
      }
      const ch = /^\/api\/agents\/([^/]+)\/changes$/.exec(url.pathname)
      if (ch && req.method === 'GET') {
        const a = (await snapshot()).agents.find((x) => x.id === decodeURIComponent(ch[1]))
        if (!a) return send(res, 404, { error: 'No such agent' })
        if (!a.cwd) return send(res, 200, { id: a.id, changes: null })
        return send(res, 200, { id: a.id, changes: await changes.detail(a.cwd) })
      }
      if (url.pathname === '/api/search' && req.method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100)
        if (q.length < 2) return send(res, 200, { q, results: [] })
        await snapshot()
        const best = new Map()
        for (const t of titles) {
          const hit = t.names.find((n) => n.toLowerCase().includes(q))
          if (hit && (!best.has(t.id) || best.get(t.id).at < t.at)) best.set(t.id, { id: t.id, name: t.names[0], matched: hit, project: t.project, at: Math.round(t.at) })
        }
        const results = [...best.values()].sort((x, y) => y.at - x.at)
        return send(res, 200, { q, total: results.length, results: results.slice(0, 25) })
      }
      if (url.pathname === '/api/act/options' && req.method === 'GET') {
        const snap = await snapshot()
        return send(res, 200, { blocked: actionsBlocked(), projects: knownProjects(snap.agents).map(({ dir, name }) => ({ dir, name })), models: MODELS, efforts: EFFORTS, modes: MODES, promptMax: PROMPT_MAX, nameMax: NAME_MAX })
      }
      if (url.pathname === '/api/act/preview' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const snap = await snapshot()
        const a = typeof body?.id === 'string' ? snap.agents.find((x) => x.id === body.id) : null
        const plan = body?.kind === 'start' ? startPlan(body, knownProjects(snap.agents))
          : body?.kind === 'stop' ? stopPlan(a)
          : body?.kind === 'fork' ? forkPlan(a, a && forks.get(a.id), body.name)
          : null
        if (!plan) return send(res, 400, { error: 'Unknown action' })
        return send(res, 200, { kind: plan.kind, id: plan.id || null, name: plan.name, command: display(plan), cwd: plan.cwd, blocked: actionsBlocked(), confirm: token(plan) })
      }
      if (url.pathname === '/api/act/run' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const blocked = actionsBlocked()
        if (blocked) return send(res, 501, { error: blocked })
        const plan = redeem(body?.confirm, ['start', 'stop', 'fork'])
        limit(runs, 10, 'starts and stops')
        const r = await runPlan(plan)
        // Ids and outcomes only: never the prompt.
        await logFleet({ at: Date.now(), action: plan.kind, ...(plan.id && { id: plan.id }), ...(plan.project && { project: plan.project }), ok: r.ok, ...(r.jobId && { jobId: r.jobId }), ...(r.error && { error: r.error }) })
        cached = null
        return send(res, r.ok ? 200 : 502, r.ok ? { ok: true, kind: plan.kind, jobId: r.jobId || null, name: plan.name } : { error: r.error })
      }
      // ---- Restore after crash (restore.mjs, README "Restore after crash") ----
      if (url.pathname === '/api/restore' && req.method === 'GET') {
        const snap = await snapshot()
        const overrides = await store.load()
        const byId = new Map(snap.agents.map((a) => [a.id, a]))
        const x = await restore.examine({ important: (id) => overrides[id]?.important === true, live: (id) => byId.get(id)?.live === true })
        // The name the rest of the app shows for it (never prompt text), when the scan still knows it.
        const named = (e) => ({ ...e, name: byId.get(e.id)?.safeName || e.name })
        const lostJobs = x.jobs.filter((j) => j.verdict === 'lost').map(named)
        const lostSessions = x.sessions.filter((j) => j.verdict === 'lost').map(named)
        const excluded = {}
        for (const e of [...x.jobs, ...x.sessions, ...x.codex]) if (e.verdict !== 'lost') excluded[e.verdict] = (excluded[e.verdict] || 0) + 1
        return send(res, 200, { blocked: restoreBlocked(), crashBoot: x.crashBoot, boot: x.boot, at: x.at, dismissed: x.dismissed, jobs: lostJobs, sessions: lostSessions, codex: x.codex.filter((c) => c.verdict === 'lost').map(named), excluded, message: RESTORE_MESSAGE })
      }
      if (url.pathname === '/api/restore/preview' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const overrides = await store.load()
        const { plans, view } = await restore.preview(body?.ids, { important: (id) => overrides[id]?.important === true })
        return send(res, 200, { ...view, blocked: restoreBlocked(), sendBlocked: sendingBlocked(), confirm: token({ kind: 'restore', plans }) })
      }
      if (url.pathname === '/api/restore/run' && req.method === 'POST') {
        json()
        const body = await readBody(req)
        const blocked = restoreBlocked()
        if (blocked) return send(res, 501, { error: blocked })
        const plan = redeem(body?.confirm, ['restore'])
        // The crown agents' one message: the inspector's path (peer-message frame + receipt).
        const sendTo = async (p, { inbox, file }) => {
          const why = sendingBlocked()
          if (why) return { status: 'skipped', detail: why }
          if (!inbox) return { status: 'failed', detail: "Can't be messaged yet" }
          const problem = inboxProblem(inbox)
          if (problem) return { status: 'failed', detail: problem }
          if (dryRun()) return { status: 'skipped', detail: 'Dry run' }
          const r = await deliver(inbox, RESTORE_MESSAGE)
          if (!r.ok) return { status: 'failed', detail: r.detail }
          const seen = await awaitReceipts([{ id: p.id, msgId: r.msgId, file }])
          return seen.has(p.id) ? { status: 'delivered', at: seen.get(p.id) } : { status: 'sent-unconfirmed', detail: 'Not confirmed within 10 s' }
        }
        const out = await restore.run(plan.plans, { send: sendTo })
        // Ids and outcomes only.
        await logFleet({ at: Date.now(), action: 'restore', results: out.results, messages: out.messages.map(({ id, status, detail }) => ({ id, status, ...(detail && { detail }) })) })
        cached = null
        return send(res, 200, out)
      }
      if (url.pathname === '/api/restore/dismiss' && req.method === 'POST') {
        json()
        await readBody(req)
        await restore.dismiss()
        cached = null
        return send(res, 200, { ok: true })
      }
      if (url.pathname === '/api/fleet/send' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const body = await readBody(req)
        const blocked = sendingBlocked()
        if (blocked) return send(res, 501, { error: blocked })
        const plan = typeof body?.confirm === 'string' && plans.get(body.confirm)
        if (!plan || Date.now() > plan.expires || plan.action !== body?.action) return send(res, 409, { error: 'This preview has expired. Open it again.' })
        // Only the previewed recipients, optionally fewer (unticked); the text is the preview's.
        let targets = plan.targets
        if (body.ids !== undefined) {
          if (!Array.isArray(body.ids) || !body.ids.every((i) => typeof i === 'string')) return send(res, 400, { error: 'ids must be a list of agent ids' })
          targets = targets.filter((t) => body.ids.includes(t.id))
        }
        // ponytail: one global window, fine for a single local user.
        const now = Date.now()
        while (sends.length && now - sends[0] > 60_000) sends.shift()
        if (sends.length >= 5) return send(res, 429, { error: 'Too many sends; wait a minute' })
        sends.push(now)
        plans.delete(body.confirm) // one send per preview
        cached = null
        const snap = await snapshot()
        const results = await Promise.all(targets.map(async (t) => {
          const a = snap.agents.find((x) => x.id === t.id)
          const inbox = inboxes.get(t.id)
          if (!a?.live || !inbox) return { id: t.id, status: 'failed', detail: 'Session ended' }
          const problem = inboxProblem(inbox)
          if (problem) return { id: t.id, status: 'failed', detail: problem }
          if (dryRun()) return { id: t.id, status: 'skipped', detail: 'Dry run' }
          const r = await deliver(inbox, t.text)
          return r.ok ? { id: t.id, status: 'sent', msgId: r.msgId, file: transcriptOf.get(t.id) } : { id: t.id, status: 'failed', detail: r.detail }
        }))
        const seen = await awaitReceipts(results.filter((r) => r.status === 'sent'))
        const out = results.map(({ id, status, detail }) => status !== 'sent' ? { id, status, ...(detail && { detail }) }
          : seen.has(id) ? { id, status: 'delivered', at: seen.get(id) } : { id, status: 'sent-unconfirmed', detail: 'Not confirmed within 10 s' })
        // A sent prep pauses its recipients exactly like a manual mark did.
        const reached = out.filter((r) => ['delivered', 'sent-unconfirmed'].includes(r.status)).map((r) => r.id)
        if (plan.action !== 'continue' && reached.length) await fleetStore.mark({ action: plan.action, ids: reached })
        await logFleet({ at: now, action: plan.action, results: out })
        cached = null
        return send(res, 200, { action: plan.action, results: out })
      }
      // Update check (update.mjs): ?fresh asks GitHub again (at most once a minute).
      if (url.pathname === '/api/update' && req.method === 'GET') {
        return send(res, 200, url.searchParams.has('fresh') ? await updater.check() : await updater.status())
      }
      if (url.pathname === '/api/update/apply' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        await readBody(req) // the body carries nothing we use
        const out = await updater.apply()
        // Respond first; the restart closes this server.
        if (out.restarting) res.once('finish', () => setTimeout(() => updater.restartNow(), 200))
        return send(res, out.ok ? 200 : 409, out)
      }
      if (url.pathname === '/api/fleet/mark' && req.method === 'POST') {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Expected application/json' })
        const record = await fleetStore.mark(await readBody(req))
        cached = null
        return send(res, 200, { ok: true, record })
      }
      return send(res, 404, { error: 'Not found' })
    } catch (e) {
      try { send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' }) } catch { /* the client went away */ }
      if (!e.status) logSafely(e)
    }
  })
  // The usage sampler (and auto-switch) runs once a minute while the server is up. Under test it
  // runs only when AGENTVILLE_SAMPLE_MS names an interval (and accounts point at a fake home).
  const testing = process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'
  const sampleMs = Number(process.env.AGENTVILLE_SAMPLE_MS) || (testing ? 0 : 60_000)
  if (sampleMs && !accountsBlocked()) {
    const tick = () => { sampler.sample(); spend.update().catch(() => {}) } // tokens keep pace with readings, page open or not
    const first = setTimeout(tick, Math.min(3000, sampleMs))
    const every = setInterval(tick, sampleMs)
    // The network rule (quarantine accounts and the work Wi-Fi) is checked every 10 s.
    const watch = setInterval(() => sampler.enforce(), Math.min(10_000, sampleMs))
    first.unref(); every.unref(); watch.unref()
    server.on('close', () => { clearTimeout(first); clearInterval(every); clearInterval(watch) })
  }
  updater.start().catch(() => {})
  server.on('close', () => updater.stop())
  server.on('upgrade', (req, socket, head) => terms.upgrade(req, socket, head))
  // Before close, not on 'close': open WebSockets would otherwise keep the server from closing.
  const close = server.close.bind(server)
  server.close = (cb) => { terms.closeAll(); return close(cb) }
  Object.assign(server, { sampler, spend, terms, updater })
  return server
}

