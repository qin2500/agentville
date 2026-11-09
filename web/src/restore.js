// Restore after crash (README "Restore after crash"). After a reboot, the crown agents and the ones
// marked Important that were running before it are listed here; on one confirm the server restarts
// them one at a time and tells each restored crown agent to check its own workers. Interactive
// sessions can't be reopened from a web page: they get a "Copy resume command".
import { ROLE_NAME, esc, clock } from './ui.js';

const STATUS = { restored: 'Restored', running: 'Already running', failed: 'Failed', delivered: 'Message delivered', 'sent-unconfirmed': 'Message sent, unconfirmed', skipped: 'No message' };
const EXCLUDED = { running: 'still running', stopped: 'stopped on purpose', removed: 'removed', 'no-transcript': 'without a saved conversation', 'not-chosen': 'not a crown agent or Important' };
const agents = n => `${n} agent${n === 1 ? '' : 's'}`;
function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60e3);
  return m < 1 ? 'moments ago' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} hr ago` : `${Math.floor(m / 1440)} days ago`;
}
const seenText = t => (t ? `last seen ${clock(t)} · ${ago(Date.now() - t)}` : '');

export function createRestore(app, sheet) {
  const { S } = app;
  const $ = id => document.getElementById(id);
  // view: loading | error | list | confirm | running | done
  const R = { view: null, data: null, checked: new Set(), preview: null, out: null, error: '' };
  const info = () => S.data?.fleet?.restore || null;
  const count = () => { const r = info(); return r ? (r.lost || 0) + (r.sessions || 0) : 0; };

  // ---------- notice (in the shared #nudge strip) + menu entry ----------
  /** The notice's HTML, or '' when there's nothing to say (no reboot, nothing lost, or dismissed). */
  function noticeHTML() {
    const r = info(), n = count();
    if (!r || !n || r.dismissed) return '';
    return `<span>Your Mac restarted — ${esc(agents(n))} ${n === 1 ? 'was' : 'were'} running.</span><button class="primary" type="button" data-restore="open">Restore…</button><button class="ghost" type="button" data-restore="dismiss">Dismiss</button>`;
  }
  function menuItemHTML() {
    const n = count();
    const line = n ? `${agents(n)} that ${n === 1 ? 'was' : 'were'} running before the restart: crown agents and ones you marked Important.` : 'Nothing to restore: no crown or Important agent was lost in a restart.';
    return `<button class="menuitem${n ? ' promo' : ''}" type="button" data-restore="open" ${n ? '' : 'disabled aria-disabled="true"'}><b>Restore after crash…</b><span>${esc(line)}</span></button>`;
  }

  // ---------- sheet ----------
  async function open() {
    app.closePops();
    Object.assign(R, { view: 'loading', data: null, preview: null, out: null, error: '' });
    render();
    if (!sheet.open) sheet.showModal();
    focusTitle();
    try {
      const res = await fetch('/api/restore', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
      R.data = body;
      R.checked = new Set((body.jobs || []).map(j => j.id)); // all checked by default
      R.view = 'list';
    } catch (e) { R.view = 'error'; R.error = e instanceof TypeError ? "The Agentville server isn't reachable." : e.message; }
    render();
    focusTitle();
  }
  const focusTitle = () => $('sheet-title')?.focus();
  const jobs = () => R.data?.jobs || [];
  const chosen = () => jobs().filter(j => R.checked.has(j.id));
  const tag = j => [j.crown ? ROLE_NAME.boss : '', j.important ? '★ Important' : ''].filter(Boolean).join(' · ');

  function jobCard(j) {
    const cid = `rs-${j.id.replace(/[^a-z0-9_-]/gi, '-')}`, on = R.checked.has(j.id);
    const res = R.out?.results?.find(r => r.id === j.id), msg = R.out?.messages?.find(m => m.id === j.id);
    const stat = r => `<span class="fstat ${r.status === 'restored' ? 'delivered' : esc(r.status)}">${esc(STATUS[r.status] || r.status)}${r.detail ? ` · ${esc(r.detail)}` : ''}</span>`;
    return `<div class="fcard${j.crown ? ' boss' : ''}${on || R.out ? '' : ' off'}" data-restore-job="${esc(j.id)}">
      <div class="fhead">${R.view === 'list' ? `<input type="checkbox" id="${cid}" data-restore-pick="${esc(j.id)}" ${on ? 'checked' : ''} aria-label="Restore ${esc(j.name)}">` : ''}
        <label ${R.view === 'list' ? `for="${cid}"` : ''} class="who"><b>${esc(j.name)}</b><small>${esc([tag(j), j.project].filter(Boolean).join(' · '))}</small></label>
        ${res ? stat(res) : ''}</div>
      <p class="reach">${esc(seenText(j.seen))}${res?.via ? ` · via ${res.via === 'respawn' ? '<code>claude respawn</code>' : '<code>claude --bg --resume</code>'}` : ''}</p>
      ${msg ? `<p class="reach">${stat(msg)}</p>` : ''}
    </div>`;
  }
  function sessionsHTML() {
    const ss = R.data?.sessions || [];
    if (!ss.length) return '';
    return `<section class="manual" style="margin-top:12px"><h3>Open in a terminal before the restart · ${ss.length}</h3>
      <p class="lede" style="margin:0 0 4px">These can't be reopened from here. Paste the command into a terminal.</p>
      <ul>${ss.map(s => `<li data-restore-session="${esc(s.id)}"><b>${esc(s.name)}</b><code title="${esc(s.command)}">${esc(s.command)}</code><button class="ghost" type="button" data-rcopy="${esc(s.command)}">Copy resume command</button>
        <small style="grid-column:1;color:var(--text-muted)">${esc([tag(s), s.project, seenText(s.seen)].filter(Boolean).join(' · '))}</small></li>`).join('')}</ul></section>`;
  }
  // Codex threads are listed only: Codex reopens them, so there is no command and nothing to confirm.
  function codexHTML() {
    const cs = R.data?.codex || [];
    if (!cs.length) return '';
    return `<section class="manual" style="margin-top:12px"><h3>Codex threads · ${cs.length}</h3>
      <ul>${cs.map(c => `<li data-restore-codex="${esc(c.id)}"><b>${esc(c.name)}</b><small style="grid-column:1;color:var(--text-muted)">${esc([c.note, tag(c), c.project, seenText(c.seen)].filter(Boolean).join(' · '))}</small></li>`).join('')}</ul></section>`;
  }
  function excludedHTML() {
    const ex = R.data?.excluded || {};
    const parts = Object.entries(ex).filter(([, n]) => n).map(([k, n]) => `${n} ${EXCLUDED[k] || k}`);
    return parts.length ? `<p class="menunote" style="padding:8px 0 0">Not listed: ${esc(parts.join(', '))}.</p>` : '';
  }
  function commandsHTML() {
    const p = R.preview;
    return `<section class="manual"><h3>Runs these, one at a time · ${p.jobs.length}</h3><ul>${p.jobs.map(j => `<li data-restore-cmd="${esc(j.id)}"><b>${esc(j.name)}</b><code title="${esc(j.command)}">${esc(j.command)}</code>
        <small style="grid-column:1/-1;color:var(--text-muted);overflow-wrap:anywhere">If that fails: ${j.fallback.unavailable ? esc(j.fallback.unavailable) : `<code style="white-space:normal">${esc(j.fallback.command)}</code>${j.fallback.envKeys?.length ? `, with its saved provider settings (${esc(j.fallback.envKeys.join(', '))})` : ''}`}</small></li>`).join('')}</ul></section>
      ${p.message ? `<section style="margin-top:12px"><h3>Then sends this to ${esc(p.message.to.map(id => p.jobs.find(j => j.id === id)?.name || id).join(', '))} once back</h3>
        <pre class="msg" style="white-space:pre-wrap;font:12px/1.45 var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:8px;margin:4px 0 0">${esc(p.message.text)}</pre>
        ${p.sendBlocked ? `<p class="warnline" style="margin-top:4px">Sending isn't available here: ${esc(p.sendBlocked)}.</p>` : ''}</section>` : ''}`;
  }
  function render() {
    const head = (t, lede) => `<header><div class="titlerow"><h2 id="sheet-title" tabindex="-1">${t}</h2></div>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
    const live = '<p class="sr" aria-live="polite" id="sheet-live"></p>';
    const title = 'Restore after crash';
    if (R.view === 'loading' || R.view === 'error') {
      sheet.innerHTML = `${head(title, R.view === 'loading' ? 'Looking for agents the restart stopped…' : `Couldn't check: ${esc(R.error)}`)}
        <footer><span class="spacer"></span><button class="ghost" type="button" data-restore-act="close">Cancel</button>${R.view === 'error' ? '<button class="primary" type="button" data-restore="open">Try again</button>' : ''}</footer>${live}`;
      return;
    }
    const d = R.data || {};
    if (R.view === 'list') {
      const none = !jobs().length && !(d.sessions || []).length && !(d.codex || []).length;
      const lede = !d.crashBoot ? 'No restart since the agents were last seen running.'
        : none ? `Your Mac restarted ${esc(ago(Date.now() - d.boot))}. No crown or Important agent needs restoring.`
        : `Your Mac restarted ${esc(ago(Date.now() - d.boot))}. These were running before it: crown agents and the ones you marked Important.${d.blocked ? ` Restoring isn't available here: ${esc(d.blocked)}.` : ''}`;
      const n = chosen().length;
      sheet.innerHTML = `${head(title, lede)}
        <div class="body">${jobs().length ? `<section><h3>Background jobs · ${jobs().length}</h3><div id="restore-jobs">${jobs().map(jobCard).join('')}</div></section>` : ''}
          ${sessionsHTML()}${codexHTML()}${excludedHTML()}</div>
        <footer><p class="err" id="restore-err" role="alert" hidden></p><span class="spacer"></span><button class="ghost" type="button" data-restore-act="close">${jobs().length ? 'Cancel' : 'Done'}</button>
          ${jobs().length ? `<button class="primary" type="button" data-restore-act="review" ${n && !d.blocked ? '' : 'disabled'}>Review ${esc(agents(n))}…</button>` : ''}</footer>${live}`;
      return;
    }
    if (R.view === 'confirm' || R.view === 'running') {
      const busy = R.view === 'running', n = R.preview.jobs.length;
      sheet.innerHTML = `${head(title, busy ? `Restarting ${esc(agents(n))}, one at a time…` : 'Check the commands. Each job is restarted in its own folder; nothing else runs.')}
        <div class="body">${commandsHTML()}</div>
        <footer><p class="err" id="restore-err" role="alert" hidden></p><span class="spacer"></span><button class="ghost" type="button" data-restore-act="back" ${busy ? 'disabled' : ''}>Back</button>
          <button class="primary" type="button" data-restore-act="run" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? 'Restarting…' : `Restart ${esc(agents(n))}`}</button></footer>${live}`;
      return;
    }
    // done
    const rs = R.out?.results || [];
    const c = s => rs.filter(r => r.status === s).length;
    const done = [`${c('restored')} restored`, c('running') && `${c('running')} already running`, c('failed') && `${c('failed')} failed`].filter(Boolean).join(', ');
    const picked = jobs().filter(j => rs.some(r => r.id === j.id));
    sheet.innerHTML = `${head(`${title}: done`, `${esc(done)}.`)}
      <div class="body"><div id="restore-jobs">${picked.map(jobCard).join('')}</div>${sessionsHTML()}</div>
      <footer><span class="spacer"></span><button class="primary" type="button" data-restore-act="close">Done</button></footer>${live}`;
  }
  function showErr(msg) { const p = $('restore-err'); if (p) { p.textContent = msg; p.hidden = !msg; } }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error || `Server returned ${res.status}`), { status: res.status });
    return out;
  }
  async function review() {
    try {
      R.preview = await post('/api/restore/preview', { ids: chosen().map(j => j.id) });
      R.view = 'confirm';
      render();
      focusTitle();
    } catch (e) { showErr(e instanceof TypeError ? "The Agentville server isn't reachable." : e.message); }
  }
  async function run() {
    R.view = 'running';
    render();
    try {
      R.out = await post('/api/restore/run', { confirm: R.preview.confirm });
      R.view = 'done';
      render();
      focusTitle();
      $('sheet-live').textContent = `${R.out.results.filter(r => r.status === 'restored').length} restored`;
      app.refresh();
    } catch (e) {
      R.view = 'confirm';
      render();
      showErr(e.status === 409 ? 'This confirmation expired. Go back and review again.' : e instanceof TypeError ? "The Agentville server isn't reachable." : `Couldn't restore: ${e.message}`);
    }
  }
  async function dismiss() {
    try { await post('/api/restore/dismiss', {}); } catch { /* the notice comes back next scan */ }
    if (S.data?.fleet?.restore) S.data.fleet.restore.dismissed = true;
    app.refresh();
  }

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-restore]');
    if (!t) return;
    if (t.dataset.restore === 'open') return open();
    if (t.dataset.restore === 'dismiss') return dismiss();
  });
  sheet.addEventListener('click', async e => {
    const t = e.target.closest('[data-restore-act],[data-rcopy]');
    if (!t || !(R.view && sheet.querySelector('[data-restore-act]'))) return;
    if (t.dataset.rcopy != null) {
      const label = t.textContent;
      let ok = true;
      try { await navigator.clipboard.writeText(t.dataset.rcopy); } catch { ok = false; }
      t.textContent = ok ? 'Copied' : "Couldn't copy";
      if ($('sheet-live')) $('sheet-live').textContent = t.textContent;
      setTimeout(() => { if (t.isConnected) t.textContent = label; }, 1500);
      return;
    }
    switch (t.dataset.restoreAct) {
      case 'close': return sheet.close();
      case 'review': return review();
      case 'back': R.view = 'list'; render(); return focusTitle();
      case 'run': return run();
    }
  });
  sheet.addEventListener('change', e => {
    const id = e.target.dataset.restorePick;
    if (!id) return;
    e.target.checked ? R.checked.add(id) : R.checked.delete(id);
    e.target.closest('.fcard')?.classList.toggle('off', !e.target.checked);
    const b = sheet.querySelector('[data-restore-act="review"]'), n = chosen().length;
    if (b) { b.textContent = `Review ${agents(n)}…`; b.disabled = !n || !!R.data?.blocked; }
  });
  sheet.addEventListener('close', () => { R.view = null; });

  return { noticeHTML, menuItemHTML, open };
}
