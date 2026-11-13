/**
 * Saved Claude accounts: the logins the user can switch Claude Code between, and their usage.
 *
 * `<data>/accounts.json` (0600) holds metadata only; `<data>/accounts/<id>.json` (0600, folder 0700)
 * holds each account's `claudeAiOauth` login only (`{"claudeAiOauth":{…}}`). id = the account's
 * profile uuid. Claude's live credential is read and written through a small adapter: the macOS
 * Keychain item "Claude Code-credentials", or `<claude home>/.credentials.json` on Linux and in tests.
 *
 * The live item holds more than the Claude login (e.g. `mcpOAuth`: MCP servers' OAuth tokens). A
 * switch replaces only its `claudeAiOauth` key and keeps every other key as it is now, so MCP
 * logins are never rolled back to an older copy. A slot is only overwritten by a login whose
 * `expiresAt` is newer than the one it holds, so a stale copy can never replace a fresher one.
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
/** Inactive saved accounts' usage is polled less often than the active one's. */
const INACTIVE_USAGE_TTL_MS = 5 * 60_000
const ID_RE = /^[A-Za-z0-9-]{8,64}$/
/** proper-lockfile's default `stale` (ms), which Claude Code uses for its `~/.claude.json.lock`. */
const CONFIG_LOCK_STALE_MS = 10_000
/** A saved login whose access token expires within this is refreshed before it is switched to. */
const EXPIRY_MARGIN_MS = 60_000
const fail = (status, message) => Object.assign(new Error(message), { status })
/** An error whose message is a fixed string, safe to show (never the server's reply). */
const fixed = (message) => Object.assign(new Error(message), { fixed: message })
const testing = () => process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'
const apiBase = () => (process.env.AGENTVILLE_ANTHROPIC_API || 'https://api.anthropic.com').replace(/\/+$/, '')
const tokenUrl = () => process.env.AGENTVILLE_OAUTH_TOKEN_URL || 'https://platform.claude.com/v1/oauth/token'
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
export const oauthOf = (text) => { try { return JSON.parse(text)?.claudeAiOauth || null } catch { return null } }
const expiresOf = (o) => Number(o?.expiresAt) || 0
/** A slot's text: the Claude login and nothing else. */
const slotText = (oauth) => JSON.stringify({ claudeAiOauth: oauth })
/**
 * `current` (Claude's live item text) with only its `claudeAiOauth` replaced by `oauth` (removed
 * when null). Every other key, and the key order, is kept.
 */
export function withOauth(current, oauth) {
  let obj = {}
  try { const j = JSON.parse(current); if (j && typeof j === 'object' && !Array.isArray(j)) obj = j } catch { /* none or unreadable */ }
  if (oauth) obj.claudeAiOauth = oauth; else delete obj.claudeAiOauth
  return JSON.stringify(obj)
}

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

function runSecurity(args, input) {
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
/**
 * The `security -i` line limit. Longer lines are silently truncated (a corrupt item), so a bigger
 * item is refused before anything is written. Claude Code itself falls back to passing the secret in
 * argv beyond this (visible to `ps`); that is never done here, and no other helper can update the
 * item without a Keychain access prompt (its access list trusts /usr/bin/security only).
 */
export const KEYCHAIN_LINE_LIMIT = 4000
/** `security`'s exit status for "the specified item could not be found in the keychain". */
const SEC_NOT_FOUND = 44
/**
 * Claude's login could not be read (locked Keychain, helper timeout, unreadable file). Never means
 * "no login": every caller must leave everything as it is. Fixed message, never any output.
 */
export const unreadable = () => Object.assign(fixed("Couldn't read Claude's stored login — nothing was changed"), { status: 503, code: 'unreadable', unreadable: true })
export function keychainStore(service = KEYCHAIN_SERVICE, { run = runSecurity } = {}) {
  const security = run
  /** The item's text; null only when the item does not exist (exit 44). Any other failure throws. */
  const read = async () => {
    const r = await security(['find-generic-password', '-s', service, '-w'])
    if (r.code === SEC_NOT_FOUND) return null
    if (r.code !== 0) throw unreadable()
    const text = r.stdout.replace(/\n$/, '')
    // `security -w` prints hex when the secret isn't plain text.
    return !text.startsWith('{') && /^(?:[0-9a-f]{2})+$/i.test(text) ? Buffer.from(text, 'hex').toString('utf8') : text
  }
  /** The `security -i` line for `hex`, minus the hex: its fixed part depends on the item's account name. */
  const linePrefix = async () => {
    const attrs = await security(['find-generic-password', '-s', service]) // attributes only, no secret
    const hexAcct = /"acct"<blob>=0x([0-9A-F]+)/i.exec(attrs.stdout)?.[1]
    const acct = hexAcct ? Buffer.from(hexAcct, 'hex').toString('utf8') : /"acct"<blob>="([^"]*)"/.exec(attrs.stdout)?.[1] || os.userInfo().username
    if (/["\\\n]/.test(acct) || /["\\\n]/.test(service)) throw new Error('Unsupported Keychain account name')
    return `add-generic-password -U -a "${acct}" -s "${service}" -X `
  }
  /** The largest item (UTF-8 bytes; = characters for ASCII JSON) whose line fits the helper's limit. */
  const maxFor = (prefix) => Math.max(0, Math.floor((KEYCHAIN_LINE_LIMIT - prefix.length - 1) / 2))
  return {
    kind: 'keychain',
    read,
    /**
     * `{ size, max, left }`: the live item's length now, the most the helper can write, and the
     * difference (negative = over). Lengths only, from the item's length; never its content.
     */
    async headroom() {
      const text = await read()
      const size = text === null ? 0 : Buffer.byteLength(text, 'utf8')
      const max = maxFor(await linePrefix())
      return { size, max, left: max - size }
    },
    async write(text) {
      const prefix = await linePrefix()
      const size = Buffer.byteLength(text, 'utf8')
      // `security -i` silently truncates longer lines, which would store a corrupt credential, and
      // the secret is never put in argv instead: a bigger item is refused, visibly, before any write.
      const max = maxFor(prefix)
      if (size > max) {
        throw Object.assign(new Error(`Claude's Keychain login is too big to update safely (${size} characters; at most ${max}). Nothing was changed. Signing out of MCP servers you no longer use makes it smaller.`), { status: 409, code: 'too_big', tooLarge: true, size, max })
      }
      await security(['-i'], `${prefix}${Buffer.from(text, 'utf8').toString('hex')}\n`)
      if ((await read()) !== text) throw new Error('The Keychain did not take the new login')
    },
  }
}

/** `<claude home>/.credentials.json` (0600): Claude Code's store on Linux, and the only one tests use. */
export function fileStore(claudeHome) {
  const file = () => path.join(claudeHome(), '.credentials.json')
  /** null only when the file does not exist; any other failure throws (never read as "no login"). */
  const read = () => fsp.readFile(file(), 'utf8').catch((e) => { if (e?.code === 'ENOENT') return null; throw unreadable() })
  return {
    kind: 'file',
    read,
    /** No helper limit for a file: `max` and `left` are null. */
    async headroom() {
      const text = await read()
      return { size: text === null ? 0 : Buffer.byteLength(text, 'utf8'), max: null, left: null }
    },
    async write(text) {
      await fsp.mkdir(claudeHome(), { recursive: true })
      await writeAtomic(file(), text, 0o600)
    },
  }
}

export const credentialStore = (claudeHome) =>
  testing() || process.platform !== 'darwin' || process.env.AGENTVILLE_CREDENTIALS === 'file' ? fileStore(claudeHome) : keychainStore()

/** One Anthropic call. Throws `fixed` errors only: no reply body or header ever leaves here. */
async function call(url, { token, body, tokenCall = false, fetchImpl } = {}) {
  if (!fetchImpl && testing() && !(process.env.AGENTVILLE_ANTHROPIC_API && process.env.AGENTVILLE_OAUTH_TOKEN_URL)) throw Object.assign(fixed('Network is disabled in tests'), { network: true })
  let res
  try {
    res = await (fetchImpl || fetch)(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        accept: 'application/json',
        ...(token && { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }),
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch { throw Object.assign(fixed("Couldn't reach Anthropic"), { network: true }) }
  if (res.status === 401 || res.status === 403 || (tokenCall && res.status === 400)) throw Object.assign(fixed('Login expired — sign in again'), { rejected: true })
  if (res.status === 429) throw Object.assign(fixed('Anthropic is rate-limiting usage checks'), { rateLimited: true, retryAfterMs: (Number(res.headers?.get?.('retry-after')) || 0) * 1000 })
  if (!res.ok) throw fixed(`Anthropic returned ${res.status}`)
  try { return await res.json() } catch { throw fixed('Unexpected response from Anthropic') }
}

/** `{ id, email }` of the account a token belongs to. */
async function profile(accessToken, fetchImpl) {
  const p = await call(`${apiBase()}/api/oauth/profile`, { token: accessToken, fetchImpl })
  const id = p?.account?.uuid
  if (typeof id !== 'string' || !ID_RE.test(id)) throw fixed('Unexpected response from Anthropic')
  const email = p.account.email ?? p.account.email_address
  return { id, email: typeof email === 'string' ? email : '' }
}

/**
 * One usage reading per account, shared by the sampler and the menu. After a 429 the account is
 * left alone until Retry-After (else 2 min, doubling to 15 min), and the last good reading is
 * returned instead (`stale`), so the bars don't vanish while Anthropic is limiting checks. The
 * active account (the one Claude Code is using) never waits more than 2 min, Retry-After or not:
 * its reading drives switching. Every reading carries `checkedAt`, when Anthropic actually sent it.
 */
const BACKOFF_MS = [2 * 60e3, 4 * 60e3, 8 * 60e3, 15 * 60e3]
export const ACTIVE_BACKOFF_CAP_MS = 2 * 60e3
export function usageReader(onReading, { fetchImpl, now: clock = Date.now } = {}) {
  const backoff = new Map() // account key -> { at, until, step }
  const lastGood = new Map() // account key -> { at, fiveHour, weekly }
  return async function usageReading(key, token, active) {
  const now = clock()
  const b = backoff.get(key)
  const fallback = (error) => {
    const g = lastGood.get(key)
    if (!g) throw fixed(error)
    return { fiveHour: g.fiveHour, weekly: g.weekly, stale: true, asOf: g.at, checkedAt: g.at, note: error }
  }
  // An account backed off while inactive may have just become the active one: the cap applies now.
  if (b && now < (active ? Math.min(b.until, b.at + ACTIVE_BACKOFF_CAP_MS) : b.until)) return fallback('Anthropic is rate-limiting usage checks')
  try {
    const u = await call(`${apiBase()}/api/oauth/usage`, { token, fetchImpl })
    backoff.delete(key)
    const weekly = usageWindow(u?.seven_day)
    // Anthropic drops the 5-hour limit from some accounts: a good reading (weekly present) with no
    // 5-hour window means there is no 5-hour limit, not missing data.
    const value = { fiveHour: usageWindow(u?.five_hour) || (weekly ? NO_LIMIT : null), weekly }
    lastGood.set(key, { at: now, ...value })
    try { onReading?.({ account: key, active: Boolean(active), windows: usageWindows(u) }) } catch { /* research only */ }
    return { ...value, checkedAt: now }
  } catch (e) {
    if (!e.rateLimited) throw e
    const step = Math.min((b?.step ?? -1) + 1, BACKOFF_MS.length - 1)
    let wait = Math.max(e.retryAfterMs || 0, BACKOFF_MS[step])
    if (active) wait = Math.min(wait, ACTIVE_BACKOFF_CAP_MS)
    backoff.set(key, { at: now, until: now + wait, step })
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
/**
 * `onReading`: told about every fresh usage reading (the research log). `store` (tests): a fake
 * credential store `{ read(), write(text) }` instead of the Keychain / credentials file. `fetch`
 * (tests): a fake fetch for every Anthropic call.
 */
export function createAccounts({ dataDir, claudeHome, exclusive, poolState, onReading, store, fetch: fetchImpl }) {
  const dir = path.join(dataDir, 'accounts')
  const metaFile = path.join(dataDir, 'accounts.json')
  const pendingFile = path.join(dir, 'pending-add.json')
  const usageCache = new Map() // id -> { at, value }: `at` = when last attempted (for the TTL)
  const usageReading = usageReader(onReading, { fetchImpl })
  let memo = null // { hash, id }: which account the live credential text belongs to
  const live = () => store || credentialStore(claudeHome)
  /** Serializes every slot read-compare-write, so two writers can't interleave. Not re-entrant. */
  let slotChain = Promise.resolve()
  const slotLock = (fn) => { const run = slotChain.then(fn, fn); slotChain = run.catch(() => {}); return run }
  const migrated = new Set() // slot ids already reduced to `claudeAiOauth` this process
  const slotFile = (id) => path.join(dir, `${id}.json`)
  // Claude Code's global config, whose `oauthAccount` describes the logged-in account.
  const globalConfig = () => (claudeHome() === path.join(os.homedir(), '.claude') ? path.join(os.homedir(), '.claude.json') : path.join(claudeHome(), '.claude.json'))

  const guard = () => { const b = accountsBlocked(); if (b) throw fail(501, b) }
  async function ensureDir() {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    await fsp.chmod(dir, 0o700)
  }
  async function loadMeta() {
    try { const list = JSON.parse(await fsp.readFile(metaFile, 'utf8')); return Array.isArray(list) ? list.filter((a) => ID_RE.test(a?.id || '')) : [] } catch { return [] }
  }
  /**
   * Saved accounts. On first sight each slot is migrated: older versions stored the whole live item
   * (including `mcpOAuth`), now only `claudeAiOauth` is kept. The file stays 0600.
   */
  async function load() {
    const list = await loadMeta()
    const todo = list.filter((a) => !migrated.has(a.id))
    if (todo.length) {
      await slotLock(async () => {
        for (const a of todo) {
          const text = await readSlot(a.id)
          let json = null
          try { json = JSON.parse(text) } catch { /* missing or unreadable: left alone */ }
          if (json && typeof json === 'object' && json.claudeAiOauth && Object.keys(json).some((k) => k !== 'claudeAiOauth')) await writeSlot(a.id, json.claudeAiOauth)
          migrated.add(a.id)
        }
      })
    }
    return list
  }
  async function saveMeta(list) {
    await fsp.mkdir(dataDir, { recursive: true })
    await writeAtomic(metaFile, JSON.stringify(list, null, 2) + '\n', 0o600)
  }
  const readSlot = (id) => (ID_RE.test(id) ? fsp.readFile(slotFile(id), 'utf8').catch(() => null) : Promise.resolve(null))
  /** Write a slot (call under slotLock): the login only, never any other key of the live item. */
  async function writeSlot(id, oauth) {
    await ensureDir()
    await writeAtomic(slotFile(id), slotText(oauth), 0o600)
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
  /**
   * Run fn holding Claude Code's own lock on its global config: Claude Code saves that file under a
   * proper-lockfile lock, a directory `<file>.lock` (mkdir is atomic), treated as abandoned once its
   * mtime is older than 10 s (proper-lockfile's default `stale`, which Claude Code keeps). Waits up to
   * `waitMs`; `{ locked: true }` when Claude still holds it then, else `{ value }`.
   */
  async function withConfigLock(file, fn, { waitMs = 3000 } = {}) {
    const lock = `${file}.lock`
    const deadline = Date.now() + waitMs
    for (let pause = 25; ; pause = Math.min(pause * 2, 400)) {
      try { await fsp.mkdir(lock); break } catch (e) {
        if (e?.code !== 'EEXIST') throw e
        const st = await fsp.stat(lock).catch(() => null)
        if (!st) continue // released just now
        if (Date.now() - st.mtimeMs > CONFIG_LOCK_STALE_MS) { await fsp.rmdir(lock).catch(() => {}); continue }
        if (Date.now() >= deadline) return { locked: true }
        await new Promise((r) => setTimeout(r, pause))
      }
    }
    try { return { value: await fn() } } finally { await fsp.rmdir(lock).catch(() => {}) }
  }
  /**
   * Set only `oauthAccount` in Claude's global config, if the file exists and the value differs.
   * Claude Code writes this file too, so the write holds Claude Code's lock on it (left alone when
   * Claude keeps it locked), the file is re-read right before writing, every other key is kept, and
   * the write is a temp file + rename. If the file changed while the new copy was being written, the
   * change is redone once on top of it; if it changes again, it is left alone.
   */
  async function writeOauthAccount(value) {
    const file = globalConfig()
    if (!(await fsp.stat(file).catch(() => null))) return false
    const r = await withConfigLock(file, () => writeOauthAccountLocked(file, value))
    return r.locked ? false : r.value
  }
  async function writeOauthAccountLocked(file, value) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await fsp.stat(file).catch(() => null)
      if (!before) return false
      const text = await fsp.readFile(file, 'utf8').catch(() => null)
      if (text === null) return false
      let json
      try { json = JSON.parse(text) } catch { return false }
      if (!json || typeof json !== 'object' || Array.isArray(json)) return false
      if (JSON.stringify(json.oauthAccount ?? null) === JSON.stringify(value ?? null)) return true
      if (value == null) delete json.oauthAccount; else json.oauthAccount = value
      const indent = /^[{[]\r?\n([ \t]+)/.exec(text)?.[1]
      const out = JSON.stringify(json, null, indent) + (text.endsWith('\n') ? '\n' : '')
      const tmp = `${file}.village-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
      try {
        await fsp.writeFile(tmp, out, { mode: before.mode & 0o777 })
        await fsp.chmod(tmp, before.mode & 0o777)
        const after = await fsp.stat(file).catch(() => null)
        if (!after || after.mtimeMs !== before.mtimeMs || after.size !== before.size) { await fsp.rm(tmp, { force: true }); continue }
        await fsp.rename(tmp, file)
        return true
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw e
      }
    }
    return false
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
    const { id } = await profile(o.accessToken, fetchImpl)
    memo = { hash, id }
    return id
  }

  /**
   * Keep a saved account's slot in step with Claude's copy (Claude rotates its tokens). Only a login
   * whose `expiresAt` is newer than the slot's is written, so an old copy read before a refresh can
   * never replace the refreshed one. Returns whether the slot was written.
   */
  async function syncSlot(id, text) {
    const o = oauthOf(text)
    if (!id || !o?.accessToken) return false
    await load() // migrated before the compare
    return slotLock(async () => {
      if (!(await loadMeta()).some((a) => a.id === id)) return false
      const cur = oauthOf(await readSlot(id))
      if (cur && !(expiresOf(o) > expiresOf(cur))) return false
      await writeSlot(id, o)
      return true
    })
  }

  /** Save a credential text as an account (dedupe by uuid). Needs the network for a new account. */
  async function saveLogin(text, label) {
    const o = oauthOf(text)
    if (!o?.accessToken) throw fail(409, 'No Claude login is stored. Run `claude auth login` first.')
    const list = await load()
    let id = await identify(text).catch(() => null)
    let email = list.find((a) => a.id === id)?.email
    if (!id || !email) {
      try { ({ id, email } = await profile(o.accessToken, fetchImpl)) } catch (e) { throw fail(502, e.fixed || "Couldn't reach Anthropic") }
      memo = { hash: sha(text), id }
    }
    await slotLock(() => writeSlot(id, o))
    migrated.add(id)
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
    const o = oauthOf(await readSlot(id))
    if (!o?.refreshToken) throw fixed('Login expired — sign in again')
    const r = await call(tokenUrl(), { tokenCall: true, fetchImpl, body: { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLIENT_ID, scope: (o.scopes || []).join(' ') } })
    if (typeof r?.access_token !== 'string') throw fixed('Unexpected response from Anthropic')
    o.accessToken = r.access_token
    if (typeof r.refresh_token === 'string') o.refreshToken = r.refresh_token
    if (Number(r.expires_in) > 0) o.expiresAt = Date.now() + Number(r.expires_in) * 1000
    // The old refresh token is spent now: the rotated login is saved whatever the slot holds.
    await slotLock(() => writeSlot(id, o))
  }

  /**
   * `{ accounts: [{ id, fiveHour, weekly, error?, stale?, checkedAt }] }`. The active account is
   * cached 60 s, inactive ones 5 min, unless `fresh`. `checkedAt` is when Anthropic sent the reading
   * shown (older than the last attempt when a stale reading is served during a rate limit).
   */
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
    const age = (id) => Date.now() - (usageCache.get(id)?.at || 0)
    const maybe = accounts.filter((a) => fresh || age(a.id) >= USAGE_TTL_MS)
    if (maybe.length) {
      // Unreadable (locked Keychain, timeout) is not "no login": the live account is then unknown, so
      // nothing is refreshed (any slot could be the live login) and no slot is synced.
      let liveText = null
      let liveKnown = false
      try { liveText = await live().read(); liveKnown = !liveText } catch { /* unknown */ }
      let liveId = null
      if (liveText) { try { liveId = await identify(liveText, { network: true }); liveKnown = true } catch { /* unknown */ } }
      const due = maybe.filter((a) => fresh || a.id === liveId || age(a.id) >= INACTIVE_USAGE_TTL_MS)
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
    return { accounts: accounts.map((a) => { const c = usageCache.get(a.id); return { ...c.value, checkedAt: c.value.checkedAt ?? c.at } }) }
  }

  /** The latest cached reading per saved account (Map id -> { fiveHour, weekly, error? }); never fetches. */
  const cachedUsage = () => new Map([...usageCache].map(([id, c]) => [id, c.value]))

  /**
   * Usage of the login in Claude's store only (the sampler, once a minute): read fresh, never
   * refreshed. `{ id, saved, fiveHour, weekly, error? }`, or null when no login is stored. A saved
   * account's reading also updates the menu's cache.
   */
  async function activeUsage() {
    guard()
    let text
    // Unreadable is not "no login" (null would read as signed out): an error reading, not saved, so
    // nothing acts on it.
    try { text = await live().read() } catch (e) { return { id: null, saved: false, fiveHour: null, weekly: null, error: e.fixed || "Couldn't read Claude's stored login", unreadable: true } }
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
    const text = await live().read() // unreadable throws: no pending add is started
    // Best effort: if the current login can't be saved (offline), it is still kept below to put back.
    const saved = text ? await saveLogin(text, '').catch(() => null) : null
    // Its account, so putting it back later can tell a rotated copy of it from a different login.
    const previousId = saved?.id ?? (text ? await identify(text).catch(() => null) : null)
    await ensureDir()
    await writeAtomic(pendingFile, JSON.stringify({ at: Date.now(), previous: text, previousId, oauthAccount: await readOauthAccount() }) + '\n', 0o600)
    return { command: 'claude auth login' }
  })

  async function readPending() {
    try { return JSON.parse(await fsp.readFile(pendingFile, 'utf8')) } catch { return null }
  }
  /** The account the login before an add belongs to (recorded at the start; older pending files: matched). */
  async function pendingPreviousId(pending) {
    if (typeof pending?.previousId === 'string' && ID_RE.test(pending.previousId)) return pending.previousId
    return pending?.previous ? identify(pending.previous).catch(() => null) : null
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
    const previousId = await pendingPreviousId(pending)
    let restored = false
    // Through restoreLive, never a raw write of the backup: its refresh token may be spent by now.
    if (pending.previous && previousId !== entry.id && await restoreLive(pending.previous, previousId)) {
      await writeOauthAccount(pending.oauthAccount)
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
    let restored = false
    // restoreLive keeps the same account's current (maybe rotated) login, else writes the fresher of
    // the backup and that account's slot; a raw write of the backup could put a spent token back.
    if (pending.previous && await restoreLive(pending.previous, await pendingPreviousId(pending))) {
      await writeOauthAccount(pending.oauthAccount)
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
    const liveText = await live().read().catch(() => null) // only for `signedIn` in the reply
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

  /**
   * Write `oauth` as the Claude login in Claude's store, keeping every other key of the item as it
   * is right now (MCP logins and the like). Returns the text written (null when nothing changed).
   * If the live item can't be read, this throws and writes nothing: writing without it would drop
   * every other key (MCP logins).
   */
  async function putLogin(oauth) {
    const cur = await live().read()
    const text = withOauth(cur, oauth)
    if (text === cur) return null
    await live().write(text)
    return text
  }

  /**
   * Put a saved account's login into Claude's store (inside a switch, which holds the lock). The
   * item is re-read first: if Claude rotated the outgoing account's tokens since the switch read
   * them, its slot is brought up to date before the login is replaced.
   */
  async function activate(id) {
    let slot = oauthOf(await readSlot(id))
    if (!slot?.accessToken) throw fail(409, 'That account has no saved login. Add it again.')
    const cur = await live().read()
    const curId = cur ? await identify(cur, { network: true }).catch(() => null) : null
    if (curId) await syncSlot(curId, cur)
    // An expired (or about to expire) saved login is refreshed first, so the check after the switch
    // is decisive. Only when the target is known not to be the live login: refreshing Claude's own
    // login would spend the refresh token Claude Code holds and sign it out.
    const notLive = !cur || (curId !== null && curId !== id)
    if (notLive && !(expiresOf(slot) > Date.now() + EXPIRY_MARGIN_MS)) {
      if (!refreshing.has(id)) refreshing.set(id, refreshSlot(id).finally(() => refreshing.delete(id)))
      try { await refreshing.get(id) } catch (e) {
        throw Object.assign(fail(e.rejected ? 409 : 502, `That account's saved login has expired and couldn't be renewed (${e.fixed || "couldn't refresh the login"}). Nothing was changed.`), { code: e.rejected ? 'login_expired' : 'refresh_failed' })
      }
      slot = oauthOf(await readSlot(id))
      if (!slot?.accessToken) throw fail(409, 'That account has no saved login. Add it again.')
    }
    // Already this account and fresher than the slot (just synced): keep Claude's copy.
    const oauth = curId === id && expiresOf(oauthOf(cur)) >= expiresOf(slot) ? oauthOf(cur) : slot
    const text = (await putLogin(oauth)) ?? cur
    memo = { hash: sha(text), id }
    const entry = (await load()).find((a) => a.id === id)
    if (entry?.oauthAccount) await writeOauthAccount(entry.oauthAccount)
  }

  /**
   * Put a backed-up live credential's login back (rollback and Undo). When Claude's current login is
   * the same account it is kept (Claude may have rotated it since); otherwise the fresher of the
   * backup's and that account's slot's login is written. Other keys of the item stay as they are now.
   * Returns whether Claude's store was written.
   */
  async function restoreLive(text, accountId) {
    const cur = await live().read() // unreadable throws: nothing is written
    if (cur === text) return false
    const curId = cur ? await identify(cur, { network: true }).catch(() => null) : null
    await syncSlot(curId, cur)
    if (accountId && curId === accountId) return false
    const slot = accountId ? oauthOf(await readSlot(accountId)) : null
    const backup = oauthOf(text)
    const best = slot && expiresOf(slot) > expiresOf(backup) ? slot : backup
    const written = await putLogin(best)
    memo = null
    return written !== null
  }

  /**
   * After a switch: is Claude's stored login accepted by Anthropic, and is it `expectedId` (the
   * account's profile uuid)? One profile call with the live access token; never returns or logs the
   * token or the email. `{ ok: true }` or `{ ok: false, reason }` ('login rejected' also carries
   * `expiresAt`, the login's expiry as a number). An unreadable store is 'could not read the login'
   * (unknown, not a failed swap), never 'no login stored'.
   */
  async function checkActive(expectedId) {
    let o
    try { o = oauthOf(await live().read()) } catch { return { ok: false, reason: 'could not read the login' } }
    if (!o?.accessToken) return { ok: false, reason: 'no login stored' }
    try {
      const { id } = await profile(o.accessToken, fetchImpl)
      if (id !== expectedId) return { ok: false, reason: 'signed in to a different account' }
      return { ok: true }
    } catch (e) {
      if (e.rejected) return { ok: false, reason: 'login rejected', expiresAt: expiresOf(o) }
      if (e.network) return { ok: false, reason: 'could not reach Anthropic' }
      if (e.rateLimited) return { ok: false, reason: 'Anthropic is rate-limiting checks' }
      return { ok: false, reason: 'unexpected response from Anthropic' }
    }
  }

  /**
   * `{ size, max, left }` (characters): how big Claude's live credential item is, the most the
   * Keychain helper can write (`max`/`left` null for a file store, which has no limit), and the room
   * left (negative = a switch would be refused with code 'too_big'). Lengths only, never content.
   * null when the item can't be read (or accounts are blocked here).
   */
  async function headroom() {
    if (accountsBlocked()) return null
    const s = live()
    try {
      if (typeof s.headroom === 'function') return await s.headroom()
      const text = await s.read()
      return { size: text === null ? 0 : Buffer.byteLength(text, 'utf8'), max: null, left: null }
    } catch { return null }
  }

  return {
    headroom, load, list, usage, cachedUsage, activeUsage, capture, addStart, addFinish, addCancel, rename, remove,
    readLive: () => live().read(), identify, syncSlot, activate, restoreLive, readOauthAccount, writeOauthAccount, checkActive,
  }
}
