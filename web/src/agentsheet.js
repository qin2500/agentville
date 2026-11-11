// Fork…, Stop job… and Edit… from the agent menu (ctxmenu.js): one sheet, the same steps the old
// inspector had. Stop and Fork go through a server preview first (the exact command), then a one-time confirm;
// Edit is the name / role / parent override form.
import { esc } from './ui.js';

const NONE_PARENT = ''; // "None" in the parent picker: an explicit "no parent" override

export function createAgentSheet(app, { descendants }) {
  const { S } = app;
  const sheet = document.getElementById('agentsheet');
  // kind: fork | stop | edit. phase: form | loading | confirm | running | done | error
  const A = { kind: null, id: null, phase: 'form', preview: null, result: null, err: '', name: '' };
  let opener = null;
  sheet.addEventListener('close', () => {
    const back = opener?.isConnected && opener.offsetParent !== null ? opener : null;
    A.kind = null; A.id = null; opener = null;
    back?.focus({ preventScroll: true });
  });
  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error || `Server returned ${res.status}`), { status: res.status });
    return out;
  };
  const why = e => (e instanceof TypeError ? "the server isn't reachable." : e.message);
  const agent = () => S.byId.get(A.id) || S.data?.agents?.find(x => x.id === A.id);
  const focus = sel => setTimeout(() => sheet.querySelector(sel)?.focus(), 0);

  function open(kind, a, from) {
    opener = from || null;
    Object.assign(A, { kind, id: a.id, phase: kind === 'fork' ? 'form' : kind === 'stop' ? 'loading' : 'form', preview: null, result: null, err: '', name: '' });
    render();
    if (!sheet.open) sheet.showModal();
    if (kind === 'stop') review();
    else focus(kind === 'fork' ? '#fork-name' : 'input[name="name"]');
  }
  const head = (title, lede) => `<header><div class="titlerow"><h2 id="as-title" tabindex="-1">${title}</h2></div>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
  const errHTML = () => `<p class="err" role="alert" ${A.err ? '' : 'hidden'}>${esc(A.err)}</p>`;
  function render() {
    const a = agent();
    if (!a) { sheet.innerHTML = `${head('Agent gone', 'It is no longer in the list.')}<footer><span class="spacer"></span><button class="ghost" type="button" data-as="close">Close</button></footer>`; return; }
    const name = esc(a.name);
    const cmd = A.preview ? `<pre class="cmd" id="act-cmd">${esc(A.preview.command)}</pre>` : '';
    const blocked = A.preview?.blocked ? `<p class="helper">${esc(A.preview.blocked)}.</p>` : '';
    if (A.kind === 'stop') {
      if (A.phase === 'done') {
        sheet.innerHTML = `${head(`Stopped ${name}`)}<div class="body"><p class="msgstat ok" role="status"><b>Stopped</b> · Its conversation is kept: <code>claude attach ${esc(A.result.jobId || a.jobId)}</code> opens it again.</p></div>
          <footer><span class="spacer"></span><button class="primary" type="button" data-as="close">Done</button></footer>`;
        return;
      }
      sheet.innerHTML = `${head(`Stop ${name}?`)}<div class="body">
        ${A.phase === 'loading' ? '<p class="helper">Checking…</p>' : A.preview ? `<p class="helper">Runs this command:</p>${cmd}
        <p class="helper">The job stops, but its conversation is kept: <code>claude attach ${esc(a.jobId || '')}</code> opens it again.</p>${blocked}` : ''}${errHTML()}</div>
        <footer><span class="spacer"></span><button class="ghost" type="button" data-as="close">${A.preview ? 'Cancel' : 'Close'}</button>${A.preview ? `<button class="primary" type="button" data-as="run" ${A.phase === 'running' ? 'disabled aria-busy="true"' : ''}>${A.phase === 'running' ? 'Stopping…' : 'Stop job'}</button>` : ''}</footer>`;
      return;
    }
    if (A.kind === 'fork') {
      if (A.phase === 'done') {
        const there = A.result.jobId && S.agents.find(x => x.jobId === A.result.jobId);
        sheet.innerHTML = `${head(`Forked ${name}`)}<div class="body"><p class="msgstat ok" role="status"><b>Forked</b> · New background job <code>${esc(A.result.jobId || '?')}</code>. ${there ? 'It’s in the list now.' : 'It appears in the list within a few seconds.'}</p></div>
          <footer><span class="spacer"></span><button class="ghost" type="button" data-as="close">Done</button>${there ? `<button class="primary" type="button" data-as="goto" data-id="${esc(there.id)}">Show it</button>` : ''}</footer>`;
        return;
      }
      sheet.innerHTML = `${head(`Fork ${name}`, 'Starts a new background job with a copy of this conversation. The original is left as it is.')}<div class="body">
        <label class="field">Name (optional)<input id="fork-name" maxlength="80" value="${esc(A.name)}" placeholder="${esc(a.name)} (fork)"></label>
        ${A.phase === 'loading' ? '<p class="helper">Checking…</p>' : ''}
        ${A.preview ? `<p class="helper">Runs this command in <code>${esc(A.preview.cwd)}</code>:</p>${cmd}${blocked}` : ''}${errHTML()}</div>
        <footer><span class="spacer"></span><button class="ghost" type="button" data-as="close">Cancel</button>${A.preview
          ? `<button class="ghost" type="button" data-as="review">Update command</button><button class="primary" type="button" data-as="run" ${A.phase === 'running' ? 'disabled aria-busy="true"' : ''}>${A.phase === 'running' ? 'Forking…' : 'Fork'}</button>`
          : '<button class="primary" type="button" data-as="review">Show the command…</button>'}</footer>`;
      return;
    }
    sheet.innerHTML = `${head(`Edit ${name}`, 'Overrides what Agentville detected. Leave a field on Auto to keep the detected value.')}<div class="body">${editForm(a)}</div>
      <footer><span class="spacer"></span><button class="ghost" type="button" data-as="close">Cancel</button><button class="primary" type="submit" form="as-edit">Save</button></footer>`;
  }
  function editForm(a) {
    const o = a.overrides || {};
    const has = k => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null;
    const roleVal = has('role') ? o.role : '';
    const parentVal = has('parentId') ? (o.parentId || NONE_PARENT) : '__auto';
    const banned = new Set([a.id, ...descendants(a).map(d => d.id)]);
    const options = S.agents.filter(x => x.bucket !== 'resting' && !banned.has(x.id)).sort((x, y) => x.name.localeCompare(y.name));
    if (has('parentId') && o.parentId && !options.some(x => x.id === o.parentId)) {
      const cur = S.byId.get(o.parentId);
      options.unshift(cur || { id: o.parentId, name: o.parentId, project: '' });
    }
    return `<form class="edit naform" id="as-edit" data-form="edit" novalidate>
      <label>Name<input name="name" value="${esc(has('name') ? o.name : '')}" placeholder="${esc(a.name)} (auto)" maxlength="120"></label>
      <label>Role<select name="role">${[['', 'Auto (detected)'], ['boss', 'Boss'], ['lead', 'Lead'], ['sub', 'Sub'], ['solo', 'Solo']].map(([v, l]) => `<option value="${v}" ${v === roleVal ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Parent<select name="parent">
        <option value="__auto" ${parentVal === '__auto' ? 'selected' : ''}>Auto (detected)</option>
        <option value="${NONE_PARENT}" ${parentVal === NONE_PARENT ? 'selected' : ''}>None</option>
        ${options.map(x => `<option value="${esc(x.id)}" ${x.id === parentVal ? 'selected' : ''}>${esc(x.name)}${x.project ? ` — ${esc(x.project)}` : ''}</option>`).join('')}
      </select></label>
      ${errHTML()}
    </form>`;
  }

  // ---------- stop / fork ----------
  async function review() {
    const a = agent();
    if (!a) return;
    const nameEl = sheet.querySelector('#fork-name');
    if (nameEl) A.name = nameEl.value;
    A.phase = 'loading'; A.err = '';
    render();
    try {
      A.preview = await post('/api/act/preview', { kind: A.kind, id: a.id, ...(A.kind === 'fork' && { name: A.name }) });
      A.phase = 'confirm';
    } catch (e) { A.preview = null; A.phase = 'error'; A.err = e.status === 409 || e.status === 400 ? e.message : `Couldn't check: ${why(e)}`; }
    if (!A.kind) return; // closed meanwhile
    render();
    focus(A.preview ? '[data-as="run"]' : '[data-as="close"]');
  }
  async function runAct() {
    const a = agent();
    if (!a || !A.preview) return;
    const nameEl = sheet.querySelector('#fork-name');
    if (A.kind === 'fork' && nameEl && nameEl.value !== A.name) return review(); // the name changed: show the new command first
    A.phase = 'running'; A.err = '';
    render();
    try {
      A.result = await post('/api/act/run', { confirm: A.preview.confirm });
      A.phase = 'done';
      app.say(A.kind === 'stop' ? `Stopped ${a.name}` : `Forked ${a.name}`);
      app.refresh();
    } catch (e) {
      A.phase = 'confirm';
      if (e.status === 409) A.preview = null;
      A.err = e.status === 409 ? 'That confirmation expired. Check the command again.' : `Couldn't ${A.kind}: ${why(e)}`;
    }
    if (!A.kind) return;
    render();
    focus('[data-as="run"], [data-as="close"]');
  }

  sheet.addEventListener('click', e => {
    const t = e.target.closest('[data-as]');
    if (!t) return;
    switch (t.dataset.as) {
      case 'close': return sheet.close();
      case 'review': return review();
      case 'run': return runAct();
      case 'goto': { const id = t.dataset.id; sheet.close(); return app.select(id, { reveal: true }); }
    }
  });
  sheet.addEventListener('keydown', e => {
    if (e.target.id === 'fork-name' && e.key === 'Enter') { e.preventDefault(); review(); }
  });
  sheet.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target, a = agent();
    if (!a || A.kind !== 'edit') return;
    const err = form.querySelector('.err'), btn = sheet.querySelector('[type="submit"]');
    const name = form.name.value.trim();
    const parent = form.parent.value;
    const body = { name: name || null, role: form.role.value || null, parentId: parent === '__auto' ? null : parent };
    btn.disabled = true; btn.textContent = 'Saving…'; err.hidden = true;
    try {
      await app.patch(a.id, body);
      sheet.close();
    } catch (ex) {
      err.textContent = ex instanceof TypeError ? "Couldn't save — server not reachable." : `Couldn't save — ${ex.message}`; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Save';
    }
  });

  return {
    open,
    /** After a fork, "Show it" appears once the new job is in the list. Nothing else re-renders on a poll. */
    update() { if (sheet.open && A.kind === 'fork' && A.phase === 'done' && !sheet.querySelector('[data-as="goto"]')) render(); },
  };
}
