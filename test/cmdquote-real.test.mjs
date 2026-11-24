// On Windows: the real cmd.exe /d /s /c line from execTarget must hand a .cmd shim exactly the argv we gave it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execTarget } from '../server/platform.mjs'
import { fakeBin, WIN, shortTmp } from './support/posix.mjs'

test('execTarget: a .cmd shim receives the original argv, metacharacters and quotes intact', { skip: !WIN && 'Windows only' }, () => {
  const dir = shortTmp('agv-cq-')
  const bin = fakeBin(dir, 'echoargs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const args = ['--bg', '--name=Docs bot', '--', 'fix the bug & ship | it <now> > out ^ (x) !y! "quoted" end\\']
  const t = execTarget(bin, args)
  const r = spawnSync(t.file, t.args, { ...t.opts, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), args)
})
