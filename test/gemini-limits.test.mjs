import test from 'node:test'
import assert from 'node:assert/strict'
import { isLimitText, limitModel, usage, nextQuotaReset, tuning, RETRY_MS } from '../server/gemini/limits.mjs'

test('isLimitText recognises the reported agy quota texts', () => {
  for (const t of ['Model quota reached', 'RESOURCE_EXHAUSTED', 'HTTP 429', 'rate limit exceeded', 'rate-limited', 'You have exhausted your capacity on this model', 'Individual quota reached']) assert.ok(isLimitText(t), t)
  assert.ok(!isLimitText('all good'))
  assert.ok(!isLimitText('port 4290 open'))
  assert.ok(!isLimitText('authentication failed or timed out'))
  assert.ok(!isLimitText(null))
})

test('limitModel never guesses a model; reset is a cautious 5 h', () => {
  assert.equal(limitModel('Model quota reached', 'gemini-3-pro'), '')
  assert.equal(nextQuotaReset(1000), 1000 + RETRY_MS)
  assert.equal(RETRY_MS, 5 * 3600e3)
})

test('usage estimate from limit hits only', () => {
  const now = Date.UTC(2026, 10, 24, 20, 0)
  assert.equal(usage({ now }).fiveHour.used, 0)
  const r = usage({ now, limitHits: [now - 3600e3] })
  assert.equal(r.fiveHour.used, 100); assert.equal(r.fiveHour.resetsAt, now - 3600e3 + RETRY_MS); assert.equal(r.estimate, true)
  assert.equal(usage({ now, limitHits: [now - 6 * 3600e3] }).fiveHour.used, 0)
  for (const v of Object.values(tuning)) assert.equal(typeof v, 'number')
})
