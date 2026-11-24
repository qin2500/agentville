// Accounts: the top-bar menu of the pool and the user's saved Claude accounts (with 5-hour and
// weekly usage), and the switch sheet (server/account.mjs + server/accounts.mjs). The server does
// the work: it swaps Claude's login and/or the pool settings, respawns each running background job
// (the first is a canary that rolls everything back if it fails) and returns per-job results.
// Terminal sessions are never touched: they are listed for the user to reopen. No token or env
// value ever reaches the browser; we only show labels, emails, plans, usage, names and folders.
import { icon, esc } from './ui.js';
import { pauseToggleHTML } from './usage-pause.js';
import { createAccountMenu } from './acctmenu.js';
import { patchAccount, LOW_PRIORITY_TIP, isLoginExpired } from './acct-items.js';
import { handoffsHTML, loadHandoffs, handoffAction } from './handoffs.js';

const LOGIN = 'claude auth login';
const RELOGIN = 'claude auth logout && claude auth login';
const PLAN = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "resets in 3h" style: minutes under an hour, days from two days on. */
function until(at) {
  const ms = at - Date.now();
  if (ms <= 60e3) return 'under a minute';
  if (ms < 3600e3) return `${Math.round(ms / 60e3)}m`;
  return ms < 48 * 3600e3 ? `${Math.round(ms / 3600e3)}h` : `${Math.round(ms / 86400e3)}d`;
}

export function createAccount(app, { open: openAgent, termName }) {
  const $ = id => document.getElementById(id);
  const sheet = $('acct'), btn = $('btn-account'), pop = $('pop-account');
  // Menu state, then the sheet's. view: loading | error | confirm | busy | results
  const A = {
    list: null, listErr: '', usage: new Map(), usageBusy: false, edit: null, menuErr: '', working: '', addInfo: null, addLabel: '', reloginId: '', addProvider: 'claude', handoffs: [],
    target: null, status: null, view: null, error: '', err: '', result: null, undone: null, undoErr: '', undoBusy: false,
  };
  const say = text => { const l = $('live'); if (l) l.textContent = text; };
  const geminiOf = () => A.list?.byProvider?.gemini?.accounts || [];
  const accountOf = id => A.list?.accounts.find(a => a.id === id) || geminiOf().find(a => a.id === id);
  /** What is running now: 'pool', a saved account id, or 'personal' (a login that isn't saved). */
  const current = () => {
    if (A.list) return A.list.active === 'unknown' ? 'personal' : A.list.active;
    return A.status?.profile || null;
  };
  const nameOf = id => (id === 'pool' ? 'Pool' : id === 'personal' ? 'Personal' : accountOf(id)?.label || 'Personal');
  const longOf = id => (id === 'pool' ? 'the pool' : id === 'personal' ? 'your personal account' : nameOf(id));

  // ---------- network ----------
  async function json(path, init) {
    const res = await fetch(path, { cache: 'no-store', ...init });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || body.error || `Server returned ${res.status}`), { code: body.code, size: body.size, max: body.max });
    return body;
  }
  const send = (method, path, body) => json(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const why = e => (e instanceof TypeError ? "the Agentville server isn't reachable" : e.code === 'too_big' ? tooBigText(e.size, e.max) : e.message);
  const tooBigText = (size, max) => `Can't switch accounts: your Claude login entry is too big (${size ?? '?'} of ${max ?? 65536}). Sign out of MCP servers you don't use to make room.`;
  /** Auto-switch has nowhere to go (blocked.why / blocked.until), or the active account is nearly out (>= 95%). No emails or labels. */
  function trouble() {
    const b = A.list?.autoSwitch?.blocked;
    if (b && b.reason !== 'too_big') {
      const at = Number(b.until);
      const when = at > 0 ? ` · resumes ~${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
      const noPool = b.why === 'all accounts low' ? ' (the pool was not chosen; switch to it by hand from this menu if you want it)' : '';
      return { text: `Auto-switch can't move: ${String(b.why || 'no account to switch to').replace(/[.\s]+$/, '')}${noPool}${when}`, blocked: true };
    }
    const u = A.usage.get(current());
    const hi = [['5-hour', u?.fiveHour], ['weekly', u?.weekly]].filter(([, w]) => w && !w.none && Math.round(w.used) >= 95);
    if (hi.length) return { text: `Active account almost out: ${hi.map(([n, w]) => `${n} ${Math.round(w.used)}%`).join(', ')}`, blocked: false };
    return { text: '' };
  }
  /** Keychain room: the too-big warning (auto-switch stopped, or a switch refused), or the remaining room once it is under 300 characters. */
  function headroomHTML() {
    const a = A.list?.autoSwitch;
    if (a?.blocked?.reason === 'too_big') return `<p class="acct-warn" role="alert" data-too-big><b>${esc(tooBigText(a.blocked.size, a.blocked.max))}</b></p>`;
    const h = a?.headroom;
    const t = trouble();
    if (t.text) return `<p class="acct-warn compact" role="alert" data-trouble><b>${esc(t.text)}</b></p>`;
    return h && h.left < 300 ? `<p class="acct-note" data-headroom>Login entry room: ${esc(h.left)} characters left (${esc(h.size)} of ${esc(h.max)}).</p>` : '';
  }

  // ---------- top bar ----------
  function label() {
    const cur = current();
    btn.hidden = !cur;
    if (!cur) return;
    const name = nameOf(cur);
    const warn = trouble().text;
    const html = `${warn ? '<span class="acct-flag" aria-hidden="true">⚠ </span>' : ''}<span class="acct-k">Account: </span><span class="acct-name">${esc(name)}</span><span class="caret"> ▾</span>`; // the prefix drops on a phone
    if (btn.innerHTML !== html) btn.innerHTML = html;
    btn.setAttribute('aria-label', `Account: ${name}. Switch account${warn ? `. Warning: ${warn}` : ''}`);
    if (warn) btn.title = warn; else btn.removeAttribute('title');
  }
  const GEMINI_HINT = 'Antigravity CLI not found. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash (Windows: irm https://antigravity.google/cli/install.ps1 | iex)';
  const GEMINI_SIGNIN = 'Sign in in the browser, then paste the code Google shows into the terminal.';
  async function loadList() {
    try { A.list = await json('/api/accounts'); A.listErr = ''; } catch (e) { A.listErr = `Couldn't load accounts: ${why(e)}`; }
    // An older server, or accounts unavailable here: fall back to the pool/personal profile.
    if (!A.list) A.status = await json('/api/account').catch(() => A.status);
    A.providers = (await json('/api/providers').catch(() => null))?.providers || A.providers;
    A.handoffs = await loadHandoffs();
    label();
  }
  loadList().then(() => loadUsage(false, true));
  // Without the menu open, check every 2 minutes so trouble shows in the top bar before agents stop.
  setInterval(() => { if (!document.hidden && pop.hidden) loadList().then(() => loadUsage(false, true)); }, 120000);

  // ---------- menu (in #pop-account, opened and closed by main.js) ----------
  function bar(name, short, w) {
    if (!w) return `<span class="ubar um" title="${name}: no data"><span class="um-k">${short}</span><span class="um-v">–</span></span>`;
    if (w.none) return ''; // no limit on this window: show nothing
    const used = Math.round(w.used), level = used >= 90 ? 'hi' : used >= 70 ? 'mid' : 'lo';
    const resets = w.resetsAt ? `resets in ${until(w.resetsAt)}` : '';
    const tip = `${name}: ${used}% used${resets ? `, ${resets}` : ''}`;
    return `<span class="ubar um ${level}" title="${esc(tip)}"><span class="um-k">${short}</span>
      <span class="um-t" role="meter" aria-label="${name} usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}" aria-valuetext="${esc(`${used}% used${resets ? `, ${resets}` : ''}`)}"><i style="width:${used}%"></i></span>
      <span class="um-v num">${used}%${resets ? `<span class="um-r"> · ${resets}</span>` : ''}</span></span>`;
  }
  const ago = at => { const m = Math.max(0, Math.round((Date.now() - at) / 60e3)); return m < 1 ? 'just now' : `${m} min ago`; };
  /** Extra usage groups the server may send (e.g. "Claude and GPT models"): shown only in the row's tooltip. */
  function extraTip(u) {
    const ex = Array.isArray(u?.extra) ? u.extra : [];
    const one = (label, w) => w && !w.none && Number.isFinite(Number(w.used)) ? `${label}: ${Math.round(w.used)}% used${w.resetsAt ? `, resets in ${until(w.resetsAt)}` : ''}` : '';
    // Server shape (gemini /usage): { name, fiveHour: {used, resetsAt}, weekly: {used, resetsAt} }
    return ex.flatMap(g => {
      const name = g.name || g.label || g.id || 'Other';
      if (g.fiveHour || g.weekly) return [one(`${name} 5h`, g.fiveHour), one(`${name} weekly`, g.weekly)];
      return [one(name, g.window || g)];
    }).filter(Boolean).join('\n');
  }
  function usageHTML(id) {
    const u = A.usage.get(id);
    if (!u) return `<span class="acct-note">${A.usageBusy ? 'Checking usage…' : 'Usage not checked'}</span>`;
    if (u.error) {
      const a = accountOf(id);
      const again = isLoginExpired(u) && a ? `<button class="linkbtn" type="button" ${k('relogin', id)} ${A.working || A.view === 'busy' || A.list?.adding ? 'disabled' : ''} aria-label="Sign in again as ${esc(a.email || a.label)}">Sign in again</button>` : '';
      const msg = String(u.error), short = msg.length > 60 ? `${msg.slice(0, 57)}…` : msg;
      return `<span class="acct-err" title="${esc(msg)}">${esc(short)}</span>${again}`;
    }
    const stale = u.stale ? `<span class="acct-note" title="${esc(u.note || 'not refreshed')}">as of ${esc(ago(u.asOf))}</span>` : '';
    return bar('5-hour', '5-hour', u.fiveHour) + bar('Weekly', 'Weekly', u.weekly) + stale;
  }
  const k = (act, id = '') => `data-am="${act}" data-id="${esc(id)}" data-key="${act}:${esc(id)}"`;
  const PILL_Q = 'Never used on the work Wi-Fi; preferred everywhere else';
  function rowHTML({ id, name, tip, plan, active, switchBtn, actions, usage, edit, quarantine, lowPriority, menu, sub }) {
    const pills = `${plan ? `<span class="acct-pill">${esc(plan)}</span>` : ''}${lowPriority ? `<span class="acct-pill lp" title="${esc(LOW_PRIORITY_TIP)}">Low priority</span>` : ''}${quarantine ? `<span class="acct-pill q" title="${PILL_Q}">Quarantine</span>` : ''}`;
    const more = menu ? `<button class="acct-more" type="button" data-more="${esc(id)}" data-key="more:${esc(id)}" aria-haspopup="menu" aria-label="Actions for ${esc(name)}" title="Rename, quarantine, low priority, remove (or right-click)">⋯</button>` : '';
    const l2 = usage ? `<div class="acct-l2" data-usage="${esc(id)}">${usageHTML(id)}</div>` : sub || actions ? `<div class="acct-l2">${sub ? `<span class="acct-note">${esc(sub)}</span>` : ''}${actions || ''}</div>` : '';
    const label = menu ? ` data-acct-menu tabindex="0" data-key="row:${esc(id)}" aria-label="${esc(name)}${active ? ' (active)' : ''}: press the context menu key or Shift+F10 for actions"` : '';
    return `<li class="acct-row${active ? ' on' : ''}${switchBtn ? ' sw' : ''}" data-row="${esc(id)}"${label}>
      <div class="acct-l1"><span class="acct-dot${active ? ' on' : ''}" role="img" aria-label="${active ? 'Active' : 'Not active'}" title="${active ? 'Active' : 'Not active'}"></span><b class="acct-nm" title="${esc(tip || name)}">${esc(name)}</b>${pills}<span class="acct-ctl">${switchBtn || ''}${more}</span></div>
      ${l2}${edit || ''}</li>`;
  }
  function editHTML(a) {
    if (A.edit?.id !== a.id) return '';
    if (A.edit.mode === 'rename') {
      return `<form class="acct-edit" data-am-form="rename" data-id="${esc(a.id)}"><label class="sr" for="acct-rename">New name for ${esc(a.label)}</label>
        <input id="acct-rename" maxlength="60" autocomplete="off" spellcheck="false" value="${esc(A.edit.value)}" data-key="rename-input">
        <button class="primary" type="submit" data-key="rename-save">Save</button><button class="ghost" type="button" ${k('edit-cancel', a.id)}>Cancel</button></form>`;
    }
    return `<div class="acct-edit confirm"><p>Remove ${esc(a.label)}? Agentville forgets its saved login; the account itself isn't affected.</p>
      <button class="primary danger" type="button" ${k('remove-confirm', a.id)}>Remove</button><button class="ghost" type="button" ${k('edit-cancel', a.id)}>Cancel</button></div>`;
  }
  const SEC_KEY = 'agentville.acct.collapsed';
  const loadSec = () => { try { return JSON.parse(localStorage.getItem(SEC_KEY)) || {}; } catch { return {}; } };
  const saveSec = () => { try { localStorage.setItem(SEC_KEY, JSON.stringify(A.sec)); } catch { /* private mode */ } };
  A.sec = loadSec(); A.footMore = false; A.hoOpen = false;
  const chev = open => `<svg class="acct-chev${open ? ' open' : ''}" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  /** A provider section: a small header with a chevron, then its rows (omitted while collapsed). */
  function sectionHTML(id, title, extra, body) {
    const open = !A.sec[id];
    return `<div class="acct-sec" data-provider="${id}"><button class="acct-sh" type="button" ${k('toggle-sec', id)} aria-expanded="${open}" aria-label="${esc(title)} accounts, ${open ? 'collapse' : 'expand'}">${chev(open)}<span>${esc(title)}</span>${extra ? `<span class="acct-sh-x">${extra}</span>` : ''}</button>${open ? body : ''}</div>`;
  }
  function menuHTML() {
    const L = A.list, cur = current(), busy = A.view === 'busy' || !!A.working;
    const sw = (to, name) => `<button class="acct-sw" type="button" ${k('switch', to)} ${busy ? 'disabled' : ''} aria-label="Switch to ${esc(name)}">Switch</button>`;
    let rows = '';
    if (L) {
      // The pool only shows while it is set up (or running): one compact row, no meters.
      if (L.pool.available || cur === 'pool') rows += rowHTML({ id: 'pool', name: 'Pool', sub: 'Shared gateway', active: cur === 'pool', switchBtn: cur !== 'pool' && L.pool.available ? sw('pool', 'the pool') : '' });
      // Claude's stored login when it isn't a saved account yet: switch to it as "personal", or save it.
      if (!L.login.id && (L.login.present || cur === 'pool' || cur === 'personal')) {
        rows += rowHTML({
          id: 'personal', name: 'Claude login', sub: L.login.present ? 'Not saved yet — save it to see its usage' : 'Signed in with claude auth login',
          active: cur === 'personal',
          switchBtn: cur === 'pool' ? sw('personal', 'your personal account') : '',
          actions: L.login.present ? `<button class="linkbtn" type="button" ${k('capture')} ${busy ? 'disabled' : ''}>Save</button>` : '',
        });
      }
      const onWork = !!L.network?.current.work;
      for (const a of L.accounts) {
        const plan = PLAN[a.subscriptionType] || a.subscriptionType || '';
        const banned = onWork && a.quarantine;
        const name = a.email || a.label;
        rows += rowHTML({
          id: a.id, name: a.label, tip: a.email && a.email !== a.label ? `${a.label} (${a.email})` : name, plan, active: cur === a.id, usage: true, edit: editHTML(a), quarantine: a.quarantine, lowPriority: a.lowPriority, menu: true,
          switchBtn: cur === a.id || banned ? '' : sw(a.id, a.label),
          sub: banned ? 'Not on the work Wi-Fi' : '',
        });
      }
    }
    const info = A.addInfo;
    // Gemini group (after Claude's): only when the server reports the provider.
    const G = L?.byProvider?.gemini, gem = G ? G.accounts || [] : [];
    const gemOff = A.providers?.find(x => x.id === 'gemini');
    const gemHint = gemOff && !gemOff.available ? esc(!gemOff.why || /not found/i.test(gemOff.why) ? GEMINI_HINT : gemOff.why) : '';
    let gemRows = '';
    for (const a of gem) {
      const gname = a.email && a.email !== a.label ? `${a.label} (${a.email})` : a.label;
      const gu = A.usage.get(a.id), ex = extraTip(gu), gact = !!(a.signedIn || G.active === a.id);
      gemRows += rowHTML({ id: a.id, name: a.label, tip: ex ? `${gname}\n${ex}` : gname, active: gact, usage: true, edit: editHTML(a), quarantine: a.quarantine, lowPriority: a.lowPriority, menu: true });
    }
    const gemAdding = L?.adding && A.addProvider === 'gemini';
    const gemAdd = gemAdding
      ? `<div class="acct-add" role="group" aria-labelledby="acct-gadd-h"><p id="acct-gadd-h"><b>Add Gemini account · step 2 of 2</b></p>
          <p>${info?.opened ? `A ${esc(termName() || 'terminal')} window is running <code>agy</code>.` : `Run <code>agy</code> in a terminal${info?.error ? ` (${esc(info.error)})` : ''}.`} ${GEMINI_SIGNIN} Then come back.</p>
          <label class="acct-field" for="acct-add-label">Name (optional)</label>
          <input id="acct-add-label" maxlength="60" autocomplete="off" spellcheck="false" placeholder="Google account" value="${esc(A.addLabel)}" data-key="add-label">
          <div class="acts"><button class="primary" type="button" ${k('finish')} ${A.working ? 'disabled' : ''}>${A.working === 'finish' ? 'Saving…' : "I've signed in"}</button>
          <button class="ghost" type="button" ${k('add-cancel')} ${A.working ? 'disabled' : ''}>Cancel</button></div></div>`
      : '';
    const addDis = busy || !L || L?.adding ? 'disabled aria-disabled="true"' : '';
    const gemBody = gemRows ? `<ul class="acct-rows" aria-label="Gemini accounts">${gemRows}</ul>`
      : `<p class="acct-empty">Not signed in · <button class="linkbtn" type="button" ${k('add-gemini')} ${addDis}>Add</button></p>${gemHint ? `<p class="acct-note acct-hint">${gemHint}</p>` : ''}`;
    const gemSection = G ? sectionHTML('gemini', `Gemini (Antigravity) · ${gem.length}`, G.exhausted ? 'out until ' + esc(new Date(G.exhausted.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : '', gemBody) : '';
    const relogin = A.reloginId ? accountOf(A.reloginId) : null;
    const add = L?.adding && A.addProvider !== 'gemini'
      ? `<div class="acct-add" role="group" aria-labelledby="acct-add-h"><p id="acct-add-h"><b>${relogin ? `Sign in as ${esc(relogin.email || relogin.label)} · step 2 of 2` : 'Add account · step 2 of 2'}</b></p>
          <p>${info?.opened ? `A ${esc(termName() || 'terminal')} window is running <code>${LOGIN}</code>.` : `Run <code>${LOGIN}</code> in a terminal${info?.error ? ` (${esc(info.error)})` : ''}.`}
          ${relogin ? `Sign in as ${esc(relogin.email || relogin.label)} in your browser (sign out of claude.ai there first if it picks another account), then come back. Its saved login is renewed; what's running doesn't change.` : 'Sign in with the other account in your browser (sign out of claude.ai there first if it picks the current one), then come back.'}</p>
          ${info?.opened ? '' : `<div class="acts"><button class="ghost" type="button" data-copy="${LOGIN}" data-key="copy-login">Copy</button></div>`}
          ${relogin ? '' : `<label class="acct-field" for="acct-add-label">Name (optional)</label>
          <input id="acct-add-label" maxlength="60" autocomplete="off" spellcheck="false" placeholder="e.g. Work" value="${esc(A.addLabel)}" data-key="add-label">`}
          <div class="acts"><button class="primary" type="button" ${k('finish')} ${A.working ? 'disabled' : ''}>${A.working === 'finish' ? 'Saving…' : "I've logged in"}</button>
          <button class="ghost" type="button" ${k('add-cancel')} ${A.working ? 'disabled' : ''}>Cancel</button></div></div>`
      : '';
    const claudeBody = rows ? `<ul class="acct-rows" aria-labelledby="acct-menu-h">${rows}</ul>`
      : `<p class="acct-empty">Not signed in · <button class="linkbtn" type="button" ${k('add')} ${addDis}>Add</button></p>`;
    const pause = pauseToggleHTML();
    const foot = `<div class="acct-foot">
        <button class="ghost sm" type="button" ${k('add')} ${addDis} aria-label="Add account (Claude)" title="Sign in to another Claude account in a terminal. What's running doesn't change.">${A.working === 'add' && A.addProvider !== 'gemini' ? 'Opening…' : '+ Claude'}</button>
        ${G ? `<button class="ghost sm" type="button" ${k('add-gemini')} ${addDis} aria-label="${gem.length ? 'Sign in to Gemini again' : 'Add Gemini account'}" title="Opens agy in a terminal. ${esc(GEMINI_SIGNIN)} One Google account for now.">${A.working === 'add' && A.addProvider === 'gemini' ? 'Opening…' : '+ Gemini'}</button>` : ''}
        <button class="ghost sm acct-ovf" type="button" ${k('toggle-more')} aria-expanded="${A.footMore}" aria-label="More account settings" title="More settings">⋯</button></div>
      ${A.footMore ? `<div class="acct-ovf-panel">${pause || '<p class="acct-note">No more settings available.</p>'}</div>` : ''}`;
    return `<div class="acctmenu">
      <div class="acct-head"><h4 id="acct-menu-h">Accounts</h4><button class="linkbtn" type="button" ${k('refresh')} ${A.usageBusy ? 'disabled aria-busy="true"' : ''} aria-label="Refresh usage">${A.usageBusy ? 'Checking…' : '↻ Refresh'}</button></div>
      ${L?.network ? networkHTML(L.network, busy) : ''}
      ${L?.network?.current.work && accountOf(cur)?.quarantine ? `<p class="acct-warn" role="alert"><b>${esc(nameOf(cur))} is a quarantine account and you're on the work Wi-Fi.</b> No regular account has room to switch to. Switch to one as soon as it frees up, or add one.</p>` : ''}
      ${headroomHTML()}
      ${L ? sectionHTML('claude', `Claude · ${L.accounts.length}`, '', claudeBody) : `<p class="helper">${esc(A.listErr || 'Loading…')}</p>`}
      ${A.view === 'busy' ? `<button class="ghost" type="button" ${k('show')}>Switching… show progress</button>` : ''}
      ${gemSection}
      ${handoffsHTML(A.handoffs, { busy, open: A.hoOpen })}
      ${add}${gemAdding ? gemAdd : ''}
      ${foot}
      <p class="err" role="alert" ${A.menuErr ? '' : 'hidden'}>${esc(A.menuErr)}</p></div>`;
  }
  // Which network this is, and the one-time "this is the work Wi-Fi" mark (server/network.mjs).
  function networkHTML(n, busy) {
    const c = n.current, dis = busy ? 'disabled' : '';
    const text = !c.id ? 'No network found' : c.work ? '<b>Work Wi-Fi</b> · quarantine accounts are off limits here' : 'Not the work Wi-Fi · quarantine accounts come first';
    const act = !c.id ? '' : c.work
      ? `<button class="linkbtn" type="button" ${k('net-work')} data-work="0" ${dis}>Not the work Wi-Fi</button>`
      : `<button class="linkbtn" type="button" ${k('net-work')} data-work="1" ${dis}>This is the work Wi-Fi</button>`;
    return `<div class="acct-net${c.work ? ' work' : ''}"><span>Network: ${text}</span>${act}</div>`;
  }
  /** Re-render the open menu, keeping keyboard focus on the same control. */
  function renderMenu() {
    if (pop.hidden) return;
    const f = document.activeElement, key = pop.contains(f) ? f.dataset.key : null;
    pop.innerHTML = menuHTML();
    if (key) pop.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }
  /** `quiet`: a background update while the menu is open, with no busy state and no announcement. */
  async function loadUsage(fresh = false, quiet = false) {
    if (!A.list?.accounts.length && !geminiOf().length) return;
    if (!quiet) { A.usageBusy = true; renderMenu(); }
    try {
      const r = await json(`/api/accounts/usage${fresh ? '?fresh=1' : ''}`);
      A.usage = new Map(r.accounts.map(u => [u.id, u]));
    } catch (e) { if (!quiet) A.menuErr = `Couldn't check usage: ${why(e)}`; }
    if (!quiet) A.usageBusy = false;
    label();
    renderMenu();
    if (!quiet) say(fresh ? 'Usage updated' : '');
  }
  /**
   * main.js calls this as the menu opens: show what we have, then refresh the list and usage, and
   * keep refreshing while it stays open (the server caches usage for a minute, so this is cheap).
   */
  let live = 0;
  function fillMenu(el) {
    A.menuErr = '';
    el.innerHTML = menuHTML();
    loadList().then(() => { renderMenu(); return loadUsage(false); });
    clearInterval(live);
    live = setInterval(() => {
      if (pop.hidden) return clearInterval(live);
      if (!A.working && !A.edit && !A.usageBusy && !document.hidden) loadList().then(() => { renderMenu(); return loadUsage(false, true); });
    }, 15000);
  }
  // An automatic switch (or its Undo) changed the account: update the top bar and the menu.
  addEventListener('va:account-changed', () => loadList().then(renderMenu));
  async function act(name, fn, done) {
    A.working = name; A.menuErr = '';
    renderMenu();
    try { await fn(); if (done) say(done); } catch (e) { A.menuErr = `Couldn't ${name === 'add' ? 'start adding' : name === 'add-cancel' ? 'cancel' : name}: ${why(e)}`; say(A.menuErr); }
    A.working = '';
    await loadList();
    renderMenu();
    // Any account the list now shows without usage (e.g. the login just saved by "Add account") gets checked.
    if (A.list?.accounts.some(x => !A.usage.has(x.id))) await loadUsage(false);
  }
  pop.addEventListener('input', e => {
    if (e.target.id === 'acct-add-label') A.addLabel = e.target.value;
    if (e.target.id === 'acct-rename' && A.edit) A.edit.value = e.target.value;
  });
  pop.addEventListener('submit', e => {
    e.preventDefault();
    const id = e.target.dataset.id;
    act('rename', async () => { await send('PATCH', `/api/accounts/${encodeURIComponent(id)}`, { label: A.edit?.value || '' }); A.edit = null; }, 'Renamed');
  });
  pop.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'acct-add-label') { e.preventDefault(); pop.querySelector('[data-am="finish"]')?.click(); }
  });
  pop.addEventListener('click', async e => {
    const t = e.target.closest('[data-am],[data-copy]');
    if (!t || t.disabled) return;
    if (t.dataset.copy != null) return copy(t);
    const id = t.dataset.id;
    switch (t.dataset.am) {
      case 'refresh': return loadUsage(true);
      case 'toggle-sec': A.sec[id] = !A.sec[id]; saveSec(); return renderMenu();
      case 'toggle-more': A.footMore = !A.footMore; return renderMenu();
      case 'toggle-handoffs': A.hoOpen = !A.hoOpen; return renderMenu();
      case 'switch': app.closePops(); return openSheet(id);
      case 'show': app.closePops(); sheet.showModal(); return focusTitle();
      case 'capture': return act('save', () => send('POST', '/api/accounts/capture', {}), 'Login saved').then(() => loadUsage(false));
      case 'add-gemini': return act('add', async () => {
        // Another sign-in started under 10 min ago: offer "Start over" (force is honoured only with the UI header).
        try { A.addInfo = await send('POST', '/api/accounts/add/start', { provider: 'gemini' }); } catch (e) {
          if (e.code !== 'add_in_progress' || !window.confirm(`${e.message}\n\nStart over? The sign-in in progress will be discarded.`)) throw e;
          A.addInfo = await json('/api/accounts/add/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentville-ui': '1' }, body: JSON.stringify({ provider: 'gemini', force: true }) });
        }
        A.addLabel = ''; A.reloginId = ''; A.addProvider = 'gemini';
      }, 'Step 2: sign in in the browser, paste the code into the terminal, then choose I\'ve signed in')
        .then(() => pop.querySelector('#acct-add-label')?.focus());
      case 'add': return act('add', async () => { A.addProvider = 'claude'; A.addInfo = await send('POST', '/api/accounts/add/start'); A.addLabel = ''; A.reloginId = ''; }, 'Step 2: sign in, then choose I\'ve logged in')
        .then(() => pop.querySelector('#acct-add-label')?.focus());
      case 'finish': return act('finish', async () => {
        const r = await send('POST', '/api/accounts/add/finish', { label: A.addLabel.trim(), ...(A.addProvider === 'gemini' ? { provider: 'gemini' } : {}) });
        A.addInfo = null; A.addLabel = ''; A.addProvider = 'claude';
        say(A.reloginId === r.account.id ? `Signed in again as ${r.account.label}` : `Added ${r.account.label}`);
        A.reloginId = '';
      }).then(() => { pop.querySelector('[data-am="add"]')?.focus(); return loadUsage(false); });
      case 'relogin': return act('add', async () => { A.addProvider = 'claude'; A.addInfo = await send('POST', '/api/accounts/add/start'); A.addLabel = ''; A.reloginId = id; }, 'Step 2: sign in again, then choose I\'ve logged in')
        .then(() => pop.querySelector('[data-am="finish"]')?.focus());
      case 'add-cancel': return act('add-cancel', async () => { await send('POST', '/api/accounts/add/cancel', A.addProvider === 'gemini' ? { provider: 'gemini' } : undefined); A.addInfo = null; A.reloginId = ''; A.addProvider = 'claude'; }, 'Adding cancelled')
        .then(() => pop.querySelector('[data-am="add"]')?.focus());
      case 'handoff-undo': case 'handoff-retry': case 'handoff-dismiss': case 'handoff-approve': {
        const hact = t.dataset.am.slice(8);
        if (hact === 'undo' && !confirm('Stop the new agent and resume the old one? Files are never reverted.')) return;
        return act('update', () => handoffAction(fetch, id, hact), `Handoff ${hact} sent`).then(() => loadList().then(renderMenu));
      }
      case 'net-work': {
        const work = t.dataset.work === '1';
        return act('mark the network', () => send('POST', '/api/network/work', { work }), work ? 'Marked as the work Wi-Fi' : 'No longer marked as the work Wi-Fi')
          .then(() => pop.querySelector('[data-am="net-work"]')?.focus());
      }
      case 'remove-confirm': return act('remove', async () => { await send('DELETE', `/api/accounts/${encodeURIComponent(id)}`); A.edit = null; A.usage.delete(id); }, 'Account removed')
        .then(() => pop.querySelector('[data-am="refresh"]')?.focus());
    }
  });
  // A click (or Enter/Space) on a non-active row runs the row's Switch button: same handler, same confirmation.
  const rowSwitch = e => {
    const row = e.target.closest?.('.acct-row.sw');
    if (!row || e.target.closest('button, a, input, textarea, form')) return null;
    return row.querySelector('.acct-sw:not([disabled])');
  };
  pop.addEventListener('click', e => rowSwitch(e)?.click());
  pop.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.acct-row.sw')) { e.preventDefault(); rowSwitch(e)?.click(); }
  });
  // ---------- the row menu (right-click, ContextMenu key, Shift+F10, or the row's "⋯") ----------
  const focusRow = id => (pop.querySelector(`[data-key="more:${CSS.escape(id)}"]`) || pop.querySelector(`.acct-row[data-row="${CSS.escape(id)}"]`))?.focus();
  const rowMenu = createAccountMenu(pop, {
    accountOf,
    pick(action, id) {
      const a = accountOf(id);
      if (!a) return;
      switch (action) {
        case 'rename': A.edit = { id, mode: 'rename', value: a.label || '' }; renderMenu(); return pop.querySelector('#acct-rename')?.select();
        case 'remove': A.edit = { id, mode: 'remove' }; renderMenu(); return pop.querySelector('[data-am="remove-confirm"]')?.focus();
        case 'quarantine': {
          const q = !a.quarantine;
          return act('update', () => patchAccount(fetch, id, { quarantine: q }), `${a.label} is now a ${q ? 'quarantine' : 'regular'} account`).then(() => focusRow(id));
        }
        case 'lowpriority': {
          const lp = !a.lowPriority;
          return act('update', () => patchAccount(fetch, id, { lowPriority: lp }), `${a.label} is now ${lp ? 'low' : 'regular'} priority`).then(() => focusRow(id));
        }
      }
    },
  });
  // The row menu belongs to the open Account menu: closing one closes the other.
  new MutationObserver(() => { if (pop.hidden) rowMenu.close(); }).observe(pop, { attributes: true, attributeFilter: ['hidden'] });

  async function copy(t) {
    let ok = true;
    try { await navigator.clipboard.writeText(t.dataset.copy); } catch { ok = false; }
    t.textContent = ok ? 'Copied' : "Couldn't copy";
    say(t.textContent);
    setTimeout(() => { if (t.isConnected) t.textContent = 'Copy'; }, 1500);
  }

  // ---------- switch sheet ----------
  sheet.addEventListener('close', () => { if (btn.offsetParent) btn.focus(); });
  async function openSheet(target) {
    Object.assign(A, { target, view: 'loading', error: '', err: '', result: null, undone: null, undoErr: '' });
    render();
    if (!sheet.open) sheet.showModal();
    focusTitle();
    await load();
  }
  async function load() {
    try {
      A.status = await json('/api/account');
      A.view = 'confirm';
    } catch (e) {
      A.view = 'error';
      A.error = e instanceof TypeError ? "The Agentville server isn't reachable." : e.message;
    }
    render();
    if (sheet.open) focusTitle();
  }
  const focusTitle = () => $('acct-title')?.focus();
  const sayIn = text => { const l = $('acct-live'); if (l) l.textContent = text; };

  // Only the legacy "personal" target (Claude's stored login) can be missing a login. Not ready = a
  // hard stop the click explains; 'unknown' (on the pool a personal login can't be seen) is a tip
  // only, because the server's first respawn verifies the account and rolls back.
  const notReady = () => A.target === 'personal' && A.status.profile === 'pool' && A.status.personalReady === false;
  const noStash = () => A.target === 'pool' && !A.status.poolStashed;
  const loginHTML = (tip) => `<div class="acct-login${tip ? ' tip' : ''}" id="acct-login">
      <p>${tip ? "We couldn't confirm a personal login; the first job is a test and everything rolls back if it fails. If you haven't logged in yet, run" : 'One-time setup: run'} <code>${LOGIN}</code> with your personal account, then come back.</p>
      <div class="acts"><button class="ghost" type="button" data-copy="${LOGIN}">Copy</button>${tip ? '' : '<button class="ghost" type="button" data-acct="recheck">I\'ve logged in — check again</button>'}</div></div>`;
  // A stored personal login was found; offer the command to use a different personal account.
  const readyHTML = () => `<div class="acct-login ok" id="acct-login"><p>✓ Personal login found. To use a different personal account first, run <code>${RELOGIN}</code>, or add it from the Account menu.</p>
      <div class="acts"><button class="ghost" type="button" data-copy="${RELOGIN}">Copy</button><button class="ghost" type="button" data-acct="recheck">Check again</button></div></div>`;
  function sessionsHTML(sessions, title) {
    if (!sessions.length) return '';
    return `<section class="manual"><h3>${title} · ${sessions.length}</h3>
      <p class="lede small">Agentville never touches these. Quit each one in its terminal, then reopen it.</p>
      <ul>${sessions.map(s => `<li data-session="${esc(s.id)}"><b>${esc(s.name)}</b>${s.note ? ` <span class="dim">· ${esc(s.note)}</span>` : ''}<span class="resume"><code title="${esc(s.resume || s.cwd || '')}">${esc(s.resume || s.cwd || '')}</code>${s.resume ? `<button class="linkbtn inline" type="button" data-copy="${esc(s.resume)}" aria-label="Copy the resume command for ${esc(s.name)}">Copy</button>` : ''}</span>
        <button class="ghost" type="button" data-open-session="${esc(s.id)}">Open in ${esc(termName() || 'a terminal')}</button>
        <p class="err" id="sess-err-${esc(s.id)}" hidden></p></li>`).join('')}</ul></section>`;
  }
  function render() {
    const head = t => `<header><div class="titlerow"><h2 id="acct-title" tabindex="-1">${t}</h2></div>`;
    const live = '<p class="sr" aria-live="polite" id="acct-live"></p>';
    const target = A.target;
    if (A.view === 'loading' || A.view === 'error') {
      sheet.innerHTML = `${head('Switch account')}<p class="lede">${A.view === 'loading' ? 'Checking what a switch would do…' : `Couldn't check: ${esc(A.error)}`}</p></header>
        <footer><button class="ghost" type="button" data-acct="close">Cancel</button>${A.view === 'error' ? '<button class="primary" type="button" data-acct="reload">Try again</button>' : ''}</footer>${live}`;
      return;
    }
    const s = A.status, jobs = s.plan?.jobs || [], sessions = s.plan?.sessions || [];
    if (A.view === 'confirm' || A.view === 'busy') {
      const busy = A.view === 'busy';
      if (s.blocked) {
        sheet.innerHTML = `${head('Switch account')}<p class="lede">${esc(s.blocked)}.</p></header><footer><button class="primary" type="button" data-acct="close">Close</button></footer>${live}`;
        return;
      }
      const personal = target === 'personal' && s.profile === 'pool';
      const swapsLogin = target !== 'pool' && target !== 'personal';
      sheet.innerHTML = `${head(`Switch to ${esc(longOf(target))}`)}
          <p class="lede">You're on ${esc(longOf(current() || s.profile))}. Here is exactly what will happen.</p>
          ${notReady() ? loginHTML(false) : personal && s.personalReady === 'unknown' ? loginHTML(true) : personal && s.personalReady === true ? readyHTML() : ''}
          ${swapsLogin ? `<p class="lede small">Claude Code's login becomes ${esc(nameOf(target))}. The login it has now is saved first, so you can switch back.</p>` : ''}
          ${noStash() ? '<p class="warnline">There is no saved pool profile to restore.</p>' : ''}
          ${busy ? '<p class="warnline" role="status">Switching now. This can take a few minutes; you can hide this and Agentville tells you when it\'s done.</p>' : ''}
        </header>
        <div class="body">
          <section class="manual"><h3>${plural(jobs.length, 'background job')} restart with full context on ${esc(longOf(target))}</h3>
            ${jobs.length ? `<p class="lede small">One at a time, with <code>claude respawn</code>; each keeps its conversation. If the first one doesn't come back healthy, everything is put back and the rest are left alone.</p>
            <ul>${jobs.map(j => `<li><b>${esc(j.name)}</b><code>${esc(j.id)}${j.live ? '' : ' · not running'}</code></li>`).join('')}</ul>` : `<p class="lede small">No background jobs are running. Only the saved ${swapsLogin ? 'login' : 'settings'} change${swapsLogin ? 's' : ''}.</p>`}</section>
          ${sessionsHTML(sessions, `${plural(sessions.length, 'terminal session')} to resume yourself`)}
        </div>
        <footer><p class="err" id="acct-err" role="alert" ${A.err ? '' : 'hidden'}>${esc(A.err)}</p><span class="spacer"></span>
          <button class="ghost" type="button" data-acct="close">${busy ? 'Hide' : 'Cancel'}</button>
          <button class="primary" type="button" data-acct="switch" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? `Switching… restarting ${plural(jobs.length, 'job')}` : `Switch to ${esc(nameOf(target))}`}</button></footer>
        ${live}`;
      return;
    }
    // results
    const r = A.result, name = id => jobs.find(j => j.id === id)?.name || id;
    const mark = st => (st === 'respawned' ? icon('check') : st === 'failed' ? icon('error') : '<span class="px">–</span>');
    const STATUS_TEXT = { respawned: 'Restarted', failed: 'Failed', unchanged: 'No restart needed', waiting: 'Will restart when idle', pending: 'Still busy — not restarted' };
    const waiting = (A.status?.restarts || []).length;
    const title = A.undone ? `Settings restored: ${nameOf(current() || A.undone.profile)}`
      : r.restored ? 'Nothing changed: the switch was rolled back' : `Now on ${longOf(r.to)}`;
    const lede = A.undone ? "The saved settings and login are back as they were before the switch. Running jobs keep their current account until they restart. Switch again to move them now."
      : r.restored ? `Switched back: ${r.reason || 'the switch could not be completed'}` : `${plural(r.results.filter(x => x.status === 'respawned').length, 'job')} restarted on ${longOf(r.to)}.`;
    sheet.innerHTML = `${head(esc(title))}<p class="lede">${esc(lede)}</p></header>
      <div class="body">
        ${r.verified === false ? `<p class="lede small">Couldn't verify the new login: ${esc(r.note || 'unknown reason')}</p>` : ''}
        ${waiting ? `<p class="lede small">${esc(plural(waiting, 'agent'))} will restart when idle</p>` : ''}
        <section class="manual acct-results"><h3>Background jobs · ${r.results.length}</h3>
          ${r.results.length ? `<ul>${r.results.map(x => `<li class="st-${esc(x.status)}"><b>${mark(x.status)} ${esc(name(x.id))}</b>
            <code>${esc([STATUS_TEXT[x.status] || 'Skipped', x.detail, x.verified && `verified: ${x.verified}`, x.restarted && `then ${x.restarted}`].filter(Boolean).join(' · '))}</code></li>`).join('')}</ul>` : '<p class="lede small">No background jobs were running.</p>'}</section>
        ${A.undone ? '' : sessionsHTML(r.sessions || [], `${plural((r.sessions || []).length, 'terminal session')} to resume yourself`)}
      </div>
      <footer><p class="err" id="acct-undo-err" role="alert" ${A.undoErr ? '' : 'hidden'}>${esc(A.undoErr)}</p><span class="spacer"></span>
        ${r.restored || A.undone ? '' : `<button class="ghost" type="button" data-acct="undo" ${A.undoBusy ? 'disabled aria-busy="true"' : ''}>${A.undoBusy ? 'Undoing…' : 'Undo'}</button>`}
        <button class="primary" type="button" data-acct="close">Done</button></footer>${live}`;
  }

  // ---------- sheet actions ----------
  async function doSwitch() {
    if (notReady() || noStash()) { // the CTA stays live; the click explains what's missing
      A.err = notReady() ? `Log in to your personal account first: run ${LOGIN}, then check again.` : 'There is no saved pool profile to restore.';
      render();
      return (notReady() ? $('acct-login') : $('acct-err'))?.scrollIntoView({ block: 'nearest' });
    }
    A.err = '';
    A.view = 'busy';
    render();
    sayIn(`Switching to ${longOf(A.target)}`);
    try {
      A.result = await send('POST', '/api/account/switch', { to: A.target, confirm: A.status.confirm });
      A.view = 'results';
      await loadList();
      const ok = !A.result.restored;
      if (!sheet.open) app.toast(ok ? `Switched to ${longOf(A.result.to)}` : 'Account switch rolled back: the first job failed', ok ? null : { label: 'Details', run: () => { sheet.showModal(); focusTitle(); } }, 10000);
      json('/api/account').then(st => { A.status = { ...st, plan: A.status.plan }; }).catch(() => {});
      app.refresh();
    } catch (e) {
      A.view = 'confirm';
      A.err = `Couldn't switch: ${why(e)}`;
      if (/expired/i.test(e.message)) { // the plan changed under us: show the new one
        try { A.status = await json('/api/account'); } catch { /* keep the old plan on screen */ }
      }
      if (!sheet.open) app.toast(A.err);
    }
    render();
    if (sheet.open) focusTitle();
    sayIn(A.view === 'results' ? $('acct-title')?.textContent || '' : A.err);
  }
  async function undo() {
    A.undoBusy = true;
    A.undoErr = '';
    render();
    try {
      A.undone = await send('POST', '/api/account/undo', {});
      await loadList();
      app.refresh();
    } catch (e) {
      A.undoErr = `Couldn't undo: ${why(e)}`;
    }
    A.undoBusy = false;
    render();
    focusTitle();
    sayIn(A.undone ? 'Settings restored' : A.undoErr);
  }

  // ---------- sheet events ----------
  sheet.addEventListener('click', async e => {
    const t = e.target.closest('[data-acct],[data-copy],[data-open-session]');
    if (!t) return;
    if (t.dataset.copy != null) return copy(t);
    if (t.dataset.openSession) {
      const id = t.dataset.openSession, err = document.getElementById(`sess-err-${id}`);
      const show = msg => { if (err) { err.textContent = msg; err.hidden = !msg; } };
      // A session still running would get a second process on one conversation: quit it first.
      if (app.S.byId.get(id)?.live) return show('Still running. Quit it in its terminal first, then open it here.');
      return openAgent(id, t, show);
    }
    switch (t.dataset.acct) {
      case 'close': return sheet.close();
      case 'reload': A.view = 'loading'; render(); return load();
      case 'recheck': A.err = ''; return load();
      case 'switch': return doSwitch();
      case 'undo': return undo();
    }
  });

  return { isOpen: () => sheet.open, fillMenu };
}
