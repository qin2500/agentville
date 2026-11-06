/**
 * Temp git repos and a fake GitHub API for the update check (unit and e2e). Never the real GitHub,
 * never this repo's own git state: everything lives in a temp folder.
 *
 *   const r = makeRepos(dir)      // dir/origin.git (bare, "GitHub"), dir/seed (where "upstream" commits),
 *                                 // dir/install (a clone, as a user would have)
 *   r.publish('Fix the thing')    // commit in seed and push to origin's main; returns the sha
 *   r.git(r.install, 'status')    // run git with a private config (no global hooks or signing)
 *   const gh = await fakeGithub(r.origin)   // serves /repos/:owner/:repo/compare/:base...:head from origin.git
 *   gh.mode = 'rate' | 'down' | 'ok'; gh.requests; gh.env; gh.close()
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// A private git config: the developer's global hooks, signing or default branch never apply here.
export const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
}
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export const REPO = 'example/agentville'
const PKG = { name: 'agentville-fixture', private: true, repository: { type: 'git', url: `git+https://github.com/${REPO}.git` },
  // A stand-in build: fast, no dependencies, and leaves a mark the tests can look for.
  scripts: { build: "node -e \"require('fs').writeFileSync('built.txt', String(Date.now()))\"" } }

export function makeRepos(dir) {
  const origin = path.join(dir, 'origin.git'), seed = path.join(dir, 'seed'), install = path.join(dir, 'install')
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  git(dir, 'init', '-q', '-b', 'main', seed)
  fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify(PKG, null, 2) + '\n')
  fs.writeFileSync(path.join(seed, 'package-lock.json'), JSON.stringify({ name: PKG.name, lockfileVersion: 3, requires: true, packages: { '': { name: PKG.name } } }, null, 2) + '\n')
  fs.writeFileSync(path.join(seed, '.gitignore'), 'built.txt\n')
  fs.writeFileSync(path.join(seed, 'app.txt'), 'v1\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'First version')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'main')
  git(dir, 'clone', '-q', origin, install)
  let n = 1
  /** A new upstream commit on main (optionally changing the lockfile). Returns its sha. */
  function publish(message, { lock = false } = {}) {
    n++
    fs.writeFileSync(path.join(seed, 'app.txt'), `v${n}\n`)
    if (lock) fs.writeFileSync(path.join(seed, 'package-lock.json'), JSON.stringify({ name: PKG.name, lockfileVersion: 3, requires: true, packages: { '': { name: PKG.name, version: `0.0.${n}` } } }, null, 2) + '\n')
    git(seed, 'commit', '-q', '-am', message)
    git(seed, 'push', '-q', 'origin', 'main')
    return git(seed, 'rev-parse', 'HEAD')
  }
  return { dir, origin, seed, install, publish, git, head: (cwd = install) => git(cwd, 'rev-parse', 'HEAD') }
}

/** GitHub's compare and commits endpoints, answered from a bare repo. */
export async function fakeGithub(bare) {
  const requests = []
  const gh = { mode: 'ok', requests, env: null, close: null }
  const has = (rev) => { try { git(bare, 'cat-file', '-e', `${rev}^{commit}`); return true } catch { return false } }
  const commit = (sha) => {
    const [h, date, ...msg] = git(bare, 'show', '-s', '--format=%H%x00%cI%x00%B', sha).split('\0')
    return { sha: h, commit: { message: msg.join('\0').trim(), author: { date }, committer: { date } } }
  }
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, ua: req.headers['user-agent'], auth: req.headers.authorization || null })
    const json = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
    if (gh.mode === 'down') return req.socket.destroy()
    if (gh.mode === 'rate') return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) })
    const m = /^\/repos\/([\w.-]+)\/([\w.-]+)\/(compare|commits)\/(.+)$/.exec(req.url)
    if (!m) return json(404, { message: 'Not Found' })
    if (m[3] === 'commits') return has(m[4]) ? json(200, commit(git(bare, 'rev-parse', m[4]))) : json(404, { message: 'No commit found' })
    const [base, head] = decodeURIComponent(m[4]).split('...')
    if (!has(base) || !has(head)) return json(404, { message: 'Not Found' })
    const b = git(bare, 'rev-parse', base), hd = git(bare, 'rev-parse', head)
    const ahead = git(bare, 'rev-list', '--reverse', `${b}..${hd}`).split('\n').filter(Boolean)
    const behind = Number(git(bare, 'rev-list', '--count', `${hd}..${b}`))
    const status = !ahead.length && !behind ? 'identical' : ahead.length && behind ? 'diverged' : ahead.length ? 'ahead' : 'behind'
    json(200, { status, ahead_by: ahead.length, behind_by: behind, total_commits: ahead.length, commits: ahead.map(commit) })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  gh.url = `http://127.0.0.1:${server.address().port}`
  gh.env = { AGENTVILLE_UPDATE_API: gh.url, AGENTVILLE_UPDATE_REPO: REPO }
  gh.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) })
  return gh
}
