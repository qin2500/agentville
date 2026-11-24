/**
 * Provider-exhausted detection and the fallback target (docs/providers-design.md §3.2–3.3).
 *
 * A provider is "exhausted" when every one of its accounts is out and the rotation inside the provider found
 * nowhere to go (the sampler's `info().blocked.why === 'all accounts low'`), confirmed over 2 ticks and
 * EXHAUST_CONFIRM_MS, and it won't free up within `handoff.minWaitMs`. A provider without accounts is exhausted
 * when one of its live agents stopped on the limit in the last LIMIT_WINDOW_MS and none has run since.
 *
 * The fallback rule: a non-default provider out -> the default; the default out -> the next in providerOrder.
 * Codex is never a target. Everything is injected (settings from provider-settings.mjs, one sampler per provider
 * from autoswitch.mjs, the adapters from providers/index.mjs), so this file has no I/O of its own.
 */

export const EXHAUST_CONFIRM_MS = 2 * 60 * 1000
export const EXHAUST_CONFIRM_TICKS = 2
export const LIMIT_WINDOW_MS = 10 * 60 * 1000
export const DEFAULT_MIN_WAIT_MS = 30 * 60 * 1000
const BLOCKED_WHY = 'all accounts low'
const NEVER_TARGET = new Set(['codex'])

/**
 * The provider that takes over from `from`, or null. Pure; exported for tests.
 * @param {string} from
 * @param {{ defaultProvider:string, providerOrder:string[] }} settings
 * @param {Record<string, { usable:boolean, why?:string }>} state
 */
export function fallbackTarget(from, { defaultProvider, providerOrder }, state) {
  const order = [defaultProvider, ...(providerOrder || []).filter((p) => p !== defaultProvider)]
  return order.find((p) => p && p !== from && !NEVER_TARGET.has(p) && state?.[p]?.usable) ?? null
}

/**
 * For a provider without accounts: { at, until } of the latest limit stop that still holds, or null.
 * "Holds" = a live agent stopped on the limit within LIMIT_WINDOW_MS, and no other agent has run since.
 */
export function limitStopsOut(agents, now) {
  const list = Array.isArray(agents) ? agents : []
  const stopOf = (a) => (a?.limitStop && a.limitStop.kind !== 'api' && a.limitStop.at > 0 ? a.limitStop : null)
  const stops = list.filter((a) => a?.live && stopOf(a) && now - stopOf(a).at <= LIMIT_WINDOW_MS)
  if (!stops.length) return null
  const at = Math.max(...stops.map((a) => stopOf(a).at))
  const ranSince = list.some((a) => !stopOf(a) && (a?.lastActivityAt || 0) > at)
  if (ranSince) return null
  const resets = stops.map((a) => stopOf(a).resetsAt).filter((v) => typeof v === 'number' && v > 0)
  return { at, until: resets.length ? Math.max(...resets) : null }
}

/**
 * @param {object} o
 * @param {{ get():any }} o.settings                 createProviderSettings() (P1); get() may be sync or async
 * @param {() => any[]} o.providers                  adapters: { id, capabilities:{ accounts, start, handoffTarget }, available() }
 * @param {Record<string, any>|((id:string)=>any)} [o.samplers]  per-provider sampler with async info() (P10)
 * @param {(id:string) => any[]} [o.agents]          the provider's agents (API records), for providers without accounts
 * @param {() => number} [o.now]
 * @param {(ev:{ type:'start'|'end', provider:string, episode:{ id, since, until } }) => void} [o.onEpisode]
 */
export function createProviderSwitch({ settings, providers, samplers = {}, agents = () => [], now = Date.now, onEpisode = () => {} } = {}) {
  const samplerOf = typeof samplers === 'function' ? samplers : (id) => samplers?.[id] ?? null
  /** per provider: { since, until, ticks, episode: {id,since,until}|null, exhausted } */
  const track = new Map()
  /** id -> { usable, why } from the last tick */
  let usableState = {}
  let lastSettings = normalize({})

  function normalize(s) {
    const defaultProvider = s?.defaultProvider || 'claude'
    const order = Array.isArray(s?.providerOrder) ? s.providerOrder : [defaultProvider]
    const minWaitMs = Number.isFinite(s?.handoff?.minWaitMs) && s.handoff.minWaitMs >= 0 ? s.handoff.minWaitMs : DEFAULT_MIN_WAIT_MS
    return { defaultProvider, providerOrder: [defaultProvider, ...order.filter((p) => p !== defaultProvider)], minWaitMs }
  }

  /** The raw "out" signal for one adapter right now: { until } or null. */
  async function outSignal(adapter, t) {
    if (adapter.capabilities?.accounts) {
      const sampler = samplerOf(adapter.id)
      if (!sampler?.info) return null
      let info
      try { info = await sampler.info() } catch { return null }
      const b = info?.blocked
      return b && b.why === BLOCKED_WHY ? { until: typeof b.until === 'number' ? b.until : null } : null
    }
    let list
    try { list = await agents(adapter.id) } catch { list = [] }
    const out = limitStopsOut(list, t)
    return out ? { until: out.until } : null
  }

  function step(id, signal, t, minWaitMs) {
    const prev = track.get(id)
    if (!signal) {
      if (prev?.episode) onEpisode({ type: 'end', provider: id, episode: { ...prev.episode } })
      track.delete(id)
      return false
    }
    const cur = prev || { since: t, ticks: 0, episode: null }
    cur.ticks += 1
    cur.until = signal.until
    if (!cur.episode) {
      cur.episode = { id: `${id}-${cur.since}`, since: cur.since, until: cur.until }
      onEpisode({ type: 'start', provider: id, episode: { ...cur.episode } })
    } else cur.episode.until = cur.until
    const confirmed = cur.ticks >= EXHAUST_CONFIRM_TICKS && t - cur.since >= EXHAUST_CONFIRM_MS
    const longWait = cur.until == null || cur.until - t > minWaitMs
    cur.exhausted = confirmed && longWait
    track.set(id, cur)
    return cur.exhausted
  }

  /** One pass over every provider. Returns status(). */
  async function tick() {
    const t = now()
    let s
    try { s = await settings?.get?.() } catch { s = null }
    lastSettings = normalize(s || {})
    const list = (await providers?.()) || []
    const seen = new Set()
    const next = {}
    for (const adapter of list) {
      if (!adapter?.id) continue
      seen.add(adapter.id)
      const out = step(adapter.id, await outSignal(adapter, t), t, lastSettings.minWaitMs)
      next[adapter.id] = await usableOf(adapter, out)
    }
    for (const id of [...track.keys()]) if (!seen.has(id)) step(id, null, t, 0)
    usableState = next
    return status()
  }

  async function usableOf(adapter, isOut) {
    const c = adapter.capabilities || {}
    if (NEVER_TARGET.has(adapter.id)) return { usable: false, why: 'display only' }
    if (!c.start || !c.handoffTarget) return { usable: false, why: 'cannot take a handoff' }
    let av
    try { av = await adapter.available?.() } catch { av = { ok: false, why: 'check failed' } }
    if (!av?.ok) return { usable: false, why: av?.why || 'not available' }
    if (isOut) return { usable: false, why: 'out on every account' }
    return { usable: true }
  }

  const exhausted = (id) => !!track.get(id)?.exhausted
  /** The current episode (from the first "out" tick until it clears), or null. Exists before it is confirmed. */
  const episode = (id) => (track.get(id)?.episode ? { ...track.get(id).episode } : null)
  const state = () => ({ ...usableState })
  const usable = (id) => !!usableState[id]?.usable
  /** Where `from`'s agents go now, or null ("no provider has room"). Re-check right before starting (§3.4). */
  const target = (from) => fallbackTarget(from, lastSettings, usableState)
  /** For GET /api/providers: id -> { exhausted: {since, until}|null, usable, why, target } */
  function status() {
    const out = {}
    for (const id of new Set([...Object.keys(usableState), ...track.keys()])) {
      const tr = track.get(id)
      out[id] = { exhausted: tr?.exhausted ? { since: tr.since, until: tr.until ?? null } : null,
        episode: tr?.episode ? { ...tr.episode } : null, usable: !!usableState[id]?.usable,
        ...(usableState[id]?.why && { why: usableState[id].why }), target: tr?.exhausted ? target(id) : null }
    }
    return out
  }

  return { tick, exhausted, episode, state, usable, target, status }
}
