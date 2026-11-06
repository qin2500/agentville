#!/usr/bin/env node
/**
 * Fit how a subscription usage window weighs tokens, from the research log (server/research.mjs).
 *
 *   node tools/usage-fit.mjs [--window five_hour|seven_day] [--account <id>] [--by field|model]
 *                            [--gap <minutes>] [--data <dir>]
 *
 * Takes the active account's readings, cuts them into intervals of at least `--gap` minutes (30 by
 * default) inside one window (same reset time, same account throughout), sums the tokens logged in
 * each interval and fits `Δused% = Σ weight × tokens` with non-negative least squares. Weights are
 * printed as % of the window per million tokens, and relative to the first feature.
 *
 * Caveats: tokens are every Claude session on this Mac, so sessions on another login (the pool, or
 * a terminal session still on the old account after a switch) add noise; utilization is coarse, so
 * longer gaps fit better; and the fit needs variety (some hours heavy on output, some on cache reads).
 */
import fs from 'node:fs'
import path from 'node:path'
import { defaultDataDir, legacyDataDir } from '../server/datadir.mjs'

const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def }
const dir = path.join(opt('data', fs.existsSync(defaultDataDir()) ? defaultDataDir() : legacyDataDir()), 'research')
const windowName = opt('window', 'five_hour')
const by = opt('by', 'field')
const gapMs = Number(opt('gap', 30)) * 60e3
const BUCKET_MS = 5 * 60e3
const FIELDS = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead']

const read = (kind) => fs.readdirSync(dir).filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.jsonl')).sort()
  .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean))
if (!fs.existsSync(dir)) { console.log(`No research log yet at ${dir}. Agentville writes it while running.`); process.exit(0) }

const family = (m) => (/opus/.test(m) ? 'opus' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : /fable/.test(m) ? 'fable' : 'other')
const featureOf = (row, i) => (by === 'model' ? `${family(row.m)}${row.sp === 'fast' ? '-fast' : ''}.${FIELDS[i]}` : FIELDS[i])

// Tokens per 5-minute bucket and feature.
const buckets = new Map()
const features = new Set()
for (const r of read('tokens')) {
  const b = buckets.get(r.t) || new Map()
  r.f.forEach((v, i) => { if (!v) return; const k = featureOf(r, i); features.add(k); b.set(k, (b.get(k) || 0) + v) })
  buckets.set(r.t, b)
}
const feats = [...features].sort()

// Active readings of the chosen account, oldest first.
const readings = read('usage').filter((u) => u.active && u.windows?.[windowName]).sort((a, b) => a.at - b.at)
const counts = new Map()
for (const u of readings) counts.set(u.account, (counts.get(u.account) || 0) + 1)
const account = opt('account', [...counts].sort((a, b) => b[1] - a[1])[0]?.[0])
console.log(`Research log: ${buckets.size} token buckets, ${readings.length} active readings (${[...counts].map(([a, n]) => `${a.slice(0, 8)}: ${n}`).join(', ') || 'none'}).`)
if (!account) process.exit(0)

// Intervals: a run of readings of this account with one reset time, cut every `gap`.
const rows = []
let start = null, prev = null
for (const u of readings) {
  const w = u.windows[windowName]
  const same = start && u.account === account && prev.account === account && w.resetsAt === start.windows[windowName].resetsAt
  if (!same) { start = u.account === account ? u : null; prev = u; continue }
  prev = u
  if (u.at - start.at < gapMs) continue
  const x = new Map()
  for (let t = Math.ceil(start.at / BUCKET_MS) * BUCKET_MS; t + BUCKET_MS <= u.at; t += BUCKET_MS) for (const [k, v] of buckets.get(t) || []) x.set(k, (x.get(k) || 0) + v)
  rows.push({ from: start.at, to: u.at, dy: w.used - start.windows[windowName].used, x: feats.map((k) => (x.get(k) || 0) / 1e6) })
  start = u
}
console.log(`Account ${account.slice(0, 8)}, window ${windowName}: ${rows.length} intervals of ≥${gapMs / 60e3} min.`)
if (rows.length < feats.length + 2) { console.log(`Not enough intervals to fit ${feats.length} weights yet; keep Agentville running.`); process.exit(0) }

// Non-negative least squares by projected coordinate descent.
const X = rows.map((r) => r.x), y = rows.map((r) => r.dy)
const w = feats.map(() => 0)
for (let it = 0; it < 5000; it++) {
  let moved = 0
  for (let j = 0; j < feats.length; j++) {
    let num = 0, den = 0
    for (let i = 0; i < X.length; i++) {
      const pred = X[i].reduce((s, v, k) => s + v * w[k], 0)
      num += X[i][j] * (y[i] - pred + X[i][j] * w[j])
      den += X[i][j] * X[i][j]
    }
    const next = den ? Math.max(0, num / den) : 0
    moved = Math.max(moved, Math.abs(next - w[j]))
    w[j] = next
  }
  if (moved < 1e-9) break
}
const mean = y.reduce((a, b) => a + b, 0) / y.length
const ssRes = X.reduce((s, x, i) => s + (y[i] - x.reduce((a, v, k) => a + v * w[k], 0)) ** 2, 0)
const ssTot = y.reduce((s, v) => s + (v - mean) ** 2, 0)
const totals = feats.map((_, j) => X.reduce((s, x) => s + x[j], 0))
const ref = w.find((v) => v > 0) || 1
console.log(`R² ${(1 - ssRes / (ssTot || 1)).toFixed(3)}\n`)
console.log('feature'.padEnd(26) + 'tokens (M)'.padStart(12) + '%/M tokens'.padStart(14) + 'relative'.padStart(10) + 'M tokens per 1%'.padStart(18))
feats.forEach((k, j) => console.log(k.padEnd(26) + totals[j].toFixed(1).padStart(12) + w[j].toPrecision(3).padStart(14) + (w[j] / ref).toFixed(3).padStart(10) + (w[j] ? (1 / w[j]).toFixed(1) : '—').padStart(18)))
