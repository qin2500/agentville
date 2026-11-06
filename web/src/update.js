// Update available: one prompt per new version of Agentville on GitHub, then a quiet Settings item.
// The server does the checking (server/update.mjs); this only asks it, every 15 minutes.
import { esc, store, agoLong } from './ui.js';

const SEEN = 'va.update.seen'; // the latest sha we've already prompted about
const EVERY_MS = 15 * 60e3;
const BACK_MS = 90e3; // how long a restart may take before we say so

export function createUpdate(app) {
  const $ = id => document.getElementById(id);
  const dlg = $('update');
  const U = { info: null, view: 'offer', busy: false, error: '', result: null, timer: 0 };
  let opener = null;

  const available = () => !!(U.info?.enabled && U.info.behindBy > 0 && U.info.latest?.sha);
  const changes = n => `${n} new change${n === 1 ? '' : 's'}`;

  async function load() {
    try {
      const res = await fetch('/api/update', { cache: 'no-store' });
      if (res.ok) U.info = await res.json();
    } catch { /* the main poll reports the server being away */ }
    clearTimeout(U.timer);
    // Until the server's first check is in, look again soon.
    U.timer = setTimeout(load, U.info?.enabled && !U.info.checkedAt ? 20e3 : EVERY_MS);
    maybePrompt();
  }

  /** Once per latest version: shown means seen, so a reload or Later never brings it back. */
  function maybePrompt() {
    if (!available() || store.get(SEEN, null) === U.info.latest.sha) return;
    if (document.querySelector('dialog[open]')) return; // never on top of another sheet; next load tries again
    store.set(SEEN, U.info.latest.sha);
    open();
  }

  function open(from = null) {
    opener = from || document.activeElement;
    Object.assign(U, { view: 'offer', busy: false, error: '', result: null });
    render();
    if (!dlg.open) dlg.showModal();
    $('update-title')?.focus();
  }

  // Esc and Later both close. While an update runs, Esc doesn't hide what's happening.
  dlg.addEventListener('cancel', e => { if (U.busy || U.view === 'restarting') e.preventDefault(); });
  dlg.addEventListener('close', () => {
    const back = opener?.isConnected && opener.offsetParent ? opener : $('btn-settings');
    back?.focus();
    opener = null;
  });

  function changeList() {
    const I = U.info, list = I.changes || [], more = I.behindBy - list.length;
    const now = Date.now();
    return `<ul class="upd-changes">${list.map(c => `<li><span class="upd-title">${esc(c.title || '(no message)')}</span><span class="upd-meta"><code>${esc(c.short)}</code>${c.date ? ` · ${esc(agoLong(now - Date.parse(c.date)))} ago` : ''}</span></li>`).join('')}</ul>${more > 0 ? `<p class="helper">…and ${more} more.</p>` : ''}`;
  }
  const commandsHTML = () => `<pre class="upd-cmd" tabindex="0" aria-label="Commands to update by hand"><code>${(U.info?.commands || []).map(esc).join('\n')}</code></pre>`;
  const termsOpen = () => (app.S.data?.term?.running || []).length;

  function render() {
    const I = U.info || {};
    const head = (t, lede) => `<header><h2 id="update-title" tabindex="-1">${t}</h2>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
    const live = `<p class="sr" aria-live="polite" id="update-live">${U.busy ? 'Updating Agentville…' : ''}</p>`;
    if (U.view === 'restarting') {
      dlg.innerHTML = `${head('Restarting…', 'Agentville is restarting with the update. This page reloads when it’s back.')}${live}`;
      return;
    }
    if (U.view === 'stuck') {
      dlg.innerHTML = `${head('Agentville didn’t come back', 'The update is installed, but the server hasn’t restarted. Start it again with <code>npm start</code> or the Desktop launcher.')}
        <footer><button class="primary" type="button" data-upd="close">Close</button></footer>${live}`;
      return;
    }
    if (U.view === 'done') {
      dlg.innerHTML = `${head('Updated. Restart Agentville to use it.', 'Stop the server (Ctrl-C in its terminal) and run <code>npm start</code> again, or quit and reopen the Desktop launcher.')}
        <footer><button class="primary" type="button" data-upd="close">Done</button></footer>${live}`;
      return;
    }
    const n = I.behindBy || 0;
    const can = !!I.canApply && !U.result?.updated;
    const terms = termsOpen();
    dlg.innerHTML = `${head('Agentville update available', `${changes(n)} on GitHub since your copy (<code>${esc(I.current?.short || '')}</code>).`)}
      <div class="body">
        ${changeList()}
        ${can ? `<p class="helper">Update now downloads the changes, rebuilds and restarts Agentville. Your agents keep running.${terms ? ` The built-in terminal${terms === 1 ? '' : 's'} open here will close.` : ''}</p>`
          : `<div class="upd-manual"><p>${U.result?.updated ? '' : `Agentville can't update itself here: ${esc(I.applyBlocked || 'unknown reason')}`} To update, run this in a terminal, then restart Agentville:</p>${commandsHTML()}</div>`}
        ${U.error ? `<p class="err" role="alert">${esc(U.error)}</p>` : ''}
      </div>
      <footer><span class="spacer"></span>
        <button class="ghost" type="button" data-upd="later" ${U.busy ? 'disabled' : ''}>Later</button>
        ${can ? `<button class="primary" type="button" data-upd="apply" ${U.busy ? 'disabled aria-busy="true"' : ''}>${U.busy ? 'Updating…' : 'Update now'}</button>` : ''}
      </footer>${live}`;
  }

  async function apply() {
    U.busy = true; U.error = '';
    render();
    const startedAt = U.info?.startedAt;
    let out;
    try {
      const res = await fetch('/api/update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      out = await res.json().catch(() => ({ ok: false, error: `Server returned ${res.status}` }));
    } catch {
      out = { ok: false, error: "The Agentville server isn't reachable." };
    }
    U.busy = false;
    if (!out.ok) {
      U.error = `Couldn't update: ${out.error || 'unknown error'}`;
      U.result = out;
      if (U.info) U.info.canApply = false; // show the commands from here on
      render();
      return;
    }
    if (!out.restarting) { U.view = 'done'; render(); $('update-title')?.focus(); load(); return; }
    U.view = 'restarting';
    render();
    $('update-title')?.focus();
    waitForRestart(startedAt);
  }

  /** The new server answers with a different startedAt; then reload into the new version. */
  function waitForRestart(before) {
    const until = Date.now() + BACK_MS;
    const tick = async () => {
      try {
        const res = await fetch('/api/update', { cache: 'no-store' });
        if (res.ok && (await res.json()).startedAt !== before) return location.reload();
      } catch { /* still restarting */ }
      if (Date.now() > until) { U.view = 'stuck'; render(); $('update-title')?.focus(); return; }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1500);
  }

  dlg.addEventListener('click', e => {
    const act = e.target.closest('[data-upd]')?.dataset.upd;
    if (act === 'later' || act === 'close') dlg.close();
    else if (act === 'apply' && !U.busy) apply();
  });

  return {
    start: load,
    /** The quiet Settings item, only while an update is available. */
    menuHTML: () => available()
      ? `<hr><button class="menuitem" type="button" data-update="open"><b>Update available</b><span>${changes(U.info.behindBy)} · see what's new</span></button>`
      : '',
    open,
  };
}
