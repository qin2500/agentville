// Changed files per agent folder, from git in temp repos only: paths and +/− counts, no content.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readChanges, createChanges } from '../server/changes.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'va-chg-'))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', '-C', dir, ...args], { stdio: 'pipe' })
const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n'

function repo(name) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir)
  git(dir, 'init', '-q')
  fs.writeFileSync(path.join(dir, 'a.txt'), lines(10))
  fs.writeFileSync(path.join(dir, 'b.txt'), lines(5))
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

test('a branch: its commits since the merge base plus uncommitted edits and untracked files', async () => {
  const dir = repo('branch')
  git(dir, 'checkout', '-qb', 'feature')
  fs.writeFileSync(path.join(dir, 'a.txt'), lines(10) + lines(3, 'new'))
  git(dir, 'commit', '-qam', 'more')
  fs.writeFileSync(path.join(dir, 'b.txt'), lines(2)) // 3 lines removed, uncommitted
  fs.writeFileSync(path.join(dir, 'notes.md'), 'secret plan\n')
  // main moves on: its own later commits are not this branch's changes.
  git(dir, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(dir, 'c.txt'), lines(50))
  git(dir, 'add', 'c.txt'); git(dir, 'commit', '-qm', 'main moves')
  git(dir, 'checkout', '-q', 'feature')
  fs.writeFileSync(path.join(dir, 'b.txt'), lines(2))
  fs.writeFileSync(path.join(dir, 'notes.md'), 'secret plan\n')
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]))
  git(dir, 'add', 'img.bin') // staged, not committed
  const c = await readChanges(dir)
  assert.equal(c.branch, 'feature')
  assert.equal(c.against, 'main')
  assert.deepEqual(c.files, [
    { path: 'a.txt', add: 3, del: 0, binary: false },
    { path: 'b.txt', add: 0, del: 3, binary: false },
    { path: 'img.bin', add: null, del: null, binary: true },
    { path: 'notes.md', add: null, del: null, untracked: true },
  ])
  assert.deepEqual([c.added, c.removed, c.count], [3, 3, 4])
  assert.doesNotMatch(JSON.stringify(c), /secret plan/, 'no file content, ever')
})

test('on the default branch: uncommitted changes only; a clean tree has none', async () => {
  const dir = repo('main')
  assert.equal((await readChanges(dir)).count, 0)
  fs.appendFileSync(path.join(dir, 'a.txt'), 'one more\n')
  const c = await readChanges(dir)
  assert.deepEqual(c.files.map((f) => [f.path, f.add, f.del]), [['a.txt', 1, 0]])
})

test('not a repo, a missing folder or a relative path: null', async () => {
  const plain = path.join(root, 'plain')
  fs.mkdirSync(plain)
  assert.equal(await readChanges(plain), null)
  assert.equal(await readChanges(path.join(root, 'nope')), null)
  assert.equal(await readChanges('relative/dir'), null)
})

test('git never takes the index lock an agent needs', async () => {
  const dir = repo('locked')
  fs.appendFileSync(path.join(dir, 'a.txt'), 'x\n')
  fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '') // an agent mid-commit
  const c = await readChanges(dir)
  assert.equal(c.count, 1)
  assert.ok(fs.existsSync(path.join(dir, '.git', 'index.lock')), 'the lock is untouched')
})

test('cache: summary never waits, reads each folder once per TTL, and detail waits for the first read', async () => {
  let reads = 0
  const ch = createChanges({ ttlMs: 60_000, read: async () => { reads++; return { added: 4, removed: 1, count: 2, files: [] } } })
  assert.equal(ch.summary('/x'), null, 'not read yet')
  const d = await ch.detail('/x')
  assert.equal(d.count, 2)
  assert.deepEqual(ch.summary('/x'), { added: 4, removed: 1, files: 2 })
  ch.summary('/x'); ch.summary('/x')
  assert.equal(reads, 1)
  const clean = createChanges({ read: async () => ({ added: 0, removed: 0, count: 0, files: [] }) })
  await clean.detail('/y')
  assert.equal(clean.summary('/y'), null, 'a clean folder shows no chip')
})
