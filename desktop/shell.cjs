'use strict'
/**
 * The desktop app's plain-Node half: settings, finding Node, probing the port, the link policy and
 * window placement. No Electron imports, so `node --test` covers it (test/desktop.test.mjs).
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawnSync } = require('node:child_process')

/** Everything that differs between the private and the public copy of this file. */
const BRAND = { name: 'Agentville', env: 'AGENTVILLE', defaultPort: 5275 }
/** A server started by the app that exits with this code wants to be started again (after an update). */
const RESTART_EXIT = 75
const MIN_NODE = [22, 13]

const envKey = (k) => `${BRAND.env}_${k}`

/** A port from a string or number, or null when it isn't 1..65535. */
function parsePort(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : null
  const s = String(v ?? '').trim()
  if (!/^\d+$/.test(s)) return null
  return parsePort(Number(s))
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null } catch { return null }
}
const isCheckout = (dir) => !!dir && fs.existsSync(path.join(dir, 'server', 'cli.mjs'))

/**
 * Where the checkout is and which port to use. First match wins:
 *   checkout: <ENV>_DESKTOP_REPO, config.json "repo", the path baked in at build time, the dev checkout
 *   port:     <ENV>_PORT, config.json "port", the default
 * Returns { repo, port, sources, problems } (problems: config values that were ignored, for the log).
 */
function resolveSettings({ env = process.env, configFile, bakedRepoFile, devRepo } = {}) {
  const config = (configFile && readJSON(configFile)) || {}
  const problems = []
  const candidates = [
    ['env', env[envKey('DESKTOP_REPO')]],
    ['config', typeof config.repo === 'string' ? config.repo : null],
    ['baked', bakedRepoFile ? readText(bakedRepoFile) : null],
    ['dev', devRepo],
  ]
  let repo = null, repoFrom = null
  for (const [from, dir] of candidates) {
    if (!dir) continue
    const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()))
    if (isCheckout(abs)) { repo = abs; repoFrom = from; break }
    problems.push(`${from} checkout ${abs} has no server/cli.mjs`)
  }
  let port = null, portFrom = null
  const rawEnvPort = env[envKey('PORT')]
  if (rawEnvPort != null && rawEnvPort !== '') {
    port = parsePort(rawEnvPort); portFrom = 'env'
    if (port == null) problems.push(`${envKey('PORT')} is not a port`)
  }
  if (port == null && config.port != null) {
    port = parsePort(config.port); portFrom = 'config'
    if (port == null) problems.push('config.json "port" is not a port')
  }
  if (port == null) { port = BRAND.defaultPort; portFrom = 'default' }
  return { repo, port, sources: { repo: repoFrom, port: portFrom }, problems }
}

/** The folders a Finder-launched app should also search for node, git, claude and codex (as launch.sh). */
function extraPath(home = os.homedir()) {
  let nvm = null
  try {
    const base = path.join(home, '.nvm', 'versions', 'node')
    const vs = fs.readdirSync(base).filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
    vs.sort((a, b) => compareVersions(b.slice(1), a.slice(1)))
    if (vs.length) nvm = path.join(base, vs[0], 'bin')
  } catch { /* no nvm */ }
  return [
    path.join(home, '.local', 'bin'), path.join(home, '.volta', 'bin'),
    path.join(home, '.fnm', 'aliases', 'default', 'bin'), ...(nvm ? [nvm] : []),
    '/opt/homebrew/bin', '/usr/local/bin',
  ]
}
/** PATH with the usual install folders first, without duplicates. */
function augmentedPath(envPath = process.env.PATH || '', home = os.homedir()) {
  const seen = new Set()
  return [...extraPath(home), ...envPath.split(path.delimiter)]
    .filter((d) => d && !seen.has(d) && seen.add(d))
    .join(path.delimiter)
}

function compareVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return 0
}
const nodeOk = (v) => !!v && compareVersions(v, MIN_NODE.join('.')) >= 0

/**
 * The system Node to run the server with: <ENV>_DESKTOP_NODE, else the first `node` on the
 * augmented PATH that is new enough. The same Node the browser launcher uses, so native modules
 * (node-pty) and `npm` next to it work exactly as they do in browser mode. Null when there is none.
 */
function findNode({ env = process.env, home = os.homedir(), version = nodeVersion } = {}) {
  const pinned = env[envKey('DESKTOP_NODE')]
  const dirs = augmentedPath(env.PATH || '', home).split(path.delimiter)
  const bins = pinned ? [pinned] : dirs.map((d) => path.join(d, process.platform === 'win32' ? 'node.exe' : 'node'))
  for (const bin of bins) {
    try { fs.accessSync(bin, fs.constants.X_OK) } catch { continue }
    const v = version(bin)
    if (nodeOk(v)) return { bin, version: v }
  }
  return null
}
function nodeVersion(bin) {
  const r = spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH || '' } })
  return r.status === 0 ? r.stdout.trim() : null
}

/**
 * What is on the port: 'ours' (answers with our page title), 'other' (something else answers or
 * holds it) or 'free' (connection refused).
 */
function probe(port, { host = '127.0.0.1', timeout = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout, agent: false, headers: { accept: 'text/html' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { if (body.length < 64 * 1024) body += c })
      res.on('end', () => resolve(body.includes(`<title>${BRAND.name}</title>`) ? 'ours' : 'other'))
      res.on('error', () => resolve('other'))
    })
    req.on('timeout', () => { req.destroy(); resolve('other') })
    req.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'free' : 'other'))
  })
}

/** Poll until our server answers, `stop()` says give up, or `ms` pass. Resolves true when ready. */
async function waitReady(port, { ms = 120_000, every = 400, stop = () => false } = {}) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if ((await probe(port)) === 'ours') return true
    if (stop()) return false
    await new Promise((r) => setTimeout(r, every))
  }
  return false
}

/** True when `url` is on the local server's origin (the only place the window may go). */
function isLocal(url, origin) {
  try { return new URL(url).origin === origin } catch { return false }
}
/** True for links the default browser (or mail app) should open. */
function isExternal(url) {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol) } catch { return false }
}

/** Permissions the page may use, as in the browser: notifications and writing to the clipboard. */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen'])

/**
 * Saved window bounds, kept only when most of the window lands on a display that exists now.
 * `displays` are workArea rectangles. Returns { width, height, x?, y? }.
 */
function placeWindow(saved, displays, fallback = { width: 1440, height: 900 }) {
  const ok = (n) => Number.isFinite(n)
  if (!saved || !ok(saved.width) || !ok(saved.height)) return { ...fallback }
  const width = Math.max(480, Math.round(saved.width)), height = Math.max(360, Math.round(saved.height))
  if (!ok(saved.x) || !ok(saved.y)) return { width, height }
  const visible = displays.some((d) => {
    const w = Math.min(saved.x + width, d.x + d.width) - Math.max(saved.x, d.x)
    const h = Math.min(saved.y + height, d.y + d.height) - Math.max(saved.y, d.y)
    return w >= Math.min(200, width / 2) && h >= Math.min(100, height / 2)
  })
  return visible ? { width, height, x: Math.round(saved.x), y: Math.round(saved.y) } : { width, height }
}

module.exports = {
  BRAND, RESTART_EXIT, envKey, parsePort, resolveSettings, extraPath, augmentedPath, compareVersions,
  findNode, probe, waitReady, isLocal, isExternal, ALLOWED_PERMISSIONS, placeWindow, readJSON,
}
