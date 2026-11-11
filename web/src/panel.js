// The agent panel: Status, Team, Tree, Table and Models views. Rows are cached by id and patched in
// place; containers are keyed too, so a poll moves at most a few nodes and never rebuilds the list.
import { BUCKET_RANK, BUCKET_NAME, ROLE_NAME, HARNESS_NAME, isError, isPrompt, bucketIcon, icon, ago, agoLong, clock, esc, safeHref, h, store } from './ui.js';
import { createTable } from './table.js';
import { createModels } from './models.js';
import { createTree } from './tree.js';
import { rank, byRank, enteredAt, syncNodes } from './order.js';
import { prTone, changesLabel } from './prs.js';
import { createMenu } from './ctxmenu.js';
import { createAgentSheet } from './agentsheet.js';
import { pinned, folds, stoppedNote } from './important.js';

const LIVE = ['stalled', 'waiting', 'building'];
const EMPTY_NOTE = { stalled: 'Nobody needs you.', waiting: 'Nothing is waiting.', building: 'Nobody is building right now.' };

export function createPanel(app) {
  const { S } = app;
  const list = document.getElementById('list');
  const fchips = document.getElementById('fchips');

  // ---------- keyed node cache ----------
  const cache = new Map();
  let used = new Set();
  const keyed = (key, make) => {
    let el = cache.get(key);
    if (!el) { el = make(); cache.set(key, el); }
    used.add(key);
    return el;
  };
  // Make parent's children `nodes`, moving as few as possible (moving a node can blur it). While the
  // user is engaged with the panel (`hold`), existing rows keep their place; see order.js.
  let hold = false, userAct = false;
  const sync = (parent, nodes) => syncNodes(parent, nodes, hold);

  // ---------- engagement: hold the order while the user is reading or pointing at the list ----------
  // Pointer over the list, keyboard focus in the panel, a scroll in the last 3 s, or the agent menu
  // open. When engagement ends, the held moves apply (with a short slide).
  const pbody = list.parentElement;
  let pointerIn = false, kbFocus = false, scrolledAt = 0, lastInput = 'mouse', releaseTimer = 0;
  let menu = null, sheet = null;
  const engaged = () => pointerIn || kbFocus || Date.now() - scrolledAt < 3000 || !!menu?.isOpen();
  const maybeRelease = () => { clearTimeout(releaseTimer); releaseTimer = setTimeout(() => { if (hold && !engaged()) app.render(); }, 50); };
  addEventListener('keydown', () => { lastInput = 'kb'; }, true);
  addEventListener('pointerdown', () => { lastInput = 'mouse'; }, true);
  pbody.addEventListener('pointerenter', () => { pointerIn = true; });
  pbody.addEventListener('pointerleave', () => { pointerIn = false; maybeRelease(); });
  const panelEl = document.getElementById('panel');
  panelEl.addEventListener('focusin', () => { kbFocus = lastInput === 'kb'; });
  panelEl.addEventListener('focusout', e => { if (!panelEl.contains(e.relatedTarget)) { kbFocus = false; maybeRelease(); } });
  list.addEventListener('scroll', () => { scrolledAt = Date.now(); clearTimeout(releaseTimer); releaseTimer = setTimeout(() => { if (hold && !engaged()) app.render(); }, 3050); }, { passive: true });
  // Buckets as last shown: while held, a row stays in its section (its colours still update).
  let shownBucket = new Map();
  const bucketOf = a => (hold && shownBucket.get(a.id)) || a.bucket;

  // ---------- filtering & sorting ----------
  const q = () => S.query.toLowerCase();
  function matchesQuery(a, s) {
    if (!s) return true;
    const t = s.replace(/^#/, '');
    return [a.name, a.title, a.project].some(v => v && v.toLowerCase().includes(s))
      || (a.prs || []).some(p => String(p.id).includes(t))
      || a.id.toLowerCase().startsWith(s) || a.id.toLowerCase().split(':').slice(1).join(':').startsWith(s);
  }
  function matches(a) {
    const f = S.filters;
    return (!f.projects.size || f.projects.has(a.project || '—'))
      && (!f.harness.size || f.harness.has(a.harness))
      && (!f.roles.size || f.roles.has(a.role))
      && (!f.bucket || (f.bucket === 'error' ? isError(a) : f.bucket === 'prompt' ? isPrompt(a) : a.bucket === f.bucket))
      && matchesQuery(a, q());
  }
  const filtering = () => !!(S.query || S.filters.projects.size || S.filters.harness.size || S.filters.roles.size || S.filters.bucket);
  // Stable orders. Sections: errors first (Stalled), then by when the agent entered the section, then
  // first-seen rank; an existing row never moves and a newcomer lands at the end. Everything else
  // (teams, cards, members) is by rank alone: urgency shows as colour, edges and counts, not order.
  const inBucket = (a, b) => isError(b) - isError(a) || enteredAt(a) - enteredAt(b) || byRank(a, b);
  const byBucket = byRank;
  const kidsOf = a => S.kids.get(a.id) || [];
  function worst(a, seen = new Set()) {
    if (seen.has(a.id)) return 3;
    seen.add(a.id);
    return Math.min(BUCKET_RANK[a.bucket], ...kidsOf(a).map(k => worst(k, seen)));
  }
  // FLIP: rows that changed position slide there in 150 ms (only rows on screen; none under reduced motion).
  const MOVERS = '.row, .trow:not(.thead), .card';
  function positions() {
    const m = new Map(), top = list.getBoundingClientRect().top, h = list.clientHeight;
    for (const el of list.querySelectorAll(MOVERS)) {
      const y = el.getBoundingClientRect().top - top;
      if (y > -200 && y < h + 200) m.set(el, y);
    }
    return m;
  }
  function flip(before) {
    const top = list.getBoundingClientRect().top;
    for (const [el, y0] of before) {
      if (!el.isConnected) continue;
      const dy = y0 - (el.getBoundingClientRect().top - top);
      if (Math.abs(dy) > 1 && Math.abs(dy) < 1500) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 150, easing: 'ease-out' });
    }
  }
  const byWorst = byRank;

  // ---------- rows ----------
  function rowBtn(a, { crumb = false, dropProject = false, noProject = false, depth = 0, ctx = false, sum = '' } = {}) {
    const btn = keyed(`row:${a.id}`, () => h('button', { class: 'row', type: 'button', 'data-id': a.id }));
    const parent = a.parentId && S.byId.get(a.parentId);
    const t = (S.data?.serverTime || Date.now()) - (a.since || 0);
    // An Important agent that isn't running says so first (it stays in view; see important.js).
    const reason = stoppedNote(a) || a.reason || BUCKET_NAME[a.bucket];
    const project = noProject || (dropProject && parent && parent.project === a.project) ? '' : a.project || '';
    const now = S.data?.serverTime || Date.now();
    // A wide panel (≥ 600px) has room for harness and last activity on line 2.
    const extra = wide ? [HARNESS_NAME[a.harness] || a.harness, a.lastActivityAt ? `active ${ago(now - a.lastActivityAt)} ago` : ''] : [];
    const l2 = [reason, project, crumb && parent && a.role !== 'boss' ? `↳ ${parent.name}` : '', ...extra].filter(Boolean).join(' · ');
    const dup = dupOf(a);
    // The accessible name comes from the visible row text (WCAG 2.5.3: speech users say what they see),
    // with role, bucket and duration spelled out in a screen-reader-only tail.
    const tail = [ROLE_NAME[a.role] || a.role, `${BUCKET_NAME[a.bucket]} for ${agoLong(t)}`, parent ? `under ${parent.name}` : '',
      a.live ? '' : 'not running'].filter(Boolean).join(', ');
    // Changed files in its folder: a small chip where there is room (expanded, or a wide panel).
    const chg = a.changes && (S.panel === 'full' || wide) ? changesLabel(a.changes) : '';
    const sig = [a.name, a.important, dup, a.role, a.roleSource, a.bucket, a.severity, a.prompt, a.live, a.hidden, l2, chg, t > 30 * 60e3, tail, sum].join('|');
    if (btn._sig !== sig) {
      btn.innerHTML = `<span class="rg">${icon(a.role in ROLE_NAME ? a.role : 'solo', 'px role')}${a.roleSource === 'override' ? '<i class="ov"></i>' : ''}</span>
        <span class="nm"><span>${esc(a.name)}</span>${a.important ? '<span class="star" title="Important" aria-label="Important">★</span>' : ''}${dup ? `<span class="dup">${esc(dup)}</span>` : ''}<span class="nmx">${a.hidden ? '<span class="htag">Hidden</span>' : ''}${chg ? `<span class="chip chg" title="Changed in its folder: ${esc(chg)}"><span class="sr">Changes: </span>${esc(chg)}</span>` : ''}</span></span>
        <span class="meta"><i class="live ${a.live ? '' : 'no'}" aria-hidden="true"></i><span class="num ${a.bucket === 'stalled' && t > 30 * 60e3 ? 'old' : ''}">${ago(t)}</span></span>
        <span class="l2">${icon(bucketIcon(a))}<span>${esc(l2)}</span></span>${sum}<span class="sr">, ${esc(tail)}</span>`;
      btn.querySelector('.nm > span').title = a.name;
      btn.title = S.compact ? `${reason}${project ? ` · ${project}` : ''}` : '';
      if (btn._bucket && btn._bucket !== a.bucket) { btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash'); }
      btn._bucket = a.bucket;
      btn._sig = sig;
    }
    btn.className = `row ${a.role} b-${a.bucket}${isError(a) ? ' sev-error' : isPrompt(a) ? ' sev-prompt' : ''}${a.hidden ? ' is-hidden' : ''}${ctx ? ' ctx' : ''}${btn.classList.contains('flash') ? ' flash' : ''}`;
    btn.style.setProperty('--depth', depth);
    if (S.selected === a.id) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
    return btn;
  }
  const chip = p => {
    const href = safeHref(p.href), t = prTone(p);
    const words = t.words ? ` (${t.words})` : '';
    return `<span class="chip${t.cls}"${href ? ` data-href="${esc(href)}" title="Open PR #${esc(p.id)}${esc(words)} in a new tab"` : t.words ? ` title="PR #${esc(p.id)}${esc(words)}"` : ''}>#${esc(p.id)}</span>`;
  };
  // A row's <li> also carries the compact "open in terminal" button (shown on hover/focus) and the
  // "⋯" that opens its menu (always shown on touch screens).
  const li = (key, ...kids) => {
    const el = keyed(key, () => h('li'));
    const a = kids[0]?.classList?.contains('row') && S.byId.get(kids[0].dataset.id);
    const ob = a && openBtn(a);
    sync(el, a ? [...kids, ...(ob ? [ob] : []), menuBtn(a)] : kids);
    return el;
  };
  function menuBtn(a) {
    const b = keyed(`mb:${a.id}`, () => h('button', { class: 'menubtn', type: 'button', 'data-menu': a.id, 'aria-haspopup': 'menu', html: '<span aria-hidden="true">⋯</span>' }));
    const label = `Actions for ${a.name}`;
    if (b.getAttribute('aria-label') !== label) { b.setAttribute('aria-label', label); b.title = `${label} (right-click, or Shift+F10)`; }
    return b;
  }

  // ---------- open in terminal (Ghostty / Terminal.app / a Linux terminal; the server picks) ----------
  // The server runs the agent's own resume command in a new terminal window. We only predict whether
  // it can (to hide or explain), using the server's exact reasons; its answer is final.
  const terminal = () => S.data?.open?.terminal || null;
  const TERM_NAME = { ghostty: 'Ghostty', terminal: 'Terminal' };
  const termName = () => TERM_NAME[terminal()] || (terminal() ? terminal()[0].toUpperCase() + terminal().slice(1) : '');
  function openBlock(a) {
    if (['subagent', 'teammate', 'thread'].includes(a.kind)) return 'Open its lead instead';
    if (a.neverStarted) return "This launch failed before it started, so there's no session to open";
    if (embedded(a.id)) return 'Running in the built-in terminal; use Pop out';
    // A job reopened in a terminal is that live session: attaching would start a second process.
    if (a.harness === 'claude-code' && (a.kind === 'session' || a.reopened) && a.live) return 'Already running in another terminal';
    return null;
  }
  // The built-in terminal (term.js): same command and refusals as Open.
  const embedded = id => (S.data?.term?.running || []).includes(id);
  const termBlock = a => (embedded(a.id) ? null : openBlock(a));

  function openBtn(a) {
    if (!terminal() || openBlock(a)) return null;
    const b = keyed(`ob:${a.id}`, () => h('button', { class: 'openbtn', type: 'button', 'data-open': a.id }));
    const label = `Open ${a.name} in ${termName()}`;
    if (b.getAttribute('aria-label') !== label) { b.setAttribute('aria-label', label); b.title = `${label} (O)`; b.textContent = '↗'; }
    return b;
  }
  let opening = false;
  // `report(msg)` lets a caller (the account sheet) show the outcome inline instead of the toast.
  async function openAgent(id, btn, report) {
    const a = S.byId.get(id);
    if (!a || opening) return;
    const block = openBlock(a);
    if (!terminal() || block) { (report || app.toast)(block || 'No supported terminal on this machine.'); return; }
    opening = true;
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); if (btn.classList.contains('primary')) btn.textContent = 'Opening…'; }
    try {
      const res = await fetch(`/api/open/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
      store.set('va.opened', true);
      app.toast(`Opened ${a.name} in ${TERM_NAME[body.terminal] || termName()}`);
      report?.('');
    } catch (e) {
      // Never retry: a window may already be open. The server's message is written for people.
      const msg = e instanceof TypeError ? "Couldn't open: the Agentville server isn't reachable." : e.message;
      if (report) report(msg); else app.toast(msg);
    } finally {
      opening = false;
      if (btn?.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); if (label != null) btn.textContent = label; }
    }
  }

  // ---------- status view ----------
  function section(b, items, { restingToggle = false, tag = 'section' } = {}) {
    const sec = keyed(`sec:${S.panel === 'full' ? 'f' : 'd'}:${b}`, () => h(tag, { class: `sec ${b}` }));
    const nodes = [];
    if (restingToggle) {
      const open = S.restingOpen || !!S.query;
      const tg = keyed(`rtog:${b}`, () => h('button', { class: 'resting-toggle', type: 'button', 'data-act': 'resting' }));
      tg.setAttribute('aria-expanded', String(open));
      tg.innerHTML = `${open ? '▾' : '▸'} Resting · <span class="num">${items.length}</span>${S.panel === 'full' && !open ? ' — show' : ''}`;
      nodes.push(tg);
      if (open) nodes.push(ul(`rul:${b}`, items.map(a => li(`sli:${a.id}`, rowBtn(a, { crumb: true })))));
      // Folded, Important resting agents still show under the toggle (only a hide removes them).
      else if (items.some(pinned)) nodes.push(ul(`rpin:${b}`, items.filter(pinned).map(a => li(`sli:${a.id}`, rowBtn(a, { crumb: true }))), 'pinned'));
    } else {
      const h2 = keyed(`h2:${S.panel}:${b}`, () => h('h2'));
      h2.innerHTML = `${icon(b)}${BUCKET_NAME[b]} · <span class="c num">${items.length}</span>`;
      nodes.push(h2);
      if (items.length && S.panel === 'full') {
        // Full-screen columns: light sub-headers by project, in the order their first row sorts.
        const groups = new Map();
        for (const a of items) { const p = a.project || '—'; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(a); }
        for (const [p, list] of groups) {
          const sh = keyed(`psub:${b}:${p}`, () => h('h3', { class: 'psub' }));
          const t = `${p} · ${list.length}`;
          if (sh.textContent !== t) sh.textContent = t;
          nodes.push(sh, ul(`psul:${b}:${p}`, list.map(a => li(`sli:${a.id}`, rowBtn(a, { crumb: true, noProject: true })))));
        }
      } else if (items.length) nodes.push(ul(`sul:${S.panel}:${b}`, items.map(a => li(`sli:${a.id}`, rowBtn(a, { crumb: true })))));
      else {
        const p = keyed(`empty:${S.panel}:${b}`, () => h('p', { class: 'empty-note' }));
        p.textContent = filtering() ? 'No matches.' : EMPTY_NOTE[b];
        nodes.push(p);
      }
    }
    sync(sec, nodes);
    return sec;
  }
  const ul = (key, kids, cls) => { const el = keyed(key, () => h('ul', cls ? { class: cls } : {})); sync(el, kids); return el; };

  function statusView(agents) {
    const by = b => agents.filter(a => bucketOf(a) === b).sort(inBucket);
    const shown = S.filters.bucket ? [['error', 'prompt'].includes(S.filters.bucket) ? 'stalled' : S.filters.bucket] : LIVE;
    if (S.panel === 'full') {
      const cols = keyed('fcols', () => h('div', { class: 'cols' }));
      sync(cols, shown.map(b => section(b, by(b))));
      if (shown.length === 1) cols.style.gridTemplateColumns = '1fr'; else cols.style.removeProperty('grid-template-columns');
      const wrap = keyed('fstatus', () => h('div', { class: 'fullstatus' }));
      const rest = by('resting');
      const bar = keyed('frest', () => h('div', { class: 'restbar' }));
      sync(bar, S.filters.bucket ? [] : [section('resting', rest, { restingToggle: true, tag: 'div' })]);
      sync(wrap, [cols, bar]);
      return [wrap];
    }
    const out = shown.map(b => section(b, by(b)));
    if (!S.filters.bucket) out.push(section('resting', by('resting'), { restingToggle: true, tag: 'div' }));
    return out;
  }

  // ---------- team view ----------
  // Docked Team shows the top level only: a team opens one level per caret click, and what is open
  // is remembered per agent id (localStorage), so polls and reloads keep it. Search, filters and the
  // selection reveal the ancestors of what they point at for as long as they apply, without
  // touching the saved state; a caret can still fold a revealed team (`unrevealed`) until they change.
  const OPEN_KEY = 'va.teamOpen', OPEN_MAX = 500, SOLO = '__solo';
  const teamOpen = new Set((v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []))(store.get(OPEN_KEY, [])));
  let revealed = new Set(), unrevealed = new Set(), revealKey = '';
  const isOpen = id => !unrevealed.has(id) && (teamOpen.has(id) || revealed.has(id));
  function setOpen(id, open) {
    teamOpen.delete(id); // re-added last, so the oldest ids are the ones dropped past OPEN_MAX
    if (open) { teamOpen.add(id); unrevealed.delete(id); } else if (revealed.has(id)) unrevealed.add(id);
    store.set(OPEN_KEY, [...teamOpen].slice(-OPEN_MAX));
  }
  const ancestors = id => {
    const out = [];
    for (let p = S.byId.get(id)?.parentId, g = 0; p && S.byId.has(p) && g < 50; p = S.byId.get(p).parentId, g++) out.push(p);
    return out;
  };
  function computeReveal(sets) {
    const f = S.filters;
    const key = [S.query, [...f.projects], [...f.harness], [...f.roles], f.bucket, S.selected].join('|');
    if (key !== revealKey) { revealKey = key; unrevealed = new Set(); }
    revealed = new Set();
    if (filtering()) {
      for (const id of sets.match) {
        const up = ancestors(id);
        for (const p of up) revealed.add(p);
        if (!up.length && S.byId.get(id)?.bucket === 'resting') revealed.add(SOLO);
      }
    }
    const sel = S.selected && S.byId.get(S.selected);
    if (sel) {
      const up = ancestors(sel.id);
      for (const p of up) revealed.add(p);
      if (!up.length && sel.bucket === 'resting') revealed.add(SOLO); // a resting solo sits under Solo's caret
    }
  }
  // One line under a folded parent: how many are under it, and their statuses (errors and "needs you" first).
  function teamSummary(a, keep) {
    const ds = descendants(a).filter(d => keep.has(d.id));
    if (!ds.length) return '';
    return `<span class="tsum"><span class="sr">, </span><span class="tsn">${ds.length} ${ds.length === 1 ? 'report' : 'reports'}</span>${tallyHTML(ds)}</span>`;
  }
  // keep = agents shown: matches plus their ancestors (ancestors that don't match render dimmed).
  function teamSets(agents) {
    const match = new Set(agents.filter(matches).map(a => a.id));
    const keep = new Set(match);
    for (const id of match) {
      let p = S.byId.get(id)?.parentId, guard = 0;
      while (p && S.byId.has(p) && !keep.has(p) && guard++ < 50) { keep.add(p); p = S.byId.get(p).parentId; }
    }
    return { match, keep };
  }
  const roots = agents => agents.filter(a => !a.parentId || !S.byId.has(a.parentId));
  // Resting leaves collapse to "+ N resting" unless searching or the group was expanded.
  function splitKids(a, keep) {
    const ks = kidsOf(a).filter(k => keep.has(k.id)).sort(byBucket);
    if (S.query || S.restExpanded?.has(a.id)) return { shown: ks, rest: 0 };
    const shown = ks.filter(k => !folds(k) || kidsOf(k).length); // Important ones never fold
    return { shown, rest: ks.length - shown.length };
  }
  function moreLine(key, a, rest, tag = 'li') {
    const el = keyed(key, () => h(tag, { class: 'more' }));
    el.innerHTML = `<button class="link" type="button" data-act="more" data-id="${esc(a.id)}">+ ${rest} resting</button>`;
    return el;
  }
  function treeNode(a, depth, sets, seen) {
    seen.add(a.id);
    const { shown, rest } = splitKids(a, sets.keep);
    const hasKids = shown.length + rest > 0;
    const open = hasKids && isOpen(a.id);
    const row = rowBtn(a, { dropProject: true, depth, ctx: !sets.match.has(a.id), sum: hasKids && !open ? teamSummary(a, sets.keep) : '' });
    const wrapKids = [];
    if (!hasKids) wrapKids.push(keyed(`chevsp:${a.id}`, () => h('span', { class: 'chev-sp', 'aria-hidden': 'true' })));
    else {
      const chev = keyed(`chev:${a.id}`, () => h('button', { class: 'chev', type: 'button', 'data-act': 'chev', 'data-id': a.id }));
      chev.textContent = open ? '▾' : '▸';
      chev.setAttribute('aria-expanded', String(open));
      chev.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${a.name}'s team`);
      wrapKids.push(chev);
    }
    wrapKids.push(row);
    const ob = openBtn(a);
    if (ob) wrapKids.push(ob);
    wrapKids.push(menuBtn(a));
    const tw = keyed(`tw:${a.id}`, () => h('div', { class: 'tw' }));
    sync(tw, wrapKids);
    const nodes = [tw];
    if (open) {
      const kul = keyed(`tkids:${a.id}`, () => h('ul', { class: 'kids' }));
      kul.style.setProperty('--depth', depth);
      const items = shown.filter(k => !seen.has(k.id)).map(k => treeNode(k, depth + 1, sets, seen));
      if (rest) items.push(moreLine(`tmore:${a.id}`, a, rest));
      sync(kul, items);
      nodes.push(kul);
    } else if (hasKids) {
      // A folded team still shows its Important members, pinned under it with "↳ parent".
      const pins = descendants(a).filter(d => pinned(d) && sets.keep.has(d.id) && !seen.has(d.id));
      if (pins.length) {
        pins.forEach(d => seen.add(d.id));
        const pul = keyed(`tpins:${a.id}`, () => h('ul', { class: 'kids pinned' }));
        pul.style.setProperty('--depth', depth);
        sync(pul, pins.map(d => li(`tli:${d.id}`, rowBtn(d, { crumb: true, dropProject: true, depth: depth + 1, ctx: !sets.match.has(d.id) }))));
        nodes.push(pul);
      }
    }
    return li(`tli:${a.id}`, ...nodes);
  }
  function teamView(agents) {
    const sets = teamSets(agents);
    if (S.panel === 'full') return fullTeam(agents, sets);
    computeReveal(sets);
    const top = roots(agents).filter(a => sets.keep.has(a.id)).sort(byWorst);
    const heads = top.filter(a => kidsOf(a).some(k => sets.keep.has(k.id)));
    const solos = top.filter(a => !heads.includes(a));
    // Resting solos fold behind the Solo heading's caret (its tally counts them), not a "+N resting" line.
    // Important resting solos stay out of the fold.
    const restSolos = S.query ? 0 : solos.filter(folds).length;
    const soloOpen = !restSolos || isOpen(SOLO);
    const soloShown = soloOpen ? solos : solos.filter(a => !folds(a));
    const seen = new Set();
    const out = [];
    if (heads.length) {
      const tools = keyed('ttools', () => h('div', { class: 'ttools' }));
      const anyOpen = heads.some(a => isOpen(a.id));
      const html = `<span>${heads.length} ${heads.length === 1 ? 'team' : 'teams'}</span><span class="tta"><button class="linkbtn" type="button" data-act="expandall">Expand all</button><button class="linkbtn" type="button" data-act="collapseall"${anyOpen ? '' : ' disabled'}>Collapse all</button></span>`;
      if (tools._html !== html) { tools.innerHTML = html; tools._html = html; }
      out.push(tools);
    }
    const tree = keyed('tree', () => h('ul', { class: 'tree' }));
    sync(tree, heads.map(a => treeNode(a, 0, sets, seen)));
    out.push(tree);
    if (solos.length) {
      const sec = keyed('tsolo', () => h('section', { class: 'sec tsolo' }));
      const h2 = keyed('tsolo:h2', () => h('h2'));
      const label = keyed('tsolo:lbl', () => h('span', { class: 'tsl' }));
      const lhtml = `Solo · <span class="c num">${solos.length}</span>${tallyHTML(solos)}`;
      if (label._html !== lhtml) { label.innerHTML = lhtml; label._html = lhtml; }
      const hk = [label];
      if (restSolos) {
        const chev = keyed('tsolo:chev', () => h('button', { class: 'chev', type: 'button', 'data-act': 'chev', 'data-id': SOLO }));
        chev.textContent = soloOpen ? '▾' : '▸';
        chev.setAttribute('aria-expanded', String(soloOpen));
        chev.setAttribute('aria-label', `${soloOpen ? 'Hide' : 'Show'} ${restSolos} resting solo ${restSolos === 1 ? 'agent' : 'agents'}`);
        hk.unshift(chev);
      }
      sync(h2, hk);
      const items = soloShown.map(a => li(`tli:${a.id}`, rowBtn(a, { ctx: !sets.match.has(a.id) })));
      sync(sec, [h2, ul('tsolo:ul', items)]);
      out.push(sec);
    }
    return out;
  }
  // Full-screen Team: one section per project (most urgent first), team cards in a masonry so there
  // are no holes, and quiet teams (nobody awake) folded into a one-line chip strip at the bottom.
  const awakeAt = new Map();
  function fullTeam(agents, sets) {
    // Shown as a row rather than "+N resting" / "Quiet": awake, Important, or a search match.
    const live = a => !folds(a) || (S.query && sets.match.has(a.id));
    const heads = agents.filter(a => sets.keep.has(a.id) && kidsOf(a).some(k => sets.keep.has(k.id)));
    const placed = new Map(); // project -> { cards: [head], solos: [], quiet: [head] }
    const slot = p => { if (!placed.has(p)) placed.set(p, { cards: [], solos: [], quiet: [], all: [] }); return placed.get(p); };
    for (const a of agents) if (sets.keep.has(a.id)) slot(a.project || '—').all.push(a);
    const now = Date.now();
    for (const a of heads) {
      // A lead only folds into "Quiet" after 10 min with nobody awake, so it doesn't flap.
      if ([a, ...descendants(a)].some(live)) awakeAt.set(a.id, now);
      const quiet = now - (awakeAt.get(a.id) ?? 0) > 10 * 60e3;
      slot(a.project || '—')[quiet ? 'quiet' : 'cards'].push(a);
    }
    for (const a of roots(agents)) if (sets.keep.has(a.id) && !heads.includes(a)) slot(a.project || '—').solos.push(a);
    const first = x => Math.min(...x.all.map(rank));
    const projects = [...placed].sort((x, y) => first(x[1]) - first(y[1]));
    const out = [], quietProjects = [], shared = [];
    for (const [project, g] of projects) {
      const awakeSolos = g.solos.filter(live);
      if (!g.cards.length && !awakeSolos.length) { quietProjects.push([project, g]); continue; }
      // A project with a single card doesn't get a whole row: it joins one shared masonry, with
      // the project name on the card instead of a section header.
      if (g.cards.length + (awakeSolos.length ? 1 : 0) === 1 && !g.quiet.length) {
        shared.push(g.cards.length ? teamCard(g.cards[0], sets, live, project) : soloCard(project, g.solos, sets, live, true));
        continue;
      }
      const sec = keyed(`fproj:${project}`, () => h('section', { class: 'proj' }));
      const h2 = keyed(`fproj:h2:${project}`, () => h('h2', { class: 'projhead' }));
      const html = `<span>${esc(project)}</span>${tallyHTML(g.all)}`;
      if (h2._html !== html) { h2.innerHTML = html; h2._html = html; }
      const cards = g.cards.sort(byWorst).map(a => teamCard(a, sets, live));
      if (awakeSolos.length) cards.push(soloCard(project, g.solos, sets, live));
      const masonry = keyed(`fmas:${project}`, () => h('div', { class: 'masonry' }));
      sync(masonry, cards);
      const nodes = [h2, masonry];
      if (g.quiet.length) nodes.push(quietStrip(`fquiet:${project}`, g.quiet.map(a => [a.id, a.name, descendants(a).length + 1])));
      sync(sec, nodes);
      out.push(sec);
    }
    if (shared.length) {
      const sec = keyed('fshared', () => h('section', { class: 'proj' }));
      const h2 = keyed('fshared:h2', () => h('h2', { class: 'projhead' }));
      const t = out.length ? 'More projects' : 'Projects';
      if (h2.textContent !== t) h2.textContent = t;
      const mas = keyed('fshared:mas', () => h('div', { class: 'masonry' }));
      sync(mas, shared);
      sync(sec, [h2, mas]);
      out.push(sec);
    }
    if (quietProjects.length) {
      const sec = keyed('fquietprojects', () => h('section', { class: 'proj' }));
      const h2 = keyed('fquietprojects:h2', () => h('h2', { class: 'projhead' }));
      h2.textContent = 'Quiet projects';
      sync(sec, [h2, quietStrip('fquietp', quietProjects.map(([p, g]) => [null, p, g.all.length]))]);
      out.push(sec);
    }
    return out;
  }
  function tallyHTML(list) {
    const n = b => list.filter(a => (b === 'error' ? isError(a) : a.bucket === b && !isError(a))).length;
    const word = { error: 'errors', stalled: 'need you', waiting: 'waiting', building: 'building' };
    const parts = ['error', 'stalled', 'waiting', 'building'].filter(b => n(b)).map(b => `<span class="tt ${b}">${icon(b)}<span class="num">${n(b)}</span><span class="sr"> ${word[b]}</span></span>`);
    if (n('resting')) parts.push(`<span class="tt resting">${icon('resting')}<span class="num">${n('resting')}</span><span class="sr"> resting</span></span>`);
    return `<span class="tally">${parts.join('')}</span>`;
  }
  // A card: the head row, a bucket tally, then its members (resting ones are just a muted count).
  // Members that lead teams of their own get their own card instead, so no row appears twice.
  function teamCard(a, sets, live, projectLabel) {
    const el = keyed(`card:${a.id}`, () => h('div', { class: 'card' }));
    const all = [a, ...descendants(a)];
    el.className = `card w-${all.some(isError) ? 'error' : ['stalled', 'waiting', 'building', 'resting'][worst(a)]}`;
    const nodes = [];
    if (projectLabel) { const ph = keyed(`cardproj:${a.id}`, () => h('div', { class: 'cardhead' })); ph.textContent = projectLabel; nodes.push(ph); }
    nodes.push(rowBtn(a, { ctx: !sets.match.has(a.id) }));
    const t = keyed(`tally:${a.id}`, () => h('div', { class: 'cardtally' }));
    const th = tallyHTML(all.slice(1));
    if (t._html !== th) { t.innerHTML = th; t._html = th; }
    if (all.length > 1) nodes.push(t);
    const members = [];
    let rest = 0;
    const walk = (x, d) => {
      for (const k of kidsOf(x).filter(k => sets.keep.has(k.id)).sort(byBucket)) {
        if (kidsOf(k).some(c => sets.keep.has(c.id))) continue; // has its own card
        if (!live(k)) { rest++; continue; }
        members.push(li(`cli:${k.id}`, rowBtn(k, { dropProject: true, depth: d, ctx: !sets.match.has(k.id) })));
      }
    };
    walk(a, 1);
    if (members.length) nodes.push(ul(`cul:${a.id}`, members));
    if (rest) { const m = keyed(`crest:${a.id}`, () => h('p', { class: 'restcount' })); m.textContent = `+${rest} resting`; nodes.push(m); }
    sync(el, nodes);
    return el;
  }
  function soloCard(project, solos, sets, live, labelled = false) {
    const el = keyed(`solocard:${project}`, () => h('div', { class: 'card solo' }));
    const awake = solos.filter(live).sort(byBucket);
    el.className = `card solo w-${awake.some(isError) ? 'error' : ['stalled', 'waiting', 'building', 'resting'][Math.min(...awake.map(a => BUCKET_RANK[a.bucket]))]}`;
    const head = keyed(`solocard:h:${project}`, () => h('div', { class: 'cardhead' }));
    head.textContent = labelled ? `${project} · solo · ${awake.length}` : `Solo sessions · ${awake.length}`;
    const nodes = [head, ul(`solocard:ul:${project}`, awake.map(a => li(`cli:${a.id}`, rowBtn(a, { noProject: true, ctx: !sets.match.has(a.id) }))))];
    const rest = solos.length - awake.length;
    if (rest) { const m = keyed(`solocard:r:${project}`, () => h('p', { class: 'restcount' })); m.textContent = `+${rest} resting`; nodes.push(m); }
    sync(el, nodes);
    return el;
  }
  // Quiet teams or projects as one wrapping line of small chips. Team chips select the lead.
  function quietStrip(key, items) {
    const el = keyed(key, () => h('div', { class: 'quiet' }));
    const html = `<span class="ql">Quiet</span>${items.map(([id, name, n]) => (id
      ? `<button class="qchip" type="button" data-act="goto" data-id="${esc(id)}">${esc(name)} <span class="num">· ${n}</span></button>`
      : `<button class="qchip" type="button" data-act="filterproj" data-project="${esc(name)}">${esc(name)} <span class="num">· ${n}</span></button>`)).join('')}`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    return el;
  }
  function descendants(a, seen = new Set([a.id])) {
    const out = [];
    for (const k of kidsOf(a)) if (!seen.has(k.id)) { seen.add(k.id); out.push(k, ...descendants(k, seen)); }
    return out;
  }

  // ---------- conversation search: names and titles of every conversation, resting ones included ----------
  // The server keeps the index (titles only, never prompt text); rows already shown above are left out.
  function convSection() {
    const c = S.conv;
    if (!S.query || !c || c.q !== S.query.trim().toLowerCase()) return null;
    const rows = (c.results || []).filter(r => !(S.byId.has(r.id) && matches(S.byId.get(r.id))));
    if (!rows.length) return null;
    const sec = keyed('convsec', () => h('section', { class: 'sec conv', 'aria-labelledby': 'conv-h' }));
    const now = S.data?.serverTime || Date.now();
    const html = `<h2 id="conv-h">Conversations by name · <span class="c num">${rows.length}</span></h2><ul>${rows.map(r => {
      const a = S.byId.get(r.id);
      const now2 = a && a.name !== r.matched ? ` · now “${esc(a.name)}”` : '';
      return `<li><button class="convrow" type="button" data-act="convopen" data-id="${esc(r.id)}"><span class="cn">${esc(r.matched)}</span><span class="cm">${esc(r.project || '—')} · ${esc(ago(now - r.at))} ago${now2}${a ? '' : ' · not in the list'}</span></button></li>`;
    }).join('')}</ul>`;
    if (sec._html !== html) { sec.innerHTML = html; sec._html = html; }
    return sec;
  }

  // ---------- states ----------
  function stateNode(key, html) {
    const el = keyed(key, () => h('div', { class: 'empty-state' }));
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    return el;
  }
  function chips() {
    const f = S.filters, out = [];
    const add = (group, value, label) => out.push(`<button class="fchip" type="button" data-clear="${esc(group)}" data-value="${esc(value)}"><span class="sr">Remove filter </span>${esc(label)}<span aria-hidden="true"> ×</span></button>`);
    if (f.bucket) add('bucket', '', f.bucket === 'error' ? 'Errors only' : `${BUCKET_NAME[f.bucket]} only`);
    f.projects.forEach(p => add('projects', p, p));
    f.harness.forEach(x => add('harness', x, `Harness: ${HARNESS_NAME[x] || x}`));
    f.roles.forEach(r => add('roles', r, `Role: ${ROLE_NAME[r]}`));
    if (f.showHidden) add('hidden', '', 'Showing hidden');
    const html = out.join('');
    if (fchips._html !== html) { fchips.innerHTML = html; fchips._html = html; }
  }

  // ---------- render ----------
  let pendingScroll = null;
  // Names that collide among rows on screen get a short id after them. Resting rows are usually
  // folded away, so they only count when the row itself rests or resting rows are expanded.
  let awakeCount = new Map(), allCount = new Map(), wide = false;
  function dupOf(a) {
    const restingShown = S.query || (S.view === 'status' ? S.restingOpen : S.view === 'table' ? S.table.resting : S.view === 'models' ? S.mv.resting : S.restExpanded?.size);
    return ((a.bucket === 'resting' || restingShown) ? allCount : awakeCount).get(a.name) > 1 ? shortId(a.id) : '';
  }
  const shortId = id => (id.includes(':sub:') ? id.split(':sub:').pop() : id.slice(id.indexOf(':') + 1)).slice(0, 8);
  function render({ loading }) {
    used = new Set();
    const wasHeld = hold;
    // A click or key in the list is the user asking for a change, so it applies even while engaged.
    hold = engaged() && !userAct && list.childElementCount > 0;
    userAct = false;
    // When not held, remember where rows are so moves can slide into place (FLIP), not jump.
    const slide = !hold && !S.reduceMotion && !list.hidden;
    const before = slide ? positions() : null;
    awakeCount = new Map(); allCount = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const a of S.agents) if (!a.hidden) { bump(allCount, a.name); if (!folds(a)) bump(awakeCount, a.name); }
    const active = document.activeElement;
    const activeKey = active && list.contains(active) ? [...cache].find(([, el]) => el === active)?.[0] : null;
    chips();
    list.classList.toggle('compact', S.compact);
    list.classList.toggle('full', S.panel === 'full');
    list.classList.toggle('tableview', S.view === 'table' || S.view === 'models');
    list.classList.toggle('modelsview', S.view === 'models');
    list.classList.toggle('treeview', S.view === 'tree');
    wide = S.panel === 'docked' && !list.hidden && list.clientWidth >= 600;
    let nodes;
    const all = S.data?.agents || [];
    if (loading || (!S.data && S.status !== 'offline')) {
      nodes = [keyed('skeleton', () => h('div', { style: 'padding-top:12px', 'aria-busy': 'true', 'aria-label': 'Loading agents', html: '<div class="sk"></div>'.repeat(6) }))];
    } else if (!S.data) {
      nodes = [stateNode('nodata', '<b>No data yet.</b><span>The Agentville server isn\'t answering. This list fills in as soon as it does.</span>')];
    } else if (!all.length) {
      const src = S.data.sources || {};
      const found = k => (k in src ? (src[k] ? ' — found, no sessions yet' : ' — not found') : '');
      nodes = [stateNode('empty', `<b>No agents found yet.</b>
        <span>Agentville reads Claude Code sessions from <code>~/.claude</code> and Codex sessions from <code>~/.codex</code>, read-only. Start a session in either and it appears here within a few seconds.</span>
        <span>Looked in:</span>
        <ul><li>Claude Code: <code>~/.claude</code> (or <code>$CLAUDE_CONFIG_DIR</code>)${found('claude')}</li><li>Codex: <code>~/.codex</code> (or <code>$CODEX_HOME</code>)${found('codex')}</li></ul>`)];
    } else if (!S.agents.length) {
      nodes = [stateNode('allhidden', `<b>All ${all.length} agents are hidden.</b><span><button class="link" type="button" data-act="showhidden">Show hidden agents</button></span>`)];
    } else {
      const agents = S.agents.filter(a => !(S.view === 'status') || matches(a));
      if (S.view === 'table') nodes = table.render();
      else if (S.view === 'models') nodes = models.render();
      else if (filtering() && !(S.view === 'status' ? agents : S.agents.filter(matches)).length) {
        nodes = [stateNode(`nomatch:${S.query}`, S.query
          ? `<b>No agents match “${esc(S.query)}”.</b><span><button class="link" type="button" data-act="clearsearch">Clear search</button></span>`
          : '<b>No agents match these filters.</b><span><button class="link" type="button" data-act="clearfilters">Clear filters</button></span>')];
      } else nodes = S.view === 'status' ? statusView(agents) : S.view === 'tree' ? tree.render() : teamView(S.agents);
      const conv = S.view === 'status' || S.view === 'team' ? convSection() : null;
      if (conv) nodes = [...nodes, conv];
    }
    if (!nodes.includes(tree.el)) list.classList.remove('chart');
    sync(list, nodes);
    if (!hold) shownBucket = new Map(S.agents.map(a => [a.id, a.bucket]));
    if (before) flip(before, wasHeld);
    for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
    menu.update();
    sheet.update();

    if (activeKey && document.activeElement !== active) {
      const el = cache.get(activeKey);
      if (el?.isConnected) el.focus({ preventScroll: true });
      else if (document.activeElement === document.body) list.focus({ preventScroll: true });
    }
    if (pendingScroll) {
      const el = cache.get(`row:${pendingScroll}`);
      if (el?.isConnected) el.scrollIntoView({ block: 'nearest' });
      pendingScroll = null;
    }
  }

  // ---------- events ----------
  async function hide(a, hidden) {
    try {
      await app.patch(a.id, { hidden: hidden ? true : null });
      if (hidden) {
        if (S.selected === a.id && !S.filters.showHidden) app.select(null);
        const n = (S.data?.agents || []).filter(x => x.hidden).length;
        app.toast(`${a.name} hidden. Find it under “${n} hidden” at the top of the list.`, { label: 'Undo', run: () => app.patch(a.id, { hidden: null }).catch(e => app.toast(`Couldn't unhide — ${e.message}`)) }, 8000);
      } else app.say(`${a.name} is shown again`);
    } catch (e) {
      app.toast(saveError(e));
    }
  }
  const saveError = e => (e instanceof TypeError ? 'Couldn\'t save — server not reachable.' : `Couldn't save — ${e.message}`);

  const userAction = () => { userAct = true; setTimeout(() => { userAct = false; }); }; // only for renders this event causes
  // Clicking nothing in the list area (whitespace, gaps, column backgrounds, a header's empty part)
  // clears the selection. Not on a drag or text selection, and never on anything interactive.
  let down = null;
  list.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  const INTERACTIVE = 'button, a, input, select, textarea, label, summary, details, .row, .trow, .card, .chip, .qchip, [data-act], [data-open], [data-menu], [role="columnheader"]';
  function clickedNothing(e) {
    if (e.currentTarget !== list || e.target.closest(INTERACTIVE)) return false;
    const d = down; down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return false;
    if (String(getSelection?.() || '').length) return false;
    return !!S.selected;
  }
  function onClick(e) {
    userAction(); // also releases the order hold for the render this click causes
    if (clickedNothing(e)) return app.select(null);
    const ob = e.target.closest('[data-open]');
    if (ob) { e.stopPropagation(); return openAgent(ob.dataset.open, ob); }
    if (S.view === 'table' && e.currentTarget === list && table.onClick(e)) return;
    if (S.view === 'models' && e.currentTarget === list && models.onClick(e)) return;
    const t = e.target;
    const href = t.closest('.chip[data-href]')?.dataset.href;
    if (href) { e.stopPropagation(); window.open(href, '_blank', 'noopener'); return; }
    const act = t.closest('[data-act]');
    if (act) {
      const id = act.dataset.id;
      switch (act.dataset.act) {
        case 'resting': S.restingOpen = !S.restingOpen; return app.render();
        case 'chev': setOpen(id, !isOpen(id)); return app.render();
        case 'expandall': for (const x of S.agents) if (kidsOf(x).length) setOpen(x.id, true); return app.render();
        case 'collapseall': {
          for (const x of [...teamOpen]) if (x !== SOLO) setOpen(x, false);
          if (!filtering()) for (const x of revealed) if (x !== SOLO) unrevealed.add(x); // the selection's too
          return app.render();
        }
        case 'more': (S.restExpanded ||= new Set()).add(id); return app.render();
        case 'clearsearch': S.query = ''; document.getElementById('q').value = ''; return app.render();
        case 'clearfilters': Object.assign(S.filters, { projects: new Set(), harness: new Set(), roles: new Set(), bucket: null }); return app.render();
        case 'showhidden': return app.setShowHidden(true);
        case 'goto': return app.select(id, { reveal: true });
        case 'convopen': {
          if (S.byId.has(id)) return app.select(id, { reveal: true, pan: S.panel !== 'full' });
          const hidden = (S.data?.agents || []).some(x => x.id === id && x.hidden);
          return app.toast(hidden ? 'That agent is hidden. Turn on “Show hidden agents” in Filters to open it.' : "That conversation isn't one of the agents in the list (it was folded into a newer copy or can't be read).");
        }
        case 'filterproj': S.filters.projects = new Set([act.dataset.project]); S.views.full = 'table'; S.table.resting = true; return app.render();
      }
      return;
    }
    const row = t.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.detail === 2) return; // second click of a double-click: dblclick opens the terminal
    // In the terminal view a click switches the terminal to it; elsewhere a second click deselects.
    app.select(S.selected === id && !S.term ? null : id);
  }
  list.addEventListener('click', onClick);
  list.addEventListener('dblclick', e => {
    const row = e.target.closest('.row, .trow[data-id]');
    const inner = e.target.closest('button, .chip[data-href]'); // a row's own buttons (the row itself is one)
    if (row && (!inner || inner === row)) app.activate(row.dataset.id);
  });
  list.addEventListener('keydown', e => {
    if (!['Tab', 'Shift'].includes(e.key)) userAction();
    if (S.view === 'table' && table.onKey(e)) return;
    if (S.view === 'models' && models.onKey(e)) return;
    const row = e.target.closest?.('.row');
    if (!row || e.metaKey || e.ctrlKey || e.altKey) return;
    const id = row.dataset.id;
    const rows = () => [...list.querySelectorAll('.row')].filter(r => r.offsetParent);
    const move = i => { const rs = rows(); const r = rs[Math.max(0, Math.min(rs.length - 1, i))]; r?.focus(); r?.scrollIntoView({ block: 'nearest' }); };
    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        // Enter selects; on the selected row it opens its menu.
        if (S.selected === id) menu.open(id, { el: row }); else app.select(id);
        break;
      case ' ': e.preventDefault(); app.select(id, { pan: false }); break;
      case 'ArrowDown': e.preventDefault(); move(rows().indexOf(row) + 1); break;
      case 'ArrowUp': e.preventDefault(); move(rows().indexOf(row) - 1); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(Infinity); break;
      case 'ArrowLeft': case 'ArrowRight':
        if (S.view === 'team' && S.panel !== 'full' && row.previousElementSibling?.classList.contains('chev')) {
          e.preventDefault();
          const close = e.key === 'ArrowLeft';
          if (close === isOpen(id)) { setOpen(id, !close); app.render(); }
        }
        break;
    }
  });

  sheet = createAgentSheet(app, { descendants });
  menu = createMenu(app, { openBlock, termBlock, embedded, terminal, termName, openAgent, hide, sheet });
  const table = createTable({ S, keyed, sync, matches, byBucket, store, dupOf, chip, render: () => app.render(), app, openHTML: a => (terminal() && !openBlock(a) ? `<button class="openbtn" type="button" data-open="${esc(a.id)}" aria-label="Open ${esc(a.name)} in ${esc(termName())}" title="Open in ${esc(termName())} (O)">↗</button>` : '') });
  const models = createModels({ S, keyed, sync, matches, store, dupOf, render: () => app.render(), app });
  const tree = createTree({ S, app, matches, filtering });
  let lastWide = null;

  return {
    render,
    tableResort: () => table.resort(),
    open: (id, btn, report) => openAgent(id, btn, report),
    termName,
    termBlock: id => { const a = S.byId.get(id); return a ? termBlock(a) : 'Unknown agent'; },
    // The splitter moved: re-render only when the wide (≥ 600px) layout flips.
    resized() { const w = S.panel === 'docked' && list.clientWidth >= 600; if (w !== lastWide) { lastWide = w; app.render(); } },
    reveal(id) {
      const a = S.byId.get(id);
      if (!a) return;
      if (a.bucket === 'resting') S.restingOpen = true;
      if (S.filters.bucket && S.filters.bucket !== a.bucket) S.filters.bucket = null;
      if (!matches(a)) { S.query = ''; document.getElementById('q').value = ''; }
      // Its ancestors (and Solo's caret) open while it stays selected: computeReveal().
      if (a.bucket === 'resting' && a.parentId && S.byId.has(a.parentId)) (S.restExpanded ||= new Set()).add(a.parentId);
      pendingScroll = id;
      if (S.view === 'tree') tree.reveal(id);
    },
    /** The agent menu: at { x, y } (a pointer) or { el } (under a row or button). */
    menu: (id, at) => menu.open(id, at),
    closeMenu: opts => menu.close(opts),
    menuOpen: () => menu.isOpen(),
    // The terminal view saves where the list was scrolled, and puts it back after.
    scrollState: () => ({ list: list.scrollTop, listLeft: list.scrollLeft }),
    restoreScroll(st) { if (!st) return; list.scrollTop = st.list; list.scrollLeft = st.listLeft; },
    focusSelectedRow() { cache.get(`row:${S.selected}`)?.focus({ preventScroll: false }); },
    firstMatch() { return [...list.querySelectorAll('.row:not(.ctx), .tnode:not(.ctx)')].find(r => r.offsetParent)?.dataset.id; },
    jumpStalled(dir) {
      const rs = [...list.querySelectorAll('.row.b-stalled')].filter(r => r.offsetParent);
      if (!rs.length) return;
      let i = rs.indexOf(document.activeElement);
      if (i < 0) i = rs.findIndex(r => r.dataset.id === S.selected);
      const next = rs[(i < 0 ? (dir > 0 ? 0 : rs.length - 1) : (i + dir + rs.length) % rs.length)];
      app.select(next.dataset.id);
      next.focus();
    },
  };
}
