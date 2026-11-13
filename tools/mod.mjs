#!/usr/bin/env node
// Author kit for Agentville worlds (docs/make-your-own-world.md).
//   node tools/mod.mjs new <id> [--extends <bundled mod id, default agentville.base>]
//   node tools/mod.mjs check <id|all|_template>
//   node tools/mod.mjs shots <id> [--fixture busy] [--zoom 1] [--night] [--dry-run]
// `check` and `new` are pure node: no browser, no server, no network. `shots` is the only command that opens a
// browser, and only a hidden headless one (never a visible window).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(REPO, 'e2e', 'fixtures', 'engine');
const TEMPLATE = '_template';
const TEMPLATE_ID = 'example.template', TEMPLATE_NAME = 'Example Template';
const SEED = 7;

const lazy = rel => import(pathToFileURL(path.join(REPO, rel)).href);
const exists = rel => fs.existsSync(path.join(REPO, rel));

// ---------------------------------------------------------------- new

/** Rejects ids a collaborator may not use. Returns the id. */
export async function validateNewId(id) {
  const { validateModId } = await lazy('web/src/engine/mod/registry.js');
  validateModId(id);
  if (id.startsWith('agentville.')) throw new Error(`"${id}": the agentville.* prefix is reserved for the bundled worlds; use your own, e.g. "yourname.autumn"`);
  return id;
}

const titleOf = id => id.split('.').slice(1).join(' ').split(/[-\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || id;

/** Copies mods/_template to <root>/mods/<id>, rewrites id, name and extends. Returns the folder. */
export async function newMod(id, { root = REPO, extendsId = 'agentville.base' } = {}) {
  await validateNewId(id);
  const parents = (await lazy('web/src/engine/mod/registry.js')).listMods().map(m => m.id);
  if (!parents.includes(extendsId)) throw new Error(`--extends must be a bundled mod: ${parents.join(', ')}`);
  const dest = path.join(root, 'mods', id);
  if (fs.existsSync(dest)) throw new Error(`mods/${id} already exists`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(REPO, 'mods', TEMPLATE), dest, { recursive: true });
  const file = path.join(dest, 'index.js');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(`id: '${TEMPLATE_ID}'`, `id: '${id}'`)
    .replace(`name: '${TEMPLATE_NAME}'`, `name: '${titleOf(id)}'`)
    .replace(/extends: 'agentville\.base'/, `extends: '${extendsId}'`);
  fs.writeFileSync(file, src);
  return dest;
}

/** Regenerates mods/index.js when the generator (tools/mods-index.mjs) exists. Returns true if it ran. */
async function refreshIndex() {
  if (!exists('tools/mods-index.mjs')) return false;
  const m = await lazy('tools/mods-index.mjs');
  if (typeof m.writeModsIndex !== 'function') return false;
  await m.writeModsIndex(REPO);
  return true;
}

// ---------------------------------------------------------------- check

const SPEC = /(?:^|[\s;}])(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*(['"][^'"]+['"]|[^)]*)\)/g;
const GRANDFATHERED = ['city-plan.js', 'styles-pool.js'];

/** Built-in fallback boundary check, used when tools/mod-lint.mjs is not present. Mirrors its mod rules M1, M2, M5. */
function fallbackImports(dir) {
  const errors = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(m?js)$/.test(e.name) ? [path.join(d, e.name)] : []);
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
    for (const m of src.matchAll(SPEC)) {
      const spec = m[1] ?? m[2];
      const rel = path.relative(REPO, file);
      if (spec === undefined) { errors.push({ file: rel, spec: String(m[3]).trim(), rule: 'M2 dynamic import must be a literal' }); continue; }
      if (spec === '#agentville/mod') continue;
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (target.startsWith(dir + path.sep) || target === dir) continue;
        if (GRANDFATHERED.some(g => target.endsWith(g))) continue;
        errors.push({ file: rel, spec, rule: 'M1/M3 imports outside this mod folder' });
      } else errors.push({ file: rel, spec, rule: 'M2 only "#agentville/mod" and relative files inside the mod' });
    }
    if (/Math\.random|Date\.now|performance\.now|new Date\(/.test(src)) errors.push({ file: path.relative(REPO, file), spec: '', rule: 'M5 no clock or global randomness in a mod' });
  }
  return errors;
}

async function importErrors(dir) {
  if (exists('tools/mod-lint.mjs')) {
    const m = await lazy('tools/mod-lint.mjs');
    if (typeof m.checkModImports === 'function') return (await m.checkModImports(dir, { root: REPO })).errors;
  }
  return fallbackImports(dir);
}

/** A mod that is not in mods/index.js (the template) resolved the way registry.resolveMod would, for checking only. */
async function resolveUnbundled(mod) {
  const reg = await lazy('web/src/engine/mod/registry.js');
  return reg.resolveWith([mod], mod.id);   // same rules as the registry: per-level ctx.parent, M6, persist owner, lint
}

async function loadMod(id) {
  const reg = await lazy('web/src/engine/mod/registry.js');
  if (id === TEMPLATE) return resolveUnbundled((await lazy(`mods/${TEMPLATE}/index.js`)).default);
  const known = reg.listMods().some(m => m.id === id);
  if (known) return reg.resolveMod(id);
  // A folder that is not in mods/index.js yet.
  if (!exists(`mods/${id}/index.js`)) throw new Error(`no mod "${id}": there is no mods/${id}/index.js`);
  return resolveUnbundled((await lazy(`mods/${id}/index.js`)).default);
}

function fixtureNames() {
  return fs.readdirSync(FIXTURES).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}

const lintErrors = lint => lint.filter(l => l && (l.level === 'error' || l.severity === 'error'));
const lintSummary = lint => { const c = {}; for (const l of lint) c[l.kind || 'other'] = (c[l.kind || 'other'] || 0) + 1; return c; };

/** Runs every invariant for one mod. Returns { id, ok, problems: string[], fixtures: [{ name, sig, lint }] }. Never throws for a mod fault. */
export async function checkMod(id, { fixtures = fixtureNames() } = {}) {
  const problems = [], report = { id, ok: false, problems, fixtures: [] };
  const dirRel = id === TEMPLATE ? `mods/${TEMPLATE}` : `mods/${id}`;
  try {
    if (!exists(dirRel)) throw new Error(`no mod "${id}": there is no ${dirRel}/ folder`);
    for (const e of await importErrors(path.join(REPO, dirRel))) problems.push(`boundary ${e.rule}: ${e.file}${e.spec ? ` (${e.spec})` : ''}`);
    const mod = await loadMod(id);
    for (const l of mod.lint || []) problems.push(`${l.kind}: ${l.reason}`);
    const { runRules } = await lazy('web/src/engine/world/rules-phase.js');
    const { buildWorld } = await lazy('web/src/engine/world/build.js');
    const { modCtx } = await lazy('web/src/engine/mod/registry.js');
    const { toWorldInput } = await lazy('web/src/engine/mod/input.js');
    const { viewFromFixture } = await lazy('web/src/engine/snapshot.js');
    const { createHash } = await import('node:crypto');
    const h = w => createHash('sha256').update(JSON.stringify([w.sig, [...w.objects.values()].map(o => JSON.stringify(o)).sort(), w.lint])).digest('hex').slice(0, 16);
    for (const name of fixtures) {
      try {
        let fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
        if (fx.frames) fx = { ...fx, ...fx.frames[0] };
        const run = () => {
          const { input, serverId } = toWorldInput(viewFromFixture(fx), { seed: SEED, salt: String(SEED), env: { reduceMotion: false, zoom: 1 } });
          const P = { v: 1, seed: SEED, blocks: {}, lots: {} };
          let w;
          for (let pass = 0; pass < 2; pass++) {
            const now = fx.now + pass * 1000;
            const rules = runRules(input, P, mod, { now, seed: SEED, serverId, ctxFor: key => modCtx(mod, { seed: SEED, now, projectKey: key }) });
            w = buildWorld(input, P, { mod, now, seed: SEED, serverId, rules });
          }
          return w;
        };
        const a = run(), b = run();
        if (h(a) !== h(b)) problems.push(`${name}: not deterministic (two identical runs gave different worlds)`);
        const bad = lintErrors(a.lint);
        if (bad.length) problems.push(`${name}: ${bad.length} lint error(s), first: ${JSON.stringify(bad[0]).slice(0, 200)}`);
        report.fixtures.push({ name, sig: h(a), lint: lintSummary(a.lint) });
      } catch (e) { problems.push(`${name}: threw ${e.message}`); }
    }
  } catch (e) { problems.push(`threw ${e.message}`); }
  report.ok = problems.length === 0;
  return report;
}

function modIds() {
  const dir = path.join(REPO, 'mods');
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
}

// ---------------------------------------------------------------- shots

/** The plan `shots` runs. Pure, so --dry-run and the tests can print it. */
export function shotsPlan(id, { fixture = 'busy', zoom = 1, night = false, out = `out/mod-shots/${id}` } = {}) {
  if (![0.25, 0.5, 1, 2, 3, 4].includes(+zoom)) throw new Error('--zoom must be one of 0.25 0.5 1 2 3 4');
  if (!fixtureNames().includes(fixture)) throw new Error(`unknown fixture "${fixture}" (have: ${fixtureNames().join(', ')})`);
  const query = ['mock', 'engine=2', 'debug', `world=${id}`, `fixture=${fixture}`, night ? 'night=1' : 'night=0'].join('&');
  return { id, out, port: Number(process.env.ARTPASS_PORT || 5391), viewport: [1536, 1020], headless: true, zoom: +zoom, query,
    steps: ['start vite with tools/artpass/vite.config.mjs (hidden dev server)', 'launch chromium headless: true', `open ?${query}`,
      'wait for villageDebug().engine === 2', 'overview.png: villageDebug().focus centred, largest zoom <= 1 that fits',
      `focus-z${zoom}.png: the focus centre at zoom ${zoom}`, 'index.json: cameras and the debug summary', 'stop the server'] };
}

async function runShots(plan) {
  const { chromium } = await import('@playwright/test');
  const { spawn } = await import('node:child_process');
  const outDir = path.resolve(REPO, plan.out);
  fs.mkdirSync(outDir, { recursive: true });
  const vite = spawn(path.join(REPO, 'node_modules', '.bin', 'vite'), ['-c', path.join(REPO, 'tools', 'artpass', 'vite.config.mjs')], { cwd: REPO, stdio: 'ignore' });
  const base = `http://127.0.0.1:${plan.port}/`;
  try {
    for (let i = 0; ; i++) { try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ } if (i > 100) throw new Error('dev server did not start'); await new Promise(r => setTimeout(r, 200)); }
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext({ viewport: { width: plan.viewport[0], height: plan.viewport[1] }, reducedMotion: 'reduce' })).newPage();
    page.on('pageerror', e => console.error('pageerror:', e.message));
    await page.addInitScript(() => { try { localStorage.setItem('va.bubbles', '0'); } catch { /* fine */ } document.addEventListener('DOMContentLoaded', () => document.body.classList.add('village-only')); });
    await page.goto(`${base}?${plan.query}`);
    await page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 60000 });
    await page.evaluate(() => { const s = document.createElement('style'); s.textContent = '#labels, .zenpill, .zoom, #quiet-note { display: none !important; }'; document.head.append(s); });
    const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));
    await settle();
    const dbg = await page.evaluate(() => window.villageDebug());
    const f = dbg.focus ?? dbg.grid;   // the layout's camera fit (world.focus); the grid when a mod sets none
    const [cx, cy] = [f.ox + f.w / 2, f.oy + f.h / 2];
    const fit = [1, 0.5, 0.25].find(z => (f.w + f.h) * 16 * z <= plan.viewport[0] && (f.w + f.h) * 8 * z <= plan.viewport[1]) ?? 0.25;
    const files = [];
    for (const [file, z] of [['overview.png', fit], [`focus-z${plan.zoom}.png`, plan.zoom]]) {
      await page.evaluate(c => window.villageSetCamera(c), { v: 2, x: cx, y: cy, z });
      await settle();
      await page.screenshot({ path: path.join(outDir, file) });
      files.push({ file, cam: { x: cx, y: cy, z } });
    }
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ query: plan.query, focus: f, files, lint: (dbg.lint || []).length }, null, 1));
    await browser.close();
    console.log(`${files.length} shots -> ${plan.out}`);
  } finally { vite.kill(); }
}

// ---------------------------------------------------------------- cli

const USAGE = `usage:
  node tools/mod.mjs new <id> [--extends <bundled mod id, default agentville.base>]
  node tools/mod.mjs check <id|all|_template>
  node tools/mod.mjs shots <id> [--fixture busy] [--zoom 1] [--night] [--dry-run]`;

async function main(argv) {
  const [cmd, arg, ...rest] = argv;
  const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i < 0 ? d : rest[i + 1]; };
  const flag = k => rest.includes(`--${k}`);
  await refreshIndex();   // a fresh clone has no mods/index.js yet (it is generated); the registry imports it
  if (cmd === 'new' && arg) {
    const dest = await newMod(arg, { extendsId: opt('extends', 'agentville.base') });
    const indexed = await refreshIndex();
    console.log(`created ${path.relative(REPO, dest)}/`);
    if (!indexed) console.log('mods/index.js was not regenerated (tools/mods-index.mjs is missing): run `npm run mods`.');
    console.log(`open it at  ?engine=2&world=${arg}\nnext: node tools/mod.mjs check ${arg}`);
    return 0;
  }
  if (cmd === 'check' && arg) {
    await refreshIndex();
    const ids = arg === 'all' ? [TEMPLATE, ...modIds().filter(n => n !== TEMPLATE)] : [arg];
    let failed = 0;
    for (const id of ids) {
      const r = await checkMod(id);
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${id}`);
      for (const f of r.fixtures) console.log(`       ${f.name.padEnd(12)} ${f.sig}  lint ${JSON.stringify(f.lint)}`);
      for (const p of r.problems) console.log(`     - ${p}`);
      if (!r.ok) failed++;
    }
    return failed ? 1 : 0;
  }
  if (cmd === 'shots' && arg) {
    await refreshIndex();
    const plan = shotsPlan(arg, { fixture: opt('fixture', 'busy'), zoom: opt('zoom', 1), night: flag('night') });
    if (flag('dry-run')) { console.log(JSON.stringify(plan, null, 2)); return 0; }
    await runShots(plan);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error(`error: ${e.message}`); process.exit(1); });
}
