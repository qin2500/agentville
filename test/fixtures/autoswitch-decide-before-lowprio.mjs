/**
 * A frozen copy of autoswitch.mjs `decide()` from before low-priority accounts (main at 76e5a5e), the oracle
 * for "regular-only scenarios decide exactly as before" (test/autoswitch-lowprio.test.mjs). Do not edit.
 */
import {
  SWITCH_AT, PROJECT_WITHIN_MS, WAIT_RESET_MS, TARGET_MIN_ROOM, SOON_WEEK_MS, COOLDOWN_MS,
  REBALANCE_LEAD_MS, REBALANCE_MIN_ROOM, REBALANCE_MAX_FIVE, AUTO_POOL, NO_TARGET_WHY, hardOut, canRun,
} from '../../server/autoswitch.mjs'

export function decideBefore({ enabled, active, saved, activeUsage, usage, limitHit, busy, lastAutoAt, poolAvailable, now, onWork = false, quarantine = new Set(), prefer = false, rebalance = false, projectedMs = null, manual = false, retryAt = 0 }) {
  if (active === 'pool') return { action: 'none', why: 'on the pool' }
  if (!saved.includes(active)) return { action: 'none', why: 'not a saved account' }
  const banned = onWork && quarantine.has(active)
  if (!enabled && !banned) return { action: 'none', why: 'off' }
  if (busy) return { action: 'none', why: 'a switch is running' }
  if (retryAt && now < retryAt) return { action: 'none', why: 'backoff' } // after a failed attempt, on every path
  if (!banned && lastAutoAt && now - lastAutoAt < COOLDOWN_MS) return { action: 'none', why: 'cooldown' }
  const five = activeUsage?.fiveHour?.used, week = activeUsage?.weekly?.used
  // Really out: the only thing that moves us off an account picked by hand.
  const hard = hardOut(activeUsage, limitHit)
  const soft = manual ? '' : five >= SWITCH_AT ? 'five_hour' : week >= SWITCH_AT ? 'weekly' : projectedMs != null && projectedMs <= PROJECT_WITHIN_MS ? 'projected' : ''
  const out = hard || soft
  const why = banned ? 'quarantine' : out || (prefer && !onWork && !quarantine.has(active) ? 'prefer' : '') || (rebalance && !manual ? 'rebalance' : '')
  if (!why) return { action: 'none', why: 'not out' }
  // Only the 5-hour window is the problem and it resets very soon: agents can wait, so stay.
  if (out && !banned && !(week >= SWITCH_AT)) {
    const resets = activeUsage?.fiveHour?.resetsAt
    if (resets != null && resets - now <= WAIT_RESET_MS) return { action: 'none', why: 'waiting for the 5-hour reset', waitUntil: resets }
  }
  const ok = (u) => u && !u.error && u.fiveHour && u.weekly && (u.fiveHour.none || 100 - u.fiveHour.used >= TARGET_MIN_ROOM) && 100 - u.weekly.used >= TARGET_MIN_ROOM
  // Off the work Wi-Fi quarantine accounts rank first; on it they aren't candidates at all.
  // Then, among accounts whose week resets within SOON_WEEK_MS, the soonest weekly reset (use it before it
  // expires), then the 5-hour reset; any other account ranks after those, by most weekly room.
  const rank = (id) => (onWork ? 0 : quarantine.has(id) ? 0 : 1)
  const at = (id, k) => usage.get(id)[k].resetsAt ?? Infinity
  const soon = (id) => at(id, 'weekly') - now <= SOON_WEEK_MS
  const week_ = (a, b) => { const d = at(a, 'weekly') - at(b, 'weekly'); return Math.abs(d) < 3600e3 ? 0 : d } // within the hour: a tie
  const order = (a, b) => rank(a) - rank(b) || (soon(a) ? 0 : 1) - (soon(b) ? 0 : 1)
    || (soon(a) ? week_(a, b) : usage.get(a).weekly.used - usage.get(b).weekly.used) || at(a, 'fiveHour') - at(b, 'fiveHour')
  const best = saved.filter((id) => id !== active && ok(usage.get(id)) && !(onWork && quarantine.has(id)) && (why !== 'prefer' || quarantine.has(id)))
    .sort(order)[0]
  if (why === 'rebalance') { // only for an account whose allowance expires well before the active one's, with real room
    // The active account's week must be known: an unreadable one (rate-limited, expired) is not "never expires".
    const w = !activeUsage?.error && activeUsage?.weekly
    if (!w || (w.resetsAt == null && w.used > 0)) return { action: 'none', why: 'not out' }
    const b = best && usage.get(best), mine = w.resetsAt ?? Infinity
    const worth = b && rank(best) <= rank(active) && at(best, 'weekly') + REBALANCE_LEAD_MS <= mine && 100 - b.weekly.used >= REBALANCE_MIN_ROOM && (b.fiveHour.none || b.fiveHour.used < REBALANCE_MAX_FIVE)
    return worth ? { action: 'switch', to: best, why } : { action: 'none', why: 'not out' }
  }
  if (best) return { action: 'switch', to: best, why }
  if (why === 'prefer') return { action: 'none', why: 'no quarantine account available' }
  if (why === 'quarantine') { // off a quarantine account no matter what: the regular one that frees up soonest, used up or not
    const frees = (id) => usage.get(id)?.fiveHour?.resetsAt ?? Infinity
    const any = saved.filter((id) => id !== active && !quarantine.has(id)).sort((a, b) => frees(a) - frees(b))[0]
    if (any) return { action: 'switch', to: any, why }
  }
  // Really out and nothing with TARGET_MIN_ROOM: the best account that can still run, not a stalled fleet.
  if (hard && !banned) {
    const room = (id) => 100 - usage.get(id).weekly.used
    const last = saved.filter((id) => id !== active && canRun(usage.get(id)) && !(onWork && quarantine.has(id)))
      .sort((a, b) => rank(a) - rank(b) || room(b) - room(a) || at(a, 'weekly') - at(b, 'weekly'))[0]
    if (last) return { action: 'switch', to: last, why, fallback: true }
  }
  if (AUTO_POOL && poolAvailable) return { action: 'switch', to: 'pool', why } // never: AUTO_POOL is false
  return { action: 'none', why: NO_TARGET_WHY }
}
