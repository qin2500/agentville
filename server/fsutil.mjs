// Bounded file reads, ported from Bot Crossing server/lib/fsutil.mjs (MIT, Jarren Rocks); see NOTICE.
import fsp from 'node:fs/promises'
import path from 'node:path'

/** First `bytes` of a file, trailing partial line dropped. */
export async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return bytesRead === bytes ? text.slice(0, text.lastIndexOf('\n') + 1) : text
  } finally { await fh.close() }
}

/** Last `bytes` of a file, leading partial line dropped. */
export async function readTail(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const want = Math.min(bytes, size)
    const buf = Buffer.allocUnsafe(want)
    const { bytesRead } = await fh.read(buf, 0, want, size - want)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return want === size ? text : text.slice(text.indexOf('\n') + 1)
  } finally { await fh.close() }
}

/** Parse JSONL, skipping partial or malformed lines. */
export function jsonLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { out.push(JSON.parse(t)) } catch { /* partial line */ }
  }
  return out
}

/** Calls `onLine` for every complete line from `offset` on; returns the offset after the last one. */
export async function readLinesFrom(file, offset, onLine) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
    let rest = ''
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
      if (!bytesRead) break
      const text = rest + buf.subarray(0, bytesRead).toString('utf8')
      const cut = text.lastIndexOf('\n')
      if (cut >= 0) {
        for (const line of text.slice(0, cut).split('\n')) onLine(line)
        rest = text.slice(cut + 1)
      } else rest = text
      offset += bytesRead
    }
    return offset - Buffer.byteLength(rest)
  } finally { await fh.close() }
}

export async function listDirs(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
  } catch { return [] }
}

export async function listFiles(dir, filter) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && filter(e.name)).map((e) => path.join(dir, e.name))
  } catch { return [] }
}

export async function readJson(file, maxBytes = 256 * 1024) {
  try {
    const st = await fsp.stat(file)
    if (st.size > maxBytes) return null
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch { return null }
}

/** `/repo/.claude/worktrees/x` -> `repo`. */
export function projectOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return 'unknown'
  const m = /[\\/]\.claude[\\/]worktrees[\\/]/.exec(cwd)
  return path.basename(m ? cwd.slice(0, m.index) : cwd) || 'unknown'
}

/** console.error that can't throw: on a full disk the log file itself may refuse the write. */
export function logSafely(...args) {
  try { console.error(...args) } catch { /* nowhere left to say it */ }
}
