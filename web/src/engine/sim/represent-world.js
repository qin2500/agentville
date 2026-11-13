// represent.pr and represent.project (MOD-READY P6; api.js PrSpec, ProjectSpec). OWNER: P6. Pure, no DOM.
// What a PR or a project is in a world, from mod data or a mod function, sanitised and linted like represent.js
// cleanAppearance. A mod function sees only a frozen allow-listed view built field by field from WorldInput: a PR's
// id, project, number, a cleaned title, state, checks, review and size; never an href/URL, a path, conversation text
// or a server id. Lints never echo a mod-supplied value.
//
//   representPr(pr, mod, ctx?)       -> PrSpec       { as: 'lot'|'venue'|'none', model?, venue?, tint? }
//   representProject(p, mod, ctx?)   -> ProjectSpec  { label, model?, accent? }   label: a clean template
//   renderLabel(template, name)      -> string       the template with {name} filled in
//   prView(pr) / projectView(p)      -> the frozen views a mod function receives
//   cleanPrTitle(raw)                -> string       the only PR title text a mod may see
// ctx: the ModCtx passed through to a mod function (registry.js modCtx), plus `lint`: an array the engine's lint
// entries are pushed to (never passed to the mod).

export const PR_AS = Object.freeze(['lot', 'venue', 'none']);
export const PR_STATES = Object.freeze(['building', 'loading', 'merged', 'closed']);
/** A PR's representation when the mod says nothing for its state: a live PR earns a lot (the lots hook decides). */
export const DEFAULT_PR = Object.freeze({ building: Object.freeze({ as: 'lot' }) });
export const DEFAULT_LABEL = '{name}';
export const LABEL_MAX = 40;            // template length, in code points
export const LABEL_TEXT_MAX = 64;       // rendered label length, in code points
export const TITLE_MAX = 80;            // PR title length a mod may see, in code points

const NAME_RE = /^[a-z][a-z0-9._-]{0,31}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const isName = s => typeof s === 'string' && NAME_RE.test(s);
const plainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
/** An own data property's value, or undefined (accessors and inherited properties are never invoked). */
const own = (o, k) => { if (!o || typeof o !== 'object') return undefined; const d = Object.getOwnPropertyDescriptor(o, k); return d && 'value' in d ? d.value : undefined; };
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = v => (typeof v === 'string' ? v : '');
const ELLIPSIS = String.fromCharCode(0x2026);
const cut = (s, n) => { const cp = [...s]; return cp.length > n ? `${cp.slice(0, n - 1).join('').trimEnd()}${ELLIPSIS}` : s; };
const pushLint = (ctx, e) => { if (Array.isArray(ctx?.lint)) ctx.lint.push(e); };
/** The ModCtx a mod function receives: ctx without the engine's lint sink. */
const hookCtx = ctx => { if (!ctx || typeof ctx !== 'object') return {}; const { lint, ...rest } = ctx; return rest; };

// ---------------------------------------------------------------- views (what a mod function sees)

// Anything URL-like or path-like is cut out of a title, as is anything after the first line.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const WWW_RE = /\bwww\.\S+/gi;
const PATH_RE = /(^|[\s("'`[])(~|\.{1,2})?(\/|\\)[^\s)"'`\]]*/g;
const WINPATH_RE = /\b[a-z]:\\\S*/gi;
const CTRL_RE = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]]
  .map(([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`).join('')}]`, 'g');   // control, zero-width and bidi characters
/** The PR title a mod may see: first non-empty line, no URLs, no file paths, no control characters, whitespace
 *  collapsed, at most TITLE_MAX code points. '' for anything that is not a string. */
export function cleanPrTitle(raw) {
  const first = str(raw).split(/\r?\n|\r/).find(l => l.trim()) || '';
  const t = first.replace(URL_RE, ' ').replace(WWW_RE, ' ').replace(WINPATH_RE, ' ').replace(PATH_RE, '$1 ')
    .replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
  return cut(t, TITLE_MAX);
}

const REVIEW = new Set(['approved', 'changes', 'pending']);
/** Frozen allow-listed PR view (from a WorldInput prs[] entry). Built field by field: nothing is copied wholesale. */
export function prView(pr) {
  const c = own(pr, 'checks'), z = own(pr, 'size'), state = own(pr, 'state'), review = own(pr, 'review');
  return Object.freeze({
    id: str(own(pr, 'id')), project: str(own(pr, 'project')), number: num(own(pr, 'number')),
    title: cleanPrTitle(own(pr, 'title')),
    state: PR_STATES.includes(state) ? state : 'building',
    checks: Object.freeze({ passed: num(own(c, 'passed')), failed: num(own(c, 'failed')), pending: num(own(c, 'pending')) }),
    review: REVIEW.has(review) ? review : null,
    size: Object.freeze({ additions: num(own(z, 'additions')), deletions: num(own(z, 'deletions')), files: num(own(z, 'files')) }),
  });
}

/** Frozen allow-listed project view (from a WorldInput projects[] entry). */
export function projectView(p) {
  const s = own(p, 'stats'), accent = own(p, 'accent');
  return Object.freeze({
    key: str(own(p, 'key')), name: str(own(p, 'name')), accent: typeof accent === 'string' && HEX_RE.test(accent) ? accent : '',
    stats: Object.freeze({ prsEver: num(own(s, 'prsEver')), prsLive: num(own(s, 'prsLive')), agentsEver: num(own(s, 'agentsEver')),
      agentsNow: num(own(s, 'agentsNow')), transcriptMB: num(own(s, 'transcriptMB')) }),
  });
}

// ---------------------------------------------------------------- represent.pr

/** A clean PrSpec from whatever the mod gave (data entry or function result); lint on every dropped field. */
function cleanPr(v, mod, ctx, where) {
  if (v == null) return null;
  if (typeof v === 'string') v = { as: v };
  if (!plainObj(v)) { pushLint(ctx, { kind: 'represent-pr', where, reason: 'a PrSpec must be a plain object' }); return null; }
  const as = own(v, 'as');
  if (!PR_AS.includes(as)) { pushLint(ctx, { kind: 'represent-pr', where, reason: "as must be 'lot', 'venue' or 'none'" }); return null; }
  const out = { as };
  const model = own(v, 'model'), tint = own(v, 'tint'), venue = own(v, 'venue');
  if (model !== undefined) { if (isName(model)) out.model = model; else pushLint(ctx, { kind: 'represent-pr', where, reason: 'model must be a short lower-case name; ignored' }); }
  if (tint !== undefined) { if (typeof tint === 'string' && HEX_RE.test(tint)) out.tint = tint; else pushLint(ctx, { kind: 'represent-pr', where, reason: 'tint must be #rrggbb; ignored' }); }
  if (as === 'venue') {
    const defs = plainObj(mod?.venues) ? mod.venues : null;
    if (!isName(venue) || !defs || !Object.prototype.hasOwnProperty.call(defs, venue)) {
      pushLint(ctx, { kind: 'represent-pr', where, reason: 'venue must name a venue kind the mod defines; shown as none' });
      return { as: 'none', ...(out.model ? { model: out.model } : {}), ...(out.tint ? { tint: out.tint } : {}) };
    }
    out.venue = venue;
  }
  return out;
}

/**
 * What a PR is in this world. mod.represent.pr is data `{ building?, loading?, merged?, closed?: PrSpec }` keyed by the
 * PR's state, or a function (prView, ctx) => PrSpec. Missing or invalid: DEFAULT_PR for the state, else { as: 'none' }.
 * @param {object} pr a WorldInput prs[] entry
 * @param {object} mod ResolvedMod
 * @param {object} [ctx] ModCtx (+ `lint: []`, engine-only)
 * @returns {Readonly<{ as: 'lot'|'venue'|'none', model?: string, venue?: string, tint?: string }>}
 */
export function representPr(pr, mod, ctx = {}) {
  const view = prView(pr);
  const rep = own(mod, 'represent'), spec = rep && typeof rep === 'object' ? own(rep, 'pr') : undefined;
  let out = null;
  if (typeof spec === 'function') {
    let r;
    try { r = spec(view, hookCtx(ctx)); } catch { pushLint(ctx, { kind: 'represent-pr', where: 'represent.pr()', reason: 'represent.pr threw; engine default used' }); r = null; }
    out = cleanPr(r, mod, ctx, 'represent.pr()');
  } else if (spec != null) {
    if (!plainObj(spec)) pushLint(ctx, { kind: 'represent-pr', where: 'represent.pr', reason: 'must be a plain object keyed by PR state, or a function' });
    else {
      const entry = own(spec, view.state);
      out = cleanPr(entry, mod, ctx, `represent.pr.${view.state}`);
    }
  }
  return Object.freeze(out ?? { ...(DEFAULT_PR[view.state] ?? { as: 'none' }) });
}

// ---------------------------------------------------------------- represent.project

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
/** A clean label template, or null (with lint) when nothing usable is left. */
function cleanLabel(v, ctx, where) {
  if (typeof v !== 'string') { pushLint(ctx, { kind: 'represent-project', where, reason: 'label must be a string; default used' }); return null; }
  let t = v.split(/\r?\n|\r/)[0].replace(CTRL_RE, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  let unknown = false;
  t = t.replace(PLACEHOLDER_RE, (m, k) => (k === 'name' ? m : ((unknown = true), ''))).split('{name}').map(part => part.replace(/[{}]/g, '')).join('{name}').replace(/\s+/g, ' ').trim();
  if (unknown) pushLint(ctx, { kind: 'represent-project', where, reason: 'label: only the {name} placeholder is allowed; others removed' });
  if ([...t].length > LABEL_MAX) { pushLint(ctx, { kind: 'represent-project', where, reason: `label is longer than ${LABEL_MAX} characters; cut` }); t = [...t].slice(0, LABEL_MAX).join('').trim(); }
  if (!t) { pushLint(ctx, { kind: 'represent-project', where, reason: 'label is empty; default used' }); return null; }
  return t;
}

function cleanProject(v, ctx, where) {
  if (v == null) return {};
  if (!plainObj(v)) { pushLint(ctx, { kind: 'represent-project', where, reason: 'a ProjectSpec must be a plain object' }); return {}; }
  const out = {};
  const label = own(v, 'label'), model = own(v, 'model'), accent = own(v, 'accent');
  if (label !== undefined) { const l = cleanLabel(label, ctx, where); if (l) out.label = l; }
  if (model !== undefined) { if (isName(model)) out.model = model; else pushLint(ctx, { kind: 'represent-project', where, reason: 'model must be a short lower-case name; ignored' }); }
  if (accent !== undefined) { if (typeof accent === 'string' && HEX_RE.test(accent)) out.accent = accent; else pushLint(ctx, { kind: 'represent-project', where, reason: 'accent must be #rrggbb; ignored' }); }
  return out;
}

/**
 * What a project is in this world. mod.represent.project is a ProjectSpec (data) or (projectView, ctx) => ProjectSpec.
 * @returns {Readonly<{ label: string, model?: string, accent?: string }>} label is a clean template (DEFAULT_LABEL
 *   when the mod gives none); fill it with renderLabel(label, project.name).
 */
export function representProject(p, mod, ctx = {}) {
  const rep = own(mod, 'represent'), spec = rep && typeof rep === 'object' ? own(rep, 'project') : undefined;
  let out = {};
  if (typeof spec === 'function') {
    let r;
    try { r = spec(projectView(p), hookCtx(ctx)); } catch { pushLint(ctx, { kind: 'represent-project', where: 'represent.project()', reason: 'represent.project threw; engine default used' }); r = null; }
    out = cleanProject(r, ctx, 'represent.project()');
  } else if (spec != null) out = cleanProject(spec, ctx, 'represent.project');
  return Object.freeze({ label: DEFAULT_LABEL, ...out });
}

/** The label text: the template with {name} filled in, control characters removed, at most LABEL_TEXT_MAX code points. */
export function renderLabel(template, name) {
  const n = str(name).replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
  const t = (typeof template === 'string' && template ? template : DEFAULT_LABEL).replace(/\{name\}/g, () => n);
  return cut(t.replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim(), LABEL_TEXT_MAX);
}
