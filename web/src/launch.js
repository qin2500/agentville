// "+ New agent": a sheet that starts a Claude Code background job (`claude --bg`). The page only
// picks values; the server checks each against its allowlists, builds the command itself and shows
// it back exactly. Nothing starts until "Start agent" on that confirm step.
import { esc } from './ui.js';

const MODEL = { '': 'Default', opus: 'Opus', 'opus[1m]': 'Opus · 1M context', sonnet: 'Sonnet', 'sonnet[1m]': 'Sonnet · 1M context', haiku: 'Haiku', fable: 'Fable' };
const EFFORT = { '': 'Default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const MODE = { '': 'Default (asks before edits and commands)', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan first', manual: 'Manual', dontAsk: "Don't ask (deny what isn't allowed)" };

export function createLaunch(app) {
  const { S } = app;
  const sheet = document.getElementById('newagent');
  // view: loading | form | review | starting | started | error
  const L = { view: 'loading', opts: null, form: { cwd: '', prompt: '', name: '', model: '', effort: '', permissionMode: '', worktree: false }, preview: null, result: null, err: '', field: '' };
  let opener = null;
  sheet.addEventListener('close', () => { (opener?.isConnected ? opener : document.getElementById('btn-new'))?.focus(); opener = null; });

  async function open() {
    opener = document.activeElement;
    app.closePops();
    Object.assign(L, { view: 'loading', preview: null, result: null, err: '', field: '' });
    render();
    if (!sheet.open) sheet.showModal();
    try {
      const res = await fetch('/api/act/options', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      L.opts = await res.json();
      // The selected agent's project is the likeliest one.
      const sel = S.byId.get(S.selected);
      const guess = L.opts.projects.find(p => sel?.cwd && (sel.cwd === p.dir || sel.cwd.startsWith(`${p.dir}/`)));
      if (!L.opts.projects.some(p => p.dir === L.form.cwd)) L.form.cwd = guess?.dir || L.opts.projects[0]?.dir || '';
      L.view = 'form';
    } catch (e) {
      L.view = 'error';
      L.err = e instanceof TypeError ? "The Agentville server isn't reachable." : e.message;
    }
    render();
    sheet.querySelector('#na-title')?.focus();
  }
  const opt = (map, list, cur) => list.map(v => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(map[v] || v)}</option>`).join('');
  function read() {
    const f = sheet.querySelector('form');
    if (!f) return;
    Object.assign(L.form, { cwd: f.cwd.value, prompt: f.prompt.value, name: f.aname.value, model: f.model.value, effort: f.effort.value, permissionMode: f.mode.value, worktree: f.worktree.checked });
  }
  function render() {
    const head = (t, lede) => `<header><div class="titlerow"><h2 id="na-title" tabindex="-1">${t}</h2></div>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
    const live = '<p class="sr" aria-live="polite" id="na-live"></p>';
    if (L.view === 'loading' || L.view === 'error') {
      sheet.innerHTML = `${head('New agent', L.view === 'loading' ? 'Loading projects…' : `Couldn't load the options: ${esc(L.err)}`)}<footer><span class="spacer"></span><button class="ghost" type="button" data-na="close">Close</button></footer>${live}`;
      return;
    }
    const o = L.opts, f = L.form;
    if (L.view === 'started') {
      const a = L.result.jobId && S.agents.find(x => x.jobId === L.result.jobId);
      sheet.innerHTML = `${head(`Started ${esc(L.result.name || 'the agent')}`, `New background job <code>${esc(L.result.jobId || '?')}</code>. ${a ? 'It’s in the list now.' : 'It appears in the list within a few seconds.'}`)}
        <footer><span class="spacer"></span><button class="ghost" type="button" data-na="close">Done</button>${a ? `<button class="primary" type="button" data-na="show" data-id="${esc(a.id)}">Show it</button>` : ''}</footer>${live}`;
      return;
    }
    if (L.view === 'review' || L.view === 'starting') {
      const p = L.preview;
      sheet.innerHTML = `${head('Start this agent?', 'Agentville runs exactly this command, once, in this folder:')}
        <div class="body"><section><h3>Folder</h3><p class="mono">${esc(p.cwd)}</p></section>
        <section><h3>Command</h3><pre class="cmd" id="na-cmd">${esc(p.command)}</pre>
        <p class="helper">It starts in the background, like <code>claude --bg</code> in a terminal. <code>claude attach</code> opens it; Stop job in its inspector stops it.</p></section>
        ${p.blocked ? `<p class="warnline">${esc(p.blocked)}.</p>` : ''}</div>
        <footer><p class="err" id="na-err" role="alert" ${L.err ? '' : 'hidden'}>${esc(L.err)}</p><span class="spacer"></span>
          <button class="ghost" type="button" data-na="back">Back</button>
          <button class="primary" type="button" data-na="start" ${L.view === 'starting' ? 'disabled aria-busy="true"' : ''}>${L.view === 'starting' ? 'Starting…' : 'Start agent'}</button></footer>${live}`;
      return;
    }
    const inval = k => (L.field === k ? 'aria-invalid="true" aria-describedby="na-err"' : '');
    sheet.innerHTML = `${head('New agent', 'Starts a Claude Code background job in one of your projects. You’ll see the exact command before anything runs.')}
      <form class="body naform" novalidate>
        <label>Project<select name="cwd" ${inval('cwd')}>${o.projects.length ? o.projects.map(p => `<option value="${esc(p.dir)}" ${p.dir === f.cwd ? 'selected' : ''}>${esc(p.name)} — ${esc(p.dir)}</option>`).join('') : '<option value="">No known projects yet</option>'}</select></label>
        <label>Prompt<textarea name="prompt" rows="6" maxlength="${o.promptMax}" spellcheck="true" ${inval('prompt')} placeholder="What should it do?">${esc(f.prompt)}</textarea></label>
        <label><span>Name <span class="opt">(optional)</span></span><input name="aname" maxlength="${o.nameMax}" value="${esc(f.name)}" ${inval('name')} placeholder="Shown in the list and in claude agents"></label>
        <div class="row3">
          <label>Model<select name="model">${opt(MODEL, o.models, f.model)}</select></label>
          <label>Effort<select name="effort">${opt(EFFORT, o.efforts, f.effort)}</select></label>
          <label>Permissions<select name="mode">${opt(MODE, o.modes, f.permissionMode)}</select></label>
        </div>
        <label class="check"><input type="checkbox" name="worktree" ${f.worktree ? 'checked' : ''}><span>Work in a new git worktree (<code>--worktree</code>)</span></label>
      </form>
      <footer><p class="err" id="na-err" role="alert" ${L.err ? '' : 'hidden'}>${esc(L.err)}</p><span class="spacer"></span>
        <button class="ghost" type="button" data-na="close">Cancel</button><button class="primary" type="button" data-na="review">Review…</button></footer>${live}`;
  }
  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error || `Server returned ${res.status}`), { status: res.status });
    return out;
  };
  const fail = e => (e instanceof TypeError ? "the Agentville server isn't reachable." : e.message);
  async function review() {
    read();
    // Never a disabled button: say what's missing and go there.
    const miss = !L.form.cwd ? ['cwd', 'Pick a project.'] : !L.form.prompt.trim() ? ['prompt', 'Write a prompt for the new agent.'] : null;
    if (miss) { [L.field, L.err] = miss; render(); return sheet.querySelector(`[name="${miss[0]}"]`)?.focus(); }
    L.err = ''; L.field = '';
    try {
      L.preview = await post('/api/act/preview', { kind: 'start', ...L.form });
      L.view = 'review';
      render();
      sheet.querySelector('[data-na="start"]')?.focus();
    } catch (e) {
      L.err = `Can't start it: ${fail(e)}`;
      L.field = /prompt/i.test(e.message) ? 'prompt' : /name/i.test(e.message) ? 'name' : /project/i.test(e.message) ? 'cwd' : '';
      render();
      (L.field ? sheet.querySelector(`[name="${L.field === 'name' ? 'aname' : L.field}"]`) : sheet.querySelector('[data-na="review"]'))?.focus();
    }
  }
  async function start() {
    L.view = 'starting'; L.err = '';
    render();
    try {
      L.result = await post('/api/act/run', { confirm: L.preview.confirm });
      L.view = 'started';
      L.form.prompt = ''; L.form.name = '';
      render();
      sheet.querySelector('#na-title')?.focus();
      document.getElementById('na-live').textContent = `Started ${L.result.name || 'the agent'}`;
      app.refresh();
    } catch (e) {
      L.view = 'review';
      if (e.status === 409) { L.view = 'form'; L.err = 'That confirmation expired. Review it again.'; } else L.err = `Couldn't start it: ${fail(e)}`;
      render();
      sheet.querySelector(L.view === 'form' ? '[data-na="review"]' : '[data-na="start"]')?.focus();
    }
  }
  sheet.addEventListener('click', e => {
    const t = e.target.closest('[data-na]');
    if (!t) return;
    switch (t.dataset.na) {
      case 'close': return sheet.close();
      case 'review': return review();
      case 'back': L.view = 'form'; L.err = ''; render(); return sheet.querySelector('[name="prompt"]')?.focus();
      case 'start': return start();
      case 'show': sheet.close(); return app.openDetail(t.dataset.id);
    }
  });
  sheet.addEventListener('submit', e => { e.preventDefault(); review(); });
  sheet.addEventListener('input', e => { if (L.field && e.target.name && L.err) { L.err = ''; L.field = ''; e.target.removeAttribute('aria-invalid'); const p = sheet.querySelector('#na-err'); if (p) p.hidden = true; } });
  sheet.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && L.view === 'form') { e.preventDefault(); review(); } });
  // While the result shows, a poll that brings the new job in turns "appears soon" into "Show it".
  function update() { if (sheet.open && L.view === 'started' && L.result?.jobId && !sheet.querySelector('[data-na="show"]') && S.agents.some(x => x.jobId === L.result.jobId)) render(); }
  return { open, update, isOpen: () => sheet.open };
}
