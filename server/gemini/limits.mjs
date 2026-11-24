// Gemini CLI limits (design G5, G6). Facts: docs/gemini-cli-notes.md (0.71.1), section 6.
// No Google calls: the quota endpoint needs the user's OAuth bearer, which we must not borrow.

export const LIMIT_EXIT_CODE = 173
export const FLASH_MODEL = 'gemini-2.5-flash'
export const FLASH_PREVIEW_MODEL = 'gemini-3-flash-preview'
export const DAILY_REQUESTS = 1000 // the smallest published daily request limit (Google login); an estimate
export const QUOTA_TZ = 'America/Los_Angeles' // daily quotas reset at midnight Pacific

const LIMIT_RE = /TerminalQuotaError|RetryableQuotaError|exhausted your (?:daily )?quota|RESOURCE_EXHAUSTED|"code"\s*:\s*429|\(Status:\s*429\)|\bstatus\s*(?:code)?[:=]?\s*429\b|\b429\b[^\n]{0,40}(?:quota|too many|rate|exhausted)|(?:quota|too many requests|rate limit)[^\n]{0,40}\b429\b/i

/** True when the text (stderr, a stream-json result message, a state detail) says the agent hit a usage limit. */
export function isLimitText(text, exitCode) {
  if (Number(exitCode) === LIMIT_EXIT_CODE) return true
  return typeof text === 'string' && LIMIT_RE.test(text)
}

const PRO_RE = /gemini-[\w.-]*pro[\w.-]*/i

/**
 * The model to retry on when Pro is out ('' when the limit is not a Pro limit or no model is known).
 * Headless `gemini -p` does not fall back to Flash on a daily quota error, so the orchestrator retries with -m.
 * `model` is the model the run used, if known; otherwise a Pro name inside the text is used.
 */
export function limitModel(text, model = '') {
  const t = typeof text === 'string' ? text : ''
  if (!isLimitText(t)) return ''
  const used = (typeof model === 'string' && model) || (PRO_RE.exec(t)?.[0] ?? '')
  if (!/pro/i.test(used)) return ''
  return /^gemini-3/i.test(used) ? FLASH_PREVIEW_MODEL : FLASH_MODEL
}

/** Epoch ms of the next 00:00 in `tz` after `now`. */
export function nextQuotaReset(now = Date.now(), tz = QUOTA_TZ) {
  const parts = (ms) => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const o = {}
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = Number(p.value)
    return o
  }
  const p = parts(now)
  const sinceMidnight = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000
  let t = now - sinceMidnight + 24 * 3600e3 // approx next midnight; fix up across a DST change
  for (let i = 0; i < 2; i++) {
    const q = parts(t)
    const off = ((q.hour * 60 + q.minute) * 60 + q.second) * 1000
    if (off === 0) break
    t -= off < 12 * 3600e3 ? off : off - 24 * 3600e3
  }
  return t
}

/**
 * An ESTIMATE of the Gemini daily quota from local evidence only.
 *   limitHits: epoch ms of recent quota errors
 *   messages:  [{ at, tokens }] one per `gemini` message in the session jsonl (tokens is the per-message total)
 *   dailyRequests: the request limit to measure against (default DAILY_REQUESTS)
 * Returns a Reading for decide(): `weekly` carries the daily window (the only window that is not `none`).
 * A limit hit since the last reset reads 100 and is the only way to read it; otherwise it is capped at 99.
 */
export function usage({ now = Date.now(), limitHits = [], messages = [], dailyRequests = DAILY_REQUESTS } = {}) {
  const resetsAt = nextQuotaReset(now)
  const windowStart = resetsAt - 24 * 3600e3
  const hit = limitHits.some((t) => Number.isFinite(t) && t >= windowStart && t <= now)
  const today = messages.filter((m) => m && m.at >= windowStart && m.at <= now)
  const requests = today.length
  const tokens = today.reduce((n, m) => n + (Number(m.tokens) || 0), 0)
  const used = hit ? 100 : Math.min(99, Math.round((requests / Math.max(1, dailyRequests)) * 100))
  return { fiveHour: { none: true }, weekly: { used, resetsAt }, estimate: true, requests, tokens, limitHit: hit, source: hit ? 'limit-error' : 'local-count' }
}

/** Overrides for autoswitch constants: a daily window resets within a day, so "soon" and "wait" are wider. */
export const tuning = {
  SOON_WEEK_MS: 24 * 3600e3, // every Gemini account resets within a day
  WAIT_RESET_MS: 15 * 60e3,
}
