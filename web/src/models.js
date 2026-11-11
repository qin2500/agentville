// Models view: which model every agent is really on (its latest reply), what it was told to use,
// whether it goes through the pool, how full its context is and its tokens, from GET /api/models.
// A strip of one card per model in use sits on top (click to filter); below, a treegrid grouped
// by project (project → boss → lead → sub) in the same stable first-seen order. Rows are keyed by
// id and patched in place; data refreshes with the agents poll while this view is showing.
import { rank, byRank } from './order.js';
import { ROLE_NAME, HARNESS_NAME, icon, ago, clock, esc, h } from './ui.js';
import { fmt } from './spend.js';
import { folds } from './important.js';

const COLS = [
  { key: 'agent', label: 'Agent' },
  { key: 'harness', label: 'Harness' },
  { key: 'now', label: 'Model now', tip: 'The model of its latest reply, read from its transcript.' },
  { key: 'cfg', label: 'Configured', tip: 'What it was told to use: the job\'s --model (aliases resolved through its model settings), the settings default for an interactive session, or what a subagent asked for.' },
  { key: 'route', label: 'Route', tip: 'Pool: through the shared gateway (a cc/ model). Personal: straight to your Claude account.' },
  { key: 'ctx', label: 'Context', tip: 'How big its latest request was (input, cache writes and cache reads), against the context window.' },
  { key: 'tok', label: 'Tokens 24 h', tip: 'Tokens in the last 24 hours from this agent\'s own transcript: input + output + cache writes + cache reads. A lead\'s figure leaves out its subagents, which have their own rows.' },
  { key: 'changed', label: 'Changed', tip: 'When its model last changed in this transcript.' },
  { key: 'flags', label: 'Flags' },
];
const SOURCE = {
  flag: 'From its --model flag',
  settings: 'The settings default for new sessions (a launch flag or /model can change it)',
  inherit: 'Uses its lead\'s model (CLAUDE_CODE_SUBAGENT_MODEL is inherit)',
  subagent: 'What the subagent asked for',
  'subagent-env': 'Set for every subagent by CLAUDE_CODE_SUBAGENT_MODEL',
  codex: 'The Codex thread\'s setting',
};
const FLAG = {
  mismatch: { label: 'Mismatch', tip: r => `Its replies come from ${r.now?.label}, but it was told to use ${r.configured?.label}.` },
  pool: { label: 'Still on pool', tip: () => 'It still goes through the shared gateway although your account is personal. Restarting the job moves it.' },
  context: { label: r => `Context ${pct(r)}%`, tip: r => `Its latest request used ${pct(r)}% of the context window.` },
};
const pct = r => (r.context?.window ? Math.round((r.context.used / r.context.window) * 100) : 0);
const win = n => (n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1e3)}k`);
const routeText = r => (r.route === 'codex' ? `Codex${r.provider ? ` · ${r.provider}` : ''}` : r.route === 'pool' ? 'Pool' : 'Personal');

export function createModels(api) {
  const { S, keyed, sync, matches, store } = api;
  const saved = store.get('va.models', {});
  S.mv = { resting: !!saved.resting, model: typeof saved.model === 'string' ? saved.model : null, collapsed: new Set(), focus: null };
  const save = () => store.set('va.models', { resting: S.mv.resting, model: S.mv.model });
  const rowsById = () => S.modelsById || new Map();

  // ---------- configured: the words and the tooltip ----------
  function cfgTitle(r) {
    const c = r.configured;
    if (!c) return r.route === 'codex' ? 'No model setting recorded for this thread' : 'No --model flag and no settings default';
    const parts = [SOURCE[c.source] || ''];
    if (c.raw && c.source !== 'inherit') parts.push(`set to ${c.raw}`);
    if (c.via && c.id) parts.push(`${c.via} = ${c.id}`);
    if (c.alias) parts.push(`${c.alias} is not pinned, so Claude Code picks its current ${c.alias} model`);
    return parts.filter(Boolean).join('; ');
  }
  const changedText = (r, now) => {
    const c = r.history?.[0];
    return c ? { text: `${c.fromLabel} → ${c.toLabel}`, when: `${ago(now - c.at)} ago`, title: `Switched from ${c.fromLabel} to ${c.toLabel} at ${clock(c.at)}` } : null;
  };

  // ---------- rows ----------
  function row(a, r, { level, hasKids, open, ctx }) {
    const el = keyed(`mr:${a.id}`, () => h('div', { class: 'trow mrow', role: 'row', 'data-id': a.id, tabindex: '-1' }));
    const now = S.data?.serverTime || Date.now();
    const ch = r && changedText(r, now);
    const p = r ? pct(r) : 0;
    const sig = r ? JSON.stringify([r.now, r.configured, r.route, r.provider, r.context, r.tokens, r.flags, ch?.text, ch?.when]) : '';
    const s = [a.name, a.role, a.roleSource, a.harness, a.hidden, a.important, hasKids, open, sig, api.dupOf(a)].join('|');
    if (el._sig !== s) {
      el._sig = s;
      const dup = api.dupOf(a);
      const flags = (r?.flags || []).map(f => { const d = FLAG[f]; const l = typeof d.label === 'function' ? d.label(r) : d.label; return `<span class="mflag" title="${esc(d.tip(r))}">${esc(l)}</span>`; }).join('');
      const c = r?.configured;
      el.innerHTML = `<div role="gridcell" class="c-agent">${hasKids ? `<span class="tchev" data-act="mchev" data-id="${esc(a.id)}" aria-hidden="true">${open ? '▾' : '▸'}</span>` : '<span class="tchev"></span>'}<span class="rg">${icon(a.role in ROLE_NAME ? a.role : 'solo', 'px role')}</span><span class="tn" title="${esc(a.name)}">${esc(a.name)}</span>${a.important ? '<span class="star" title="Important" aria-label="Important">★</span>' : ''}${dup ? `<span class="dup">${esc(dup)}</span>` : ''}${a.hidden ? '<span class="htag">Hidden</span>' : ''}<span class="sr">, ${ROLE_NAME[a.role] || a.role}</span></div>
        <div role="gridcell" class="c-harness">${esc(HARNESS_NAME[a.harness] || a.harness)}</div>
        <div role="gridcell" class="c-now" title="${esc(r?.now ? `${r.now.id}${r.now.at ? ` · last reply ${clock(r.now.at)}` : ''}` : 'No reply with a model yet')}">${r?.now ? esc(r.now.label) : '<span class="dim">—</span>'}</div>
        <div role="gridcell" class="c-cfg" title="${esc(r ? cfgTitle(r) : '')}">${c ? `${esc(c.label || c.raw)}${c.effort ? `<span class="dim"> · ${esc(c.effort)}</span>` : ''}${c.source === 'settings' ? '<span class="dim"> · default</span>' : ''}` : '<span class="dim">—</span>'}</div>
        <div role="gridcell" class="c-route${r?.flags.includes('pool') ? ' pool' : ''}">${r ? esc(routeText(r)) : '—'}</div>
        <div role="gridcell" class="c-ctx num">${r?.context ? `<span>${fmt(r.context.used)}${r.context.window ? ` / ${win(r.context.window)}` : ''}</span>${r.context.window ? `<span class="mbar${p > 80 ? ' hot' : ''}" aria-hidden="true"><i style="width:${Math.min(100, p)}%"></i></span><span class="sr">, ${p}% full</span>` : ''}` : '<span class="dim">—</span>'}</div>
        <div role="gridcell" class="c-tok num" title="${r ? `Last hour ${fmt(r.tokens.hour)} · last 24 h ${fmt(r.tokens.day)}` : ''}">${r?.tokens.day ? fmt(r.tokens.day) : '<span class="dim">—</span>'}</div>
        <div role="gridcell" class="c-changed" title="${esc(ch?.title || '')}">${ch ? `${esc(ch.text)}<span class="dim"> · ${esc(ch.when)}</span>` : ''}</div>
        <div role="gridcell" class="c-flags">${flags}</div>`;
    }
    el.className = `trow mrow${a.bucket === 'resting' ? ' b-resting' : ''}${ctx ? ' ctx' : ''}${a.hidden ? ' is-hidden' : ''}${S.selected === a.id ? ' cur' : ''}`;
    el.style.setProperty('--lvl', level);
    el.setAttribute('aria-level', level + 2);
    if (hasKids) el.setAttribute('aria-expanded', String(open)); else el.removeAttribute('aria-expanded');
    el.setAttribute('aria-selected', String(S.selected === a.id));
    return el;
  }
  function groupRow(project, n, open) {
    const el = keyed(`mg:${project}`, () => h('div', { class: 'trow tgroup', role: 'row', 'data-group': project, tabindex: '-1' }));
    const html = `<div role="gridcell" class="c-group"><span class="tchev" data-act="mgroup" data-group="${esc(project)}" aria-hidden="true">${open ? '▾' : '▸'}</span><b>${esc(project)}</b><span class="tcount num">${n}</span></div>`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.setAttribute('aria-level', '1');
    el.setAttribute('aria-expanded', String(open));
    return el;
  }

  // ---------- summary strip ----------
  function cards(data) {
    const strip = keyed('mcards', () => h('div', { class: 'mcards', role: 'group', 'aria-label': 'Models in use' }));
    const list = data.models || [];
    const html = list.length ? list.map(c => {
      const on = S.mv.model === c.key;
      const share = Math.round(c.share * 100);
      return `<button type="button" class="mcard" data-act="mcard" data-key="${esc(c.key)}" aria-pressed="${on}" title="${on ? 'Show every model again' : `Show only agents on ${esc(c.label)}`}">
        <span class="ml">${esc(c.label)}</span>
        <span class="mn num"><b>${c.agents}</b> agent${c.agents === 1 ? '' : 's'}${c.agents ? ` · ${c.live} live` : ''}</span>
        <span class="mt num">1 h <b>${fmt(c.hour)}</b> · 24 h <b>${fmt(c.day)}</b></span>
        <span class="mbar" aria-hidden="true"><i style="width:${Math.max(c.day ? 1 : 0, share)}%"></i></span>
        <span class="ms num">${share}% of 24 h tokens</span></button>`;
    }).join('') : '<p class="empty-note">No model replies in the transcripts yet.</p>';
    if (strip._html !== html) {
      const had = strip.contains(document.activeElement) && document.activeElement.dataset.key;
      strip.innerHTML = html; strip._html = html;
      if (had) strip.querySelector(`[data-key="${CSS.escape(had)}"]`)?.focus();
    }
    return strip;
  }

  // ---------- view ----------
  function render() {
    const M = S.mv;
    const data = S.models;
    if (!data) {
      const n = keyed('mloading', () => h('p', { class: 'empty-note' }));
      n.textContent = S.modelsError ? `Couldn't load model data (${S.modelsError}). Retrying…` : 'Reading which models your agents use…';
      return [n];
    }
    const byId = rowsById();
    if (M.model && !(data.models || []).some(c => c.key === M.model)) M.model = null; // that model is gone
    const card = M.model && data.models.find(c => c.key === M.model);
    const all = S.agents;
    const onModel = a => !M.model || byId.get(a.id)?.card === M.model;
    const restingN = all.filter(a => folds(a) && matches(a) && onModel(a)).length;
    const match = new Set(all.filter(a => matches(a) && onModel(a) && (M.resting || !folds(a))).map(a => a.id));
    const keep = new Set(match);
    for (const id of match) for (let p = S.byId.get(id)?.parentId, g = 0; p && S.byId.has(p) && !keep.has(p) && g < 50; p = S.byId.get(p).parentId, g++) keep.add(p);

    const rows = [];
    const byProject = new Map();
    for (const a of all) if (keep.has(a.id)) {
      const p = a.project || '—';
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p).push(a);
    }
    const first = list => Math.min(...list.map(rank));
    for (const [project, members] of [...byProject].sort((x, y) => first(x[1]) - first(y[1]))) {
      const open = !M.collapsed.has(`p:${project}`);
      rows.push(groupRow(project, members.filter(a => match.has(a.id)).length, open));
      if (!open) continue;
      const inGroup = new Set(members.map(a => a.id));
      const seen = new Set();
      const walk = (a, level) => {
        if (seen.has(a.id)) return;
        seen.add(a.id);
        const ks = members.filter(k => k.parentId === a.id).sort(byRank);
        const o = !M.collapsed.has(a.id);
        rows.push(row(a, byId.get(a.id), { level, hasKids: ks.length > 0, open: o, ctx: !match.has(a.id) }));
        if (o) ks.forEach(k => walk(k, level + 1));
      };
      members.filter(a => !inGroup.has(a.parentId)).sort(byRank).forEach(a => walk(a, 0));
    }

    const flagged = all.filter(a => match.has(a.id) && byId.get(a.id)?.flags.length).length;
    const bar = keyed('mtools', () => h('div', { class: 'ttools' }));
    const barHtml = `<button class="ghost" type="button" data-act="mresting" aria-pressed="${M.resting}">${M.resting ? 'Hide' : 'Show'} resting (${restingN})</button>
      ${card ? `<button class="fchip" type="button" data-act="mclear" aria-label="Showing ${esc(card.label)} only. Show every model">${esc(card.label)} <span aria-hidden="true">×</span></button>` : ''}
      <span class="tsum num">${match.size} agent${match.size === 1 ? '' : 's'}${flagged ? ` · ${flagged} flagged` : ''}</span>
      <span class="tsum">${data.profile === 'pool' ? 'Account: the pool' : 'Account: personal'}</span>
      ${data.catchingUp ? '<span class="tsum">Catching up on transcripts…</span>' : ''}`;
    if (bar._html !== barHtml) {
      const had = bar.contains(document.activeElement) && document.activeElement.dataset.act;
      bar.innerHTML = barHtml; bar._html = barHtml;
      if (had) (bar.querySelector(`[data-act="${had}"]`) || bar.querySelector('[data-act="mresting"]'))?.focus();
    }
    const head = keyed('mhead', () => h('div', { class: 'trow thead', role: 'row' }));
    const headHtml = COLS.map(c => `<div role="columnheader" class="h-${c.key}"${c.tip ? ` title="${esc(c.tip)}"` : ''}><span>${c.label}</span>${c.tip ? `<span class="sr">. ${esc(c.tip)}</span>` : ''}</div>`).join('');
    if (head._html !== headHtml) { head.innerHTML = headHtml; head._html = headHtml; }
    const grid = keyed('mgrid', () => h('div', { class: 'tgrid mgrid', role: 'treegrid', 'aria-label': 'Models by agent' }));
    let empty = null;
    if (!rows.length) {
      empty = keyed('mempty', () => h('p', { class: 'empty-note' }));
      empty.textContent = restingN && !M.resting ? `Only resting agents match. Show resting (${restingN}) to see them.` : 'No agents match.';
    }
    const focusRow = rows.find(r => (r.dataset.id || `g:${r.dataset.group}`) === M.focus) || rows.find(r => r.classList.contains('cur')) || rows[0];
    rows.forEach(r => { r.tabIndex = r === focusRow ? 0 : -1; });
    sync(grid, [head, ...rows]);
    const wrap = keyed('mwrap', () => h('div', { class: 'mwrap' }));
    sync(wrap, [cards(data), bar, grid, ...(empty ? [empty] : [])]);
    return [wrap];
  }

  // ---------- events (delegated from the list) ----------
  function toggle(key) {
    const c = S.mv.collapsed;
    c.has(key) ? c.delete(key) : c.add(key);
    api.render();
  }
  function onClick(e) {
    const t = e.target.closest('[data-act]');
    if (t) {
      const act = t.dataset.act;
      if (act === 'mcard') { S.mv.model = S.mv.model === t.dataset.key ? null : t.dataset.key; save(); api.render(); return true; }
      if (act === 'mclear') { S.mv.model = null; save(); api.render(); document.querySelector('.mcards .mcard')?.focus(); return true; }
      if (act === 'mresting') { S.mv.resting = !S.mv.resting; save(); api.render(); return true; }
      if (act === 'mchev') { toggle(t.dataset.id); return true; }
      if (act === 'mgroup') { toggle(`p:${t.dataset.group}`); return true; }
    }
    const r = e.target.closest('.trow');
    if (!r || r.classList.contains('thead')) return !!e.target.closest('.mcards, .ttools');
    if (r.dataset.group) { toggle(`p:${r.dataset.group}`); return true; }
    S.mv.focus = r.dataset.id;
    if (e.detail !== 2) api.app.select(S.selected === r.dataset.id && !S.term ? null : r.dataset.id);
    return true;
  }
  function onKey(e) {
    const r = e.target.closest?.('.mrow, .tgroup');
    if (!r || !r.closest('.mgrid') || e.metaKey || e.ctrlKey || e.altKey) return false;
    const rows = [...r.parentElement.querySelectorAll('.trow:not(.thead)')];
    const i = rows.indexOf(r);
    const key = r.dataset.id || `p:${r.dataset.group}`;
    const go = j => {
      const n = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (!n) return;
      S.mv.focus = n.dataset.id || `g:${n.dataset.group}`;
      rows.forEach(x => { x.tabIndex = x === n ? 0 : -1; });
      n.focus();
      n.scrollIntoView({ block: 'nearest' });
    };
    const expanded = r.getAttribute('aria-expanded');
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i - 1); break;
      case 'Home': go(0); break;
      case 'End': go(rows.length - 1); break;
      case 'ArrowRight': if (expanded === 'false') toggle(key); else if (expanded === 'true') go(i + 1); break;
      case 'ArrowLeft': {
        if (expanded === 'true') { toggle(key); break; }
        const lvl = +r.getAttribute('aria-level');
        if (lvl > 1) for (let j = i - 1; j >= 0; j--) if (+rows[j].getAttribute('aria-level') < lvl) { go(j); break; }
        break;
      }
      case 'Enter':
        if (r.dataset.group) toggle(key); else { S.mv.focus = r.dataset.id; if (S.selected === r.dataset.id) api.app.menu(r.dataset.id, { el: r }); else api.app.select(r.dataset.id); }
        break;
      case ' ': if (r.dataset.id) api.app.select(r.dataset.id, { pan: false }); break;
      default: return false;
    }
    e.preventDefault();
    if (document.activeElement !== r && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Enter') && r.isConnected && !api.app.menuOpen?.()) r.focus();
    return true;
  }

  return { render, onClick, onKey };
}

/** GET /api/models into S.models (and S.modelsById). A failure keeps the last good data. */
export async function loadModels(S) {
  try {
    const res = await fetch('/api/models', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.agents) || !Array.isArray(data.models)) throw new Error('malformed response');
    S.models = data;
    S.modelsById = new Map(data.agents.map(r => [r.id, r]));
    S.modelsError = '';
  } catch (e) {
    S.modelsError = e instanceof TypeError ? 'server not reachable' : e.message;
  }
}
