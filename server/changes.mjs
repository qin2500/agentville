/**
 * What an agent has changed in its working folder: changed files with +/− line counts, against the
 * merge base with the repo's default branch (so a branch's commits count, plus anything uncommitted),
 * and untracked files by name. Paths and counts only: no diff content is ever read or returned.
 *
 * git runs with --no-optional-locks (it never takes the index lock an agent's own git needs), a
 * timeout, no prompts and no pager; results are cached per folder for 60 s and refreshed in the
 * background, a few folders at a time, so the 2 s agents poll never waits on git.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const TTL_MS = 60_000
const TIMEOUT_MS = 5_000
const MAX_FILES = 500
const PARALLEL = 3

function git(dir, args, timeout = TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', dir, ...args], {
      timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
    }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

/** The default branch to compare against: origin's HEAD, else main/master (remote, then local). */
async function defaultBranch(dir) {
  const head = (await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim()
  if (head) return head
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null) return ref
  }
  return null
}

/** `+add −del path` per changed file, plus untracked files. null when `dir` isn't a git checkout. */
export async function readChanges(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null
  if ((await git(dir, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return null
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || ''
  const against = await defaultBranch(dir)
  const base = (against && (await git(dir, ['merge-base', 'HEAD', against]))?.trim()) || ((await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null ? 'HEAD' : null)
  const files = []
  if (base) {
    const out = await git(dir, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, '--'])
    if (out === null) return null
    for (const rec of out.split('\0')) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec)
      if (m) files.push({ path: m[3], add: m[1] === '-' ? null : Number(m[1]), del: m[2] === '-' ? null : Number(m[2]), binary: m[1] === '-' })
    }
  }
  const status = await git(dir, ['status', '--porcelain', '-z', '--untracked-files=normal'])
  if (status === null) return null
  for (const rec of status.split('\0')) if (rec.startsWith('?? ')) files.push({ path: rec.slice(3), add: null, del: null, untracked: true })
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    branch: branch === 'HEAD' ? '' : branch,
    against: against || '',
    added: files.reduce((n, f) => n + (f.add || 0), 0),
    removed: files.reduce((n, f) => n + (f.del || 0), 0),
    count: files.length,
    files: files.slice(0, MAX_FILES),
    truncated: files.length > MAX_FILES,
  }
}

/** Per-folder cache. `summary(dir)` never waits: it returns the last result and queues a refresh. */
export function createChanges({ ttlMs = TTL_MS, read = readChanges } = {}) {
  const cache = new Map() // dir -> { at, value, busy }
  const queue = []
  let running = 0
  const pump = () => {
    while (running < PARALLEL && queue.length) {
      const dir = queue.shift()
      const e = cache.get(dir)
      running++
      read(dir).catch(() => null).then((value) => { Object.assign(e, { at: Date.now(), value, busy: null }) })
        .finally(() => { running--; pump() })
    }
  }
  function refresh(dir) {
    let e = cache.get(dir)
    if (!e) cache.set(dir, (e = { at: 0, value: undefined }))
    if (e.busy || Date.now() - e.at < ttlMs) return e
    e.busy = true
    queue.push(dir)
    pump()
    return e
  }
  return {
    /** `{ added, removed, files }` or null (clean, not a repo, or not read yet). */
    summary(dir) {
      const v = refresh(dir).value
      return v && v.count ? { added: v.added, removed: v.removed, files: v.count } : null
    },
    /** The full list, waiting for a read when there is none yet. */
    async detail(dir) {
      const e = refresh(dir)
      for (let i = 0; e.value === undefined && i < 100; i++) await new Promise((r) => setTimeout(r, 50))
      return e.value ?? null
    },
    /** Forget folders nobody asked about for 10 minutes. */
    prune(keep) {
      for (const [dir, e] of cache) if (!keep.has(dir) && !e.busy && Date.now() - e.at > 10 * ttlMs) cache.delete(dir)
    },
  }
}
