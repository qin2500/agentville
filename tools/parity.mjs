#!/usr/bin/env node
// Engine v2 parity tracker. Derives each item's status in docs/engine-parity.json from the repo:
//   tag   = a `// parity: <id>[, <id>...]` comment in web/src/engine, mods or test (.js/.mjs/.css/.ts files)
//   proof = (static mode, `proof: "static"`) a test whose title contains `[<id>]` in a test(...) / it(...) / t(...) call under test/ or e2e/
//           that is NOT todo or skipped. HEURISTIC: a call is excluded when the rest of its first line has a
//           literal `todo: true|'..'|".."` or `skip: ...` option. A dynamic option (`todo: TODO`) counts as
//           proof, because the tag it needs lives in the module the test waits for. test.todo()/test.skip()
//           never match (the regex needs `name(`).
//   proof = (run mode, `--run`, `proof: "run"`) a test that ACTUALLY RAN under `node --test` (TAP) over test/engine-*.test.mjs and
//           passed without being todo/skip (at runtime or via a parent); its own title or any ancestor title carries `[<id>]`.
//           e2e titles count only from a Playwright JSON report (`--e2e-report <file>`, passed non-skipped specs).
//   status: tag + proof -> done, tag only -> partial, otherwise -> missing. `waived` is kept untouched.
// Usage: node tools/parity.mjs [--write] [--check] [--run] [--e2e-report f.json] [--gate M4]
//   --run runs the suite for proof; --gate always implies --run. --write --run stores "proof": "run" in the JSON;
//   --check is static and cheap: for a "run" JSON it verifies tags/engine and that nothing is done without a tag.
//   (no flag)  print a summary    --write  rewrite docs/engine-parity.json    --check  exit 1 on drift
//   --gate Mn  print done/(items with milestone <= Mn minus waived); exit 1 below the floor (0.90, 1.00 at M7)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DOC = 'docs/engine-parity.json';
const TAG_DIRS = ['web/src/engine', 'mods', 'test'];
const TEST_DIRS = ['test', 'e2e'];
const CODE = /\.(m?js|ts|css)$/;
// Per-milestone gate floor: M3-M6 keep 0.90; M7 (the switch to the new engine) needs everything not waived.
export const GATE_MIN_BY = { M7: 1.0 };
export const GATE_MIN_DEFAULT = 0.9;
export const gateMin = ms => GATE_MIN_BY[ms] ?? GATE_MIN_DEFAULT;

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (CODE.test(e.name)) out.push(p);
  }
  return out;
}

/** Scan the repo at `root`. Returns { tags: Map<id, Set<file>>, proofs: Map<id, Set<file>> }. */
export function scan(root, ids, ran = null) {
  const known = new Set(ids), tags = new Map(), proofs = new Map();
  const add = (m, id, file) => { if (known.has(id)) (m.get(id) || m.set(id, new Set()).get(id)).add(file); };
  for (const d of TAG_DIRS) for (const f of walk(path.join(root, d))) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:\/\/|\/\*)\s*parity:\s*([^\n*]*)/g))
      for (const id of m[1].split(/[\s,]+/).filter(Boolean)) add(tags, id, rel);
  }
  if (ran) {
    for (const [id, files] of ran) add(proofs, id, [...files][0] || 'run');
    return { tags, proofs };
  }
  const call = /\b(?:test|it|t)\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1([^\n]*)/g;
  for (const d of TEST_DIRS) for (const f of walk(path.join(root, d))) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    for (const m of fs.readFileSync(f, 'utf8').matchAll(call)) {
      if (/\b(?:todo|skip)\s*:\s*(?:true|'|"|`)/.test(m[3])) continue;
      for (const b of m[2].matchAll(/\[([a-z0-9][a-z0-9._-]*)\]/gi)) add(proofs, b[1], rel);
    }
  }
  return { tags, proofs };
}

/** Return a new doc with engine + status recomputed; every other field is preserved. */
export function compute(root, doc, ran = null) {
  const { tags, proofs } = scan(root, doc.items.map(i => i.id), ran);
  const items = doc.items.map(it => {
    const t = tags.get(it.id), p = proofs.get(it.id);
    const status = t && p ? 'done' : t ? 'partial' : 'missing';
    const out = {};
    for (const [k, v] of Object.entries(it)) if (k !== 'engine' && k !== 'status') out[k] = v;
    // engine goes just before status; waived (if any) stays after it
    const { waived, ...rest } = out;
    const res = { ...rest, engine: t ? [...t].sort() : [], status };
    if (waived !== undefined) res.waived = waived;
    return res;
  });
  return { ...doc, items };
}

const idsOf = title => [...title.matchAll(/\[([a-z0-9][a-z0-9._-]*)\]/gi)].map(b => b[1]);
function addRan(map, titles, file) {
  for (const t of titles) for (const id of idsOf(t)) (map.get(id) || map.set(id, new Set()).get(id)).add(file);
}

/** Parse node:test TAP output. Returns { passed: string[][] } = title paths (root..leaf) of leaf tests that passed
 *  and were not todo/skip, whose ancestors also passed and were not todo/skip. Subtests precede their parent line. */
export function parseTap(tap) {
  const pending = {}, line = /^(\s*)(not ok|ok)\s+\d+(?:\s+-\s+(.*?))?(?:\s+#\s*(SKIP|TODO)\b.*)?\s*$/i;
  for (const raw of String(tap).split('\n')) {
    const m = line.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    const depth = Math.floor(m[1].length / 4);
    const node = { name: (m[3] || '').replace(/\\#/g, '#'), ok: m[2].toLowerCase() === 'ok' && !m[4], kids: pending[depth + 1] || [] };
    delete pending[depth + 1];
    for (const d of Object.keys(pending)) if (Number(d) > depth + 1) delete pending[d];
    (pending[depth] || (pending[depth] = [])).push(node);
  }
  const passed = [];
  const walkN = (n, trail) => {
    if (!n.ok) return;
    const t = [...trail, n.name];
    if (!n.kids.length) passed.push(t); else for (const k of n.kids) walkN(k, t);
  };
  for (const r of pending[0] || []) walkN(r, []);
  return { passed };
}

/** Playwright JSON report -> title paths of specs that passed (every result expected, none skipped). */
export function parseE2e(report) {
  const passed = [];
  const walkS = (s, trail) => {
    const t = s.title ? [...trail, s.title] : trail;
    for (const sp of s.specs || []) {
      const tests = sp.tests || [];
      const ok = tests.length && tests.every(x => x.status === 'expected' || (x.results?.length && x.results.every(r => r.status === 'passed')) && x.status !== 'skipped');
      if (ok && sp.ok !== false) passed.push([...t, sp.title]);
    }
    for (const c of s.suites || []) walkS(c, t);
  };
  for (const s of report.suites || []) walkS(s, []);
  return { passed };
}

/** Run test/engine-*.test.mjs under node --test (TAP) and collect ids proven by tests that really passed. */
export function runProof(root, e2eReport = null) {
  const ran = new Map(), dir = path.join(root, 'test');
  const files = fs.readdirSync(dir).filter(f => /^engine-.*\.test\.mjs$/.test(f)).map(f => path.join('test', f));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  for (const p of parseTap(r.stdout || '').passed) addRan(ran, p, 'test/engine-*.test.mjs');
  if (e2eReport) for (const p of parseE2e(JSON.parse(fs.readFileSync(e2eReport, 'utf8'))).passed) addRan(ran, p, 'e2e');
  return ran;
}

const val = v => Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v);
/** Stable formatting: one item per line, arrays with ", " separators. */
export function render(doc) {
  const { items, ...head } = doc;
  const lines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${val(v)},`);
  const rows = items.map(it => `    { ${Object.entries(it).map(([k, v]) => `${JSON.stringify(k)}: ${val(v)}`).join(', ')} }`);
  return `{\n${lines.join('\n')}\n  "items": [\n${rows.join(',\n')}\n  ]\n}\n`;
}

const msNum = m => Number(String(m).replace(/\D/g, '')) || 0;
export function gate(doc, ms) {
  const cap = msNum(ms), pool = doc.items.filter(i => msNum(i.milestone) <= cap && !i.waived);
  const done = pool.filter(i => i.status === 'done').length;
  return { ms, done, total: pool.length, ratio: pool.length ? done / pool.length : 1 };
}

/** In-process check: returns { ok, drift: [{id, field, was, now}] }. */
export function check(root = defaultRoot) {
  const file = path.join(root, DOC), text = fs.readFileSync(file, 'utf8'), doc = JSON.parse(text);
  const run = doc.proof === 'run', next = compute(root, doc), drift = [];
  next.items.forEach((n, i) => {
    const o = doc.items[i];
    if (run) {
      // run-based statuses cannot be recomputed cheaply: tags/engine must match, and done needs a tag
      if (JSON.stringify(o.engine) !== JSON.stringify(n.engine)) drift.push({ id: n.id, field: 'engine', was: o.engine, now: n.engine });
      if (o.status === 'done' && !n.engine.length) drift.push({ id: n.id, field: 'status', was: o.status, now: 'partial/missing' });
      return;
    }
    for (const f of ['status', 'engine']) if (JSON.stringify(o[f]) !== JSON.stringify(n[f])) drift.push({ id: n.id, field: f, was: o[f], now: n[f] });
  });
  if (!drift.length && render(run ? doc : next) !== text) drift.push({ id: '*', field: 'format', was: 'unstable', now: 'run --write' });
  return { ok: !drift.length, drift };
}

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), root = defaultRoot, file = path.join(root, DOC);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  let code = 0;
  const gi = args.indexOf('--gate'), ei = args.indexOf('--e2e-report');
  const useRun = args.includes('--run') || gi >= 0;
  const ran = useRun ? runProof(root, ei >= 0 ? args[ei + 1] : null) : null;
  const calc = () => compute(root, doc, ran);
  if (args.includes('--write')) {
    const next = { ...calc(), proof: useRun ? 'run' : 'static' };
    fs.writeFileSync(file, render(next));
    Object.assign(doc, next);
  }
  if (args.includes('--check')) {
    const r = check(root);
    if (!r.ok) { for (const d of r.drift.slice(0, 40)) console.error(`drift ${d.id} ${d.field}: ${JSON.stringify(d.was)} -> ${JSON.stringify(d.now)}`); console.error(`${r.drift.length} drifted; run node tools/parity.mjs --write`); code = 1; }
  }
  if (gi >= 0) {
    const cur = args.includes('--write') ? doc : calc(), g = gate(cur, args[gi + 1] || 'M4');
    console.log(`${g.ms} gate: ${g.done}/${g.total} = ${g.ratio.toFixed(3)} (need ${gateMin(g.ms)})`);
    if (g.ratio < gateMin(g.ms)) code = 1;
  } else if (!args.includes('--check')) {
    const cur = calc(), by = {};
    for (const i of cur.items) by[i.status] = (by[i.status] || 0) + 1;
    console.log(JSON.stringify(by));
  }
  process.exit(code);
}
