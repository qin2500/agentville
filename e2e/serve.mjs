// Playwright webServer: fresh fixture home, fresh build, then the real CLI entry point.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { prepareHome, sweepStaleTemp, HOME, PORT, ROOT, SAFE_ENV } from './helpers.mjs'

sweepStaleTemp()
// If stopped by a catchable signal, take the fixture home along (teardown.mjs covers SIGKILL).
const bye = () => { fs.rmSync(HOME, { recursive: true, force: true }); process.exit(0) }
process.once('SIGTERM', bye).once('SIGINT', bye)
Object.assign(process.env, prepareHome(), { AGENTVILLE_PORT: String(PORT), XDG_CONFIG_HOME: path.join(HOME, 'xdg') }, SAFE_ENV)
const b = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (b.status !== 0) process.exit(1)
await import('../server/cli.mjs')
