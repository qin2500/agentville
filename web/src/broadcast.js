// "Message agents…" (README "Message agents"): one message you write, sent straight into many agents'
// sessions at once. Pick them with filters (or Everyone), untick any, write the message, then confirm
// the exact text and recipient list. Nothing is sent before that confirm, which the server binds to
// that set and text. Results come back per agent as they happen. The page never shows agent text.
import { ROLE_NAME, icon, esc } from './ui.js';
import { MAX_RECIPIENTS, TEXT_MAX, RANKS, STATUSES, STATUS_NAME, statusOf, pick, isFiltered } from './broadcast-match.js';

const STATUS_ICON = { error: 'error', prompt: 'prompt', stalled: 'stalled', waiting: 'waiting', building: 'building', resting: 'resting' };
const RESULT = { queued: 'Queued', sent: 'Sent, waiting for receipt…', delivered: 'Delivered', 'sent-unconfirmed': 'Sent (no receipt in 10 s)', failed: 'Failed', skipped: 'Skipped' };
const agentsN = n => `${n} agent${n === 1 ? '' : 's'}`;
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function createBroadcast(app) {
  const { S } = app;
  const sheet = document.getElementById('broadcast');
  const btn = document.getElementById('btn-msg');
  // view: compose | review | sending | done
  const B = { view: 'compose', f: { name: '', ranks: [], statuses: [], projects: [] }, drop: new Set(), text: '', err: '', field: '', preview: null, results: new Map(), summary: null, changed: false };
  let opener = null;
  sheet.addEventListener('close', () => { (opener?.isConnected && opener.offsetParent ? opener : btn)?.focus(); opener = null; });

  const agents = () => S.data?.agents || [];
  const picked = () => pick(agents(), B.f, { showHidden: !!S.filters.showHidden });
  /** The ids that would get it right now: matching, able to receive it, not unticked. */
  const chosen = p => p.eligible.filter(a => !B.drop.has(a.id)).map(a => a.id).sort();

  function open() {
    opener = document.activeElement;
    app.closePops();
    Object.assign(B, { view: 'compose', err: '', field: '', preview: null, results: new Map(), summary: null, changed: false });
    render();
    if (!sheet.open) sheet.showModal();
    sheet.querySelector('#bc-title')?.focus();
  }

  const toggle = (k, v, label, ic, n) => `<button type="button" class="bcchip" data-bc-f="${k}" data-v="${esc(v)}" aria-pressed="${B.f[k].includes(v)}">${ic ? icon(ic) : ''}<span>${esc(label)}</span>${n != null ? `<span class="n">${n}</span>` : ''}</button>`;
  const head = (t, lede) => `<header><div class="titlerow"><h2 id="bc-title" tabindex="-1">${t}</h2></div>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
  const live = '<p class="sr" aria-live="polite" id="bc-live"></p>';
  const status = a => { const s = statusOf(a); return `<span class="pill b-${s === 'prompt' || s === 'stalled' ? 'stalled' : s}">${icon(STATUS_ICON[s])}${esc(STATUS_NAME[s])}</span>`; };
  const who = a => `${icon(RANKS.includes(a.role) ? a.role : 'solo', 'px role')}<span class="nm" title="${esc(ROLE_NAME[a.role] || 'Solo')}">${esc(a.name)}</span>`;

  function composeHTML() {
    const p = picked(), ids = chosen(p), all = agents().filter(a => S.filters.showHidden || !a.hidden);
    const blocked = S.data?.fleet?.blocked || '';
    const count = (k, v) => all.filter(a => (k === 'ranks' ? a.role : k === 'statuses' ? statusOf(a) : a.project || 'unknown') === v).length;
    const projects = [...new Set(all.map(a => a.project || 'unknown'))].sort((x, y) => x.localeCompare(y));
    const over = ids.length > MAX_RECIPIENTS;
    const rows = p.eligible.map(a => `<li class="bcrow" data-bc-id="${esc(a.id)}"><label><input type="checkbox" data-bc-pick="${esc(a.id)}" ${B.drop.has(a.id) ? '' : 'checked'}>${who(a)}</label>${status(a)}<span class="proj">${esc(a.project || 'unknown')}</span></li>`).join('');
    const offRows = p.ineligible.map(({ agent: a, why }) => `<li class="bcrow off" data-bc-id="${esc(a.id)}"><span class="lbl">${who(a)}</span>${status(a)}<span class="proj">${esc(a.project || 'unknown')}</span><span class="why">${esc(why)}</span></li>`).join('');
    const n = ids.length;
    return `${head('Message agents', 'Sends one message straight into each chosen agent’s session. You’ll see exactly what arrives, and who gets it, before anything is sent.')}
      <div class="body bcbody">
        ${blocked ? `<p class="warnline">${icon('waiting')}Sending isn't available here: ${esc(blocked)}.</p>` : ''}
        <section aria-labelledby="bc-fh"><h3 id="bc-fh">Who</h3>
          <div class="bcfilters">
            <button type="button" class="bcchip every" data-bc="everyone" aria-pressed="${!isFiltered(B.f)}">Everyone</button>
            <label class="bcname"><span class="sr">Name contains</span><input id="bc-name" type="search" placeholder="Name contains…" value="${esc(B.f.name)}" autocomplete="off" spellcheck="false"></label>
          </div>
          <div class="bcgroup" role="group" aria-label="Rank"><span class="glabel">Rank</span>${RANKS.map(r => toggle('ranks', r, ROLE_NAME[r], r, count('ranks', r))).join('')}</div>
          <div class="bcgroup" role="group" aria-label="Status"><span class="glabel">Status</span>${STATUSES.map(s => toggle('statuses', s, STATUS_NAME[s], STATUS_ICON[s], count('statuses', s))).join('')}</div>
          ${projects.length > 1 ? `<div class="bcgroup" role="group" aria-label="Project"><span class="glabel">Project</span>${projects.map(pr => toggle('projects', pr, pr, null, count('projects', pr))).join('')}</div>` : ''}
        </section>
        <section aria-labelledby="bc-rh"><h3 id="bc-rh"><span id="bc-count">${n ? `${agentsN(n)} will get it` : 'Nobody will get it yet'}</span></h3>
          ${over ? `<p class="err" id="bc-over" role="alert">That’s ${n} agents; one message can go to at most ${MAX_RECIPIENTS}. Narrow the filters or untick some.</p>` : ''}
          ${p.eligible.length ? `<ul class="bclist" id="bc-list">${rows}</ul>` : `<p class="helper" id="bc-none">${p.ineligible.length ? 'None of the matching agents can be messaged.' : 'No agents match these filters.'}</p>`}
          ${p.ineligible.length ? `<details class="bcoff" id="bc-off"><summary>${p.ineligible.length} matching ${p.ineligible.length === 1 ? 'agent' : 'agents'} can’t be messaged</summary><ul class="bclist">${offRows}</ul></details>` : ''}
        </section>
        <section aria-labelledby="bc-mh"><h3 id="bc-mh"><label for="bc-text">Message</label></h3>
          <textarea id="bc-text" rows="5" maxlength="${TEXT_MAX}" spellcheck="true" placeholder="What should they all hear?" ${B.field === 'text' ? 'aria-invalid="true" aria-describedby="bc-err"' : ''}>${esc(B.text)}</textarea>
          <div class="under"><span>Arrives as a message from Agentville.</span><span class="spacer"></span><span id="bc-len">${B.text.length} / ${TEXT_MAX}</span></div>
        </section>
      </div>
      <footer><p class="err" id="bc-err" role="alert" ${B.err ? '' : 'hidden'}>${esc(B.err)}</p><span class="spacer"></span>
        <button class="ghost" type="button" data-bc="close">Cancel</button><button class="primary" type="button" data-bc="review">Review…</button></footer>${live}`;
  }

  function reviewHTML() {
    const pv = B.preview;
    return `${head(`Send this to ${agentsN(pv.count)}?`, 'Each one gets exactly this, once, in its session:')}
      <div class="body bcbody">
        <section><h3>Message as it arrives</h3><pre class="cmd bcmsg" id="bc-sent">${esc(pv.sent)}</pre></section>
        <section><h3 id="bc-rcount">${agentsN(pv.count)}</h3><ul class="bclist" id="bc-recipients">${pv.recipients.map(r => { const a = S.byId.get(r.id) || { name: r.name, role: 'solo', bucket: 'resting' }; return `<li class="bcrow" data-bc-id="${esc(r.id)}"><span class="lbl">${who({ ...a, name: r.name })}</span>${status(a)}<span class="proj">${esc(a.project || 'unknown')}</span></li>`; }).join('')}</ul></section>
        ${B.changed ? '<p class="warnline" id="bc-changed" role="alert">The agents that match have changed since you reviewed. Review them again before sending.</p>' : ''}
      </div>
      <footer><p class="err" id="bc-err" role="alert" ${B.err ? '' : 'hidden'}>${esc(B.err)}</p><span class="spacer"></span>
        <button class="ghost" type="button" data-bc="back">Back</button>
        ${B.changed ? '<button class="primary" type="button" data-bc="review">Review again</button>' : `<button class="primary" type="button" data-bc="send">Send to ${agentsN(pv.count)}</button>`}</footer>${live}`;
  }

  function resultsHTML() {
    const pv = B.preview, done = B.view === 'done', s = B.summary;
    const rows = pv.recipients.map(r => {
      const x = B.results.get(r.id) || { status: 'queued' };
      const a = S.byId.get(r.id) || { role: 'solo' };
      return `<li class="bcrow" data-bc-id="${esc(r.id)}"><span class="lbl">${who({ ...a, name: r.name })}</span><span class="fstat ${esc(x.status)}" data-bc-stat>${esc(RESULT[x.status] || x.status)}${x.detail && x.status === 'failed' ? `: ${esc(x.detail)}` : ''}</span></li>`;
    }).join('');
    const extra = s ? [s.sent && `${s.sent} sent without a receipt`, s.failed && `${s.failed} failed`, s.skipped && `${s.skipped} skipped`].filter(Boolean).join(' · ') : '';
    return `${head(done ? `Delivered to ${s.delivered} of ${s.total}` : `Sending to ${agentsN(pv.count)}…`, done ? (extra ? esc(extra) + '.' : 'Every agent recorded it.') : 'Results appear as each session takes the message.')}
      <div class="body bcbody"><ul class="bclist" id="bc-results" aria-busy="${!done}">${rows}</ul></div>
      <footer><p class="err" id="bc-err" role="alert" ${B.err ? '' : 'hidden'}>${esc(B.err)}</p><span class="spacer"></span>
        <button class="${done ? 'primary' : 'ghost'}" type="button" data-bc="close">${done ? 'Done' : 'Close'}</button></footer>${live}`;
  }

  function render() {
    sheet.innerHTML = B.view === 'compose' ? composeHTML() : B.view === 'review' ? reviewHTML() : resultsHTML();
  }
  /** Re-render the compose view but keep the caret where it was (filters re-run on every keystroke). */
  function rerender() {
    const el = document.activeElement, id = el?.id, sel = id && 'selectionStart' in el ? [el.selectionStart, el.selectionEnd] : null;
    const key = el?.dataset?.bcF ? `[data-bc-f="${el.dataset.bcF}"][data-v="${CSS.escape(el.dataset.v)}"]` : el?.dataset?.bcPick ? `[data-bc-pick="${CSS.escape(el.dataset.bcPick)}"]` : el?.dataset?.bc ? `[data-bc="${el.dataset.bc}"]` : null;
    const offOpen = sheet.querySelector('#bc-off')?.open;
    const scroll = sheet.querySelector('.body')?.scrollTop || 0;
    render();
    if (offOpen) sheet.querySelector('#bc-off')?.setAttribute('open', '');
    const b = sheet.querySelector('.body');
    if (b) b.scrollTop = scroll;
    const back = id ? sheet.querySelector(`#${id}`) : key ? sheet.querySelector(key) : null;
    if (back) { back.focus(); if (sel) try { back.setSelectionRange(...sel); } catch { /* not a text field */ } }
  }
  const say = t => { const l = sheet.querySelector('#bc-live'); if (l) l.textContent = t; };

  const fail = e => (e instanceof TypeError ? "the Agentville server isn't reachable." : e.message);
  async function review() {
    if (B.view === 'compose') B.text = sheet.querySelector('#bc-text')?.value ?? B.text;
    const ids = chosen(picked());
    const miss = !ids.length ? ['', 'Pick at least one agent who can receive it.'] : ids.length > MAX_RECIPIENTS ? ['', `One message can go to at most ${MAX_RECIPIENTS} agents; this has ${ids.length}. Narrow the filters or untick some.`]
      : !B.text.trim() ? ['text', 'Write the message first.'] : null;
    if (miss) {
      B.view = 'compose'; [B.field, B.err] = miss; render();
      return sheet.querySelector(B.field ? '#bc-text' : '[data-bc="review"]')?.focus();
    }
    B.err = ''; B.field = '';
    try {
      const res = await fetch('/api/broadcast/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, text: B.text }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Server returned ${res.status}`);
      B.preview = out; B.view = 'review'; B.changed = false;
      render();
      sheet.querySelector('[data-bc="send"]')?.focus();
    } catch (e) {
      B.view = 'compose'; B.err = `Can't send it: ${fail(e)}`; render();
      sheet.querySelector('[data-bc="review"]')?.focus();
    }
  }

  async function sendIt() {
    const pv = B.preview;
    B.view = 'sending'; B.err = ''; B.results = new Map(); B.summary = null;
    render();
    sheet.querySelector('#bc-title')?.focus();
    try {
      const res = await fetch('/api/broadcast/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: pv.confirm, ids: pv.recipients.map(r => r.id), text: pv.text }) });
      if (!res.ok) {
        const out = await res.json().catch(() => ({}));
        throw Object.assign(new Error(out.error || `Server returned ${res.status}`), { status: res.status });
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.id) B.results.set(ev.id, ev);
          if (ev.done) { B.summary = ev.summary; B.view = 'done'; }
        }
        if (sheet.open) render();
        if (done) break;
      }
      if (!B.summary) throw new Error('The connection closed before every result came back. Check the agents themselves.');
      say(`Delivered to ${B.summary.delivered} of ${B.summary.total}`);
      sheet.querySelector('[data-bc="close"]')?.focus();
      app.refresh?.();
    } catch (e) {
      if (B.view === 'sending' && !B.results.size) {
        // Nothing went out: back to the confirm step (or the compose step when it must be confirmed again).
        B.view = e.status === 409 ? 'compose' : 'review';
        B.err = e.status === 409 ? `${e.message}` : `Couldn't send it: ${fail(e)}`;
      } else { B.view = 'done'; B.summary ||= summarizeLocal(); B.err = fail(e); }
      render();
      sheet.querySelector(B.view === 'review' ? '[data-bc="send"]' : '[data-bc="review"],[data-bc="close"]')?.focus();
    }
  }
  const summarizeLocal = () => {
    const v = [...B.results.values()], n = s => v.filter(r => r.status === s).length;
    return { total: B.preview.count, delivered: n('delivered'), sent: n('sent-unconfirmed'), failed: n('failed'), skipped: n('skipped') };
  };

  sheet.addEventListener('click', e => {
    const f = e.target.closest('[data-bc-f]');
    if (f) {
      const list = B.f[f.dataset.bcF], v = f.dataset.v, i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1); else list.push(v);
      B.err = ''; return rerender();
    }
    const t = e.target.closest('[data-bc]');
    if (!t) return;
    switch (t.dataset.bc) {
      case 'close': return sheet.close();
      case 'everyone': B.f = { name: '', ranks: [], statuses: [], projects: [] }; B.err = ''; return rerender();
      case 'review': return review();
      case 'back': B.view = 'compose'; B.err = ''; render(); return sheet.querySelector('#bc-text')?.focus();
      case 'send': return sendIt();
    }
  });
  sheet.addEventListener('change', e => {
    const id = e.target.dataset?.bcPick;
    if (!id) return;
    if (e.target.checked) B.drop.delete(id); else B.drop.add(id);
    B.err = ''; rerender();
  });
  sheet.addEventListener('input', e => {
    if (e.target.id === 'bc-name') { B.f.name = e.target.value; return rerender(); }
    if (e.target.id === 'bc-text') {
      B.text = e.target.value;
      const len = sheet.querySelector('#bc-len');
      if (len) len.textContent = `${B.text.length} / ${TEXT_MAX}`;
      if (B.field === 'text') { B.field = ''; B.err = ''; e.target.removeAttribute('aria-invalid'); const p = sheet.querySelector('#bc-err'); if (p) p.hidden = true; }
    }
  });
  sheet.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && B.view === 'compose') { e.preventDefault(); review(); } });
  // Fleet menu and the Team toolbar both open it.
  document.addEventListener('click', e => { if (e.target.closest('[data-broadcast="open"], #btn-msg')) open(); });

  const menuItemHTML = () => (S.data?.fleet ? '<button class="menuitem" type="button" data-broadcast="open"><b>Message agents…</b><span>Write one message and send it to every agent you pick, or to everyone.</span></button>' : '');

  /** Each poll: the Team toolbar button, a live preview, and a confirm step that notices a changed set. */
  function update() {
    btn.hidden = S.view !== 'team' || !S.data?.fleet;
    if (!sheet.open) return;
    if (B.view === 'compose') {
      if (sheet.contains(document.activeElement) && document.activeElement.id === 'bc-text') {
        // Don't redraw under the cursor in the message box; the list refreshes on the next change.
        const ids = chosen(picked()).join();
        if (ids === B.lastIds) return;
        B.lastIds = ids;
      }
      return rerender();
    }
    if (B.view === 'review' && B.preview) {
      const now = chosen(picked()), was = B.preview.recipients.map(r => r.id).sort();
      const changed = !sameIds(now, was);
      if (changed !== B.changed) { B.changed = changed; render(); sheet.querySelector(changed ? '[data-bc="review"]' : '[data-bc="send"]')?.focus(); }
    }
  }
  return { open, update, menuItemHTML, isOpen: () => sheet.open };
}
