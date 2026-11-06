/**
 * The Models view: which model each agent is really on (its latest reply, from the transcript),
 * what it was told to use (its job's `--model`, resolved through the job's `_MODEL` aliases, or the
 * settings default), whether it goes through the shared gateway ("pool"), how full its context is,
 * and its tokens per model. Only model names, token counts and times leave this module: never a
 * path, transcript content or any other env value.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { modelEnv } from './claude-code.mjs'

const K200 = 200_000
const M1 = 1_000_000
const ALIASES = ['opus', 'sonnet', 'haiku', 'fable']
const FAMILY = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' }
const ONE_M = /\[1m\]$/i

/** Model id or alias -> `{ base, pool, oneM }`: "cc/claude-opus-5-5[1m]" -> base "claude-opus-5-5". */
export function parseModel(v) {
  let s = String(v || '').trim()
  const oneM = ONE_M.test(s)
  s = s.replace(ONE_M, '')
  const pool = /^cc\//i.test(s)
  s = s.replace(/^cc\//i, '').replace(/^anthropic\//i, '')
  return { base: s, pool, oneM }
}
/** "claude-opus-5-5-20260101" -> "claude-opus-5-5": what to compare (routing and dates aside). */
export const canonical = (v) => parseModel(v).base.toLowerCase().replace(/-\d{8}$/, '')
// "opusplan" plans on Opus; "default" is whatever Claude Code picks for the account (not compared).
const aliasOf = (v) => { const b = canonical(v); return ALIASES.includes(b) ? b : b === 'opusplan' ? 'opus' : null }
/** "opus" for any Opus id or alias. */
export function familyOf(v) {
  const b = canonical(v)
  return ALIASES.find((a) => b === a || new RegExp(`(^|[-/])${a}([-.]|$)`).test(b)) || null
}

/**
 * A short display name: "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5",
 * "claude-3-5-sonnet-20241022" -> "Sonnet 3.5", "gpt-6.1-sol" -> "GPT-6.1 Sol", "opus" -> "Opus".
 * The pool prefix and the 1M suffix are not part of the name (see route and window).
 */
export function modelLabel(v) {
  const b = canonical(v)
  if (!b) return ''
  if (ALIASES.includes(b)) return FAMILY[b]
  let m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?$/.exec(b)
  if (m) return `${FAMILY[m[1]]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  m = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)$/.exec(b)
  if (m) return `${FAMILY[m[3]]} ${m[1]}${m[2] ? `.${m[2]}` : ''}`
  m = /^gpt-([\d.]+)(?:-(.+))?$/.exec(b)
  if (m) return `GPT-${m[1]}${m[2] ? ` ${m[2].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')}` : ''}`
  return String(v).replace(/^cc\//i, '').replace(ONE_M, '').slice(0, 40)
}

/** `~/.claude/settings.json`: the default `model` and the env's `_MODEL` keys, nothing else. */
export async function readDefaults(claudeHome) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(claudeHome, 'settings.json'), 'utf8'))
    const model = typeof j?.model === 'string' && /^[\w.:/@[\]-]{1,80}$/.test(j.model) ? j.model : null
    return { model, env: modelEnv(j?.env) }
  } catch { return { model: null, env: {} } }
}

/**
 * Resolve what an agent was told to run on. `raw` is the flag or setting ("opus[1m]"); an alias goes
 * through `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` from the job's env, then the settings env. An alias
 * neither names stays an alias (Claude Code then picks its own default for it).
 */
export function resolve(raw, envs) {
  if (!raw) return null
  const p = parseModel(raw)
  const alias = aliasOf(raw)
  let id = p.base, via = null
  if (alias) {
    const key = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`
    const hit = envs.find((e) => e?.[key])
    if (hit) { id = hit[key]; via = key }
  }
  if (canonical(raw) === 'default') return { raw, id: null, alias: null, via: null, pool: p.pool, oneM: p.oneM, label: 'Default' }
  const r = parseModel(id)
  return { raw, id: r.base, alias: alias && !via ? alias : null, via, pool: p.pool || r.pool, oneM: p.oneM || r.oneM }
}

/** True when the reply's model is not the configured one; routing (cc/) and [1m] don't count. */
export function mismatch(now, configured) {
  if (!now || !configured) return false
  if (configured.alias) return familyOf(now) !== configured.alias
  if (!configured.id) return false
  return canonical(now) !== canonical(configured.id)
}

const sum = (a) => a.reduce((x, y) => x + y, 0)

/**
 * The /api/models body. `agents`: the classified list; `info`: id -> server-private
 * `{ kind, harness, parentId, file, config }`; `facts(file)`: spend.modelFacts; `profile`: the
 * account profile ('pool' | 'personal'); `defaults`: readDefaults().
 */
export function buildModels({ agents, info, facts, profile, defaults, now = Date.now(), catchingUp = false }) {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const rows = new Map()
  const rowOf = (id, depth = 0) => {
    if (rows.has(id)) return rows.get(id)
    const a = byId.get(id)
    const i = info.get(id) || {}
    const f = (i.file && facts(i.file)) || null
    const isCodex = a?.harness === 'codex'
    const cfg = i.config || {}
    const nowId = f?.model || (isCodex ? cfg.model : '') || ''
    let configured = null
    if (isCodex) {
      configured = cfg.model ? { raw: cfg.model, id: cfg.model, label: modelLabel(cfg.model), source: 'codex', effort: cfg.effort || null } : null
    } else if (['subagent', 'teammate'].includes(i.kind)) {
      const parent = info.get(i.parentId) || {}
      const envs = [parent.config?.env, defaults.env]
      const sub = envs.find((e) => e?.CLAUDE_CODE_SUBAGENT_MODEL)?.CLAUDE_CODE_SUBAGENT_MODEL
      const want = sub || cfg.requested
      if (want && /^inherit$/i.test(want)) {
        const p = depth < 5 && i.parentId && byId.has(i.parentId) ? rowOf(i.parentId, depth + 1) : null
        configured = { raw: 'inherit', id: p?.now?.id || null, label: 'Inherits', source: 'inherit', effort: null, oneM: false }
      } else if (want) {
        const r = resolve(want, envs)
        configured = { ...r, label: r.label || (r.alias ? FAMILY[r.alias] : modelLabel(r.id)), source: sub ? 'subagent-env' : 'subagent', effort: null }
      }
    } else {
      const flag = cfg.model || null
      const raw = flag || defaults.model
      const r = resolve(raw, [cfg.env, defaults.env])
      if (r) configured = { ...r, label: r.label || (r.alias ? FAMILY[r.alias] : modelLabel(r.id)), source: flag ? 'flag' : 'settings', effort: cfg.effort || null }
    }
    const pnow = parseModel(nowId)
    const route = isCodex ? 'codex' : pnow.pool || configured?.pool ? 'pool' : 'personal'
    // The window: 1M when the configuration says [1m] (a transcript never does), or when the context
    // is already past 200k; Codex reports its own.
    const used = f?.ctx || 0
    const cfgFamily = configured && (configured.alias || familyOf(configured.id))
    const sameFamily = !nowId || !cfgFamily || familyOf(nowId) === cfgFamily
    const oneM = !isCodex && ((Boolean(configured?.oneM) && sameFamily) || pnow.oneM || used > K200)
    const window = isCodex ? f?.window || 0 : nowId || used ? (oneM ? M1 : K200) : 0
    const tokens = Object.entries(f?.tokens || {}).map(([m, t]) => {
      const id = m || nowId || cfg.model || ''
      return { id, label: modelLabel(id) || 'Unknown', pool: parseModel(id).pool, input: t.day[0], output: t.day[1], cacheWrite: t.day[2], cacheRead: t.day[3], day: sum(t.day), hour: sum(t.hour) }
    }).filter((t) => t.day || t.hour).sort((x, y) => y.day - x.day)
    const history = (f?.history || []).slice(-5).reverse().map((h) => ({ at: h.at, from: h.from, to: h.to, fromLabel: label(h.from), toLabel: label(h.to) }))
    const flags = []
    // A settings default is only where an interactive session starts (`/model` or a flag can change
    // it on purpose), so it is shown but never flagged.
    const mis = configured?.source !== 'settings' && mismatch(nowId, configured)
    if (mis) flags.push('mismatch')
    if (route === 'pool' && profile === 'personal') flags.push('pool')
    if (window && used / window > 0.8) flags.push('context')
    const row = {
      id,
      now: nowId ? { id: nowId, label: modelLabel(nowId), at: f?.at || 0 } : null,
      configured: configured && {
        raw: configured.raw, id: configured.id || null, label: `${configured.label || ''}${configured.oneM && configured.label ? ' · 1M' : ''}`, source: configured.source,
        via: configured.via || null, alias: configured.alias || null, effort: configured.effort || null,
      },
      route,
      provider: isCodex ? cfg.provider || null : null,
      context: used ? { used, window: window || null } : null,
      // Each row counts its own transcript only: a lead's figure leaves out its subagents (own rows).
      tokens: { hour: sum(tokens.map((t) => t.hour)), day: sum(tokens.map((t) => t.day)) },
      byModel: tokens,
      history,
      flags,
      // Summary card this row belongs to, by its current model.
      card: nowId ? cardKey(nowId, oneM) : null,
      oneM,
    }
    rows.set(id, row)
    return row
  }
  const label = (id) => {
    const p = parseModel(id)
    return `${modelLabel(id)}${p.pool ? ' (pool)' : ''}`
  }
  for (const a of agents) rowOf(a.id)

  // Summary cards: one per model in use. Tokens are every listed agent's (resting ones too, they may
  // have worked today); agent counts are the ones not resting.
  const cards = new Map()
  const card = (key, id, oneM) => {
    if (!cards.has(key)) cards.set(key, { key, label: `${modelLabel(id)}${oneM ? ' · 1M' : ''}`, family: familyOf(id), agents: 0, live: 0, hour: 0, day: 0 })
    return cards.get(key)
  }
  for (const a of agents) {
    if (a.hidden) continue
    const r = rows.get(a.id)
    if (r.card && a.bucket !== 'resting') {
      const c = card(r.card, r.now.id, r.oneM)
      c.agents++
      if (a.live) c.live++
    }
    for (const t of r.byModel) {
      const c = card(cardKey(t.id, r.oneM && familyOf(t.id) === familyOf(r.now?.id)), t.id, r.oneM && familyOf(t.id) === familyOf(r.now?.id))
      c.hour += t.hour
      c.day += t.day
    }
  }
  const total = sum([...cards.values()].map((c) => c.day))
  const models = [...cards.values()].filter((c) => c.agents || c.day || c.hour)
    .map((c) => ({ ...c, share: total ? c.day / total : 0 }))
    // A fixed order (family, then newest version first), so cards never swap places as counts move.
    .sort((x, y) => rankOf(x) - rankOf(y) || y.label.localeCompare(x.label, undefined, { numeric: true }))
  return { serverTime: now, profile, catchingUp, models, agents: agents.map((a) => rows.get(a.id)) }
}

const rankOf = (c) => (c.family ? ALIASES.indexOf(c.family) : ALIASES.length)
/** Card key: the model (routing aside) plus its window. */
const cardKey = (id, oneM) => `${canonical(id)}${oneM ? '[1m]' : ''}`
