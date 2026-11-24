/**
 * Gemini provider accounts, Antigravity CLI (`agy`). Facts: docs/antigravity-cli-notes.md §4.
 *
 * agy keeps ONE subscription sign-in in the OS keyring (macOS Keychain, Windows Credential Manager, Linux
 * Secret Service) and has no home or config relocation, so every agy process on this OS user shares it.
 * The Gemini provider is therefore single-account for now:
 *
 * - The account list shows at most one entry, "Antigravity sign-in", labelled by the user (default
 *   "Google account"). Agentville never reads, copies or writes the keyring item.
 * - Adding opens a terminal running plain `agy`, which signs in interactively on first launch.
 * - "I've signed in" confirms with a cheap headless `agy -p ok --output-format stream-json --print-timeout 20s`:
 *   signed in unless it fails with an authentication error (agy 1.5.16: result.error "authentication failed or
 *   timed out", exit 1). A headless run with no sign-in may also open a browser; that cannot be suppressed. The probe is injectable for tests.
 * - There is no switcher (the adapter's `switcher` is null). When Gemini is out, provider-switch hands agents
 *   off to Claude from the runs' limit stops.
 *
 * A limit hit recorded with `noteLimit(id)` marks the account out for a cautious 5 hours (agy's reset time is
 * undocumented).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAccountRegistry } from '../account-registry.mjs'
import { renameRetry } from '../fsutil.mjs'
import { launchTarget, parseEvents, runEnv, isAuthText, isQuotaText, scrub } from './runner.mjs'
import { RETRY_MS } from './limits.mjs'

export const PROVIDER = 'gemini'
/** The one account's id: there is one agy sign-in per OS user. */
export const ACCOUNT_ID = 'gemini-antigravity'
export const DEFAULT_LABEL = 'Google account'
export const ENTRY_KIND = 'Antigravity sign-in'
const PENDING_FRESH_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 40_000
/** agy's own cap on the probe turn, so a missing sign-in fails fast (agy 1.5.16 otherwise waits on a browser sign-in). */
export const PROBE_PRINT_TIMEOUT = '20s'
export const AGY_MISSING_MESSAGE = 'Antigravity CLI not found. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash (Windows: irm https://antigravity.google/cli/install.ps1 | iex)'
/** Old name, kept for importers. */
export const GEMINI_MISSING_MESSAGE = AGY_MISSING_MESSAGE
const fail = (status, message, extra) => Object.assign(new Error(message), { status }, extra)

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
 * Default sign-in check: one headless turn. -> { ok, auth?, missing?, error? }. Never throws.
 * `ok` unless agy says authentication is required (a quota error still proves a sign-in).
 */
export function probeSignIn({ bin, spawn = nodeSpawn, env = process.env, platform = process.platform, timeoutMs = PROBE_TIMEOUT_MS, cwd = os.homedir() } = {}) {
  return new Promise((resolve) => {
    if (!bin) return resolve({ ok: false, missing: true, error: AGY_MISSING_MESSAGE })
    let out = '', err = '', done = false
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    let child
    try {
      const t = launchTarget(bin, ['-p', 'ok', '--output-format', 'stream-json', '--mode', 'plan', '--print-timeout', PROBE_PRINT_TIMEOUT], { platform, env })
      child = spawn(t.file, t.args, { ...t.opts, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...runEnv({ base: env }), ...t.env } })
    } catch (e) { return resolve({ ok: false, error: scrub(e?.message || e) }) }
    const timer = setTimeout(() => { try { child.kill?.() } catch { /* gone */ } finish({ ok: false, error: 'The sign-in check timed out' }) }, timeoutMs)
    child.stdout?.on?.('data', (b) => { if (out.length < 256 * 1024) out += b })
    child.stderr?.on?.('data', (b) => { if (err.length < 64 * 1024) err += b })
    child.on?.('error', (e) => finish({ ok: false, missing: e?.code === 'ENOENT', error: e?.code === 'ENOENT' ? AGY_MISSING_MESSAGE : scrub(e?.message || e) }))
    child.on?.('close', (code) => {
      const ev = parseEvents(out)
      const text = [ev.error, err, ev.status === 'ERROR' ? ev.response : ''].filter(Boolean).join('\n')
      if (isAuthText(text)) return finish({ ok: false, auth: true, error: 'agy says authentication is required' })
      if (ev.status === 'SUCCESS' || ev.conversationId || isQuotaText(text)) return finish({ ok: true })
      if (code === 0) return finish({ ok: true })
      finish({ ok: false, error: scrub(text || `agy exited with code ${code}`) })
    })
  })
}

/**
 * `dataDir`: Agentville's data folder. `bin()`: resolves the agy path (async, may return null).
 * `probe({ bin })`: the sign-in check (default probeSignIn). `registry` (tests): `{ loadMeta, saveMeta }`.
 * `now`: clock (tests).
 */
export function createGeminiAccounts({ dataDir, bin = async () => null, probe = probeSignIn, registry, now = Date.now, platform = process.platform } = {}) {
  if (!dataDir) throw new Error('createGeminiAccounts: dataDir is required')
  const root = path.join(dataDir, 'accounts', 'gemini')
  const pendingFile = path.join(root, 'pending-add.json')
  const limitsFile = path.join(root, 'limits.json')
  const reg = registry || createAccountRegistry({ dataDir })

  let chain = Promise.resolve()
  /** Serializes every change (409-free queue). */
  const exclusive = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run }
  async function ensureRoot() {
    await fsp.mkdir(root, { recursive: true, mode: 0o700 })
    await fsp.chmod(root, 0o700).catch(() => {})
  }

  /** Saved rows, keeping only the single agy entry (rows from the old per-home Gemini CLI design are dropped). */
  const load = async () => (await reg.loadMeta(PROVIDER) || []).filter((a) => a?.id === ACCOUNT_ID)
  const saveMeta = (list) => reg.saveMeta(PROVIDER, list)
  const entryOf = async () => (await load())[0] || null
  /** True once a sign-in was confirmed with "I've signed in". */
  const signedIn = async () => { const e = await entryOf(); return Boolean(e && !e.signedOutAt) }
  /** A run failed with an auth error: keep the entry but mark it signed out until "I've signed in" again. */
  const noteSignedOut = (at = now()) => exclusive(async () => {
    const e = await entryOf()
    if (!e || e.signedOutAt || at <= (e.checkedAt || 0)) return false // an old failure from before the last sign-in
    await saveMeta([{ ...e, signedOutAt: at }])
    return true
  })
  const cleanLabel = (label) => {
    if (typeof label !== 'string') return ''
    const t = label.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    return t.length <= 60 ? t : ''
  }

  // --- errors-only usage --------------------------------------------------------------------
  let limits = null // id -> last limit hit (ms)
  async function readLimits() {
    if (!limits) {
      const j = await readJsonFile(limitsFile)
      limits = new Map(j && typeof j === 'object' ? Object.entries(j).filter(([k, v]) => k === ACCOUNT_ID && Number.isFinite(v)) : [])
    }
    return limits
  }
  function readingOf(id, at) {
    const t = now()
    const out = Number.isFinite(at) && at + RETRY_MS > t
    return { id, fiveHour: { used: out ? 100 : 0, resetsAt: out ? at + RETRY_MS : null }, weekly: { used: 0, resetsAt: null, none: true }, checkedAt: t, estimate: true }
  }

  const publicOf = (a) => ({ id: a.id, provider: PROVIDER, label: a.label || DEFAULT_LABEL, email: ENTRY_KIND, subscriptionType: null,
    authType: 'antigravity-keyring', quarantine: a.quarantine === true, lowPriority: a.lowPriority === true, active: true, signedIn: !a.signedOutAt, ...(a.signedOutAt && { note: 'Signed out: choose Add Gemini account to sign in again' }) })

  // --- AccountOps ---------------------------------------------------------------------------
  /** `{ active: <label> }` once a sign-in was confirmed, else null. Never a credential. */
  async function readLive() { const e = await entryOf(); return e ? { active: e.label || DEFAULT_LABEL } : null }
  async function identify() { return (await entryOf()) ? ACCOUNT_ID : null }

  async function list() {
    const e = await entryOf()
    return {
      active: e ? ACCOUNT_ID : 'unknown',
      accounts: e ? [publicOf(e)] : [],
      pool: { available: false },
      login: { present: Boolean(e), id: e ? ACCOUNT_ID : null },
      adding: fs.existsSync(pendingFile),
      single: true,
    }
  }
  async function usage() {
    const e = await entryOf()
    return { accounts: e ? [readingOf(ACCOUNT_ID, (await readLimits()).get(ACCOUNT_ID))] : [] }
  }
  const cachedUsage = () => new Map([...(limits || new Map())].map(([id, at]) => [id, readingOf(id, at)]))
  async function activeUsage() {
    if (!(await entryOf())) return null
    return { ...readingOf(ACCOUNT_ID, (await readLimits()).get(ACCOUNT_ID)), saved: true }
  }

  /** Record that a Gemini agent stopped on a quota error at `at`. */
  const noteLimit = (id = ACCOUNT_ID, at = now()) => exclusive(async () => {
    if (id !== ACCOUNT_ID) return false
    const l = await readLimits()
    if ((l.get(id) || 0) >= at) return false
    l.set(id, at)
    await ensureRoot()
    await writeAtomic(limitsFile, JSON.stringify(Object.fromEntries(l)) + '\n')
    return true
  })

  const capture = async () => { throw fail(409, 'Sign in to Antigravity with "Sign in to Gemini (Antigravity)", then choose I\'ve signed in.') }

  /** argv that opens plain `agy` in a terminal, so the user signs in interactively. */
  function loginArgv(binPath) {
    if (!binPath) return null
    if (platform === 'win32') {
      const cmd = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
      if (/["%&|<>^]/.test(String(binPath))) throw fail(400, 'The agy program path has a character that cmd.exe cannot take safely')
      return [cmd, '/d', '/k', `"${binPath}"`]
    }
    // The terminal opens a fresh login shell whose PATH may differ: hand it the server's PATH, node's folder first.
    const PATHv = [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(':')
    return ['/usr/bin/env', `PATH=${PATHv}`, binPath]
  }

  /**
   * Step 1: return how to sign in (`{ command, argv|null, env }`). `bin` is the resolved agy path; when the
   * caller passes `bin` and it is empty, refuse before any pending state exists.
   */
  const addStart = (opts = {}) => exclusive(async () => {
    const b = 'bin' in opts ? opts.bin : await bin()
    if (!b) throw fail(409, AGY_MISSING_MESSAGE, { code: 'gemini_missing', body: { error: 'gemini_missing', message: AGY_MISSING_MESSAGE } })
    const old = await readJsonFile(pendingFile)
    if (old && !opts.force && Number.isFinite(old.at) && now() - old.at >= 0 && now() - old.at < PENDING_FRESH_MS) {
      throw fail(409, 'An Antigravity sign-in is already in progress. Finish or cancel it first.', { code: 'add_in_progress' })
    }
    await ensureRoot()
    await writeAtomic(pendingFile, JSON.stringify({ at: now() }) + '\n')
    return { command: 'agy', argv: loginArgv(b), env: {} }
  })

  /** Step 2: confirm the sign-in with a headless probe and save the single entry (label default "Google account"). */
  const addFinish = (body) => exclusive(async () => {
    const label = cleanLabel(body?.label)
    const res = await probe({ bin: await bin() })
    if (!res?.ok) {
      if (res?.missing) throw fail(409, AGY_MISSING_MESSAGE, { code: 'gemini_missing' })
      if (res?.auth) throw fail(409, 'Not signed in yet. Finish signing in to Antigravity in the terminal (run agy), then try again.', { code: 'not_signed_in' })
      throw fail(409, `Couldn't confirm the Antigravity sign-in: ${res?.error || 'unknown error'}`)
    }
    const prev = await entryOf()
    const { signedOutAt: _gone, ...kept } = prev || { addedAt: now() }
    const entry = { ...kept, id: ACCOUNT_ID, label: label || prev?.label || DEFAULT_LABEL, checkedAt: now() }
    await saveMeta([entry])
    await fsp.rm(pendingFile, { force: true })
    return { account: publicOf(entry), restored: false }
  })

  const addCancel = () => exclusive(async () => { await fsp.rm(pendingFile, { force: true }); return { restored: false } })

  const rename = (id, body) => exclusive(async () => {
    const hasLabel = body?.label !== undefined, hasQ = body?.quarantine !== undefined, hasLow = body?.lowPriority !== undefined
    if (!hasLabel && !hasQ && !hasLow) throw fail(400, 'Nothing to change: send label, quarantine and/or lowPriority')
    const label = hasLabel ? cleanLabel(body.label) : null
    if (hasLabel && !label) throw fail(400, 'label must be text of at most 60 characters')
    if (hasQ && typeof body.quarantine !== 'boolean') throw fail(400, 'quarantine must be true or false')
    if (hasLow && typeof body.lowPriority !== 'boolean') throw fail(400, 'lowPriority must be true or false')
    const entry = id === ACCOUNT_ID ? await entryOf() : null
    if (!entry) throw fail(404, 'No such account')
    if (hasLabel) entry.label = label
    if (hasQ) { if (body.quarantine) entry.quarantine = true; else delete entry.quarantine }
    if (hasLow) { if (body.lowPriority) entry.lowPriority = true; else delete entry.lowPriority }
    await saveMeta([entry])
    return { account: publicOf(entry) }
  })

  /** Forget the entry. The keyring sign-in stays (sign out with /logout inside agy). */
  const remove = (id) => exclusive(async () => {
    if (id !== ACCOUNT_ID || !(await entryOf())) throw fail(404, 'No such account')
    await saveMeta([])
    const l = await readLimits()
    if (l.delete(id)) await writeAtomic(limitsFile, JSON.stringify(Object.fromEntries(l)) + '\n')
    return { removed: id, note: 'Agentville forgot it. To sign out of Antigravity, run /logout inside agy.' }
  })

  /** One account: activating it is a no-op; anything else is unknown. */
  async function activate(id) {
    if (id !== ACCOUNT_ID || !(await entryOf())) throw fail(404, 'No such account')
    return false
  }
  const restoreLive = async () => false
  async function checkActive(expectedId) {
    if (!(await entryOf())) return { ok: false, reason: 'no login stored' }
    return expectedId === ACCOUNT_ID ? { ok: true } : { ok: false, reason: 'signed in to a different account' }
  }
  const headroom = async () => ({ size: 0, max: null, left: null })

  const accounts = {
    provider: PROVIDER, load, list, usage, cachedUsage, activeUsage, capture, addStart, addFinish, addCancel,
    rename, remove, readLive, identify, activate, restoreLive, checkActive, headroom, noteLimit, signedIn, noteSignedOut,
  }
  /** Thin aliases (§1.2). Nothing to write: the agy sign-in lives in the OS keyring and is never touched. */
  const credentials = {
    read: readLive,
    write: async () => { throw fail(409, 'The Antigravity sign-in is only written by agy itself') },
    identify: () => identify(),
  }
  return { accounts, switcher: null, credentials, loginArgv, root }
}
