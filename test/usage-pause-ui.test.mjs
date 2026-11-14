import test from 'node:test'
import assert from 'node:assert/strict'
import { bannerText, formatTime } from '../web/src/usage-pause.js'

test('hidden when running or missing', () => {
  assert.equal(bannerText(null), '')
  assert.equal(bannerText({ enabled: true, state: 'running' }), '')
})
test('paused banner counts agents and shows resume time', () => {
  const until = Date.UTC(2026, 10, 13, 15, 40)
  const t = bannerText({ enabled: true, state: 'paused', until, agents: [{ id: 'a' }, { id: 'b' }] }, 'en-US')
  assert.match(t, /^All accounts are out of usage — 2 agents paused\. Resumes automatically ~/)
  assert.ok(t.includes(formatTime(until, 'en-US')))
})
test('singular and no until', () => {
  const t = bannerText({ state: 'paused', until: null, agents: [{ id: 'a' }] })
  assert.match(t, /1 agent paused\./)
  assert.doesNotMatch(t, /~/)
})
test('resuming banner', () => {
  assert.equal(bannerText({ enabled: true, state: 'resuming' }), 'Usage is back — resuming agents…')
})
