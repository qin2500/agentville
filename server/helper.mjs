/**
 * The Helper: a Haiku model Agentville can call for small jobs (first: naming tasks).
 * Off by default. Settings live in `helper.json`. Spawns the claude binary directly (never a shell),
 * with no tools, no MCP, no user/project settings (so no hooks), in an empty directory.
 * Prompts and outputs are never logged.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { POOL_KEYS } from './account.mjs'

const DAILY_CAP = 300
const MAX_OUT = 1_000_000
const STRIP = new Set(['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'])

function claudeBinary() {
  const local = path.join(os.homedir(), '.local', 'bin', 'claude')
  return existsSync(local) ? local : 'claude'
}

// The child skips settings files (--setting-sources ""), so a pool account's gateway env is copied
// in by hand from the live settings.json, read fresh on every call. Personal mode needs nothing:
// the login is in the Keychain. Values are never logged or returned. CLAUDE_CONFIG_DIR is never set.
async function buildEnv(settingsFile, src = process.env) {
  const env = {}
  for (const [k, v] of Object.entries(src)) {
    if (STRIP.has(k) || k.startsWith('CLAUDE_CODE_') || k.startsWith('ANTHROPIC_') || POOL_KEYS.includes(k)) continue
    env[k] = v
  }
  try {
    const pool = JSON.parse(await fsp.readFile(settingsFile(), 'utf8'))?.env
    if (pool && typeof pool === 'object') {
      for (const k of POOL_KEYS) if (Object.hasOwn(pool, k) && typeof pool[k] === 'string') env[k] = pool[k]
    }
  } catch { /* no settings: personal mode */ }
  return env
}

const fail = (code, message) => Object.assign(new Error(message || code), { code })
const day = (ms) => new Date(ms).toISOString().slice(0, 10)

export function createHelper({ dir, spawnImpl = nodeSpawn, now = Date.now, claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  const file = path.join(dir, 'helper.json')
  let enabled = null
  let counter = { day: day(now()), n: 0 }
  let lastError = null
  let lastOkAt = null
  let queue = Promise.resolve()

  async function load() {
    if (enabled !== null) return enabled
    try { enabled = JSON.parse(await fsp.readFile(file, 'utf8'))?.enabled === true } catch { enabled = false }
    return enabled
  }

  function rollover() {
    const d = day(now())
    if (counter.day !== d) counter = { day: d, n: 0 }
  }

  async function status() {
    rollover()
    return { enabled: await load(), callsToday: counter.n, lastError, lastOkAt }
  }

  async function setEnabled(value) {
    if (typeof value !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { status: 400 })
    await load()
    await fsp.mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify({ enabled: value }) + '\n')
    await fsp.rename(tmp, file)
    enabled = value
    return status()
  }

  async function exec(prompt, { system, timeoutMs = 60000 } = {}) {
    if (!(await load())) throw fail('disabled', 'Helper is off')
    rollover()
    if (counter.n >= DAILY_CAP) throw fail('cap', 'Helper daily cap reached')
    counter.n++
    const cwd = path.join(dir, 'helper-cwd')
    await fsp.mkdir(cwd, { recursive: true })
    const args = ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'json',
      '--tools', '', '--strict-mcp-config', '--setting-sources', '']
    if (system) args.push('--system-prompt', String(system))
    const env = await buildEnv(() => path.join(claudeHome(), 'settings.json'))
    return new Promise((resolve, reject) => {
      let child
      try { child = spawnImpl(claudeBinary(), args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) } catch { return reject(fail('spawn', 'Could not start claude')) }
      let out = ''
      let settled = false
      const done = (err, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) { lastError = err.code === 'timeout' ? 'timed out' : err.message.slice(0, 80); reject(err) } else { lastError = null; lastOkAt = now(); resolve(value) }
      }
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} done(fail('timeout', 'Helper timed out')) }, timeoutMs)
      child.stdout?.on('data', (d) => { if (out.length < MAX_OUT) out += d })
      child.stderr?.on('data', () => {}) // drained, never kept or logged
      child.on('error', () => done(fail('spawn', 'Could not start claude')))
      child.on('close', (code) => {
        if (code !== 0) return done(fail('exit', `claude exited with code ${code}`))
        try {
          const parsed = JSON.parse(out)
          if (parsed?.is_error || typeof parsed?.result !== 'string') return done(fail('bad-output', 'Unexpected claude output'))
          done(null, parsed.result)
        } catch { done(fail('bad-output', 'Unparseable claude output')) }
      })
      try { child.stdin.on('error', () => {}); child.stdin.end(String(prompt ?? '')) } catch {}
    })
  }

  /** One call at a time. */
  function run(prompt, opts) {
    const p = queue.then(() => exec(prompt, opts))
    queue = p.catch(() => {})
    return p
  }

  return { status, setEnabled, run }
}
