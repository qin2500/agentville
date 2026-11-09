// Build the page once up front, so each fixture server (and the app's own) starts straight away.
import { spawnSync } from 'node:child_process'
import { ROOT, sweepStaleTemp } from '../e2e/helpers.mjs'

export default () => {
  sweepStaleTemp()
  const b = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (b.status !== 0) throw new Error('The web build failed')
}
