/**
 * When will a usage window run out? Pure: tests drive it with synthetic samples.
 *
 * The 5-hour pace (`project`) blends two rates, because either alone misleads:
 *   - recent: a least-squares line through the last 30 min of samples, each weighted by recency
 *     (half-life 10 min), so a real, sustained burst moves it within a few minutes;
 *   - average: `used` over the time since the window started (resetsAt − 5 h): steady, but slow.
 * perHour = ½ recent + ½ average (recent alone until the window is 15 min old, or without a reset time).
 * The usage endpoint reports whole percent, so a single 1 % step says little: while the fit has
 * risen by at most one step, the recent rate is capped at that step spread over the span watched
 * (one step in 5 min can't read as 20 %/h). The run-out time is extrapolated from the latest reading.
 *
 * The weekly projection (`projectWeekly`) respects the 5-hour cap: usage stops when the 5-hour
 * window is full and resumes after its reset. It measures how much of the week a 5-hour percent costs
 * (`weeklyPerFive`), then simulates the windows ahead at the current pace, each used to the full
 * (`flatOut`): an earliest time, not a forecast. Beside it, `average` extrapolates this week's own
 * average pace (which already includes breaks and caps).
 */
export const FIT_MS = 30 * 60e3 // fit over the last 30 min of samples
export const HALF_LIFE_MS = 10 * 60e3 // a sample's weight halves every 10 min of age
export const MIN_SPAN_MS = 5 * 60e3 // and only once they span at least 5 min
export const MIN_SAMPLES = 3
export const FLAT_PER_HOUR = 0.25 // under 0.25 %/h counts as flat
export const RECENT_WEIGHT = 0.5 // perHour = RECENT_WEIGHT·recent + (1 − RECENT_WEIGHT)·average
export const MIN_AVG_MS = 15 * 60e3 // the window average counts once the window is this old
export const FIVE_HOUR_MS = 5 * 3600e3
export const WEEK_MS = 7 * 24 * 3600e3
export const MIN_WEEK_AVG_MS = 3600e3
// Weekly % per 5-hour %: a full 5-hour window is about a quarter of the week (measured on a Max
// account, 2026-10). Used until the samples show the 5-hour window rising by RATIO_MIN_FIVE %.
export const RATIO_PRIOR = 0.25
export const RATIO_MIN = 0.05
export const RATIO_MAX = 1
export const RATIO_MIN_FIVE = 10

const round1 = (x) => Math.round(x * 10) / 10

/** This window's samples within FIT_MS of `now`: a reset (a new resetsAt, or usage dropping) starts over. */
function windowFit(samples, now) {
  const resetsAt = samples.at(-1).resetsAt || null
  const recent = []
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]
    if (now - s.at > FIT_MS) break
    if (recent.length && (Math.abs((s.resetsAt || 0) - (resetsAt || 0)) > 120e3 || s.used > recent[0].used)) break
    recent.unshift(s)
  }
  return recent
}

/** The recency-weighted least-squares slope (percent per hour), with the one-step cap. */
function recentRate(fit, now) {
  const w = fit.map((s) => 2 ** (-(now - s.at) / HALF_LIFE_MS))
  const sw = w.reduce((a, b) => a + b, 0)
  const mx = fit.reduce((a, s, i) => a + w[i] * s.at, 0) / sw
  const my = fit.reduce((a, s, i) => a + w[i] * s.used, 0) / sw
  let sxx = 0, sxy = 0
  fit.forEach((s, i) => { sxx += w[i] * (s.at - mx) ** 2; sxy += w[i] * (s.at - mx) * (s.used - my) })
  let perHour = sxx ? (sxy / sxx) * 3600e3 : 0
  const rise = fit.at(-1).used - fit[0].used, span = fit.at(-1).at - fit[0].at
  if (rise <= 1) perHour = Math.min(perHour, (Math.max(rise, 0) / span) * 3600e3)
  return Math.max(perHour, 0)
}

/** `used` over the time since the window started, %/h; null while the window is too young or unknown. */
function averageRate(used, resetsAt, windowMs, now, minMs) {
  if (!resetsAt) return null
  const elapsed = now - (resetsAt - windowMs)
  return elapsed >= minMs && elapsed <= windowMs ? (used / elapsed) * 3600e3 : null
}

/**
 * `samples`: [{ at, used, resetsAt }] oldest first, for one window (5-hour unless `windowMs`).
 * Returns one of:
 *   { state: 'gathering', resetsAt }                too few samples, or too short a span
 *   { state: 'out', resetsAt, perHourAvg }          already at 100 %
 *   { state: 'runsOut', at, resetsAt, perHour, … }  projected to hit 100 % before the reset
 *   { state: 'lasts', resetsAt, perHour, … }        lasts until the reset (or flat / falling)
 * where … is `perHourRecent` and `perHourAvg` (null when not known), the two parts of `perHour`.
 */
export function project(samples, now = Date.now(), { windowMs = FIVE_HOUR_MS } = {}) {
  const last = samples.at(-1)
  if (!last) return { state: 'gathering' }
  const resetsAt = last.resetsAt || null
  const avg = averageRate(last.used, resetsAt, windowMs, now, windowMs === WEEK_MS ? MIN_WEEK_AVG_MS : MIN_AVG_MS)
  const perHourAvg = avg == null ? null : round1(avg)
  if (last.used >= 100) return { state: 'out', resetsAt, perHourAvg }
  const fit = windowFit(samples, now)
  if (fit.length < MIN_SAMPLES || fit.at(-1).at - fit[0].at < MIN_SPAN_MS) return { state: 'gathering', resetsAt }
  const recent = recentRate(fit, now)
  const rate = avg == null ? recent : RECENT_WEIGHT * recent + (1 - RECENT_WEIGHT) * avg
  const out = { resetsAt, perHour: round1(rate), perHourRecent: round1(recent), perHourAvg }
  if (rate < FLAT_PER_HOUR) return { state: 'lasts', ...out }
  // From the latest reading, not the fitted line, so the projection never starts behind reality.
  const at = Math.round(last.at + ((100 - last.used) / rate) * 3600e3)
  if (resetsAt && at >= resetsAt) return { state: 'lasts', ...out }
  return { state: 'runsOut', at, ...out }
}

/**
 * Weekly % per 5-hour % from the samples [{ at, five: { used }, week: { used } }]: the rises of both
 * between consecutive samples, summed, skipping any step where either window reset (the whole-percent
 * rounding cancels out within a run). `{ ratio, from: 'samples' | 'default' }`, clamped to
 * [RATIO_MIN, RATIO_MAX]; RATIO_PRIOR until the 5-hour window has risen RATIO_MIN_FIVE % in the samples.
 */
export function weeklyPerFive(samples) {
  let dFive = 0, dWeek = 0
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]
    if (!a.five || !b.five || !a.week || !b.week) continue
    const df = b.five.used - a.five.used, dw = b.week.used - a.week.used
    if (df < 0 || dw < 0) continue // a reset
    dFive += df; dWeek += dw
  }
  if (dFive < RATIO_MIN_FIVE) return { ratio: RATIO_PRIOR, from: 'default' }
  return { ratio: Math.round(Math.min(RATIO_MAX, Math.max(RATIO_MIN, dWeek / dFive)) * 1000) / 1000, from: 'samples' }
}

/**
 * The earliest the week can run out at `pace` (5-hour %/h): the current 5-hour window runs to its
 * cap or its reset, then each later window runs flat out from its start, `ratio` weekly % per 5-hour %.
 * `{ state: 'runsOut', at }`, or `{ state: 'lasts' }` when that is not before `weekResetsAt`.
 */
export function flatOut({ weekUsed, weekResetsAt, fiveUsed, fiveResetsAt, pace, ratio, now }) {
  if (!(pace > 0) || !(ratio > 0)) return { state: 'lasts' }
  const fivePerMs = pace / 3600e3, weekPerMs = fivePerMs * ratio
  const live = fiveResetsAt > now // else the 5-hour window hasn't started (or has just reset)
  let t = now, w = weekUsed, f = live ? fiveUsed : 0, reset = live ? fiveResetsAt : now + FIVE_HOUR_MS
  const end = weekResetsAt || Infinity
  for (let i = 0; i < 100 && t < end; i++) {
    if (f < 100) {
      const runUntil = Math.min(t + (100 - f) / fivePerMs, reset, end)
      const outAt = t + (100 - w) / weekPerMs
      if (outAt <= runUntil) return { state: 'runsOut', at: Math.round(outAt) }
      w += (runUntil - t) * weekPerMs
    }
    t = reset; f = 0; reset = t + FIVE_HOUR_MS
  }
  return { state: 'lasts' }
}

/**
 * The weekly projection. `week`: { used, resetsAt }; `five`: the 5-hour projection plus its `used`
 * (or `{ none: true }` with no 5-hour limit); `ratio`: weeklyPerFive(); `samples`: the weekly series
 * (used only without a 5-hour limit). Returns `{ state, at?, resetsAt, perHour, ratio, ratioFrom,
 * basis: 'flatOut', average }`; `average` is `{ state: 'runsOut' | 'lasts', at?, perHour }` at this
 * week's own average pace, or null until the week is an hour old.
 */
export function projectWeekly({ week, five, ratio = { ratio: RATIO_PRIOR, from: 'default' }, samples = [], now = Date.now() }) {
  const resetsAt = week.resetsAt || null
  if (week.used >= 100) return { state: 'out', resetsAt, average: null }
  const a = averageRate(week.used, resetsAt, WEEK_MS, now, MIN_WEEK_AVG_MS)
  let average = null
  if (a != null) {
    const at = a > 0 ? Math.round(now + ((100 - week.used) / a) * 3600e3) : Infinity
    average = resetsAt && at >= resetsAt ? { state: 'lasts', perHour: round1(a) } : { state: 'runsOut', at, perHour: round1(a) }
  }
  if (!five || five.none) { // no 5-hour cap to respect: the weekly samples alone
    return { ...project(samples, now, { windowMs: WEEK_MS }), resetsAt, basis: 'samples', average }
  }
  const pace = five.perHour ?? five.perHourAvg
  if (pace == null) return { state: 'gathering', resetsAt, average }
  const base = { resetsAt, perHour: round1(pace * ratio.ratio), ratio: ratio.ratio, ratioFrom: ratio.from, basis: 'flatOut', average }
  if (pace < FLAT_PER_HOUR) return { state: 'lasts', ...base }
  const f = flatOut({ weekUsed: week.used, weekResetsAt: resetsAt, fiveUsed: five.used, fiveResetsAt: five.resetsAt, pace, ratio: ratio.ratio, now })
  return { ...f, ...base }
}

/**
 * Which window binds first, for the top bar: `{ window: 'fiveHour' | 'weekly', state: 'out' | 'runsOut', at? }`
 * or null. A weekly run-out shows when it comes before the 5-hour one, or (the 5-hour one lasting)
 * before the next 5-hour reset; a later weekly run-out stays in the details.
 */
export function binding(fiveHour, weekly) {
  if (weekly?.state === 'out') return { window: 'weekly', state: 'out' }
  if (fiveHour?.state === 'out') return { window: 'fiveHour', state: 'out' }
  const f = fiveHour?.state === 'runsOut' ? fiveHour.at : null
  const w = weekly?.state === 'runsOut' ? weekly.at : null
  if (w != null && (f != null ? w < f : fiveHour?.none || !fiveHour?.resetsAt || w < fiveHour.resetsAt)) return { window: 'weekly', state: 'runsOut', at: w }
  if (f != null) return { window: 'fiveHour', state: 'runsOut', at: f }
  return null
}
