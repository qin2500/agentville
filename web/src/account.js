// Accounts: the top-bar menu of the pool and the user's saved Claude accounts (with 5-hour and
// weekly usage), and the switch sheet (server/account.mjs + server/accounts.mjs). The server does
// the work: it swaps Claude's login and/or the pool settings, respawns each running background job
// (the first is a canary that rolls everything back if it fails) and returns per-job results.
// Terminal sessions are never touched: they are listed for the user to reopen. No token or env
// value ever reaches the browser; we only show labels, emails, plans, usage, names and folders.
import { icon, esc } from './ui.js';

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
    list: null, listErr: '', usage: new Map(), usageBusy: false, edit: null, menuErr: '', working: '', addInfo: null, addLabel: '',
    target: null, status: null, view: null, error: '', err: '', result: null, undone: null, undoErr: '', undoBusy: false,
  };
  const say = text => { const l = $('live'); if (l) l.textContent = text; };
  const accountOf = id => A.list?.accounts.find(a => a.id === id);
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
    if (!res.ok) throw Object.assign(new Error(body.error || `Server returned ${res.status}`), { code: body.code, size: body.size, max: body.max });
    return body;
  }
  const send = (method, path, body) => json(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const why = e => (e instanceof TypeError ? "the Agentville server isn't reachable" : e.code === 'too_big' ? tooBigText(e.size, e.max) : e.message);
  const tooBigText = (size, max) => `Can't switch accounts: your Claude login entry is too big (${size ?? '?'} of ${max ?? 4000}). Sign out of MCP servers you don't use to make room.`;
  /** Keychain room: the too-big warning (auto-switch stopped, or a switch refused), or the remaining room once it is under 300 characters. */
  function headroomHTML() {
    const a = A.list?.autoSwitch;
    if (a?.blocked?.reason === 'too_big') return `<p class="acct-warn" role="alert" data-too-big><b>${esc(tooBigText(a.blocked.size, a.blocked.max))}</b></p>`;
    const h = a?.headroom;
    return h && h.left < 300 ? `<p class="acct-note" data-headroom>Login entry room: ${esc(h.left)} characters left (${esc(h.size)} of ${esc(h.max)}).</p>` : '';
  }

  // ---------- top bar ----------
  function label() {
    const cur = current();
    btn.hidden = !cur;
    if (!cur) return;
    const name = nameOf(cur);
    const html = `<span class="acct-k">Account: </span><span class="acct-name">${esc(name)}</span><span class="caret"> ▾</span>`; // the prefix drops on a phone
    if (btn.innerHTML !== html) btn.innerHTML = html;
    btn.setAttribute('aria-label', `Account: ${name}. Switch account`);
  }
  async function loadList() {
    try { A.list = await json('/api/accounts'); A.listErr = ''; } catch (e) { A.listErr = `Couldn't load accounts: ${why(e)}`; }
    // An older server, or accounts unavailable here: fall back to the pool/personal profile.
    if (!A.list) A.status = await json('/api/account').catch(() => A.status);
    label();
  }
  loadList();

  // ---------- menu (in #pop-account, opened and closed by main.js) ----------
  function bar(name, w) {
    if (!w) return `<div class="ubar"><span class="ubar-k">${name}</span><span class="ubar-v">No data</span></div>`;
    if (w.none) return `<div class="ubar"><span class="ubar-k">${name}</span><span class="ubar-v">No limit</span></div>`;
    const used = Math.round(w.used), level = used >= 90 ? 'hi' : used >= 70 ? 'mid' : 'lo';
    const resets = w.resetsAt ? `resets in ${until(w.resetsAt)}` : '';
    return `<div class="ubar ${level}"><span class="ubar-k">${name}</span>
      <span class="ubar-track" role="meter" aria-label="${name} usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}" aria-valuetext="${used}% used${resets ? `, ${resets}` : ''}"><i style="width:${used}%"></i></span>
      <span class="ubar-v num">${used}%${resets ? ` · ${resets}` : ''}</span></div>`;
  }
  const ago = at => { const m = Math.max(0, Math.round((Date.now() - at) / 60e3)); return m < 1 ? 'just now' : `${m} min ago`; };
  function usageHTML(id) {
    const u = A.usage.get(id);
    if (!u) return `<p class="acct-note">${A.usageBusy ? 'Checking usage…' : 'Usage not checked'}</p>`;
    if (u.error) return `<p class="acct-note bad">${esc(u.error)}</p>`;
    const stale = u.stale ? `<p class="acct-note">As of ${esc(ago(u.asOf))} · ${esc(u.note || 'not refreshed')}</p>` : '';
    return bar('5-hour', u.fiveHour) + bar('Weekly', u.weekly) + stale;
  }
  const k = (act, id = '') => `data-am="${act}" data-id="${esc(id)}" data-key="${act}:${esc(id)}"`;
  function rowHTML({ id, name, sub, active, actions, usage, edit, quarantine }) {
    return `<li class="acct-row${active ? ' on' : ''}" data-row="${esc(id)}">
      <div class="acct-main"><b>${esc(name)}</b>${active ? '<span class="acct-badge">Active</span>' : ''}${quarantine ? '<span class="acct-badge q" title="Never used on the work Wi-Fi; preferred everywhere else">Quarantine</span>' : ''}${sub ? `<span class="acct-sub">${esc(sub)}</span>` : ''}</div>
      ${usage ? `<div class="acct-usage" data-usage="${esc(id)}">${usageHTML(id)}</div>` : ''}
      ${edit || (actions ? `<div class="acct-acts">${actions}</div>` : '')}</li>`;
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
  function menuHTML() {
    const L = A.list, cur = current(), busy = A.view === 'busy' || !!A.working;
    const sw = (to, name) => `<button class="ghost" type="button" ${k('switch', to)} ${busy ? 'disabled' : ''} aria-label="Switch to ${esc(name)}">Switch</button>`;
    let rows = '';
    if (L) {
      // The pool only shows while it is set up (or running).
      if (L.pool.available || cur === 'pool') rows += rowHTML({ id: 'pool', name: 'Pool', sub: 'Shared gateway', active: cur === 'pool', actions: cur !== 'pool' && L.pool.available ? sw('pool', 'the pool') : '' });
      // Claude's stored login when it isn't a saved account yet: switch to it as "personal", or save it.
      if (!L.login.id && (L.login.present || cur === 'pool' || cur === 'personal')) {
        rows += rowHTML({
          id: 'personal', name: 'Claude login', sub: L.login.present ? 'Not saved yet — save it to see its usage' : 'Signed in with claude auth login',
          active: cur === 'personal',
          actions: (cur === 'pool' ? sw('personal', 'your personal account') : '') + (L.login.present ? `<button class="ghost" type="button" ${k('capture')} ${busy ? 'disabled' : ''}>Save</button>` : ''),
        });
      }
      const onWork = !!L.network?.current.work;
      for (const a of L.accounts) {
        const plan = PLAN[a.subscriptionType] || a.subscriptionType || '';
        const banned = onWork && a.quarantine;
        rows += rowHTML({
          id: a.id, name: a.label, sub: [a.email !== a.label && a.email, plan].filter(Boolean).join(' · '), active: cur === a.id, usage: true, edit: editHTML(a), quarantine: a.quarantine,
          actions: (cur === a.id ? '' : banned ? '<span class="acct-note">Not on the work Wi-Fi</span>' : sw(a.id, a.label)) +
            `<button class="linkbtn" type="button" ${k('quarantine', a.id)} aria-label="${a.quarantine ? `Make ${esc(a.label)} a regular account` : `Make ${esc(a.label)} a quarantine account`}">${a.quarantine ? 'Make regular' : 'Quarantine'}</button>` +
            `<button class="linkbtn" type="button" ${k('rename', a.id)} aria-label="Rename ${esc(a.label)}">Rename</button>` +
            (a.signedIn ? '' : `<button class="linkbtn" type="button" ${k('remove', a.id)} aria-label="Remove ${esc(a.label)}">Remove</button>`),
        });
      }
    }
    const info = A.addInfo;
    const add = L?.adding
      ? `<div class="acct-add" role="group" aria-labelledby="acct-add-h"><p id="acct-add-h"><b>Add account · step 2 of 2</b></p>
          <p>${info?.opened ? `A ${esc(termName() || 'terminal')} window is running <code>${LOGIN}</code>.` : `Run <code>${LOGIN}</code> in a terminal${info?.error ? ` (${esc(info.error)})` : ''}.`}
          Sign in with the other account in your browser (sign out of claude.ai there first if it picks the current one), then come back.</p>
          ${info?.opened ? '' : `<div class="acts"><button class="ghost" type="button" data-copy="${LOGIN}" data-key="copy-login">Copy</button></div>`}
          <label class="acct-field" for="acct-add-label">Name (optional)</label>
          <input id="acct-add-label" maxlength="60" autocomplete="off" spellcheck="false" placeholder="e.g. Work" value="${esc(A.addLabel)}" data-key="add-label">
          <div class="acts"><button class="primary" type="button" ${k('finish')} ${A.working ? 'disabled' : ''}>${A.working === 'finish' ? 'Saving…' : "I've logged in"}</button>
          <button class="ghost" type="button" ${k('add-cancel')} ${A.working ? 'disabled' : ''}>Cancel</button></div></div>`
      : `<button class="menuitem" type="button" ${k('add')} ${busy || !L ? 'disabled aria-disabled="true"' : ''}><b>${A.working === 'add' ? 'Opening a terminal…' : 'Add account…'}</b><span>Sign in to another Claude account in a terminal. What's running doesn't change.</span></button>`;
    return `<div class="acctmenu">
      <div class="acct-head"><h4 id="acct-menu-h">Accounts</h4><button class="linkbtn" type="button" ${k('refresh')} ${A.usageBusy ? 'disabled aria-busy="true"' : ''} aria-label="Refresh usage">${A.usageBusy ? 'Checking…' : '↻ Refresh'}</button></div>
      ${L?.network ? networkHTML(L.network, busy) : ''}
      ${L?.network?.current.work && accountOf(cur)?.quarantine ? `<p class="acct-warn" role="alert"><b>${esc(nameOf(cur))} is a quarantine account and you're on the work Wi-Fi.</b> No regular account has room to switch to. Switch to one as soon as it frees up, or add one.</p>` : ''}
      ${headroomHTML()}
      ${L ? `<ul class="acct-rows" aria-labelledby="acct-menu-h">${rows}</ul>` : `<p class="helper">${esc(A.listErr || 'Loading…')}</p>`}
      ${A.view === 'busy' ? `<button class="ghost" type="button" ${k('show')}>Switching… show progress</button>` : ''}
      <hr>${add}
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
    if (!A.list?.accounts.length) return;
    if (!quiet) { A.usageBusy = true; renderMenu(); }
    try {
      const r = await json(`/api/accounts/usage${fresh ? '?fresh=1' : ''}`);
      A.usage = new Map(r.accounts.map(u => [u.id, u]));
    } catch (e) { if (!quiet) A.menuErr = `Couldn't check usage: ${why(e)}`; }
    if (!quiet) A.usageBusy = false;
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
      case 'switch': app.closePops(); return openSheet(id);
      case 'show': app.closePops(); sheet.showModal(); return focusTitle();
      case 'capture': return act('save', () => send('POST', '/api/accounts/capture', {}), 'Login saved').then(() => loadUsage(false));
      case 'add': return act('add', async () => { A.addInfo = await send('POST', '/api/accounts/add/start'); A.addLabel = ''; }, 'Step 2: sign in, then choose I\'ve logged in')
        .then(() => pop.querySelector('#acct-add-label')?.focus());
      case 'finish': return act('finish', async () => {
        const r = await send('POST', '/api/accounts/add/finish', { label: A.addLabel.trim() });
        A.addInfo = null; A.addLabel = '';
        say(`Added ${r.account.label}`);
      }).then(() => { pop.querySelector('[data-am="add"]')?.focus(); return loadUsage(false); });
      case 'add-cancel': return act('add-cancel', async () => { await send('POST', '/api/accounts/add/cancel'); A.addInfo = null; }, 'Adding cancelled')
        .then(() => pop.querySelector('[data-am="add"]')?.focus());
      case 'rename': A.edit = { id, mode: 'rename', value: accountOf(id)?.label || '' }; renderMenu(); return pop.querySelector('#acct-rename')?.select();
      case 'quarantine': {
        const q = !accountOf(id)?.quarantine;
        return act('update', () => send('PATCH', `/api/accounts/${encodeURIComponent(id)}`, { quarantine: q }), `${accountOf(id)?.label} is now a ${q ? 'quarantine' : 'regular'} account`)
          .then(() => pop.querySelector(`[data-am="quarantine"][data-id="${CSS.escape(id)}"]`)?.focus());
      }
      case 'net-work': {
        const work = t.dataset.work === '1';
        return act('mark the network', () => send('POST', '/api/network/work', { work }), work ? 'Marked as the work Wi-Fi' : 'No longer marked as the work Wi-Fi')
          .then(() => pop.querySelector('[data-am="net-work"]')?.focus());
      }
      case 'remove': A.edit = { id, mode: 'remove' }; renderMenu(); return pop.querySelector('[data-am="remove-confirm"]')?.focus();
      case 'edit-cancel': A.edit = null; renderMenu(); return pop.querySelector(`[data-am="rename"][data-id="${CSS.escape(id)}"]`)?.focus();
      case 'remove-confirm': return act('remove', async () => { await send('DELETE', `/api/accounts/${encodeURIComponent(id)}`); A.edit = null; A.usage.delete(id); }, 'Account removed')
        .then(() => pop.querySelector('[data-am="refresh"]')?.focus());
    }
  });
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
