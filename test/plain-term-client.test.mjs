/** The page side of plain terminals (web/src/plain-term.js) with a fake app and a stubbed fetch. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPlainTerm } from '../web/src/plain-term.js'

const agent = { id: 'claude-code:abc', name: 'Fix the login bug' }
const mk = (plainList) => {
  const calls = [], opened = [], toasts = []
  const S = { view: 'team', byId: new Map([[agent.id, agent]]), data: { term: { available: true, plain: plainList } } }
  const app = { S, openTerminal: (id) => opened.push(id), toast: (m) => toasts.push(m) }
  globalThis.fetch = async (url, init) => { calls.push([url, init?.method, init?.body]); return { ok: true, status: 200, json: async () => ({ id: 'shell:new1', name: 'Terminal — ~' }) } }
  return { p: createPlainTerm(app), calls, opened, toasts, S }
}

test('an agent running in a plain pane opens that pane; its name is the pane title while it runs', () => {
  const { p } = mk([{ id: 'shell:a', title: 'Terminal — ~/x', agentId: agent.id }, { id: 'shell:b', title: 'Terminal — ~', agentId: null }])
  assert.equal(p.paneOf(agent.id), 'shell:a')
  assert.equal(p.paneOf('claude-code:other'), null)
  assert.equal(p.agentOf('shell:a'), agent)
  assert.equal(p.agentOf('shell:b'), null, 'a session that exited: back to the plain title')
  assert.equal(p.stub('shell:b').name, 'Terminal — ~')
  assert.equal(p.stub(agent.id), null)
})

test('open posts only the kind and folder, then opens the pane', async () => {
  const { p, calls, opened } = mk([])
  await p.open('claude', '/some/project')
  assert.equal(calls[0][0], '/api/term-plain')
  assert.deepEqual(JSON.parse(calls[0][2]), { kind: 'claude', cwd: '/some/project' })
  assert.deepEqual(opened, ['shell:new1'])
  assert.equal(p.stub('shell:new1').name, 'Terminal — ~', 'named before the server lists it')
  await p.open('shell')
  assert.deepEqual(JSON.parse(calls[1][2]), { kind: 'shell' })
})

test('closing a pane ends its shell; leaving the view ends only shells with no agent in them', () => {
  const { p, calls } = mk([{ id: 'shell:a', agentId: agent.id }, { id: 'shell:b', agentId: null }])
  p.viewClosed(['shell:a', 'shell:b', 'claude-code:abc'])
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), [['/api/term/shell%3Ab', 'DELETE']])
  p.paneClosed('shell:a')
  p.paneClosed('claude-code:abc')
  assert.deepEqual(calls.map((c) => c[0]), ['/api/term/shell%3Ab', '/api/term/shell%3Aa'])
})
