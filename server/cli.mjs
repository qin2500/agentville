#!/usr/bin/env node
/** `npm start`: build web/dist if it is missing or older than web/ sources, then serve on 127.0.0.1. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { adoptLegacyEnv, resolveDataDir } from './datadir.mjs'

// Before anything else loads: on an older Node the server would fail later with a cryptic error.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Agentville needs Node.js 22.13 or newer; this is ${process.version}.
Install a current Node from https://nodejs.org (or \`brew install node\`, or \`nvm install 22\`), then run ./setup.sh again.`)
  process.exit(1)
}
adoptLegacyEnv() // VILLAGE_* settings from before the rename still work
const { createServer } = await import('./serve.mjs')

const rawPort = process.env.AGENTVILLE_PORT ?? ''
const port = rawPort === '' ? 5275 : /^\d+$/.test(rawPort.trim()) ? Number(rawPort.trim()) : NaN
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`AGENTVILLE_PORT must be a whole number from 1 to 65535 (got "${rawPort}").`)
  process.exit(1)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')

/** Newest mtime of the web sources (not dist, not node_modules); 0 when web/ isn't shipped. */
function newestSource(dir = WEB) {
  let newest = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'dist' || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    newest = Math.max(newest, e.isDirectory() ? newestSource(p) : fs.statSync(p).mtimeMs)
  }
  return newest
}

const built = fs.statSync(path.join(WEB, 'dist', 'index.html'), { throwIfNoEntry: false })?.mtimeMs || 0
const hasSources = fs.existsSync(path.join(WEB, 'index.html'))
if (!built || (hasSources && newestSource() > built)) {
  console.log(built ? 'Web sources changed; rebuilding…' : 'Building the web app (first run)…')
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) console.error('Build failed; serving the API only. Run `npm install && npm run build` to see the village.')
}
// A local dashboard should outlive one bad request or a full disk: log and keep serving.
// (Writing the log can itself fail when the disk is full, so the logging can't throw either.)
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})
const report = (what) => (e) => { try { console.error(`Agentville kept running after ${what}:`, e) } catch { /* disk full */ } }
process.on('uncaughtException', report('an uncaught error'))
process.on('unhandledRejection', report('an unhandled rejection'))
const server = createServer({ dataDir: resolveDataDir() })
// Hang up the built-in terminals on the way out (for `claude attach`, that only detaches).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, async () => { await server.terms.closeAll(); process.exit(0) })
server
  .on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Set AGENTVILLE_PORT to use another.` : e.message); process.exit(1) })
  .listen(port, '127.0.0.1', () => console.log(`Agentville running at http://127.0.0.1:${port}/  (Ctrl-C to stop)`))
