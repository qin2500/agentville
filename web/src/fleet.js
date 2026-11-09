// Fleet actions (README "Fleet actions (experimental)"). The server composes one message
// per target; on the user's confirm it sends them straight into live Claude sessions' inboxes. Agentville
// never runs a command. A sent prep marks its recipients paused, which drives the after-reboot strip.
import { ROLE_NAME, icon, esc, clock } from './ui.js';
import { createRestore } from './restore.js';

const README = 'https://github.com/qin2500/agentville#fleet-actions-experimental';
const ACTIONS = {
  offline: { title: 'Prep for internet loss', menu: 'Agents commit WIP locally, write a resume note and pause network work.', short: 'internet-loss prep', since: 'You prepped for internet loss', done: 'paused' },
  reboot: { title: 'Prep for laptop reboot', menu: 'Same, plus stop background processes and record how to restart them.', short: 'reboot prep', since: 'You prepped for a reboot', done: 'paused' },
  resume: { title: 'Resume', menu: 'Agents pick up from their notes.', short: 'resume', done: 'resumed' },
  continue: { title: 'Continue stuck agents', menu: 'Send "continue" to agents showing an error or restarted mid-task.', short: 'continue', done: 'sent' },
};
const MENU = ['offline', 'reboot', 'resume', 'continue'];
const LEDE = "Sends straight into each selected agent's session. Agents you can't reach are listed with the reason.";
const STATUS = { delivered: 'Delivered', 'sent-unconfirmed': 'Sent, unconfirmed', failed: 'Failed', skipped: 'Skipped' };
function since(ms) {
  const m = Math.floor(Math.max(0, ms) / 60e3);
  return m < 1 ? 'moments ago' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} hr ago` : `${Math.floor(m / 1440)} days ago`;
}
const agents = n => `${n} agent${n === 1 ? '' : 's'}`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* not persisted */ } },
};

export function createFleet(app) {
  const { S } = app;
  const $ = id => document.getElementById(id);
  const sheet = $('sheet'), btn = $('btn-fleet'), nudge = $('nudge');
  // view: loading | error | confirm | marked | commands
  const F = { action: null, view: null, preview: null, checked: new Set(), copied: new Set(), text: '', err: {}, error: '', marked: null, busy: false };
  const fleet = () => S.data?.fleet || {};
  const pending = () => fleet().pending || null;
  const restore = createRestore(app, sheet);

  // ---------- top bar + after-prep strip ----------
  let onlineAt = 0;
  addEventListener('online', () => { onlineAt = Date.now(); update(); });
  function update() {
    btn.hidden = !S.data?.fleet; // the server advertises fleet support with a `fleet` block
    const p = pending();
    if (btn.hidden) { $('app').classList.remove('nudged'); nudge.hidden = true; return; }
    const html = p ? `<span class="w">${icon('waiting')}</span> Fleet<span class="fl-p"> · Paused</span><span class="caret"> ▾</span>` : 'Fleet<span class="caret"> ▾</span>';
    if (btn.innerHTML !== html) btn.innerHTML = html;
    btn.setAttribute('aria-label', p ? 'Fleet actions, paused' : 'Fleet actions');
    const dismissed = p && store.get('va.fleet.nudge') === String(p.at);
    const due = p && (p.kind === 'reboot' ? p.rebootDetected : (onlineAt > p.at || Date.now() - p.at > 120e3));
    const show = !!(p && due && !dismissed);
    // After a crash, the restore notice takes the strip when no prep is waiting to be resumed.
    const rn = show ? '' : restore.noticeHTML();
    $('app').classList.toggle('nudged', show || !!rn);
    nudge.hidden = !(show || rn);
    if (rn) {
      const html = `${icon('waiting')}${rn}`;
      if (nudge.dataset.text !== html) { nudge.dataset.text = html; nudge.innerHTML = html; }
      return;
    }
    if (show) {
      const n = p.ids?.length || 0;
      const text = `${ACTIONS[p.kind]?.since || 'You prepped'} ${since(Date.now() - p.at)}. ${agents(n)} ${n === 1 ? 'is' : 'are'} paused.`;
      if (nudge.dataset.text !== text) {
        nudge.dataset.text = text;
        nudge.innerHTML = `${icon('waiting')}<span>${esc(text)}</span><button class="primary" type="button" data-fleet="resume">Resume…</button><button class="ghost" type="button" data-fleet-act="notnow">Not now</button>`;
      }
    }
  }

  // ---------- menu (rendered into the shared .pop by main.js) ----------
  function menuHTML() {
    const p = pending(), last = fleet().last;
    const errors = S.data?.counts?.continuable ?? S.data?.counts?.errors ?? 0;
    const item = k => {
      const none = k === 'continue' && !errors;
      // Resume names the prep it undoes, when there is one.
      const promo = k === 'resume' && p;
      const line = none ? 'No agents are erroring or waiting after a restart' : k === 'continue' ? `Send "continue" to ${agents(errors)} showing an error or restarted mid-task.`
        : promo ? `Tell the ${agents(p.ids?.length || 0)} from your ${ACTIONS[p.kind]?.short || 'prep'} ${since(Date.now() - p.at)} to pick up where they left off.` : ACTIONS[k].menu;
      return `<button class="menuitem${promo ? ' promo' : ''}" type="button" data-fleet="${k}" ${none ? 'disabled aria-disabled="true"' : ''}><b>${ACTIONS[k].title}…</b><span>${esc(line)}</span></button>`;
    };
    let foot = '';
    if (last) foot += `<p class="menunote">Last sent: ${esc(ACTIONS[last.kind]?.short || last.kind)} · ${agents(last.ids?.length || 0)} · ${clock(last.at)}</p>`;
    if (p?.kind === 'reboot') foot += '<button class="linkbtn" type="button" data-fleet="commands">Commands to run after the reboot</button>';
    // With a prep pending, Resume comes first.
    const order = p ? ['resume', ...MENU.filter(k => k !== 'resume')] : MENU;
    // Restore after crash: first while it has agents to bring back, last otherwise.
    const rs = restore.menuItemHTML(), lost = (fleet().restore?.lost || 0) + (fleet().restore?.sessions || 0);
    return (lost ? rs : '') + order.map(item).join('') + (lost ? '' : rs) + (foot ? `<hr>${foot}` : '');
  }

  // ---------- sheet ----------
  let opener = null;
  // Closing (Esc, Cancel, Done) returns focus to what opened the sheet, else the Fleet button.
  sheet.addEventListener('close', () => { (opener?.isConnected && opener.offsetParent ? opener : btn).focus(); opener = null; });
  async function open(action) {
    opener = document.activeElement?.closest?.('#nudge button') || null;
    app.closePops();
    const view = action === 'commands' ? 'commands' : 'confirm';
    if (action === 'commands') action = 'resume';
    Object.assign(F, { action, view: 'loading', preview: null, err: {}, error: '', results: null, busy: false, copied: new Set() });
    F.text = store.get(`va.fleet.${action}`) ?? '';
    render();
    if (!sheet.open) sheet.showModal();
    focusTitle();
    await loadPreview(view);
  }
  let previewSeq = 0;
  async function fetchPreview() {
    const seq = ++previewSeq;
    const res = F.text
      ? await fetch('/api/fleet/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: F.action, text: F.text }) })
      : await fetch(`/api/fleet/preview?action=${encodeURIComponent(F.action)}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
    return seq === previewSeq ? body : null; // a newer edit superseded this one
  }
  async function loadPreview(view) {
    F.reloadView = view;
    try {
      const body = await fetchPreview();
      if (!body) return;
      F.preview = body;
      if (!F.text) F.text = body.template || '';
      // Resume ticks the agents from the last prep; newcomers are listed separately, unticked.
      const p = pending(), prep = F.action === 'resume' && p ? new Set(p.ids || []) : null;
      F.checked = new Set((body.targets || []).filter(t => !t.problem && (!prep || prep.has(t.id))).map(t => t.id));
      F.view = view;
    } catch (e) {
      F.view = 'error';
      F.error = e instanceof TypeError ? "The Agentville server isn't reachable." : e.message;
    }
    render();
    if (sheet.open) focusTitle();
  }
  // Editing the template re-fills every target's message on the server (debounced).
  let editTimer = 0;
  function refill() {
    clearTimeout(editTimer);
    editTimer = setTimeout(async () => {
      try {
        const body = await fetchPreview();
        if (!body || F.view !== 'confirm') return;
        F.preview = body;
        F.copied = new Set(); // the text changed, so earlier copies are stale
        renderTargets();
      } catch (e) { showErr(e instanceof TypeError ? "Couldn't update the messages: server not reachable." : `Couldn't update the messages: ${e.message}`); }
    }, 400);
  }
  const focusTitle = () => $('sheet-title')?.focus();
  // Marking a different kind of prep replaces the pending one (same-kind marks are merged).
  const replaces = () => { const p = pending(); return p && F.action !== 'resume' && p.kind !== F.action ? p : null; };
  const targets = () => F.preview?.targets || [];
  const chosen = () => targets().filter(t => F.checked.has(t.id) && !t.problem);
  function stripHTML() {
    const ts = chosen(), relay = ts.reduce((n, t) => n + (t.relayTo?.length || 0), 0), ex = F.preview?.excluded || {};
    const chip = (n, txt) => (n ? `<span class="fchip num">${n} ${txt}</span>` : '');
    const off = targets().filter(t => t.problem).length;
    return chip(ts.length, ts.length === 1 ? 'agent selected' : 'agents selected') + chip(relay, 'reached through their lead') + chip(off, "can't be reached")
      + chip(ex.resting, 'resting, not included') + chip(ex.hidden, 'hidden, not included') || '<span class="fchip">Nobody selected</span>';
  }
  const markLabel = () => F.action === 'continue' ? `Send "continue" to ${agents(chosen().length)}` : `Send to ${agents(chosen().length)}`;
  // A boss's relay tree from `relayed` (viaId = direct parent): its leads, then each lead's subs.
  function relayList(t) {
    const rel = (F.preview.relayed || []).filter(r => r.rootId === t.id);
    const walk = (via, d) => rel.filter(r => r.viaId === via).flatMap(r => [`<li style="--d:${d}">${esc(r.name)}</li>`, ...walk(r.id, d + 1)]);
    return rel.length ? `<div class="relays"><p>Relays to ${agents(rel.length)}</p><ul>${walk(t.id, 0).join('')}</ul></div>` : '';
  }

  function cardHTML(t) {
    const role = t.role in ROLE_NAME ? t.role : 'solo', cid = `ft-${t.id.replace(/[^a-z0-9_-]/gi, '-')}`;
    const copied = F.copied.has(t.id);
    const res = F.results?.[t.id];
    const on = F.checked.has(t.id) && !t.problem;
    return `<div class="fcard${t.role === 'boss' ? ' boss' : ''}${on ? '' : ' off'}" data-target="${esc(t.id)}">
      <div class="fhead"><input type="checkbox" id="${cid}" data-rcp="${esc(t.id)}" ${on ? 'checked' : ''} ${t.problem || F.view === 'sent' ? 'disabled' : ''} aria-label="Include ${esc(t.name)}">
        <label for="${cid}" class="who"><b>${esc(t.name)}</b><small>${ROLE_NAME[role]} · ${esc(t.project || '')}${t.reason ? ` · ${esc(t.reason)}` : ''}</small></label>
        ${res ? `<span class="fstat ${esc(res.status)}">${esc(STATUS[res.status] || res.status)}${res.detail ? ` · ${esc(res.detail)}` : ''}</span>` : ''}</div>
      ${t.problem ? `<p class="reach">${esc(t.problem)}${t.reach?.command ? ` · <code>${esc(t.reach.command)}</code> <button class="linkbtn" type="button" data-copy="${esc(t.reach.command)}">Copy</button>` : ''}</p>` : ''}
      ${relayList(t)}
      ${F.action === 'continue' ? '' : `<details><summary>Show message</summary><pre class="msg">${esc(t.text)}</pre></details>`}
    </div>`;
  }
  function targetsHTML() {
    const p = pending(), prep = F.action === 'resume' && p ? new Set(p.ids || []) : null;
    const order = { boss: 0, lead: 1 };
    const ts = [...targets()].filter(t => F.view !== 'sent' || F.results?.[t.id]).sort((a, b) => (order[a.role] ?? 2) - (order[b.role] ?? 2)), fresh = prep ? ts.filter(t => !prep.has(t.id)) : [], main = ts.filter(t => !fresh.includes(t));
    if (!ts.length) return `<p class="lede">${F.action === 'continue' ? 'No agents are erroring or waiting after a restart.' : 'No agents are running, so there is nothing to send.'}</p>`;
    return `${main.map(cardHTML).join('')}${fresh.length ? `<h3 style="margin-top:12px">Not in the last prep</h3>${fresh.map(cardHTML).join('')}` : ''}`;
  }
  function commandsHTML() {
    const cmds = F.preview?.commands || [];
    if (!cmds.length) return F.view === 'commands' ? '<p class="lede">No commands to run.</p>' : '';
    const title = F.view === 'commands' || F.action === 'reboot' ? 'After the reboot, run these yourself' : 'Run these yourself';
    cmds.sort((a, b) => (b.id === null) - (a.id === null)); // `claude respawn --all` first
    return `<section class="manual"><h3>${title} · ${cmds.length}</h3><ul>${cmds.map(c => `<li><b>${esc(c.name)}</b><code title="${esc(c.command)}">${esc(c.command)}</code><button class="ghost" type="button" data-copy="${esc(c.command)}">Copy</button></li>`).join('')}</ul>
      <button class="ghost" type="button" data-copy="${esc(cmds.map(c => c.command).join('\n'))}" style="margin-top:8px">Copy all</button></section>`;
  }
  function render() {
    const A = ACTIONS[F.action];
    const exp = `<a class="htag exp" href="${README}" target="_blank" rel="noopener noreferrer">Experimental</a>`;
    const head = t => `<header><div class="titlerow"><h2 id="sheet-title" tabindex="-1">${t}</h2>${exp}</div>`;
    const live = '<p class="sr" aria-live="polite" id="sheet-live"></p>';
    if (F.view === 'loading' || F.view === 'error') {
      sheet.innerHTML = `${head(A.title)}<p class="lede">${F.view === 'loading' ? 'Composing messages…' : `Couldn't compose the messages: ${esc(F.error)}`}</p></header>
        <footer><button class="ghost" type="button" data-fleet-act="close">Cancel</button>${F.view === 'error' ? '<button class="primary" type="button" data-fleet-act="reload">Try again</button>' : ''}</footer>${live}`;
      return;
    }
    if (F.view === 'commands') {
      sheet.innerHTML = `${head('Commands to run after the reboot')}<p class="lede">Agentville never runs these. Paste them into a terminal yourself.</p></header>
        <div class="body">${commandsHTML()}</div><footer><button class="primary" type="button" data-fleet-act="close">Done</button></footer>${live}`;
      return;
    }
    if (F.view === 'sent') {
      const rs = Object.values(F.results || {}), ok = rs.filter(r => r.status === 'delivered').length;
      const unc = rs.filter(r => r.status === 'sent-unconfirmed').length, bad = rs.filter(r => r.status === 'failed').length;
      const after = F.action === 'continue' || F.action === 'resume' ? ''
        : ` They show as Waiting · “${F.action === 'reboot' ? 'Paused for reboot prep' : 'Paused for internet loss'}” once they finish their turn.`;
      sheet.innerHTML = `${head(`${A.title}: sent`)}<p class="lede">${ok} delivered${unc ? `, ${unc} sent but not yet confirmed` : ''}${bad ? `, ${bad} failed` : ''}.${after}</p></header>
        <div class="body"><div id="fleet-targets">${targetsHTML()}</div>${F.action === 'reboot' ? commandsHTML() : ''}</div>
        <footer><button class="primary" type="button" data-fleet-act="close">Done</button></footer>${live}`;
      return;
    }
    const add = F.preview?.addendum || {};
    const blocked = F.preview?.blocked;
    sheet.innerHTML = `${head(A.title)}
        <p class="lede">${blocked ? `Sending isn't available here: ${esc(blocked)}.` : F.action === 'continue' ? 'Sends the word “continue” straight into each agent’s session: ones showing an error, and ones a restart left waiting mid-task.' : LEDE}</p>
        <div class="fchips" id="fleet-strip" aria-live="polite">${stripHTML()}</div>${F.err.none ? '<p class="err" id="err-none">Pick at least one agent.</p>' : ''}
        ${replaces() ? `<p class="warnline" id="fleet-replaces">${icon('waiting')}<span>This replaces your pending ${esc(ACTIONS[replaces().kind]?.short || 'prep')} (${agents(replaces().ids?.length || 0)}, ${clock(replaces().at)}); those agents won't be grouped for Resume.</span></p>` : ''}
      </header>
      <div class="body">
        ${F.action === 'continue' ? '' : `<section><h3><label for="fleet-msg">Message</label></h3>
          <textarea id="fleet-msg" rows="10" spellcheck="false" ${F.err.empty ? 'aria-invalid="true" aria-describedby="err-empty"' : ''}>${esc(F.text)}</textarea>
          ${F.err.empty ? '<p class="err" id="err-empty">The message can\'t be empty.</p>' : ''}
          <div class="under">Filled in per agent: <span class="chip">{name}</span><span class="chip">{notePath}</span><span class="chip">{project}</span><span class="spacer"></span><button class="linkbtn" type="button" data-fleet-act="reset">Reset to default</button></div>
          ${add.boss || add.lead ? `<h3 style="margin-top:12px">Bosses and leads also get</h3>${add.boss ? `<p class="addendum">${esc(add.boss)}</p>` : ''}${add.lead ? `<p class="addendum">${esc(add.lead)}</p>` : ''}` : ''}</section>`}
        <section><div class="secrow"><h3>Recipients</h3></div>
          <div id="fleet-targets">${targetsHTML()}</div></section>
      </div>
      <footer><p class="err" id="fleet-err" role="alert" hidden></p><span class="spacer"></span>
        <button class="ghost" type="button" data-fleet-act="close">Cancel</button><button class="primary" type="button" data-fleet-act="mark" ${F.busy || blocked ? 'disabled' : ''} ${F.busy ? 'aria-busy="true"' : ''}>${F.busy ? 'Sending…' : esc(markLabel())}</button></footer>
      ${live}`;
  }
  function renderTargets() {
    const box = $('fleet-targets');
    if (!box) return;
    const open = new Set([...box.querySelectorAll('details[open]')].map(d => d.closest('[data-target]').dataset.target));
    box.innerHTML = targetsHTML();
    open.forEach(id => box.querySelector(`[data-target="${CSS.escape(id)}"] details`)?.setAttribute('open', ''));
    refreshCounts();
  }
  function refreshCounts() {
    $('fleet-strip') && ($('fleet-strip').innerHTML = stripHTML());
    const b = sheet.querySelector('[data-fleet-act="mark"]');
    if (b && !F.busy) b.textContent = markLabel();
  }
  function showErr(msg) { const p = $('fleet-err'); if (p) { p.textContent = msg; p.hidden = !msg; } }

  // ---------- send ----------
  async function mark() {
    if (F.action !== 'continue') F.text = $('fleet-msg').value;
    F.err = { empty: F.action !== 'continue' && !F.text.trim(), none: chosen().length === 0 };
    if (F.err.empty || F.err.none) { render(); return F.err.empty ? $('fleet-msg').focus() : focusTitle(); }
    F.busy = true;
    render();
    try {
      // The confirm token binds this exact preview (text + recipients); the server sends only to those.
      const res = await fetch('/api/fleet/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: F.action, confirm: F.preview.confirm, ids: chosen().map(t => t.id) }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) { F.busy = false; await loadPreview('confirm'); return showErr('The preview expired, so it was refreshed. Check it and send again.'); }
      if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
      F.results = Object.fromEntries((body.results || []).map(r => [r.id, r]));
      F.view = 'sent';
      F.busy = false;
      render();
      focusTitle();
      const n = (body.results || []).filter(r => r.status === 'delivered' || r.status === 'sent-unconfirmed').length;
      $('sheet-live').textContent = `Sent to ${agents(n)}`;
      app.refresh();
    } catch (e) {
      F.busy = false;
      render();
      showErr(e instanceof TypeError ? "Couldn't send: the Agentville server isn't reachable." : `Couldn't send: ${e.message}`);
    }
  }

  // ---------- events ----------
  document.addEventListener('click', e => {
    const f = e.target.closest('[data-fleet]');
    if (f) return open(f.dataset.fleet);
    if (e.target.closest('[data-fleet-act="notnow"]')) { store.set('va.fleet.nudge', String(pending()?.at)); update(); }
  });
  sheet.addEventListener('click', async e => {
    const t = e.target.closest('[data-fleet-act],[data-copy],[data-copy-msg]');
    if (!t) return;
    if (t.dataset.copy != null) return copy(t, t.dataset.copy);
    if (t.dataset.copyMsg) {
      const tg = targets().find(x => x.id === t.dataset.copyMsg);
      if (tg && await copy(t, tg.text, 'Copied ✓', true)) F.copied.add(tg.id);
      return;
    }
    switch (t.dataset.fleetAct) {
      case 'close': return sheet.close();
      case 'mark': return mark();
      case 'reload': F.view = 'loading'; render(); return loadPreview(F.reloadView || 'confirm');
      case 'copyall': return copy(t, chosen().map(x => `--- ${x.name}${x.reach?.command ? ` (${x.reach.command})` : ''} ---\n${x.text}`).join('\n\n'));
      case 'reset':
        store.set(`va.fleet.${F.action}`, null);
        $('fleet-msg').value = F.preview?.template || '';
        F.text = '';
        refill();
        return $('fleet-msg').focus();
    }
  });
  sheet.addEventListener('change', e => {
    const id = e.target.dataset.rcp;
    if (!id) return;
    e.target.checked ? F.checked.add(id) : F.checked.delete(id);
    e.target.closest('.fcard')?.classList.toggle('off', !e.target.checked);
    F.err.none = false;
    $('err-none')?.remove();
    refreshCounts();
  });
  sheet.addEventListener('input', e => {
    if (e.target.id !== 'fleet-msg') return;
    F.text = e.target.value;
    store.set(`va.fleet.${F.action}`, F.text === F.preview?.template ? null : F.text);
    if (F.err.empty && F.text.trim()) { F.err.empty = false; e.target.removeAttribute('aria-invalid'); $('err-empty')?.remove(); }
    if (F.text.trim()) refill();
  });
  sheet.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.preventDefault(); });
  async function copy(b, text, okLabel = 'Copied', sticky = false) {
    const label = b.textContent;
    let ok = true;
    try { await navigator.clipboard.writeText(text); } catch { ok = false; }
    b.textContent = ok ? okLabel : "Couldn't copy";
    const live = $('sheet-live');
    if (live) live.textContent = ok ? 'Copied' : "Couldn't copy";
    if (!sticky || !ok) setTimeout(() => { if (b.isConnected) b.textContent = label; }, 1500);
    return ok;
  }

  return { update, menuHTML, isOpen: () => sheet.open };
}
