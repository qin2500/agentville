/**
 * Plain terminals, unit level: what the server will and will not start, and how a claude or codex
 * session started inside one is linked to its pane. Fake process tables, fake registries and fake
 * agents only: no pty, no real shell, no real claude or codex.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPlainTerms, descendants, tilde, PLAIN_PREFIX } from '../server/plain-term.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-plain-'))
const home = path.join(root, 'home')
const proj = path.join(root, 'proj')
const elsewhere = path.join(root, 'elsewhere')
for (const d of [home, proj, elsewhere]) fs.mkdirSync(d)
const shellBin = path.join(root, 'fakeshell')
fs.writeFileSync(shellBin, '#!/bin/sh\n'); fs.chmodSync(shellBin, 0o755)
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

const mk = (over = {}) => createPlainTerms({
  home, shell: () => shellBin, platform: 'linux', findBin: async (n) => `/fake/bin/${n}`,
  procs: async () => [], cwd: async () => null, registry: async () => [], ...over,
})
const projects = [{ dir: proj }]

test('a shell is the login shell, with a fixed argv and a "Terminal — ~/path" title', async () => {
  const p = mk()
  const e = await p.create({ kind: 'shell', projects })
  assert.deepEqual(e.argv, [shellBin, '-l'])
  assert.equal(e.cwd, home)
  assert.equal(e.title, 'Terminal — ~')
  assert.ok(e.id.startsWith(PLAIN_PREFIX) && e.id.length > 20, 'an unguessable id')
  assert.equal(p.get(e.id), e)
  assert.equal((await p.create({ kind: 'shell', cwd: proj, projects })).title, `Terminal — ${proj}`)
  assert.equal(tilde(path.join(home, 'a', 'b'), home), '~/a/b')
})

test('the folder is home or a listed project, nothing else', async () => {
  const p = mk()
  for (const bad of [elsewhere, '/', '/etc', 'relative', path.join(proj, '..'), path.join(home, 'nope'), 42, {}]) {
    await assert.rejects(p.create({ kind: 'shell', cwd: bad, projects }), (e) => e.status === 400, String(bad))
  }
  assert.equal((await p.create({ kind: 'shell', cwd: proj, projects })).cwd, proj)
  assert.equal(p.entries.size, 1, 'a refusal registers nothing')
})

test('the kind is enumerated and the command is ours: claude and codex run bare', async () => {
  const p = mk()
  for (const bad of ['rm -rf /', '', null, 'Shell', ['shell']]) {
    await assert.rejects(p.create({ kind: bad === null ? 'x' : bad, projects }), (e) => e.status === 400)
  }
  assert.deepEqual((await p.create({ kind: 'claude', projects })).argv, ['/fake/bin/claude'])
  assert.deepEqual((await p.create({ kind: 'codex', projects })).argv, ['/fake/bin/codex'])
  // Extra fields are never read.
  const e = await p.create({ kind: 'claude', projects, argv: ['/bin/evil'], command: 'x', prompt: 'hi' })
  assert.deepEqual(e.argv, ['/fake/bin/claude'])
  const none = mk({ findBin: async () => null })
  await assert.rejects(none.create({ kind: 'claude', projects }), (e2) => e2.status === 409 && /not found/.test(e2.message))
})

test('an unusable $SHELL falls back to a fixed shell, never to request data', async () => {
  for (const shell of [undefined, '', 'zsh', '/nonexistent/sh', root]) {
    const e = await mk({ shell: () => shell }).create({ kind: 'shell', projects })
    assert.deepEqual(e.argv, ['/bin/zsh', '-l'])
  }
})

test('descendants walks the process tree, root included, and survives loops', () => {
  const procs = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 }, { pid: 13, ppid: 10 }]
  assert.deepEqual(descendants(10, procs).map((p) => p.pid).sort(), [10, 11, 12, 13])
  assert.deepEqual(descendants(99, procs).map((p) => p.pid), [99])
  assert.deepEqual(descendants(1, [{ pid: 1, ppid: 2 }, { pid: 2, ppid: 1 }]).map((p) => p.pid).sort(), [1, 2])
})

// A fake pty registry: only the pid of each session's process.
const fakeTerms = (map) => ({ get: (id) => (map[id] ? { proc: { pid: map[id] } } : null) })

test('a claude started by hand in the shell is linked through the session registry', async () => {
  const sid = 'cccccccc-0000-4000-8000-000000000001'
  const procs = [{ pid: 100, ppid: 1, command: '/bin/zsh' }, { pid: 101, ppid: 100, command: '/x/claude' }, { pid: 500, ppid: 1, command: '/x/claude' }]
  const registry = [{ pid: 101, sessionId: sid, cwd: home, kind: 'interactive' }, { pid: 500, sessionId: 'other', cwd: home, kind: 'interactive' }]
  const p = mk({ procs: async () => procs, registry: async () => registry })
  const e = await p.create({ kind: 'shell', projects })
  const agents = [{ id: `claude-code:${sid}` }, { id: 'claude-code:other' }]
  assert.deepEqual(await p.status(fakeTerms({ [e.id]: 100 }), agents), [{ id: e.id, kind: 'shell', title: 'Terminal — ~', cwd: home, agentId: `claude-code:${sid}` }])
  // The session ends: the pane is a plain terminal again (its title is the "Terminal — ~/path" one).
  const gone = mk({ procs: async () => procs.slice(0, 1), registry: async () => registry.slice(1) })
  const e2 = await gone.create({ kind: 'shell', projects })
  assert.equal((await gone.status(fakeTerms({ [e2.id]: 100 }), agents))[0].agentId, null)
})

test('a "+ Claude" pane is the claude process itself, and is linked at once', async () => {
  const sid = 'cccccccc-0000-4000-8000-000000000002'
  const p = mk({ procs: async () => [{ pid: 200, ppid: 1, command: '/x/claude' }], registry: async () => [{ pid: 200, sessionId: sid, kind: 'interactive' }] })
  const e = await p.create({ kind: 'claude', projects })
  assert.equal((await p.status(fakeTerms({ [e.id]: 200 }), [{ id: `claude-code:${sid}` }]))[0].agentId, `claude-code:${sid}`)
})

test('only interactive sessions link, and only to an agent the scanner shows', async () => {
  const sid = 'cccccccc-0000-4000-8000-000000000003'
  const procs = [{ pid: 300, ppid: 1, command: '/bin/zsh' }, { pid: 301, ppid: 300, command: '/x/claude' }]
  const bg = mk({ procs: async () => procs, registry: async () => [{ pid: 301, sessionId: sid, kind: 'bg' }] })
  const a = await bg.create({ kind: 'shell', projects })
  assert.equal((await bg.status(fakeTerms({ [a.id]: 300 }), [{ id: `claude-code:${sid}` }]))[0].agentId, null)
  const hidden = mk({ procs: async () => procs, registry: async () => [{ pid: 301, sessionId: sid, kind: 'interactive' }] })
  const b = await hidden.create({ kind: 'shell', projects })
  assert.equal((await hidden.status(fakeTerms({ [b.id]: 300 }), []))[0].agentId, null, 'not in the snapshot yet')
})

test('two terminals never claim one agent; a plain terminal that is not running is not listed', async () => {
  const sid = 'cccccccc-0000-4000-8000-000000000004'
  const procs = [{ pid: 400, ppid: 1, command: 'zsh' }, { pid: 401, ppid: 400, command: 'claude' }, { pid: 410, ppid: 1, command: 'zsh' }]
  const p = mk({ procs: async () => procs, registry: async () => [{ pid: 401, sessionId: sid, kind: 'interactive' }] })
  const a = await p.create({ kind: 'shell', projects }), b = await p.create({ kind: 'shell', projects }), c = await p.create({ kind: 'shell', projects })
  const out = await p.status(fakeTerms({ [a.id]: 400, [b.id]: 410 }), [{ id: `claude-code:${sid}` }])
  assert.deepEqual(out.map((x) => [x.id, x.agentId]), [[a.id, `claude-code:${sid}`], [b.id, null]])
  assert.ok(!out.some((x) => x.id === c.id))
})

test('codex: a codex process in the tree links the one live codex agent in its folder', async () => {
  const procs = [{ pid: 600, ppid: 1, command: '/bin/zsh' }, { pid: 601, ppid: 600, command: '/opt/bin/codex' }]
  const agents = [
    { id: 'codex:old', harness: 'codex', live: true, cwd: proj, lastActivityAt: 1 },
    { id: 'codex:new', harness: 'codex', live: true, cwd: proj, lastActivityAt: 9 },
    { id: 'codex:else', harness: 'codex', live: true, cwd: elsewhere, lastActivityAt: 99 },
    { id: 'codex:dead', harness: 'codex', live: false, cwd: proj, lastActivityAt: 100 },
  ]
  const asked = []
  const p = mk({ procs: async () => procs, cwd: async (pid) => { asked.push(pid); return proj } })
  const e = await p.create({ kind: 'shell', projects })
  assert.equal((await p.status(fakeTerms({ [e.id]: 600 }), agents))[0].agentId, 'codex:new')
  assert.deepEqual(asked, [601])
  // No codex process: nothing is guessed from the folder alone.
  const q = mk({ procs: async () => procs.slice(0, 1), cwd: async () => proj })
  const e2 = await q.create({ kind: 'shell', projects })
  assert.equal((await q.status(fakeTerms({ [e2.id]: 600 }), agents))[0].agentId, null)
})

test('forget drops a terminal; old ones are capped', async () => {
  const p = mk()
  const first = await p.create({ kind: 'shell', projects })
  p.forget(first.id)
  assert.equal(p.get(first.id), null)
  for (let i = 0; i < 60; i++) await p.create({ kind: 'shell', projects })
  assert.equal(p.entries.size, 50)
  assert.equal(p.get(null), null)
})
