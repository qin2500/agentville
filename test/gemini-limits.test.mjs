import test from 'node:test'
import assert from 'node:assert/strict'
import { isLimitText, limitModel, usage, nextQuotaReset, tuning, FLASH_MODEL } from '../server/gemini/limits.mjs'

test('isLimitText recognises the verified quota texts and exit 173', () => {
  assert.ok(isLimitText('TerminalQuotaError: You have exhausted your daily quota on this model.'))
  assert.ok(isLimitText('[API Error: x (Status: RESOURCE_EXHAUSTED)]'))
  assert.ok(isLimitText('{"error":{"message":"m","code":429}}'))
  assert.ok(isLimitText('', 173))
  assert.ok(!isLimitText('all good'))
  assert.ok(!isLimitText('port 4290 open'))
  assert.ok(!isLimitText(null))
})

test('limitModel suggests flash only for a Pro limit', () => {
  const t = 'You have exhausted your daily quota on this model.'
  assert.equal(limitModel(t, 'gemini-2.5-pro'), FLASH_MODEL)
  assert.equal(limitModel(t, 'gemini-3-pro-preview'), 'gemini-3-flash-preview')
  assert.equal(limitModel(t, 'gemini-2.5-flash'), '')
  assert.equal(limitModel(t), '')
  assert.equal(limitModel('ok', 'gemini-2.5-pro'), '')
})

test('nextQuotaReset is the next Pacific midnight (DST aware)', () => {
  const now = Date.UTC(2026, 10, 24, 12, 0) // 04:00 PST
  assert.equal(nextQuotaReset(now), Date.UTC(2026, 10, 25, 8, 0))
  const summer = Date.UTC(2026, 6, 1, 12, 0) // 05:00 PDT
  assert.equal(nextQuotaReset(summer), Date.UTC(2026, 6, 2, 7, 0))
})

test('usage estimate', () => {
  const now = Date.UTC(2026, 10, 24, 20, 0)
  const at = now - 3600e3
  const r = usage({ now, messages: [{ at, tokens: 15 }, { at, tokens: 5 }, { at: now - 3 * 86400e3, tokens: 99 }], dailyRequests: 10 })
  assert.equal(r.estimate, true)
  assert.equal(r.requests, 2)
  assert.equal(r.tokens, 20)
  assert.equal(r.weekly.used, 20)
  assert.ok(r.fiveHour.none)
  assert.equal(usage({ now, limitHits: [at] }).weekly.used, 100)
  assert.equal(usage({ now, limitHits: [now - 2 * 86400e3] }).weekly.used, 0)
  assert.equal(usage({ now, messages: Array(50).fill({ at, tokens: 1 }), dailyRequests: 10 }).weekly.used, 99)
})

test('tuning has numeric overrides', () => {
  for (const v of Object.values(tuning)) assert.equal(typeof v, 'number')
})
