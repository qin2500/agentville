/**
 * Gemini accounts (docs/providers-design.md slot G4; facts in docs/gemini-cli-notes.md §5).
 *
 * One `GEMINI_CLI_HOME` folder per account, under `<data>/accounts/gemini/<home>/` (0700). The Gemini CLI
 * keeps everything for that account in `<home>/.gemini/` (oauth_creds.json, google_accounts.json, settings,
 * sessions). Agentville never copies, swaps or rewrites a credential file:
 *
 * - A live `gemini` process keeps its tokens in memory and on every refresh MERGES them into the
 *   oauth_creds.json of its own home. Swapping that file under it would mix two accounts. So
 *   "switching" only changes which home NEW Gemini runs get (`envFor()`); running ones finish on their
 *   own account. There is no restart.
 * - Adding an account runs the official `gemini` sign-in in a fresh, empty home. The account is then
 *   named from that home's `google_accounts.json` (`{ active: <email> }`). oauth_creds.json is only
 *   checked for existence; its content (tokens) is never opened.
 * - No Google API is called from here, and nothing here logs a token or an email.
 *
 * The active account is a stored pointer (`<data>/accounts/gemini/active.json`), unlike Claude, whose
 * live credential is the truth (§2.2): Gemini has no single live credential once every account has its
 * own home.
 *
 * Usage is errors-only until G6 (§1.4): a limit hit recorded with `noteLimit(id)` marks the account out
 * until the next 00:00 America/Los_Angeles (Gemini's daily quota day).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createAccountRegistry } from '../account-registry.mjs'
import { renameRetry } from '../fsutil.mjs'
import { quoteForShell } from '../platform.mjs'

export const PROVIDER = 'gemini'
const ID_RE = /^gemini-[a-f0-9]{16}$/
const HOME_RE = /^h-[a-f0-9]{16}$/
const EMAIL_MAX = 320
const READ_MAX = 64 * 1024
const PENDING_FRESH_MS = 10 * 60_000
const CTRL_RE = /[\u0000-\u001f\u007f]/

/** Read a small identity file: never through a symlink (O_NOFOLLOW where supported), at most 64 KB. Null on any problem. */
async function readSmall(file) {
  let fh
  try {
    fh = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const st = await fh.stat()
    if (!st.isFile() || st.size > READ_MAX) return null
    const buf = Buffer.alloc(Math.min(st.size, READ_MAX) + 1)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return bytesRead > READ_MAX ? null : buf.subarray(0, bytesRead).toString('utf8')
  } catch { return null } finally { await fh?.close().catch(() => {}) }
}
const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra)

/** Stable account id for a Google account: `gemini-` + 16 hex of sha256(lowercased email). */
export function geminiIdOf(email) {
  const e = String(email || '').trim().toLowerCase()
  if (!e) return null
  return `gemini-${crypto.createHash('sha256').update(e).digest('hex').slice(0, 16)}`
}

/** The email in a `google_accounts.json` text (`{ active, old }`), or null. Never anything else. */
export function emailOf(text) {
  try {
    const a = JSON.parse(text)?.active
    return typeof a === 'string' && a.includes('@') && a.length <= EMAIL_MAX ? a.trim() : null
  } catch { return null }
}

/**
 * What can be told about a Gemini home without reading a token:
 * `{ email, creds }`, where `creds` says whether `<home>/.gemini/oauth_creds.json` exists (stat only).
 */
export async function readIdentity(home) {
  const dir = path.join(home, '.gemini')
  const text = await readSmall(path.join(dir, 'google_accounts.json'))
  const creds = await fsp.stat(path.join(dir, 'oauth_creds.json')).then((s) => s.isFile() && s.size > 0, () => false)
  return { email: text === null ? null : emailOf(text), creds }
}

/** Next 00:00 in America/Los_Angeles after `now` (ms). Gemini's per-day quotas reset then. */
export function nextPacificMidnight(now = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]))
  const sinceMidnight = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + (now % 1000)
  let guess = now - sinceMidnight + 24 * 3600_000
  // A DST change makes that day 23 or 25 h long: step to the hour where the local clock reads 00.
  for (const d of [0, -3600_000, 3600_000]) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess + d)).map((x) => [x.type, x.value]))
    if (p.hour === '00' && p.minute === '00') { guess += d; break }
  }
  return guess
}

const NO_LIMIT = Object.freeze({ used: 0, resetsAt: null, none: true })

async function writeAtomic(file, text) {
  const tmp = `${file}.agentville-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    await fsp.writeFile(tmp, text, { mode: 0o600 })
    await fsp.chmod(tmp, 0o600)
    await renameRetry(tmp, file)
  } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e }
}
const readJsonFile = (file) => fsp.readFile(file, 'utf8').then((t) => JSON.parse(t), () => null).catch(() => null)

/**
 * `dataDir`: Agentville's data folder. `registry` (tests): a `{ loadMeta, saveMeta }` instead of
 * `createAccountRegistry`. `network`: `{ onWork() }` for quarantine accounts (optional).
 * `busyHomes()`: Promise<Iterable<string>> of home folders that running Gemini processes use (from the
 * runner), so a removal never pulls a login out from under one (optional). `now`: clock (tests).
 */
export function createGeminiAccounts({ dataDir, registry, network, busyHomes, now = Date.now, platform = process.platform } = {}) {
  if (!dataDir) throw new Error('createGeminiAccounts: dataDir is required')
  const root = path.join(dataDir, 'accounts', 'gemini')
  const pendingFile = path.join(root, 'pending-add.json')
  const activeFile = path.join(root, 'active.json')
  const limitsFile = path.join(root, 'limits.json')
  const reg = registry || createAccountRegistry({ dataDir })
  const homePath = (name) => (HOME_RE.test(name || '') ? path.join(root, name) : null)
  const newHomeName = (prefix) => `${prefix}-${crypto.randomBytes(8).toString('hex')}`

  let chain = Promise.resolve()
  /** Serializes every change to accounts, the pointer and the pending add (409-free queue). */
  const exclusive = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run }

  async function ensureRoot() {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 })
    await fsp.chmod(root, 0o700)
  }
  async function makeHome(name) {
    await ensureRoot()
    const home = path.join(root, name)
    await fsp.mkdir(path.join(home, '.gemini'), { recursive: true, mode: 0o700 })
    await fsp.chmod(home, 0o700)
    await fsp.chmod(path.join(home, '.gemini'), 0o700)
    // Ask for "Login with Google" up front, so the sign-in doesn't stop at the auth-type picker.
    await writeAtomic(path.join(home, '.gemini', 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }, null, 2) + '\n')
    return home
  }

  const load = () => reg.loadMeta(PROVIDER)
  const saveMeta = (list) => reg.saveMeta(PROVIDER, list)
  const cleanLabel = (label) => {
    if (typeof label !== 'string') return ''
    const t = label.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    return t.length <= 60 ? t : ''
  }
  /** An email as a default label: rejected (not stripped) when it has control characters or is over 80 chars. */
  const emailLabel = (email) => (typeof email === 'string' && !CTRL_RE.test(email) && email.length <= 80 ? email : 'Gemini account')
  /** Remove a pending home, unless a saved account lists it (a stale pending file must never delete a login). */
  async function rmPendingHome(name, accounts) {
    const dir = homePath(name)
    if (!dir) return false
    if (accounts.some((a) => a.home === name || (a.oldHomes || []).includes(name))) return false
    await fsp.rm(dir, { recursive: true, force: true })
    return true
  }

  // --- the active pointer -------------------------------------------------------------------
  async function readPointer() {
    const p = await readJsonFile(activeFile)
    return p && typeof p === 'object' ? p : {}
  }
  async function writePointer(p) { await ensureRoot(); await writeAtomic(activeFile, JSON.stringify(p) + '\n') }
  /** The active saved account's id, or null. A pointer to a removed account counts as none. */
  async function activeId(list) {
    const p = await readPointer()
    const rows = list || await load()
    return typeof p.id === 'string' && rows.some((a) => a.id === p.id) ? p.id : null
  }

  // --- errors-only usage --------------------------------------------------------------------
  let limits = null // id -> last limit hit (ms)
  async function readLimits() {
    if (!limits) {
      const j = await readJsonFile(limitsFile)
      limits = new Map(j && typeof j === 'object' ? Object.entries(j).filter(([k, v]) => ID_RE.test(k) && Number.isFinite(v)) : [])
    }
    return limits
  }
  function readingOf(id, at) {
    const t = now()
    const resetsAt = nextPacificMidnight(t)
    const out = Number.isFinite(at) && nextPacificMidnight(at) > t
    return { id, fiveHour: NO_LIMIT, weekly: { used: out ? 100 : 0, resetsAt }, checkedAt: t }
  }

  const publicOf = (a, liveId) => ({ id: a.id, provider: PROVIDER, label: a.label, email: a.email, subscriptionType: null,
    authType: a.authType || 'oauth-personal', quarantine: a.quarantine === true, lowPriority: a.lowPriority === true,
    active: a.id === liveId, signedIn: a.id === liveId })

  // --- AccountOps ---------------------------------------------------------------------------
  /**
   * The identity text of the active account: its `google_accounts.json` (an email, no token), or null
   * when no account is active. This is `credentials.read()`; it never returns oauth_creds.json.
   */
  async function readLive() {
    const list = await load()
    const id = await activeId(list)
    const home = homePath(list.find((a) => a.id === id)?.home)
    if (!home) return null
    const text = await readSmall(path.join(home, '.gemini', 'google_accounts.json'))
    const email = text === null ? null : emailOf(text)
    return email ? { active: email } : null
  }

  /** Which saved account an identity text (`google_accounts.json`) names; null when unknown. Offline. */
  async function identify(text) {
    const id = geminiIdOf(typeof text === 'string' ? emailOf(text) : emailOf(JSON.stringify({ active: text?.active })))
    return id && (await load()).some((a) => a.id === id) ? id : null
  }

  async function list() {
    const accounts = await load()
    const liveId = await activeId(accounts)
    return {
      active: liveId || 'unknown',
      accounts: accounts.map((a) => publicOf(a, liveId)),
      pool: { available: false },
      login: { present: Boolean(liveId), id: liveId },
      adding: fs.existsSync(pendingFile),
    }
  }

  async function usage() {
    const accounts = await load()
    const l = await readLimits()
    return { accounts: accounts.map((a) => readingOf(a.id, l.get(a.id))) }
  }
  /** Map id -> reading (never reads anything new beyond the local limit ledger). */
  const cachedUsage = () => new Map([...(limits || new Map())].map(([id, at]) => [id, readingOf(id, at)]))
  async function activeUsage() {
    const id = await activeId()
    if (!id) return null
    return { ...readingOf(id, (await readLimits()).get(id)), saved: true }
  }

  /** Record that a Gemini agent on account `id` stopped on a quota error at `at` (limits/scan call this). */
  const noteLimit = (id, at = now()) => exclusive(async () => {
    if (!ID_RE.test(id || '')) return false
    const l = await readLimits()
    if ((l.get(id) || 0) >= at) return false
    l.set(id, at)
    await ensureRoot()
    await writeAtomic(limitsFile, JSON.stringify(Object.fromEntries(l)) + '\n')
    return true
  })

  /** Claude's capture saves "the login the CLI has now"; Gemini accounts are only added in their own home. */
  const capture = async () => { throw fail(409, 'Gemini accounts are added with "Add a Gemini account", which signs in in a separate folder.') }

  /** argv that opens the official `gemini` sign-in in `home` (the terminal opener takes argv, no env). */
  function loginArgv(bin, home) {
    if (!bin) return null
    if (platform === 'win32') {
      const cmd = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
      for (const v of [home, bin]) if (/["%&|<>^]/.test(String(v))) throw fail(400, 'The Gemini folder or program path has a character that cmd.exe cannot take safely')
      return [cmd, '/d', '/k', `set "GEMINI_CLI_HOME=${home}" && set "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=false" && "${bin}"`]
    }
    return ['/usr/bin/env', `GEMINI_CLI_HOME=${home}`, 'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=false', bin]
  }

  /**
   * Step 1 of adding: make a fresh, empty home and return how to sign in there. The caller (serve.mjs)
   * opens `argv` in the built-in terminal; `bin` is the resolved `gemini` path (optional).
   * -> `{ command, argv|null, env, home }`. A previous unfinished add is discarded first.
   */
  const addStart = (opts = {}) => exclusive(async () => {
    const old = await readJsonFile(pendingFile)
    if (homePath(old?.home) && !opts.force && Number.isFinite(old.at) && now() - old.at >= 0 && now() - old.at < PENDING_FRESH_MS) {
      throw fail(409, 'A Gemini sign-in is already in progress. Finish or cancel it first.', { code: 'add_in_progress' })
    }
    if (old?.home) await rmPendingHome(old.home, await load())
    const name = newHomeName('h')
    const home = await makeHome(name)
    await writeAtomic(pendingFile, JSON.stringify({ at: now(), home: name }) + '\n')
    const command = platform === 'win32'
      ? `$env:GEMINI_CLI_HOME=${quoteForShell(home, { platform })}; $env:GEMINI_FORCE_ENCRYPTED_FILE_STORAGE='false'; gemini`
      : `GEMINI_CLI_HOME=${quoteForShell(home, { platform })} GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=false gemini`
    return { command, argv: loginArgv(opts.bin, home), env: { GEMINI_CLI_HOME: home }, home }
  })

  /**
   * Step 2: the sign-in finished in the pending home. Name it from google_accounts.json and save it.
   * A Google account that is already saved gets the new home (its old home is kept, untouched, for
   * any run still using it). Nothing is moved or renamed: the sign-in terminal may still be open in the
   * pending folder, which simply becomes the account's home.
   */
  const addFinish = (body) => exclusive(async () => {
    const label = cleanLabel(body?.label)
    const pending = await readJsonFile(pendingFile)
    const home = homePath(pending?.home)
    if (!home) throw fail(409, 'Start adding an account first')
    const { email, creds } = await readIdentity(home)
    if (!creds || !email) throw fail(409, 'No Google sign-in yet. Finish signing in to Gemini in the terminal, then try again.')
    const id = geminiIdOf(email)
    const accounts = await load()
    let entry = accounts.find((a) => a.id === id)
    if (!entry) accounts.push(entry = { id, label: label || emailLabel(email), email, authType: 'oauth-personal', addedAt: now() })
    else {
      if (homePath(entry.home) && entry.home !== pending.home) entry.oldHomes = [...new Set([...(entry.oldHomes || []), entry.home])].filter((h) => HOME_RE.test(h))
      entry.email = email
    }
    if (label) entry.label = label
    entry.home = pending.home
    await fsp.rm(pendingFile, { force: true })
    await saveMeta(accounts)
    // The first account becomes the active one, so Gemini runs have a home right away.
    let liveId = await activeId(accounts)
    if (!liveId) { await writePointer({ id, at: now(), prev: null }); liveId = id }
    return { account: publicOf(entry, liveId), restored: false }
  })

  /** Abandon an add: the pending home is ours and new, so it is deleted. Nothing else changes. */
  const addCancel = () => exclusive(async () => {
    const pending = await readJsonFile(pendingFile)
    if (pending?.home) await rmPendingHome(pending.home, await load())
    await fsp.rm(pendingFile, { force: true })
    return { restored: false }
  })

  const rename = (id, body) => exclusive(async () => {
    const hasLabel = body?.label !== undefined, hasQ = body?.quarantine !== undefined, hasLow = body?.lowPriority !== undefined
    if (!hasLabel && !hasQ && !hasLow) throw fail(400, 'Nothing to change: send label, quarantine and/or lowPriority')
    const label = hasLabel ? cleanLabel(body.label) : null
    if (hasLabel && !label) throw fail(400, 'label must be text of at most 60 characters')
    if (hasQ && typeof body.quarantine !== 'boolean') throw fail(400, 'quarantine must be true or false')
    if (hasLow && typeof body.lowPriority !== 'boolean') throw fail(400, 'lowPriority must be true or false')
    const accounts = await load()
    const entry = accounts.find((a) => a.id === id)
    if (!entry) throw fail(404, 'No such account')
    if (hasLabel) entry.label = label
    if (hasQ) { if (body.quarantine) entry.quarantine = true; else delete entry.quarantine }
    if (hasLow) { if (body.lowPriority) entry.lowPriority = true; else delete entry.lowPriority }
    await saveMeta(accounts)
    return { account: publicOf(entry, await activeId(accounts)) }
  })

  /**
   * Forget an account and delete its saved Google login (the credential files only; its session history
   * stays readable). Refused while it is the active account or while a Gemini run uses one of its homes.
   */
  const remove = (id) => exclusive(async () => {
    const accounts = await load()
    const entry = accounts.find((a) => a.id === id)
    if (!entry) throw fail(404, 'No such account')
    if ((await activeId(accounts)) === id) throw fail(409, 'That is the active Gemini account. Switch to another account first.')
    const homes = [entry.home, ...(entry.oldHomes || [])].map(homePath).filter(Boolean)
    const busy = new Set([...(await (busyHomes?.() ?? []))].map((h) => path.resolve(h)))
    if (homes.some((h) => busy.has(path.resolve(h)))) throw fail(409, 'Gemini agents are still running on that account. Stop them first.')
    await saveMeta(accounts.filter((a) => a.id !== id))
    for (const h of homes) {
      for (const f of ['oauth_creds.json', 'google_accounts.json', 'gemini-credentials.json']) await fsp.rm(path.join(h, '.gemini', f), { force: true })
    }
    const l = await readLimits()
    if (l.delete(id)) await writeAtomic(limitsFile, JSON.stringify(Object.fromEntries(l)) + '\n')
    return { removed: id }
  })

  /** Make `id` the account new Gemini runs use. Writes the pointer only; no credential file is touched. */
  async function activate(id) {
    const accounts = await load()
    const entry = accounts.find((a) => a.id === id)
    if (!entry) throw fail(404, 'No such account')
    const home = homePath(entry.home)
    const ident = home ? await readIdentity(home) : { creds: false }
    if (!ident.creds) throw fail(409, 'That Gemini account has no saved sign-in. Add it again.', { code: 'login_expired' })
    if (geminiIdOf(ident.email) !== id) throw fail(409, 'That folder is signed in to a different Google account. Add the account again.', { code: 'login_expired' })
    const p = await readPointer()
    if (p.id === id) return false
    await writePointer({ id, at: now(), prev: typeof p.id === 'string' ? p.id : null })
    return true
  }

  /** Put the pointer back on `accountId` (or the account `text` names). Returns whether it changed. */
  async function restoreLive(text, accountId) {
    const id = accountId || (text ? await identify(text) : null)
    if (!id) return false
    const p = await readPointer()
    if (p.id === id) return false
    const entry = (await load()).find((a) => a.id === id)
    if (!entry) return false
    if (entry.quarantine && (await network?.onWork?.())) throw fail(409, `${entry.label} is a quarantine account, and quarantine accounts can't be used on the work Wi-Fi.`)
    const home = homePath(entry.home)
    const ident = home ? await readIdentity(home) : { creds: false }
    if (!ident.creds || geminiIdOf(ident.email) !== id) throw fail(409, 'That Gemini account\'s sign-in is missing or changed. Add the account again.', { code: 'login_expired' })
    await writePointer({ id, at: now(), prev: typeof p.id === 'string' ? p.id : null })
    return true
  }

  /** Is `expectedId` the active account, with a sign-in present in its home that names it? Offline. */
  async function checkActive(expectedId) {
    const accounts = await load()
    const id = await activeId(accounts)
    if (!id) return { ok: false, reason: 'no login stored' }
    if (id !== expectedId) return { ok: false, reason: 'signed in to a different account' }
    const home = homePath(accounts.find((a) => a.id === id)?.home)
    const ident = home ? await readIdentity(home) : { creds: false }
    if (!ident.creds) return { ok: false, reason: 'no login stored' }
    if (geminiIdOf(ident.email) !== id) return { ok: false, reason: 'signed in to a different account' }
    return { ok: true }
  }

  /** No Keychain size limit applies to a Gemini home. */
  const headroom = async () => ({ size: 0, max: null, left: null })

  const accounts = {
    provider: PROVIDER, load, list, usage, cachedUsage, activeUsage, capture, addStart, addFinish, addCancel,
    rename, remove, readLive, identify, activate, restoreLive, checkActive, headroom, noteLimit,
  }

  // --- for the runner and the scan ----------------------------------------------------------
  /**
   * Env for a new Gemini run: `{ GEMINI_CLI_HOME, GEMINI_FORCE_ENCRYPTED_FILE_STORAGE:'false' }` for
   * account `id` (default: the active one), or null when no account is saved/active (the CLI's own
   * home is used). Throws 409 (code 'login_expired') when that home's sign-in is gone or names someone else.
   * The second key keeps the login in the home folder: keychain mode is not per home.
   */
  async function envFor(id) {
    const list = await load()
    const want = id || await activeId(list)
    const entry = list.find((a) => a.id === want)
    const home = homePath(entry?.home)
    if (!home) return null
    if (entry.quarantine && (await network?.onWork?.())) throw fail(409, `${entry.label} is a quarantine account, and quarantine accounts can't be used on the work Wi-Fi.`)
    // Someone may have used /auth inside that home: never run on a login that isn't this account.
    const ident = await readIdentity(home)
    if (!ident.creds || geminiIdOf(ident.email) !== want) throw fail(409, 'That Gemini account\'s sign-in is missing or changed. Add the account again.', { code: 'login_expired' })
    return { GEMINI_CLI_HOME: home, GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false' }
  }
  /** Every account home folder Agentville made (current and earlier), for session discovery. */
  async function homes() {
    const names = await fsp.readdir(root).catch(() => [])
    return names.filter((n) => HOME_RE.test(n)).map((n) => path.join(root, n))
  }
  /** The saved account a home folder belongs to (null when none). */
  async function accountOfHome(home) {
    const name = path.basename(path.resolve(home))
    if (path.dirname(path.resolve(home)) !== path.resolve(root)) return null
    return (await load()).find((a) => a.home === name || (a.oldHomes || []).includes(name))?.id || null
  }

  // --- SwitchOps ----------------------------------------------------------------------------
  let busy = false
  const switches = []
  const plans = new Map()
  let changedAt = 0
  const liveGemini = (agents) => (agents || []).filter((a) => a && a.live && (a.provider === PROVIDER || a.harness === 'gemini-cli'))
  const KEEP = 'Keeps its account until it finishes; new Gemini agents use the new one'

  async function audit(entry) {
    if (entry.action === 'undo' || entry.action === 'switch') changedAt = now()
    await fsp.mkdir(dataDir, { recursive: true })
    await fsp.appendFile(path.join(dataDir, 'account-log.jsonl'), JSON.stringify({ at: now(), provider: PROVIDER, ...entry }) + '\n', { mode: 0o600 })
  }
  const plainWhy = (why) => (typeof why === 'string' ? why.slice(0, 200) : undefined)
  async function quarantined(id) {
    const q = (await load()).find((a) => a.id === id && a.quarantine)
    return q && (await network?.onWork?.()) ? q : null
  }

  async function status(agents) {
    const jobs = liveGemini(agents).map((a) => ({ id: a.id, name: a.name || a.id, live: true, model: a.model || '' }))
    const confirm = crypto.randomUUID()
    for (const [k, v] of plans) if (now() > v) plans.delete(k)
    plans.set(confirm, now() + 120_000)
    return { profile: 'personal', provider: PROVIDER, personalReady: true, poolStashed: false, blocked: null,
      plan: { jobs, sessions: [] }, confirm, restarts: [], note: 'Running Gemini agents keep their account until they finish.' }
  }

  /**
   * `{ to, confirm }` -> `{ to, restored:false, results, sessions:[], verified }`. Only the pointer moves;
   * every live Gemini agent is reported 'unchanged'. `auto` (autoswitch) needs no confirm.
   */
  async function switchTo(body, agents, { auto = false, why } = {}) {
    const saved = await load()
    const target = saved.find((a) => a.id === body?.to)
    if (!target) throw fail(400, 'to must be a saved Gemini account id')
    if (target.quarantine && (await network?.onWork?.())) throw fail(409, `${target.label} is a quarantine account, and quarantine accounts can't be used on the work Wi-Fi.`)
    if (busy) throw fail(409, 'A switch is already running')
    const t = now()
    while (switches.length && t - switches[0] > 60_000) switches.shift()
    if (switches.length >= 3) throw fail(429, 'Too many switches; wait a minute')
    if (!auto) {
      const exp = typeof body.confirm === 'string' && plans.get(body.confirm)
      if (!exp || t > exp) throw fail(409, 'This preview has expired. Open it again.')
    }
    busy = true
    try {
      return await exclusive(async () => {
        const from = await activeId()
        if (from === target.id) throw fail(409, 'Already on that account')
        if (!auto) plans.delete(body.confirm)
        switches.push(t)
        try { await activate(target.id) } catch (e) {
          await audit({ action: 'switch', from, account: target.id, auto: auto === true, ...(plainWhy(why) && { why: plainWhy(why) }), restored: true, ...(e.code && { code: e.code }), results: [] })
          throw e
        }
        const check = await checkActive(target.id)
        const results = liveGemini(agents).map((a) => ({ id: a.id, status: 'unchanged', detail: KEEP }))
        await audit({ action: 'switch', from, account: target.id, auto: auto === true, ...(plainWhy(why) && { why: plainWhy(why) }), verified: check.ok, restored: false, results })
        return { to: target.id, restored: false, results, sessions: [], verified: check.ok, ...(!check.ok && { note: check.reason }) }
      })
    } finally { busy = false }
  }

  /** Point back at the account active before the last switch. */
  async function undo() {
    if (busy) throw fail(409, 'A switch is already running')
    busy = true
    try {
      return await exclusive(async () => {
        const p = await readPointer()
        const accounts = await load()
        if (typeof p.prev !== 'string' || !accounts.some((a) => a.id === p.prev)) throw fail(409, 'Nothing to undo')
        const q = await quarantined(p.prev)
        if (q) throw fail(409, `Undo would switch back to ${q.label}, a quarantine account, and quarantine accounts can't be used on the work Wi-Fi.`)
        await writePointer({ id: p.prev, at: now(), prev: p.id ?? null })
        await audit({ action: 'undo', from: p.id ?? null, account: p.prev })
        return { profile: 'personal', provider: PROVIDER, restoredFrom: 'switch to account' }
      })
    } finally { busy = false }
  }

  async function lastChangeAt() {
    if (changedAt) return changedAt
    const p = await readPointer()
    return Number.isFinite(p.at) ? p.at : 0
  }

  const switcher = {
    provider: PROVIDER, status, switchTo, undo, lastChangeAt, accounts,
    isBusy: () => busy,
    profile: async () => 'personal',
    settled: async () => [],
    respawnStale: async () => ({ queued: [], reason: 'Gemini agents are not restarted on a switch' }),
    noteDrift: async () => {},
    poolAvailable: () => false,
  }

  /** Thin aliases for the adapter (§1.2). There is nothing to write: a Gemini login is never written by us. */
  const credentials = {
    read: readLive,
    write: async () => { throw fail(409, 'Gemini logins are only written by the Gemini CLI sign-in') },
    identify: (text) => identify(text),
  }

  return { accounts, switcher, credentials, envFor, homes, accountOfHome, loginArgv, root }
}
