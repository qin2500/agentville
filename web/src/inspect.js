// Inspector extras: reply to an agent that needs you (and message any live Claude session), its
// changed files and PRs, and Stop job / Fork. Everything that acts on an agent goes through a server
// preview first (the exact text or command), then a one-time confirm. No conversation text is shown:
// only the job's own short `needs` line and the scheduler's suggested reply.
import { esc, safeHref } from './ui.js';

const STATUS = {
  delivered: ['ok', 'Delivered', 'The session recorded the message.'],
  'sent-unconfirmed': ['warn', 'Sent, no receipt yet', "It reached the session's inbox, but the session hasn't recorded it within 10 seconds. It may still arrive with its next turn."],
  failed: ['bad', 'Failed', ''],
  skipped: ['warn', 'Not sent', ''],
};
const PR_STATE = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const REVIEW = { approved: 'Approved', changes: 'Changes requested', required: 'Review required' };
const num = n => (n || 0).toLocaleString();
/** "+412 −37 · 6 files" */
export const changesLabel = c => `+${num(c.added)} −${num(c.removed)} · ${c.files} file${c.files === 1 ? '' : 's'}`;
/** A PR's checks in words: "1 failed, 2 pending, 7 passed". */
export function checksText(c) {
  if (!c) return '';
  const parts = [c.failed && `${c.failed} failed`, c.pending && `${c.pending} pending`, c.passed && `${c.passed} passed`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no checks';
}
/** Chip class + words for a PR: failing checks are amber (needs attention), never red. */
export function prTone(p) {
  if (!p.state) return { cls: '', words: '' };
  const failing = p.checks?.failed > 0 && ['open', 'draft'].includes(p.state);
  const words = [PR_STATE[p.state], failing ? `${p.checks.failed} check${p.checks.failed === 1 ? '' : 's'} failing` : p.checks?.pending && ['open', 'draft'].includes(p.state) ? 'checks running' : '', REVIEW[p.review] || ''].filter(Boolean).join(', ');
  return { cls: ` pr-${p.state}${failing ? ' pr-failing' : ''}`, words };
}

export function createInspect(app) {
  const { S } = app;
  const msg = new Map(); // agent id -> { open, draft, phase, preview, result, err }
  const act = new Map(); // agent id -> { kind, phase, preview, result, err, name }
  const chg = new Map(); // agent id -> { at, data, loading }
  const showAll = new Set();
  const M = id => { if (!msg.has(id)) msg.set(id, { open: false, draft: null, phase: 'edit' }); return msg.get(id); };
  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error || `Server returned ${res.status}`), { status: res.status });
    return out;
  };
  const why = e => (e instanceof TypeError ? "the server isn't reachable." : e.message);

  // ---------- reply / message ----------
  function composeHTML(a, m, suggested) {
    const name = esc(a.name);
    if (m.phase === 'preview' || m.phase === 'sending') {
      return `<p class="helper">This exact text goes into ${name}'s session:</p>
        <pre class="msg" id="msg-preview">${esc(m.preview.sent)}</pre>
        <div class="actions"><button class="primary" type="button" data-ins="msgsend" ${m.phase === 'sending' ? 'disabled aria-busy="true"' : ''}>${m.phase === 'sending' ? 'Sending…' : `Send to ${name}`}</button>
        <button class="ghost" type="button" data-ins="msgedit">Edit</button></div>
        <p class="err" role="alert" ${m.err ? '' : 'hidden'}>${esc(m.err || '')}</p>`;
    }
    if (m.phase === 'result') {
      const [tone, word, line] = STATUS[m.result.status] || ['warn', m.result.status, ''];
      return `<p class="msgstat ${tone}" role="status"><b>${esc(word)}</b>${line || m.result.detail ? ` · ${esc(m.result.detail && tone !== 'ok' ? m.result.detail : line)}` : ''}</p>
        <div class="actions"><button class="ghost" type="button" data-ins="msgagain">Write another</button></div>`;
    }
    m.suggested = suggested || '';
    // The box's text is set after rendering (patch), so typing never changes this HTML.
    return `<label class="sr" for="msg-box">Message to ${name}</label>
      <textarea id="msg-box" rows="4" spellcheck="true" maxlength="8000" ${m.err ? 'aria-invalid="true" aria-describedby="msg-err"' : ''}></textarea>
      <p class="err" id="msg-err" role="alert" ${m.err ? '' : 'hidden'}>${esc(m.err || '')}</p>
      <div class="actions"><button class="primary" type="button" data-ins="msgpreview">Send to ${name}…</button>
      ${a.ask ? '' : '<button class="ghost" type="button" data-ins="msgclose">Cancel</button>'}</div>
      <p class="helper">${suggested ? 'Prefilled with the suggested reply; edit it as you like. ' : ''}It arrives as a message from another session (wrapped in a &lt;cross-session-message from Agentville&gt; tag), the same way Fleet messages do. You'll see the exact text before it's sent.</p>`;
  }
  function replyHTML(a) {
    const m = M(a.id);
    if (a.ask) {
      return `<section class="ask" aria-labelledby="ask-h"><h4 id="ask-h">${esc(a.name)} is asking</h4>
        <p class="needs">${esc(a.ask.needs)}</p>
        ${a.messageWhy ? `${a.ask.suggestedReply ? `<p class="helper">Suggested reply: “${esc(a.ask.suggestedReply)}”</p>` : ''}<p class="helper">Can't reply from here: ${esc(a.messageWhy)}</p>` : composeHTML(a, m, a.ask.suggestedReply || '')}</section>`;
    }
    if (a.bucket === 'resting' && !a.live) return '';
    const open = m.open || m.phase !== 'edit';
    return `<section class="compose"><button class="ghost" type="button" data-ins="msgtoggle" aria-expanded="${open}">Message ${esc(a.name)}</button>
      ${open ? `<div class="composebox">${a.messageWhy ? `<p class="helper">Can't message ${esc(a.name)}: ${esc(a.messageWhy)}</p>` : composeHTML(a, m, '')}</div>` : ''}</section>`;
  }
  async function preview(a) {
    const m = M(a.id), box = document.getElementById('msg-box');
    if (box) m.draft = box.value;
    const text = (m.draft ?? a.ask?.suggestedReply ?? '');
    if (!text.trim()) { m.err = 'Write a message first.'; app.render(); document.getElementById('msg-box')?.focus(); return; }
    m.err = '';
    try {
      m.preview = await post('/api/message/preview', { id: a.id, text });
      m.phase = 'preview';
    } catch (e) { m.err = `Couldn't prepare the message: ${why(e)}`; }
    app.render();
    focus(m.phase === 'preview' ? '[data-ins="msgsend"]' : '#msg-box');
  }
  async function sendMsg(a) {
    const m = M(a.id);
    m.phase = 'sending'; m.err = '';
    app.render();
    try {
      m.result = await post('/api/message/send', { confirm: m.preview.confirm });
      m.phase = 'result';
      m.draft = null;
      app.say(`${STATUS[m.result.status]?.[1] || m.result.status}: message to ${a.name}`);
      app.refresh();
    } catch (e) {
      m.phase = 'preview';
      m.err = e.status === 409 ? 'The preview expired. Choose Edit, then send again.' : `Couldn't send: ${why(e)}`;
    }
    app.render();
    focus('[data-ins="msgagain"], [data-ins="msgsend"]');
  }

  // ---------- stop / fork ----------
  function actHTML(a) {
    const s = act.get(a.id);
    if (!s) return '';
    const cmd = s.preview ? `<pre class="cmd" id="act-cmd">${esc(s.preview.command)}</pre>` : '';
    const err = `<p class="err" role="alert" ${s.err ? '' : 'hidden'}>${esc(s.err || '')}</p>`;
    const blocked = s.preview?.blocked ? `<p class="helper">${esc(s.preview.blocked)}.</p>` : '';
    if (s.kind === 'stop') {
      if (s.phase === 'done') return `<section class="actbox" aria-label="Stop job"><p class="msgstat ok" role="status"><b>Stopped</b> · Its conversation is kept: <code>claude attach ${esc(s.result.jobId || a.jobId)}</code> opens it again.</p><div class="actions"><button class="ghost" type="button" data-ins="actclose">Done</button></div></section>`;
      return `<section class="actbox" aria-labelledby="act-h"><h4 id="act-h">Stop ${esc(a.name)}?</h4>
        ${s.phase === 'loading' ? '<p class="helper">Checking…</p>' : s.preview ? `<p class="helper">Runs this command:</p>${cmd}
        <p class="helper">The job stops, but its conversation is kept: <code>claude attach ${esc(a.jobId || '')}</code> opens it again.</p>${blocked}` : ''}
        ${err}<div class="actions">${s.preview ? `<button class="primary" type="button" data-ins="actrun" ${s.phase === 'running' ? 'disabled aria-busy="true"' : ''}>${s.phase === 'running' ? 'Stopping…' : 'Stop job'}</button>` : ''}<button class="ghost" type="button" data-ins="actclose">${s.preview ? 'Cancel' : 'Close'}</button></div></section>`;
    }
    if (s.phase === 'done') {
      const there = s.result.jobId && S.agents.find(x => x.jobId === s.result.jobId);
      return `<section class="actbox" aria-label="Fork"><p class="msgstat ok" role="status"><b>Forked</b> · New background job <code>${esc(s.result.jobId || '?')}</code>. ${there ? 'It’s in the list now.' : 'It appears in the list within a few seconds.'}</p>
        <div class="actions">${there ? `<button class="primary" type="button" data-ins="actgoto" data-id="${esc(there.id)}">Show it</button>` : ''}<button class="ghost" type="button" data-ins="actclose">Done</button></div></section>`;
    }
    return `<section class="actbox" aria-labelledby="act-h"><h4 id="act-h">Fork ${esc(a.name)}</h4>
      <p class="helper">Starts a new background job with a copy of this conversation. The original is left as it is.</p>
      <label class="field">Name (optional)<input id="fork-name" maxlength="80" value="${esc(s.name || '')}" placeholder="${esc(a.name)} (fork)"></label>
      ${s.preview ? `<p class="helper">Runs this command in <code>${esc(s.preview.cwd)}</code>:</p>${cmd}${blocked}` : ''}
      ${err}<div class="actions">${s.preview
        ? `<button class="primary" type="button" data-ins="actrun" ${s.phase === 'running' ? 'disabled aria-busy="true"' : ''}>${s.phase === 'running' ? 'Forking…' : 'Fork'}</button><button class="ghost" type="button" data-ins="actreview">Update command</button>`
        : `<button class="primary" type="button" data-ins="actreview">Show the command…</button>`}<button class="ghost" type="button" data-ins="actclose">Cancel</button></div></section>`;
  }
  async function actPreview(a, kind) {
    const s = act.get(a.id) || { kind };
    if (s.kind !== kind) Object.assign(s, { kind, preview: null, name: '' });
    act.set(a.id, s);
    const nameEl = document.getElementById('fork-name');
    if (nameEl) s.name = nameEl.value;
    if (kind === 'fork' && !s.reviewing) { s.phase = 'form'; s.reviewing = true; app.render(); return focus('#fork-name'); }
    s.phase = 'loading'; s.err = '';
    app.render();
    try {
      s.preview = await post('/api/act/preview', { kind, id: a.id, ...(kind === 'fork' && { name: s.name }) });
      s.phase = 'confirm';
    } catch (e) { s.preview = null; s.phase = 'error'; s.err = e.status === 409 || e.status === 400 ? e.message : `Couldn't check: ${why(e)}`; }
    app.render();
    focus(s.preview ? '[data-ins="actrun"]' : '[data-ins="actclose"]');
  }
  async function actRun(a) {
    const s = act.get(a.id);
    if (!s?.preview) return;
    const nameEl = document.getElementById('fork-name');
    if (s.kind === 'fork' && nameEl && nameEl.value !== s.name) { s.reviewing = true; return actPreview(a, 'fork'); } // the name changed: show the new command first
    s.phase = 'running'; s.err = '';
    app.render();
    try {
      s.result = await post('/api/act/run', { confirm: s.preview.confirm });
      s.phase = 'done';
      app.say(s.kind === 'stop' ? `Stopped ${a.name}` : `Forked ${a.name}`);
      app.refresh();
    } catch (e) {
      s.phase = 'confirm';
      if (e.status === 409) { s.preview = null; s.reviewing = s.kind === 'fork'; }
      s.err = e.status === 409 ? 'That confirmation expired. Check the command again.' : `Couldn't ${s.kind}: ${why(e)}`;
    }
    app.render();
    focus('[data-ins="actclose"], [data-ins="actrun"]');
  }

  // ---------- changes + PRs ----------
  function loadChanges(a) {
    const c = chg.get(a.id);
    if (c && (c.loading || Date.now() - c.at < 30e3)) return;
    chg.set(a.id, { ...(c || {}), loading: true, at: Date.now() });
    fetch(`/api/agents/${encodeURIComponent(a.id)}/changes`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null)).catch(() => null)
      .then(body => { chg.set(a.id, { at: Date.now(), data: body?.changes || null, loading: false }); if (S.selected === a.id) app.render(); });
  }
  function changesHTML(a) {
    if (a.bucket === 'resting' && !a.live) return '';
    if (a.changes) loadChanges(a);
    const d = chg.get(a.id)?.data;
    if (!a.changes && !d?.count) return '';
    const sum = a.changes || { added: d.added, removed: d.removed, files: d.count };
    const files = d?.files || [];
    const shown = showAll.has(a.id) ? files : files.slice(0, 40);
    return `<section class="chg" aria-labelledby="chg-h"><h4 id="chg-h">Changes <span class="num">${esc(changesLabel(sum))}</span></h4>
      ${d ? `<p class="helper">${d.against ? `Against ${esc(d.against)}` : 'Uncommitted'}${d.branch ? ` · on ${esc(d.branch)}` : ''} · paths and line counts only</p>` : '<p class="helper">Loading the file list…</p>'}
      ${shown.length ? `<ul class="files">${shown.map(f => `<li><span class="fp" title="${esc(f.path)}"><bdi>${esc(f.path)}</bdi></span>${f.untracked ? '<span class="ft">new, untracked</span>' : f.binary ? '<span class="ft">binary</span>' : `<span class="num add">+${num(f.add)}</span><span class="num del">−${num(f.del)}</span>`}</li>`).join('')}</ul>` : ''}
      ${files.length > shown.length ? `<button class="linkbtn inline" type="button" data-ins="allfiles">Show all ${files.length} files</button>` : ''}${d?.truncated ? '<p class="helper">Only the first 500 files are listed.</p>' : ''}</section>`;
  }
  function prsHTML(a) {
    const prs = a.prs || [];
    if (!prs.length) return '';
    return `<section class="prs" aria-labelledby="prs-h"><h4 id="prs-h">Pull requests · ${prs.length}</h4><ul>${prs.map(p => {
      const href = safeHref(p.href), t = prTone(p);
      const link = href ? `<a class="chip${t.cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">#${esc(p.id)}</a>` : `<span class="chip${t.cls}">#${esc(p.id)}</span>`;
      if (!p.state) return `<li>${link}<span class="helper">No status yet (Claude Code hasn't cached it)</span></li>`;
      const failing = p.checks?.failed > 0 && ['open', 'draft'].includes(p.state);
      return `<li>${link}<span class="prst pr-${esc(p.state)}">${PR_STATE[p.state]}</span>
        <span class="prck${failing ? ' failing' : ''}">Checks: ${esc(checksText(p.checks))}</span>${p.review ? `<span class="prrv">${esc(REVIEW[p.review])}</span>` : ''}</li>`;
    }).join('')}</ul></section>`;
  }

  // ---------- render + events ----------
  function focus(sel) { setTimeout(() => document.querySelector(`#drawer ${sel.split(', ').join(', #drawer ')}`)?.focus(), 0); }
  /** Keeps what was typed and where the cursor was when a poll re-renders the box. */
  function patch(el, html) {
    if (el._html === html) return;
    const box = el.querySelector('#msg-box, #fork-name'), had = box && document.activeElement === box;
    const st = had ? { id: box.id, start: box.selectionStart, end: box.selectionEnd } : null;
    const mb = el.querySelector('#msg-box'), fn = el.querySelector('#fork-name');
    if (mb) M(S.selected).draft = mb.value;
    if (fn && act.get(S.selected)) act.get(S.selected).name = fn.value;
    el.innerHTML = html;
    el._html = html;
    const nb = el.querySelector('#msg-box');
    if (nb) { const m = M(S.selected); nb.value = m.draft ?? m.suggested ?? ''; }
    if (st) { const b = el.querySelector(`#${st.id}`); if (b) { b.focus(); try { b.setSelectionRange(st.start, st.end); } catch { /* not a text box */ } } }
  }
  // A background job reopened in a terminal: its status comes from that session, not the job record.
  const reopenedHTML = a => (a.reopened && a.live ? `<p class="helper reopened">Reopened in a terminal · shown as that live session; switch to its terminal to work with it.</p>` : '');
  function render(a, { reply, extra }) {
    patch(reply, replyHTML(a));
    patch(extra, reopenedHTML(a) + actHTML(a) + changesHTML(a) + prsHTML(a));
  }
  function onClick(e) {
    const t = e.target.closest('[data-ins]');
    if (!t) return false;
    const a = S.byId.get(S.selected);
    if (!a) return true;
    const m = M(a.id);
    switch (t.dataset.ins) {
      case 'msgtoggle': m.open = !(m.open || m.phase !== 'edit'); if (!m.open) Object.assign(m, { phase: 'edit', err: '' }); app.render(); if (m.open) focus('#msg-box'); break;
      case 'msgclose': Object.assign(m, { open: false, phase: 'edit', err: '' }); app.render(); focus('[data-ins="msgtoggle"]'); break;
      case 'msgpreview': preview(a); break;
      case 'msgsend': sendMsg(a); break;
      case 'msgedit': m.phase = 'edit'; m.err = ''; app.render(); focus('#msg-box'); break;
      case 'msgagain': Object.assign(m, { phase: 'edit', err: '', draft: '', result: null, open: true }); app.render(); focus('#msg-box'); break;
      case 'stop': act.delete(a.id); actPreview(a, 'stop'); break;
      case 'fork': act.delete(a.id); actPreview(a, 'fork'); break;
      case 'actreview': { const s = act.get(a.id); if (s) s.reviewing = true; actPreview(a, s?.kind || 'fork'); break; }
      case 'actrun': actRun(a); break;
      case 'actclose': act.delete(a.id); app.render(); focus('[data-act="fork"], [data-act="stop"]'); break;
      case 'actgoto': act.delete(a.id); app.openDetail(t.dataset.id); break;
      case 'allfiles': showAll.add(a.id); app.render(); break;
    }
    return true;
  }
  function onInput(e) {
    if (e.target.id === 'msg-box') {
      const m = M(S.selected);
      m.draft = e.target.value;
      if (m.err && e.target.value.trim()) { m.err = ''; e.target.removeAttribute('aria-invalid'); const p = document.getElementById('msg-err'); if (p) p.hidden = true; }
    }
  }
  function onKey(e) {
    // ⌘/Ctrl+Enter in the box goes to the preview step (never straight to sending).
    if (e.target.id === 'msg-box' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); const a = S.byId.get(S.selected); if (a) preview(a); }
    if (e.target.id === 'fork-name' && e.key === 'Enter') { e.preventDefault(); const a = S.byId.get(S.selected); if (a) { const s = act.get(a.id); if (s) s.reviewing = true; actPreview(a, 'fork'); } }
  }
  return { render, onClick, onInput, onKey };
}
