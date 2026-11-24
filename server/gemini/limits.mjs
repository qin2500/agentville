// Gemini provider limits, Antigravity CLI (`agy`). Facts: docs/antigravity-cli-notes.md §5.
// Google documents no quota error text, exit code or reset cadence for agy. The texts below are the reported
// ones (third-party); the 5-hour window is a cautious guess, not a documented reset. No Google calls are made.

/** Matches stderr, result.error or result.response text of a run stopped by quota or rate limiting. */
const LIMIT_RE = /quota|RESOURCE_EXHAUSTED|\b429\b|rate.?limit|Model quota reached|exhausted your capacity/i

/** UNCERTAIN: agy's reset time is unknown (5-hour and weekly windows are both reported). Retry after this. */
export const RETRY_MS = 5 * 3600e3

/** True when the text (stderr, a stream-json result message, a state detail) says the agent hit a usage limit. */
export function isLimitText(text, _exitCode) {
  return typeof text === 'string' && LIMIT_RE.test(text)
}

/**
 * The model to retry on after a limit. Always '' for agy: model slugs are not known ahead of a real install
 * (`agy models`), and headless `--model` never falls back, so Agentville does not guess one.
 */
export function limitModel(_text, _model = '') { return '' }

/** When to try again after a limit at `now`: agy's real `reset_time` (ms) when known and ahead, else a cautious `RETRY_MS` later. */
export function nextQuotaReset(now = Date.now(), resetAt = null) { return Number.isFinite(resetAt) && resetAt > now ? resetAt : now + RETRY_MS }

/**
 * An ESTIMATE from local evidence only. A limit hit within the last RETRY_MS reads 100; otherwise 0, since
 * agy publishes no request budget to count against.
 */
export function usage({ now = Date.now(), limitHits = [] } = {}) {
  const last = Math.max(0, ...limitHits.filter((t) => Number.isFinite(t) && t <= now))
  const hit = last > 0 && now - last < RETRY_MS
  return { fiveHour: { used: hit ? 100 : 0, resetsAt: hit ? last + RETRY_MS : null }, weekly: { none: true }, estimate: true, limitHit: hit, source: hit ? 'limit-error' : 'none' }
}

/** Overrides for autoswitch constants (unused while the Gemini provider has one account and no switcher). */
export const tuning = {
  SOON_WEEK_MS: RETRY_MS,
  WAIT_RESET_MS: 15 * 60e3,
}
