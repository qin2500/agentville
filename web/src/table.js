// Table view: every agent in one dense, sortable treegrid (Project → boss → lead → subs), or flat.
// Rows are keyed by id and patched in place like the other views; off-screen rows skip layout via
// content-visibility, so 400+ rows stay smooth without a virtual scroller.
import { rank, byRank } from './order.js';
import { BUCKET_RANK, BUCKET_NAME, ROLE_NAME, HARNESS_NAME, isError, bucketIcon, icon, ago, esc, h } from './ui.js';
import { folds, stoppedNote } from './important.js';

const COLS = [
  { key: 'agent', label: 'Agent', val: a => a.name.toLowerCase() },
  { key: 'status', label: 'Status', val: null }, // bucket rank, then the panel's in-bucket order
  { key: 'reason', label: 'Reason', val: a => (a.reason || '').toLowerCase() },
  { key: 'project', label: 'Project', val: a => (a.project || '').toLowerCase() },
  { key: 'parent', label: 'Lead / parent', val: (a, S) => (S.byId.get(a.parentId)?.name || '').toLowerCase() },
  { key: 'harness', label: 'Harness', val: a => a.harness },
  { key: 'time', label: 'In state', val: (a, S) => (S.data?.serverTime || Date.now()) - (a.since || 0) },
  { key: 'last', label: 'Last active', val: a => -(a.lastActivityAt || 0) },
  { key: 'prs', label: 'PRs', val: a => (a.prs || []).length },
];

export function createTable(api) {
  const { S, keyed, sync, matches, store } = api;
  // Default order is the tree by first-seen rank: no implicit urgency sort. `sort` is only set when
  // the user picks a column (`chosen` marks that; older saved state without it falls back to rank).
  const saved = store.get('va.table', {});
  S.table = { sort: null, dir: 1, flat: false, resting: false, collapsed: new Set(), focus: null, snap: null, ...saved };
  if (!saved.chosen) S.table.sort = null;
  S.table.collapsed = new Set();
  const save = () => { const { sort, dir, flat, resting } = S.table; store.set('va.table', { sort, dir, flat, resting, chosen: !!sort }); };
  const TIME = new Set(['time', 'last']);
  const statusOrder = (a, b) => isError(b) - isError(a) || BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];

  // The column order the data has right now, ties broken by rank.
  function live(a, b) {
    const { sort, dir } = S.table;
    if (!sort) return byRank(a, b);
    const col = COLS.find(c => c.key === sort);
    if (!col.val) return dir * statusOrder(a, b) || byRank(a, b);
    const x = col.val(a, S), y = col.val(b, S);
    return dir * (x < y ? -1 : x > y ? 1 : 0) || byRank(a, b);
  }
  // Time columns change every poll, so their order is a snapshot taken when the user sorts (or
  // presses R / "re-sort"); newcomers go after the snapshot. A chip says when it has drifted.
  function compare(a, b) {
    const snap = TIME.has(S.table.sort) && S.table.snap;
    if (!snap) return live(a, b);
    const x = snap.get(a.id), y = snap.get(b.id);
    if (x != null && y != null) return x - y;
    if (x != null || y != null) return x != null ? -1 : 1;
    return live(a, b);
  }
  const takeSnap = () => { S.table.snap = new Map([...S.agents].sort(live).map((a, i) => [a.id, i])); };
  const tally = list => {
    const n = b => list.filter(a => (b === 'error' ? isError(a) : a.bucket === b && !isError(a))).length;
    const word = { error: 'errors', stalled: 'need you', waiting: 'waiting', building: 'building' };
    return ['error', 'stalled', 'waiting', 'building'].filter(b => n(b)).map(b => `<span class="tt ${b}" title="${n(b)} ${word[b]}">${icon(b)}<span class="num">${n(b)}</span></span>`).join('');
  };

  // ---------- rows ----------
  function row(a, { level, hasKids, open, ctx }) {
    const el = keyed(`tr:${a.id}`, () => h('div', { class: 'trow', role: 'row', 'data-id': a.id, tabindex: '-1' }));
    const now = S.data?.serverTime || Date.now();
    const parent = S.byId.get(a.parentId);
    const prs = a.prs || [];
    const dup = api.dupOf(a);
    const t = now - (a.since || 0);
    const sig = [S.table.flat, api.openHTML(a), a.severity, a.name, dup, a.role, a.roleSource, a.bucket, a.reason, a.project, parent?.name, a.harness, ago(t), a.lastActivityAt ? ago(now - a.lastActivityAt) : '', prs.map(p => p.id).join(), a.hidden, a.live, a.important, hasKids, open].join('|');
    if (el._sig !== sig) {
      el._sig = sig;
      el.innerHTML = `<div role="gridcell" class="c-agent">${hasKids ? `<span class="tchev" data-act="tchev" data-id="${esc(a.id)}" aria-hidden="true">${open ? '▾' : '▸'}</span>` : '<span class="tchev"></span>'}<span class="rg">${icon(a.role in ROLE_NAME ? a.role : 'solo', 'px role')}${a.roleSource === 'override' ? '<i class="ov"></i>' : ''}</span><span class="tn" title="${esc(a.name)}">${esc(a.name)}</span>${a.important ? '<span class="star" title="Important" aria-label="Important">★</span>' : ''}${dup ? `<span class="dup">${esc(dup)}</span>` : ''}${a.hidden ? '<span class="htag">Hidden</span>' : ''}<span class="sr">, ${ROLE_NAME[a.role] || a.role}</span>${api.openHTML(a)}</div>
        <div role="gridcell" class="c-status b-${a.bucket}${isError(a) ? ' sev-error' : ''}">${icon(bucketIcon(a))}<span>${isError(a) ? 'Error' : BUCKET_NAME[a.bucket]}</span></div>
        <div role="gridcell" class="c-reason" title="${esc(stoppedNote(a) || a.reason || '')}">${esc(stoppedNote(a) || a.reason || '—')}</div>
        ${S.table.flat ? `<div role="gridcell" class="c-project" title="${esc(a.project || '')}">${esc(a.project || '—')}</div>` : ''}
        <div role="gridcell" class="c-parent" title="${esc(parent?.name || '')}">${esc(parent?.name || '—')}</div>
        <div role="gridcell" class="c-harness">${esc(HARNESS_NAME[a.harness] || a.harness)}</div>
        <div role="gridcell" class="c-time num${a.bucket === 'stalled' && t > 30 * 60e3 ? ' old' : ''}">${ago(t)}</div>
        <div role="gridcell" class="c-last num"><i class="live ${a.live ? '' : 'no'}" aria-hidden="true"></i>${a.lastActivityAt ? `${ago(now - a.lastActivityAt)} ago` : '—'}${a.live ? '' : '<span class="sr"> (not running)</span>'}</div>
        <div role="gridcell" class="c-prs">${prs.slice(0, 3).map(p => api.chip(p)).join('')}${prs.length > 3 ? `<span class="chip">+${prs.length - 3}</span>` : ''}</div>`;
    }
    el.className = `trow b-${a.bucket}${isError(a) ? ' sev-error' : ''}${ctx ? ' ctx' : ''}${a.hidden ? ' is-hidden' : ''}${S.selected === a.id ? ' cur' : ''}`;
    el.style.setProperty('--lvl', level);
    if (S.table.flat) el.removeAttribute('aria-level'); else el.setAttribute('aria-level', level + 2);
    if (hasKids) el.setAttribute('aria-expanded', String(open)); else el.removeAttribute('aria-expanded');
    el.setAttribute('aria-selected', String(S.selected === a.id));
    return el;
  }
  function groupRow(project, members, open) {
    const el = keyed(`tg:${project}`, () => h('div', { class: 'trow tgroup', role: 'row', 'data-group': project, tabindex: '-1' }));
    const html = `<div role="gridcell" class="c-group"><span class="tchev" data-act="tgroup" data-group="${esc(project)}" aria-hidden="true">${open ? '▾' : '▸'}</span><b>${esc(project)}</b><span class="tcount num">${members.length}</span>${tally(members)}</div>`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.setAttribute('aria-level', '1');
    el.setAttribute('aria-expanded', String(open));
    return el;
  }

  // ---------- view ----------
  function render() {
    const T = S.table;
    const all = S.agents;
    // "Hide resting" never takes an Important agent (important.js).
    const restingN = all.filter(a => folds(a) && matches(a)).length;
    const shown = a => matches(a) && (T.resting || !folds(a));
    const match = new Set(all.filter(shown).map(a => a.id));
    const keep = new Set(match);
    if (!T.flat) for (const id of match) { // ancestors stay as dimmed context
      for (let p = S.byId.get(id)?.parentId, g = 0; p && S.byId.has(p) && !keep.has(p) && g < 50; p = S.byId.get(p).parentId, g++) keep.add(p);
    }
    if (TIME.has(T.sort) && !T.snap) takeSnap();
    const rows = [];
    if (T.flat) {
      all.filter(a => match.has(a.id)).sort(compare).forEach(a => rows.push(row(a, { level: 0, hasKids: false, open: false, ctx: false })));
    } else {
      const byProject = new Map();
      for (const a of all) if (keep.has(a.id)) {
        const p = a.project || '—';
        if (!byProject.has(p)) byProject.set(p, []);
        byProject.get(p).push(a);
      }
      const first = list => Math.min(...list.map(rank));
      const projects = [...byProject].sort((x, y) => (T.sort === 'project'
        ? T.dir * x[0].localeCompare(y[0])
        : first(x[1]) - first(y[1])));
      for (const [project, members] of projects) {
        const gkey = `p:${project}`;
        const open = !T.collapsed.has(gkey);
        rows.push(groupRow(project, members.filter(a => match.has(a.id)), open));
        if (!open) continue;
        const inGroup = new Set(members.map(a => a.id));
        const kids = a => members.filter(k => k.parentId === a.id).sort(compare);
        const seen = new Set();
        const walk = (a, level) => {
          if (seen.has(a.id)) return;
          seen.add(a.id);
          const ks = kids(a);
          const o = !T.collapsed.has(a.id);
          rows.push(row(a, { level, hasKids: ks.length > 0, open: o, ctx: !match.has(a.id) }));
          if (o) ks.forEach(k => walk(k, level + 1));
        };
        members.filter(a => !inGroup.has(a.parentId)).sort(compare).forEach(a => walk(a, 0));
      }
    }
    // toolbar
    const bar = keyed('ttools', () => h('div', { class: 'ttools' }));
    const barHtml = `<div class="seg" role="group" aria-label="Table layout"><button type="button" data-act="tlayout" data-v="tree" aria-pressed="${!T.flat}">Grouped</button><button type="button" data-act="tlayout" data-v="flat" aria-pressed="${T.flat}">Flat</button></div>
      <button class="ghost" type="button" data-act="tresting" aria-pressed="${T.resting}">${T.resting ? 'Hide' : 'Show'} resting (${restingN})</button>
      <span class="tsum num">${match.size} agent${match.size === 1 ? '' : 's'}</span>
      ${drifted(all.filter(a => match.has(a.id))) ? '<button class="fchip paused" type="button" data-act="tresort" title="Re-sort by the current times (R)">Order paused · ↻ re-sort</button>' : ''}`;
    if (bar._html !== barHtml) { bar.innerHTML = barHtml; bar._html = barHtml; }
    // header
    const head = keyed('thead', () => h('div', { class: 'trow thead', role: 'row' }));
    // Grouped mode: the group header already names the project, so that column goes to Reason.
    const headHtml = COLS.filter(c => T.flat || c.key !== 'project').map(c => {
      const on = T.sort === c.key;
      return `<div role="columnheader" class="h-${c.key}" aria-sort="${on ? (T.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-act="tsort" data-key="${c.key}">${c.label}<span aria-hidden="true">${on ? (T.dir > 0 ? ' ▴' : ' ▾') : ''}</span></button></div>`;
    }).join('');
    if (head._html !== headHtml) { head.innerHTML = headHtml; head._html = headHtml; }
    const grid = keyed('tgrid', () => h('div', { class: 'tgrid', 'aria-label': 'All agents' }));
    grid.setAttribute('role', T.flat ? 'grid' : 'treegrid');
    grid.classList.toggle('flat', T.flat);
    let empty = null;
    if (!rows.length) {
      empty = keyed('tempty', () => h('p', { class: 'empty-note' }));
      empty.textContent = restingN && !T.resting ? `Only resting agents match. Show resting (${restingN}) to see them.` : 'No agents match.';
    }
    // Roving tabindex: one row is in the tab order.
    const focusRow = rows.find(r => (r.dataset.id || `g:${r.dataset.group}`) === T.focus) || rows.find(r => r.classList.contains('cur')) || rows[0];
    rows.forEach(r => { r.tabIndex = r === focusRow ? 0 : -1; });
    sync(grid, [head, ...rows]);
    const wrap = keyed('twrap', () => h('div', { class: 'tablewrap' }));
    sync(wrap, empty ? [bar, grid, empty] : [bar, grid]);
    return [wrap];
  }

  function drifted(list) {
    if (!TIME.has(S.table.sort) || !S.table.snap) return false;
    const shown = [...list].sort(compare), now = [...list].sort(live);
    return shown.some((a, i) => a !== now[i]);
  }
  function resort() { S.table.snap = null; api.render(); }

  // ---------- events (delegated from the list) ----------
  function onClick(e) {
    const t = e.target.closest('[data-act]');
    const T = S.table;
    if (t) {
      const act = t.dataset.act;
      if (act === 'tsort') { const k = t.dataset.key; T.dir = T.sort === k ? -T.dir : 1; T.sort = k; T.snap = null; save(); api.render(); return true; }
      if (act === 'tresort') { resort(); return true; }
      if (act === 'tlayout') { T.flat = t.dataset.v === 'flat'; save(); api.render(); return true; }
      if (act === 'tresting') { T.resting = !T.resting; save(); api.render(); return true; }
      if (act === 'tchev') { toggle(t.dataset.id); return true; }
      if (act === 'tgroup') { toggle(`p:${t.dataset.group}`); return true; }
    }
    const r = e.target.closest('.trow');
    if (!r || r.classList.contains('thead')) return false;
    if (e.target.closest('.chip[data-href]')) return false;
    if (r.dataset.group) { toggle(`p:${r.dataset.group}`); return true; }
    T.focus = r.dataset.id;
    app().openDetail(r.dataset.id);
    return true;
  }
  const app = () => api.app;
  function toggle(key) {
    const c = S.table.collapsed;
    c.has(key) ? c.delete(key) : c.add(key);
    api.render();
  }
  function onKey(e) {
    const r = e.target.closest?.('.trow');
    if (!r || r.classList.contains('thead') || e.metaKey || e.ctrlKey || e.altKey) return false;
    const rows = [...r.parentElement.querySelectorAll('.trow:not(.thead)')];
    const i = rows.indexOf(r);
    const key = r.dataset.id || `p:${r.dataset.group}`;
    const go = j => {
      const n = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (!n) return;
      S.table.focus = n.dataset.id || `g:${n.dataset.group}`;
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
        if (r.dataset.group) toggle(key); else { S.table.focus = r.dataset.id; app().openDetail(r.dataset.id); }
        break;
      case ' ': if (r.dataset.id) app().select(r.dataset.id, { pan: false }); break;
      case 'r': case 'R': resort(); break;
      default: return false;
    }
    e.preventDefault();
    // A collapse/expand re-render keeps the same row element, so put focus back on it.
    if (document.activeElement !== r && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Enter') && r.isConnected && !S.detail) r.focus();
    return true;
  }

  return { render, onClick, onKey, compare, resort };
}
