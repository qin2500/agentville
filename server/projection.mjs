/**
 * When will a usage window run out? A least-squares line through the recent `used` samples (percent),
 * extrapolated to 100 %. Pure: tests drive it with synthetic samples.
 */
export const FIT_MS = 30 * 60e3 // fit over the last 30 min of samples
export const MIN_SPAN_MS = 5 * 60e3 // and only once they span at least 5 min
export const MIN_SAMPLES = 3
export const FLAT_PER_HOUR = 0.25 // under 0.25 %/h counts as flat

/**
 * `samples`: [{ at, used, resetsAt }] oldest first, for one window (5-hour or weekly).
 * Returns one of:
 *   { state: 'gathering' }                       too few samples, or too short a span
 *   { state: 'out', resetsAt }                   already at 100 %
 *   { state: 'runsOut', at, resetsAt, perHour }  projected to hit 100 % before the reset
 *   { state: 'lasts', resetsAt, perHour }        lasts until the reset (or flat / falling)
 */
export function project(samples, now = Date.now()) {
  const last = samples.at(-1)
  if (!last) return { state: 'gathering' }
  const resetsAt = last.resetsAt || null
  if (last.used >= 100) return { state: 'out', resetsAt }
  // Only this window's samples: a reset (a new resetsAt, or usage dropping) starts the fit over.
  const recent = []
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]
    if (now - s.at > FIT_MS) break
    if (recent.length && (Math.abs((s.resetsAt || 0) - (resetsAt || 0)) > 120e3 || s.used > recent[0].used)) break
    recent.unshift(s)
  }
  if (recent.length < MIN_SAMPLES || recent.at(-1).at - recent[0].at < MIN_SPAN_MS) return { state: 'gathering', resetsAt }
  const mx = recent.reduce((a, s) => a + s.at, 0) / recent.length
  const my = recent.reduce((a, s) => a + s.used, 0) / recent.length
  let sxx = 0, sxy = 0
  for (const s of recent) { sxx += (s.at - mx) ** 2; sxy += (s.at - mx) * (s.used - my) }
  const slope = sxx ? sxy / sxx : 0 // percent per ms
  const perHour = Math.round(slope * 3600e3 * 10) / 10
  if (slope * 3600e3 < FLAT_PER_HOUR) return { state: 'lasts', resetsAt, perHour }
  // From the latest reading, not the fitted line, so the projection never starts behind reality.
  const at = Math.round(last.at + (100 - last.used) / slope)
  if (resetsAt && at >= resetsAt) return { state: 'lasts', resetsAt, perHour }
  return { state: 'runsOut', at, resetsAt, perHour }
}
