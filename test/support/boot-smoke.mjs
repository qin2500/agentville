#!/usr/bin/env node
// CI smoke test: boot `node server/cli.mjs` against a fixture home and a temporary HOME / USERPROFILE,
// poll GET /api/agents until it answers 200, then stop the server. Exit 0 on success, 1 otherwise.
//   node test/support/boot-smoke.mjs [port]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeHome } from '../fixtures/make-home.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = Number(process.argv[2] || 5275)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'va-boot-'))
const home = path.join(tmp, 'home')
fs.mkdirSync(home)
const fixtures = makeHome(path.join(tmp, 'fx'))
const env = { ...process.env, ...fixtures, HOME: home, USERPROFILE: home, AGENTVILLE_PORT: String(port), AGENTVILLE_DATA_DIR: path.join(tmp, 'data') }
const child = spawn(process.execPath, [path.join(ROOT, 'server', 'cli.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })
let exited = null
child.on('exit', (code) => { exited = code })

let ok = false
const t0 = Date.now()
while (Date.now() - t0 < 60_000 && exited === null) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/agents`)
    if (r.status === 200) { const body = await r.json(); console.log(`GET /api/agents -> 200 (${(body.agents || body).length ?? '?'} agents)`); ok = true; break }
  } catch { /* not listening yet */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (exited !== null && !ok) console.error(`server exited early with code ${exited}`)
child.kill()
await new Promise((r) => setTimeout(r, 500))
if (!ok) console.error(out)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
