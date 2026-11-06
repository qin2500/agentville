/**
 * Saved Claude accounts: the logins the user can switch Claude Code between, and their usage.
 *
 * `<data>/accounts.json` (0600) holds metadata only; `<data>/accounts/<id>.json` (0600, folder 0700)
 * holds each account's credential exactly as Claude Code stored it. id = the account's profile uuid.
 * Claude's live credential is read and written through a small adapter: the macOS Keychain item
 * "Claude Code-credentials", or `<claude home>/.credentials.json` on Linux and in tests.
 *
 * Token hazard: refreshing an OAuth login rotates its refresh token. The login in Claude's store
 * belongs to Claude Code, which refreshes it itself; refreshing it here would log Claude out. So the
 * live login is only ever read (fresh, each time), and only saved, inactive accounts are refreshed,
 * under the switch lock, with the rotated tokens saved at once. No token is ever returned or logged.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { usageWindows } from './research.mjs'

export const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const USAGE_TTL_MS = 60_000
const ID_RE = /^[A-Za-z0-9-]{8,64}$/
const fail = (status, message) => Object.assign(new Error(message), { status })
/** An error whose message is a fixed string, safe to show (never the server's reply). */
const fixed = (message) => Object.assign(new Error(message), { fixed: message })
const testing = () => process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'
const apiBase = () => (process.env.AGENTVILLE_ANTHROPIC_API || 'https://api.anthropic.com').replace(/\/+$/, '')
const tokenUrl = () => process.env.AGENTVILLE_OAUTH_TOKEN_URL || 'https://platform.claude.com/v1/oauth/token'
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
export const oauthOf = (text) => { try { return JSON.parse(text)?.claudeAiOauth || null } catch { return null } }

/** Why saved accounts can't be used here ('' = they can). Tests must name a fake Claude home. */
export function accountsBlocked() {
  if (process.platform === 'win32') return 'Accounts are not supported on Windows'
  if (testing() && !process.env.AGENTVILLE_CLAUDE_HOME) return 'Accounts are disabled in tests'
  return ''
}

export async function writeAtomic(file, text, mode) {
  const tmp = `${file}.agentville-${process.pid}.tmp`
  try {
    await fsp.writeFile(tmp, text, { mode })
    if (mode) await fsp.chmod(tmp, mode)
    await fsp.rename(tmp, file)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {}) // a half-written temp file on a full disk
    throw e
  }
}

function security(args, input) {
  return new Promise((resolve) => {
    const child = execFile('/usr/bin/security', args, { timeout: 10_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') })
    })
    if (input !== undefined) child.stdin.end(input)
  })
}

/**
 * The macOS Keychain item Claude Code reads. Reads use `-w`; writes go through `security -i` over
 * stdin with the JSON hex-encoded (`-X`), so the secret never appears in any process's argv.
 */
export function keychainStore(service = KEYCHAIN_SERVICE) {
  const read = async () => {
    const r = await security(['find-generic-password', '-s', service, '-w'])
    if (r.code !== 0) return null
    const text = r.stdout.replace(/\n$/, '')
    // `security -w` prints hex when the secret isn't plain text.
    return !text.startsWith('{') && /^(?:[0-9a-f]{2})+$/i.test(text) ? Buffer.from(text, 'hex').toString('utf8') : text
  }
  return {
    kind: 'keychain',
    read,
    async write(text) {
      const attrs = await security(['find-generic-password', '-s', service]) // attributes only, no secret
      const hexAcct = /"acct"<blob>=0x([0-9A-F]+)/i.exec(attrs.stdout)?.[1]
      const acct = hexAcct ? Buffer.from(hexAcct, 'hex').toString('utf8') : /"acct"<blob>="([^"]*)"/.exec(attrs.stdout)?.[1] || os.userInfo().username
      if (/["\\\n]/.test(acct) || /["\\\n]/.test(service)) throw new Error('Unsupported Keychain account name')
      const line = `add-generic-password -U -a "${acct}" -s "${service}" -X ${Buffer.from(text, 'utf8').toString('hex')}\n`
      // `security -i` silently truncates longer lines, which would store a corrupt credential.
      if (line.length > 4000) throw new Error('Credential too large for the Keychain helper')
      await security(['-i'], line)
      if ((await read()) !== text) throw new Error('The Keychain did not take the new login')
    },
  }
}

/** `<claude home>/.credentials.json` (0600): Claude Code's store on Linux, and the only one tests use. */
export function fileStore(claudeHome) {
  const file = () => path.join(claudeHome(), '.credentials.json')
  return {
    kind: 'file',
    read: () => fsp.readFile(file(), 'utf8').catch(() => null),
    async write(text) {
      await fsp.mkdir(claudeHome(), { recursive: true })
      await writeAtomic(file(), text, 0o600)
    },
  }
}

export const credentialStore = (claudeHome) =>
  testing() || process.platform !== 'darwin' || process.env.AGENTVILLE_CREDENTIALS === 'file' ? fileStore(claudeHome) : keychainStore()

/** One Anthropic call. Throws `fixed` errors only: no reply body or header ever leaves here. */
async function call(url, { token, body, tokenCall = false } = {}) {
  if (testing() && !(process.env.AGENTVILLE_ANTHROPIC_API && process.env.AGENTVILLE_OAUTH_TOKEN_URL)) throw fixed('Network is disabled in tests')
  let res
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        accept: 'application/json',
        ...(token && { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }),
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch { throw fixed("Couldn't reach Anthropic") }
  if (res.status === 401 || res.status === 403 || (tokenCall && res.status === 400)) throw fixed('Login expired — sign in again')
  if (res.status === 429) throw Object.assign(fixed('Anthropic is rate-limiting usage checks'), { rateLimited: true, retryAfterMs: (Number(res.headers.get('retry-after')) || 0) * 1000 })
  if (!res.ok) throw fixed(`Anthropic returned ${res.status}`)
  try { return await res.json() } catch { throw fixed('Unexpected response from Anthropic') }
}

/** `{ id, email }` of the account a token belongs to. */
async function profile(accessToken) {
  const p = await call(`${apiBase()}/api/oauth/profile`, { token: accessToken })
  const id = p?.account?.uuid
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fixed('Unexpected response from Anthropic')
  const email = p.account.email ?? p.account.email_address
  return { id, email: typeof email === 'string' ? email : '' }
}

/**
 * One usage reading per account, shared by the sampler and the menu. After a 429 the account is
 * left alone until Retry-After (else 2 min, doubling to 15 min), and the last good reading is
 * returned instead (`stale`), so the bars don't vanish while Anthropic is limiting checks.
 */
const BACKOFF_MS = [2 * 60e3, 4 * 60e3, 8 * 60e3, 15 * 60e3]
function usageReader(onReading) {
  const backoff = new Map() // account key -> { until, step }
  const lastGood = new Map() // account key -> { at, fiveHour, weekly }
  return async function usageReading(key, token, active) {
  const now = Date.now()
  const b = backoff.get(key)
  const fallback = (error) => {
    const g = lastGood.get(key)
    if (!g) throw fixed(error)
    return { fiveHour: g.fiveHour, weekly: g.weekly, stale: true, asOf: g.at, note: error }
  }
  if (b && now < b.until) return fallback('Anthropic is rate-limiting usage checks')
  try {
    const u = await call(`${apiBase()}/api/oauth/usage`, { token })
    backoff.delete(key)
    const weekly = usageWindow(u?.seven_day)
    // Anthropic drops the 5-hour limit from some accounts: a good reading (weekly present) with no
    // 5-hour window means there is no 5-hour limit, not missing data.
    const value = { fiveHour: usageWindow(u?.five_hour) || (weekly ? NO_LIMIT : null), weekly }
    lastGood.set(key, { at: now, ...value })
    try { onReading?.({ account: key, active: Boolean(active), windows: usageWindows(u) }) } catch { /* research only */ }
    return value
  } catch (e) {
    if (!e.rateLimited) throw e
    const step = Math.min((b?.step ?? -1) + 1, BACKOFF_MS.length - 1)
    backoff.set(key, { until: now + Math.max(e.retryAfterMs || 0, BACKOFF_MS[step]), step })
    return fallback(e.fixed)
  }
  }
}

/** A window the account doesn't have: never "out", always has room, no reset. */
export const NO_LIMIT = Object.freeze({ used: 0, resetsAt: null, none: true })
const usageWindow = (w) => (w && typeof w.utilization === 'number'
  ? { used: Math.max(0, Math.min(100, w.utilization)), resetsAt: Date.parse(w.resets_at) || null } : null)

/**
 * `exclusive(fn)` runs fn under the account switch's lock (409 while a switch runs). `poolState()`
 * says whether the pool gateway is the active profile and whether one is available to switch to.
 */
/** `onReading`: told about every fresh usage reading (the research log). */
export function createAccounts({ dataDir, claudeHome, exclusive, poolState, onReading }) {
  const dir = path.join(dataDir, 'accounts')
  const metaFile = path.join(dataDir, 'accounts.json')
  const pendingFile = path.join(dir, 'pending-add.json')
  const usageCache = new Map() // id -> { at, value }
  const usageReading = usageReader(onReading)
  let memo = null // { hash, id }: which account the live credential text belongs to
  const live = () => credentialStore(claudeHome)
  const slotFile = (id) => path.join(dir, `${id}.json`)
  // Claude Code's global config, whose `oauthAccount` describes the logged-in account.
  const globalConfig = () => (claudeHome() === path.join(os.homedir(), '.claude') ? path.join(os.homedir(), '.claude.json') : path.join(claudeHome(), '.claude.json'))

  const guard = () => { const b = accountsBlocked(); if (b) throw fail(501, b) }
  async function ensureDir() {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    await fsp.chmod(dir, 0o700)
  }
  async function load() {
    try { const list = JSON.parse(await fsp.readFile(metaFile, 'utf8')); return Array.isArray(list) ? list.filter((a) => ID_RE.test(a?.id || '')) : [] } catch { return [] }
  }
  async function saveMeta(list) {
    await fsp.mkdir(dataDir, { recursive: true })
    await writeAtomic(metaFile, JSON.stringify(list, null, 2) + '\n', 0o600)
  }
  const readSlot = (id) => (ID_RE.test(id) ? fsp.readFile(slotFile(id), 'utf8').catch(() => null) : Promise.resolve(null))
  async function writeSlot(id, text) {
    await ensureDir()
    await writeAtomic(slotFile(id), text, 0o600)
  }
  const publicOf = (a, liveId, pool) => ({ id: a.id, label: a.label, email: a.email, subscriptionType: a.subscriptionType || null, quarantine: a.quarantine === true, active: !pool && a.id === liveId, signedIn: a.id === liveId })
  const cleanLabel = (label) => {
    if (label == null || label === '') return ''
    if (typeof label !== 'string' || label.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(label)) throw fail(400, 'label must be text of at most 60 characters')
    return label.trim()
  }

  async function readOauthAccount() {
    try { return JSON.parse(await fsp.readFile(globalConfig(), 'utf8')).oauthAccount ?? null } catch { return null }
  }
  /** Set only `oauthAccount` in Claude's global config, if the file exists and the value differs. */
  async function writeOauthAccount(value) {
    const file = globalConfig()
    const text = await fsp.readFile(file, 'utf8').catch(() => null)
    if (text === null) return
    let json
    try { json = JSON.parse(text) } catch { return }
    if (JSON.stringify(json.oauthAccount ?? null) === JSON.stringify(value ?? null)) return
    if (value == null) delete json.oauthAccount; else json.oauthAccount = value
    const indent = /^[{[]\r?\n([ \t]+)/.exec(text)?.[1]
    await writeAtomic(file, JSON.stringify(json, null, indent) + (text.endsWith('\n') ? '\n' : ''), fs.statSync(file).mode & 0o777)
  }

  /**
   * Which account a credential text belongs to: a saved slot with the same refresh (or access)
   * token, else, with `network`, its profile. null when unknown. Throws `fixed` on network failure.
   */
  async function identify(text, { network = false } = {}) {
    const o = oauthOf(text)
    if (!o?.accessToken) return null
    const hash = sha(text)
    if (memo?.hash === hash) return memo.id
    for (const a of await load()) {
      const s = oauthOf(await readSlot(a.id))
      if (s && ((o.refreshToken && s.refreshToken === o.refreshToken) || s.accessToken === o.accessToken)) { memo = { hash, id: a.id }; return a.id }
    }
    if (!network) return null
    const { id } = await profile(o.accessToken)
    memo = { hash, id }
    return id
  }

  /** Keep a saved account's slot in step with Claude's copy (Claude rotates its tokens). */
  async function syncSlot(id, text) {
    if (!id || !text || !(await load()).some((a) => a.id === id)) return
    if ((await readSlot(id)) !== text) await writeSlot(id, text)
  }

  /** Save a credential text as an account (dedupe by uuid). Needs the network for a new account. */
  async function saveLogin(text, label) {
    const o = oauthOf(text)
    if (!o?.accessToken) throw fail(409, 'No Claude login is stored. Run `claude auth login` first.')
    const list = await load()
    let id = await identify(text).catch(() => null)
    let email = list.find((a) => a.id === id)?.email
    if (!id || !email) {
      try { ({ id, email } = await profile(o.accessToken)) } catch (e) { throw fail(502, e.fixed || "Couldn't reach Anthropic") }
      memo = { hash: sha(text), id }
    }
    await writeSlot(id, text)
    const oauthAccount = await readOauthAccount()
    let entry = list.find((a) => a.id === id)
    if (!entry) list.push(entry = { id, label: label || email || id, email: email || '', subscriptionType: null, addedAt: Date.now() })
    if (label) entry.label = label
    if (email) entry.email = email
    entry.subscriptionType = typeof o.subscriptionType === 'string' ? o.subscriptionType : entry.subscriptionType
    if (oauthAccount?.accountUuid === id) entry.oauthAccount = oauthAccount
    await saveMeta(list)
    usageCache.delete(id)
    return entry
  }

  async function list() {
    guard()
    const pool = await poolState()
    const liveText = await live().read()
    const liveId = liveText ? await identify(liveText).catch(() => null) : null
    const accounts = await load()
    return {
      active: pool.active ? 'pool' : liveId && accounts.some((a) => a.id === liveId) ? liveId : 'unknown',
      accounts: accounts.map((a) => publicOf(a, liveId, pool.active)),
      pool: { available: pool.active || pool.available },
      login: { present: Boolean(liveText), id: liveId },
      adding: fs.existsSync(pendingFile),
    }
  }

  const refreshing = new Map()
  /** Refresh a saved, inactive account's tokens and save the rotated ones. Never the live one. */
  async function refreshSlot(id) {
    const text = await readSlot(id)
    const cred = JSON.parse(text)
    const o = cred.claudeAiOauth
    if (!o?.refreshToken) throw fixed('Login expired — sign in again')
    const r = await call(tokenUrl(), { tokenCall: true, body: { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLIENT_ID, scope: (o.scopes || []).join(' ') } })
    if (typeof r?.access_token !== 'string') throw fixed('Unexpected response from Anthropic')
    o.accessToken = r.access_token
    if (typeof r.refresh_token === 'string') o.refreshToken = r.refresh_token
    if (Number(r.expires_in) > 0) o.expiresAt = Date.now() + Number(r.expires_in) * 1000
    await writeSlot(id, JSON.stringify(cred))
  }

  /** `{ accounts: [{ id, fiveHour, weekly, error?, checkedAt }] }`; each cached 60 s unless `fresh`. */
  let usageInflight = null
  async function usage(opts) {
    guard()
    usageInflight ??= fetchUsage(opts).finally(() => { usageInflight = null })
    const r = await usageInflight
    // A check already running when an account was saved doesn't know about it: run once more.
    const ids = (await load()).map((a) => a.id)
    return ids.every((id) => r.accounts.some((x) => x.id === id)) ? r : fetchUsage(opts)
  }
  async function fetchUsage({ fresh = false } = {}) {
    const accounts = await load()
    const due = accounts.filter((a) => fresh || !(Date.now() - (usageCache.get(a.id)?.at || 0) < USAGE_TTL_MS))
    if (due.length) {
      let liveText = await live().read()
      let liveId = null
      let liveKnown = !liveText
      if (liveText) { try { liveId = await identify(liveText, { network: true }); liveKnown = true } catch { /* unknown */ } }
      await syncSlot(liveId, liveText)
      // Saved, inactive accounts whose access token has expired (or is about to) need a refresh.
      const soon = Date.now() + 60_000
      const stale = []
      for (const a of due) {
        if (a.id === liveId) continue
        const o = oauthOf(await readSlot(a.id))
        if (o && !(o.expiresAt > soon)) stale.push(a.id)
      }
      const refreshErr = new Map()
      if (stale.length) {
        if (!liveKnown) for (const id of stale) refreshErr.set(id, "Can't refresh until the current login is recognised — try again shortly")
        else {
          // Under the switch lock, and with the live login re-checked: a switch could have just
          // made one of these the live login, which must then never be refreshed here.
          try {
            await exclusive(async () => {
              liveText = await live().read()
              liveId = liveText ? await identify(liveText, { network: true }) : null
              for (const id of stale) {
                if (id === liveId) continue
                if (!refreshing.has(id)) refreshing.set(id, refreshSlot(id).finally(() => refreshing.delete(id)))
                await refreshing.get(id).catch((e) => refreshErr.set(id, e.fixed || "Couldn't refresh the login"))
              }
            })
          } catch (e) { for (const id of stale) refreshErr.set(id, e.status === 409 ? 'Busy switching — try again in a moment' : e.fixed || "Can't refresh right now — try again shortly") }
        }
      }
      await Promise.all(due.map(async (a) => {
        let value
        try {
          if (refreshErr.has(a.id)) throw fixed(refreshErr.get(a.id))
          const o = oauthOf(a.id === liveId ? liveText : await readSlot(a.id))
          if (!o?.accessToken) throw fixed('Saved login is missing — add the account again')
          if (a.id === liveId && !(o.expiresAt > Date.now())) throw fixed('Token expired — Claude Code refreshes it on its next request')
          value = { id: a.id, ...(await usageReading(a.id, o.accessToken, a.id === liveId)) }
        } catch (e) { value = { id: a.id, fiveHour: null, weekly: null, error: e.fixed || "Couldn't check usage" } }
        usageCache.set(a.id, { at: Date.now(), value })
      }))
    }
    return { accounts: accounts.map((a) => ({ ...usageCache.get(a.id).value, checkedAt: usageCache.get(a.id).at })) }
  }

  /**
   * Usage of the login in Claude's store only (the sampler, once a minute): read fresh, never
   * refreshed. `{ id, saved, fiveHour, weekly, error? }`, or null when no login is stored. A saved
   * account's reading also updates the menu's cache.
   */
  async function activeUsage() {
    guard()
    const text = await live().read()
    const o = oauthOf(text)
    if (!o?.accessToken) return null
    let id = null
    try { id = await identify(text, { network: true }) } catch { /* unknown: still measurable */ }
    const saved = Boolean(id) && (await load()).some((a) => a.id === id)
    if (saved) await syncSlot(id, text)
    let value
    try {
      if (!(o.expiresAt > Date.now())) throw fixed('Token expired — Claude Code refreshes it on its next request')
      // The sampler's reading is the fresh one; it also fills the cache the menu reads from.
      value = { id, ...(await usageReading(id || 'live', o.accessToken, true)) }
    } catch (e) { value = { id, fiveHour: null, weekly: null, error: e.fixed || "Couldn't check usage" } }
    if (saved) usageCache.set(id, { at: Date.now(), value })
    return { ...value, saved }
  }

  /** POST /api/accounts/capture: save the login currently in Claude's store. */
  const capture = (body) => exclusive(async () => {
    guard()
    const label = cleanLabel(body?.label)
    const text = await live().read()
    if (!text) throw fail(409, 'No Claude login is stored. Run `claude auth login` first.')
    const entry = await saveLogin(text, label)
    return { account: publicOf(entry, entry.id, (await poolState()).active) }
  })

  /** Step 1 of adding: save the current login, remember it to put back, then `claude auth login` runs. */
  const addStart = () => exclusive(async () => {
    guard()
    const text = await live().read()
    // Best effort: if the current login can't be saved (offline), it is still kept below to put back.
    if (text) await saveLogin(text, '').catch(() => {})
    await ensureDir()
    await writeAtomic(pendingFile, JSON.stringify({ at: Date.now(), previous: text, oauthAccount: await readOauthAccount() }) + '\n', 0o600)
    return { command: 'claude auth login' }
  })

  async function readPending() {
    try { return JSON.parse(await fsp.readFile(pendingFile, 'utf8')) } catch { return null }
  }
  /** Step 2: save the new login, then put the previous one back so nothing running changes. */
  const addFinish = (body) => exclusive(async () => {
    guard()
    const label = cleanLabel(body?.label)
    const pending = await readPending()
    if (!pending) throw fail(409, 'Start adding an account first')
    const text = await live().read()
    if (!text || text === pending.previous) throw fail(409, 'No new login yet. Finish signing in in the terminal, then try again.')
    const entry = await saveLogin(text, label)
    const previousId = pending.previous ? await identify(pending.previous).catch(() => null) : null
    let restored = false
    if (pending.previous && previousId !== entry.id) {
      await live().write(pending.previous)
      await writeOauthAccount(pending.oauthAccount)
      memo = null
      restored = true
    }
    await fsp.rm(pendingFile, { force: true })
    return { account: publicOf(entry, restored ? previousId : entry.id, (await poolState()).active), restored }
  })

  /** Abandon an add: if a new login already replaced the previous one, put the previous one back. */
  const addCancel = () => exclusive(async () => {
    guard()
    const pending = await readPending()
    if (!pending) return { restored: false }
    const text = await live().read()
    let restored = false
    if (pending.previous && text !== pending.previous) {
      await live().write(pending.previous)
      await writeOauthAccount(pending.oauthAccount)
      memo = null
      restored = true
    }
    await fsp.rm(pendingFile, { force: true })
    return { restored }
  })

  /** PATCH: a new `label`, and/or `quarantine` (true: never used on the work Wi-Fi). */
  const rename = (id, body) => exclusive(async () => {
    guard()
    const hasLabel = body?.label !== undefined, hasQ = body?.quarantine !== undefined
    if (!hasLabel && !hasQ) throw fail(400, 'Nothing to change: send label and/or quarantine')
    const label = hasLabel ? cleanLabel(body.label) : null
    if (hasLabel && !label) throw fail(400, 'label must be text of at most 60 characters')
    if (hasQ && typeof body.quarantine !== 'boolean') throw fail(400, 'quarantine must be true or false')
    const accounts = await load()
    const entry = accounts.find((a) => a.id === id)
    if (!entry) throw fail(404, 'No such account')
    if (hasLabel) entry.label = label
    if (hasQ) { if (body.quarantine) entry.quarantine = true; else delete entry.quarantine }
    await saveMeta(accounts)
    const liveText = await live().read()
    return { account: publicOf(entry, liveText ? await identify(liveText).catch(() => null) : null, (await poolState()).active) }
  })

  const remove = (id) => exclusive(async () => {
    guard()
    const accounts = await load()
    if (!accounts.some((a) => a.id === id)) throw fail(404, 'No such account')
    const liveText = await live().read()
    if (liveText && (await identify(liveText).catch(() => null)) === id) throw fail(409, 'That account is signed in to Claude Code right now. Switch to another account first.')
    await saveMeta(accounts.filter((a) => a.id !== id))
    await fsp.rm(slotFile(id), { force: true })
    usageCache.delete(id)
    return { removed: id }
  })

  /** Put a saved account's login into Claude's store (inside a switch, which holds the lock). */
  async function activate(id) {
    const text = await readSlot(id)
    if (!oauthOf(text)?.accessToken) throw fail(409, 'That account has no saved login. Add it again.')
    await live().write(text)
    memo = { hash: sha(text), id }
    const entry = (await load()).find((a) => a.id === id)
    if (entry?.oauthAccount) await writeOauthAccount(entry.oauthAccount)
  }

  /**
   * Put a backed-up live credential back (rollback and Undo). When Claude's current login is the
   * same account it is kept (Claude may have rotated it since); otherwise the fresher of the backup
   * and that account's slot is written.
   */
  async function restoreLive(text, accountId) {
    const cur = await live().read()
    if (cur === text) return
    const curId = cur ? await identify(cur, { network: true }).catch(() => null) : null
    await syncSlot(curId, cur)
    if (accountId && curId === accountId) return
    const slot = accountId ? await readSlot(accountId) : null
    const best = slot && (oauthOf(slot)?.expiresAt || 0) > (oauthOf(text)?.expiresAt || 0) ? slot : text
    await live().write(best)
    memo = null
  }

  return {
    load, list, usage, activeUsage, capture, addStart, addFinish, addCancel, rename, remove,
    readLive: () => live().read(), identify, syncSlot, activate, restoreLive, readOauthAccount, writeOauthAccount,
  }
}
