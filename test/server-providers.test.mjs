// P16: the provider endpoints on a throwaway server (docs/providers-design.md §5).
import test from 'node:test'
import assert from 'node:assert/strict'
import { withServer } from './support/with-server.mjs'

const req = async (base, method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { origin: base, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }) })
  return { status: r.status, body: await r.json().catch(() => null) }
}

test('providers, options, handoffs and settings endpoints', async () => {
  await withServer(async ({ base }) => {
    const p = await req(base, 'GET', '/api/providers')
    assert.equal(p.status, 200)
    assert.equal(p.body.defaultProvider, 'claude')
    assert.ok(p.body.providers.some((x) => x.id === 'claude' && x.capabilities.start === true))
    assert.ok(p.body.providers.every((x) => typeof x.available === 'boolean' && 'exhausted' in x))

    const o = await req(base, 'GET', '/api/act/options')
    assert.equal(o.body.defaultProvider, 'claude')
    assert.ok(o.body.providers.claude && Array.isArray(o.body.providers.claude.models))
    assert.ok(!o.body.providers.codex, 'codex is display-only')
    assert.deepEqual(o.body.models, o.body.providers.claude.models, 'top level stays Claude\'s')

    const h = await req(base, 'GET', '/api/handoffs')
    assert.equal(h.status, 200)
    assert.deepEqual(h.body.handoffs, [])

    const a = await req(base, 'GET', '/api/agents')
    assert.ok(a.body.agents.length > 0)
    for (const x of a.body.agents) {
      assert.ok(['claude', 'codex', 'gemini'].includes(x.provider), x.harness)
      assert.ok('handoff' in x && 'handedOffFrom' in x && 'startedBy' in x)
    }

    // Agent starts can't be turned on by a request that isn't the page.
    const off = await req(base, 'PUT', '/api/providers/settings', { agentStarts: { enabled: false } })
    assert.equal(off.status, 200)
    const on = await req(base, 'PUT', '/api/providers/settings', { agentStarts: { enabled: true } })
    assert.equal(on.status, 403)
    const ui = await req(base, 'PUT', '/api/providers/settings', { agentStarts: { enabled: true, perHour: 500 } }, { 'x-agentville-ui': '1' })
    assert.equal(ui.status, 200)
    assert.equal(ui.body.settings.agentStarts.enabled, true)
    assert.ok(ui.body.settings.agentStarts.perHour <= 60)

    const bad = await req(base, 'PUT', '/api/providers/settings', { defaultProvider: 'codex' })
    assert.equal(bad.status, 400)

    // The start endpoint: guards answer 4xx with fixed strings.
    const st = await req(base, 'POST', '/api/agents/start', { session: 'nope', prompt: 'hi' })
    assert.ok(st.status >= 400 && st.status < 500)
    assert.equal(st.body.ok, false)
  })
})
