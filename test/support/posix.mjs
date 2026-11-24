// Helpers for tests that must behave on both POSIX and Windows.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const WIN = process.platform === 'win32'

/** A pid that is alive on every OS, for fixture session registries. POSIX uses pid 1 (kill -0 answers EPERM); Windows has no pid 1, so use this process. */
export const LIVE_PID = WIN ? process.pid : 1

/**
 * A temp dir. POSIX uses /tmp, not os.tmpdir(): unix socket paths are limited to ~104 bytes and
 * macOS's tmpdir is long. Windows has no such limit and no /tmp.
 */
export const shortTmp = (prefix) => fs.mkdtempSync(path.join(WIN ? os.tmpdir() : '/tmp', prefix))

/**
 * Wraps node:test's `test` so every test it declares is skipped on Windows, with `reason`.
 *   import baseTest from 'node:test'; const test = posixTest(baseTest, 'unix sockets')
 * Hooks (test.after, ...) and the other members pass through untouched.
 */
export function posixTest(base, reason) {
  if (!reason) throw new Error('posixTest needs a reason')
  const wrap = (name, a, b) => {
    const [opts, fn] = typeof a === 'function' ? [{}, a] : [a || {}, b]
    return base(name, WIN ? { ...opts, skip: reason } : opts, fn)
  }
  for (const k of ['after', 'afterEach', 'before', 'beforeEach', 'describe', 'it', 'mock', 'only', 'skip', 'todo', 'suite']) if (base[k]) wrap[k] = base[k]
  return wrap
}

/**
 * Writes a fake CLI that runs `jsSource` (CommonJS) under the current node, and returns the path to
 * exec: `dir/name` (a shebang script, mode 755) on POSIX, `dir/name.cmd` (a shim that runs node on
 * `dir/name.cjs`) on Windows.
 */
export function fakeBin(dir, name, jsSource) {
  fs.mkdirSync(dir, { recursive: true })
  if (!WIN) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, `#!${process.execPath}\n${jsSource}\n`)
    fs.chmodSync(file, 0o755)
    return file
  }
  fs.writeFileSync(path.join(dir, `${name}.cjs`), `${jsSource}\n`)
  const cmd = path.join(dir, `${name}.cmd`)
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`)
  return cmd
}

/**
 * A listening address for a fake unix-socket peer: `dir/name.sock` on POSIX, a named pipe on Windows
 * (a .sock file path throws EACCES there). The app does not message agents on Windows, so on Windows
 * this only lets the test file load; the tests that send are skipped with posixTest.
 */
export const sockPath = (dir, name) => (WIN ? `\\\\.\\pipe\\agv-${path.basename(path.dirname(dir))}-${name}` : path.join(dir, `${name}.sock`))

const stubCache = new Map()
/**
 * The path to exec for a committed fake CLI in test/fixtures/bin: the node-shebang script itself on
 * POSIX, and on Windows a `.cmd` shim (in a temp dir) that runs it under the current node.
 */
export function stubBin(name) {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bin', name)
  if (!WIN) return src
  if (!stubCache.has(name)) {
    const dir = shortTmp('agv-stub-')
    const cmd = path.join(dir, `${name}.cmd`)
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${src}" %*\r\nexit /b %ERRORLEVEL%\r\n`)
    stubCache.set(name, cmd)
  }
  return stubCache.get(name)
}
