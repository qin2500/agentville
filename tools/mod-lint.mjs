#!/usr/bin/env node
// Ownership boundary for mods (docs/mod-boundary.md). Pure fs + regex, no engine imports.
//   node tools/mod-lint.mjs            lint every mods/<id>/ and the engine imports (exit 1 on any error)
//   node tools/mod-lint.mjs <id>...    lint only those mods
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_SPEC = '#agentville/mod';
export const PUBLIC_FILE = 'web/src/engine/mod/public.js';
export const FIRST_PARTY = ['agentville.base', 'agentville.fantasy'];
/** Grandfathered: classic still uses these. Remove the entries when classic is deleted and the files move into the mod. */
export const GRANDFATHERED = {
  'agentville.fantasy': ['web/src/city-plan.js', 'web/src/styles-pool.js'],
};
/** Same as MOD_ID_RE in web/src/engine/mod/registry.js (copied: this tool imports no engine code; a test keeps them equal). */
export const MOD_ID_RE = /^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$/;
export const WORLD_WORDS = /dock|harbou?r|ship|sloop|island|shore|sea_?deep|forest|porter|palace|villager|townsfolk/gi;
export const NONDETERMINISTIC = /Math\.random|Date\.now|performance\.now|new\s+Date\s*\(/;

const SPEC_RE = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYN_RE = /import\s*\(\s*(?!['"])/;

export function listFiles(dir, exts = ['.js', '.mjs']) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...listFiles(p, exts)); }
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out.sort();
}

/** Every import/export-from/dynamic-import specifier in a source text. */
export function specifiers(src) {
  return [...src.matchAll(SPEC_RE)].map(m => m[1] || m[2] || m[3]);
}

function resolveFile(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, base + '.js', base + '.mjs', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return base;
}
const inside = (dir, file) => { const r = path.relative(dir, file); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

/**
 * Lint one mod folder. Rules: M1 only own files, the public barrel, grandfathered files; M2 no bare/node:/URL specifier and
 * no non-literal import(); M3 no other mod; M4 folder name equals mod.id and `agentville.` is reserved; M5 no clock/random; M4 also needs the folder to match MOD_ID_RE; M6 a non-first-party mod must not declare `ambient`
 * (not part of the v1 public API).
 * @returns {{ errors: { file: string, spec: string, rule: string }[] }}
 */
export function checkModImports(modDir, { root = ROOT } = {}) {
  const errors = [];
  const dir = path.resolve(modDir);
  const id = path.basename(dir);
  const publicFile = path.join(root, PUBLIC_FILE);
  const modsDir = path.join(root, 'mods');
  const allowed = (GRANDFATHERED[id] || []).map(f => path.join(root, f));
  const err = (file, spec, rule) => errors.push({ file: rel(root, file), spec, rule });

  const indexFile = path.join(dir, 'index.js');
  if (!id.startsWith('_')) {
    const m = fs.existsSync(indexFile) && fs.readFileSync(indexFile, 'utf8').match(/\bid\s*:\s*['"]([^'"]+)['"]/);
    if (!m) err(indexFile, '', 'M4');
    else if (m[1] !== id) err(indexFile, m[1], 'M4');
    if (!MOD_ID_RE.test(id)) err(dir, id, 'M4');
    if (!id.startsWith('agentville.') && fs.existsSync(indexFile)) {
      const code0 = fs.readFileSync(indexFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/(^|[\s,{])ambient\s*[:,(}]/.test(code0) || /\.ambient\s*=/.test(code0)) err(indexFile, 'ambient', 'M6');
    }
    if (id.startsWith('agentville.') && !FIRST_PARTY.includes(id)) err(dir, id, 'M4');
  }

  for (const f of listFiles(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    if (DYN_RE.test(src)) err(f, 'import(<non-literal>)', 'M2');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (NONDETERMINISTIC.test(code)) err(f, code.match(NONDETERMINISTIC)[0], 'M5');
    for (const spec of specifiers(src)) {
      if (spec === PUBLIC_SPEC) continue;
      if (!/^\.{1,2}\//.test(spec)) { err(f, spec, 'M2'); continue; }
      const target = resolveFile(f, spec);
      if (target === publicFile) continue;
      if (allowed.includes(target)) continue;
      if (inside(dir, target)) continue;
      err(f, spec, inside(modsDir, target) ? 'M3' : 'M1');
    }
  }
  return { errors };
}

/** E1: nothing under web/src/engine/** imports mods/**, except mod/registry.js -> mods/index.js. */
export function checkEngineImports(root = ROOT) {
  const errors = [];
  const modsDir = path.join(root, 'mods');
  const registry = path.join(root, 'web/src/engine/mod/registry.js');
  const index = path.join(modsDir, 'index.js');
  for (const f of listFiles(path.join(root, 'web/src/engine'))) {
    for (const spec of specifiers(fs.readFileSync(f, 'utf8'))) {
      if (!/^\.{1,2}\//.test(spec)) continue;
      const target = resolveFile(f, spec);
      if (!inside(modsDir, target)) continue;
      if (f === registry && target === index) continue;
      errors.push({ file: rel(root, f), spec, rule: 'E1' });
    }
  }
  return { errors };
}

/** E2 input: world-word count per file under web/src/engine/** (only files with at least one hit). */
export function countWorldWords(root = ROOT) {
  const counts = {};
  for (const f of listFiles(path.join(root, 'web/src/engine'))) {
    const n = (fs.readFileSync(f, 'utf8').match(WORLD_WORDS) || []).length;
    if (n) counts[rel(root, f)] = n;
  }
  return counts;
}

/** Every mods/<id> folder (including `_template`). */
export function modDirs(root = ROOT) {
  const dir = path.join(root, 'mods');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(dir, e.name)).sort();
}

export function lintAll(root = ROOT, ids = null) {
  const errors = [...checkEngineImports(root).errors];
  for (const d of modDirs(root)) {
    if (ids && !ids.includes(path.basename(d))) continue;
    errors.push(...checkModImports(d, { root }).errors);
  }
  return { errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ids = process.argv.slice(2);
  const { errors } = lintAll(ROOT, ids.length ? ids : null);
  for (const e of errors) console.error(`${e.rule}  ${e.file}  ${e.spec}`);
  console.log(errors.length ? `mod-lint: ${errors.length} error(s)` : 'mod-lint: ok');
  process.exit(errors.length ? 1 : 0);
}
