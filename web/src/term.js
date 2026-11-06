// The terminal view: the agent's terminal takes the centre of the app (#stage) while the village or
// list and the inspector compress to the sides (main.js owns the layout and the saved view). The
// server runs the agent's own command in a PTY (it chooses the command; we only name the agent) and
// streams it over a one-ticket WebSocket. One terminal at a time: switching agents or leaving the
// view only detaches; the PTY lives on for 10 min and re-attaching replays its recent output.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { BUCKET_NAME, ROLE_NAME, isError, bucketIcon, icon, esc } from './ui.js';

const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createTermView(app, { termName, terminal, onClose }) {
  const { S } = app;
  const stage = document.getElementById('stage');
  let cur = null; // { id, name, term, fit, ws, ro, host, exited, state, cols, rows }

  stage.innerHTML = `<header class="termhead">
      <button class="ghost tback" type="button" data-tact="close" aria-label="Back (Shift+Esc)">← Back</button>
      <span class="tglyph"></span><h2 class="tname"></h2><span class="tbadge"></span>
      <span class="termstatus" role="status" aria-live="polite"></span>
      <span class="spacer"></span>
      <button class="ghost" type="button" data-tact="popout"></button>
      <button class="ghost" type="button" data-tact="stop" title="End the process running in this terminal">Stop</button>
      <button class="ghost tclose" type="button" data-tact="close" title="Close (Shift+Esc). The session keeps running for 10 minutes.">Close</button>
    </header>
    <p class="helper term-err" role="alert" hidden></p>
    <div class="termhost"></div>
    <p class="helper termhint">Every key goes to the terminal, Esc included. Shift+Esc closes it; the session keeps running.</p>`;
  const host = stage.querySelector('.termhost');

  function theme() {
    return {
      background: token('--bg'), foreground: token('--text'), cursor: token('--text'), cursorAccent: token('--bg'),
      selectionBackground: token('--surface-3'), black: token('--surface-2'), brightBlack: token('--text-dim'),
      red: token('--error'), green: token('--building'), yellow: token('--stalled'), blue: token('--waiting'),
      white: token('--text-muted'), brightWhite: token('--text'),
    };
  }
  function setStatus(text, { again = null } = {}) {
    const s = stage.querySelector('.termstatus');
    s.innerHTML = `${esc(text)}${again ? ` — <button class="linkbtn inline" type="button" data-tact="reconnect">${esc(again)}</button>` : ''}`;
    if (cur) cur.state = text;
  }
  function showErr(msg) {
    const p = stage.querySelector('.term-err');
    p.textContent = msg || '';
    p.hidden = !msg;
  }

  /** Header from the latest data: role glyph, name, bucket badge (called on every render). */
  function header() {
    if (!cur) return;
    const a = S.byId.get(cur.id) || S.data?.agents?.find(x => x.id === cur.id);
    const name = a?.name || cur.name;
    const sig = [name, a?.role, a?.bucket, a?.severity, terminal()].join('|');
    if (stage._sig === sig) return;
    stage._sig = sig;
    stage.setAttribute('aria-label', `Terminal: ${name}`);
    stage.querySelector('.tglyph').innerHTML = a ? icon(a.role in ROLE_NAME ? a.role : 'solo', 'px role') : '';
    stage.querySelector('.tname').textContent = name;
    stage.querySelector('.tbadge').innerHTML = a ? `<span class="pill b-${isError(a) ? 'error' : a.bucket}">${icon(bucketIcon(a))}${isError(a) ? 'Error' : BUCKET_NAME[a.bucket]}</span>` : '';
    const pop = stage.querySelector('[data-tact="popout"]');
    pop.hidden = !terminal();
    if (pop.getAttribute('aria-busy') !== 'true') pop.textContent = `Pop out to ${termName()}`;
  }

  let sizeTimer = 0;
  function fitNow() {
    if (!cur) return;
    try { cur.fit.fit(); } catch { return; }
    clearTimeout(sizeTimer); // the PTY hears the final size, not every frame of a transition
    sizeTimer = setTimeout(() => {
      if (!cur) return;
      const { cols, rows } = cur.term;
      if ((cols !== cur.cols || rows !== cur.rows) && cur.ws?.readyState === 1) {
        cur.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        cur.cols = cols; cur.rows = rows;
      }
    }, 60);
  }

  async function connect() {
    const c = cur;
    if (!c) return;
    showErr('');
    setStatus('Connecting…');
    c.exited = false;
    c.term.reset();
    let body;
    try {
      const res = await fetch(`/api/term/${encodeURIComponent(c.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
    } catch (e) {
      if (cur !== c) return;
      setStatus("Couldn't start the terminal", { again: 'Try again' });
      showErr(e instanceof TypeError ? "Couldn't connect: the Agentville server isn't reachable." : e.message);
      return;
    }
    if (cur !== c) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/term/ws?ticket=${encodeURIComponent(body.ticket)}`);
    ws.binaryType = 'arraybuffer';
    c.ws = ws;
    c.cols = c.rows = 0;
    ws.onmessage = ev => {
      if (cur !== c) return;
      if (typeof ev.data !== 'string') { c.term.write(new Uint8Array(ev.data)); return; }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'attached') { setStatus('Attached'); fitNow(); }
      else if (m.type === 'ending') setStatus(m.why === 'popout' ? `Moving to ${termName()}…` : 'Ending…');
      else if (m.type === 'exit') {
        c.exited = true;
        setStatus(m.why === 'popout' ? `Popped out to ${termName()}` : m.why === 'idle' ? 'Ended after 10 idle minutes'
          : `Process exited (${m.signal ? `signal ${m.signal}` : `code ${m.code}`})`, { again: 'Start again' });
        app.refresh?.();
      }
    };
    ws.onclose = () => {
      if (cur !== c || c.ws !== ws) return;
      c.ws = null;
      if (!c.exited) setStatus('Disconnected', { again: 'Reconnect' });
    };
  }

  /** Close the socket and drop the xterm; the PTY is left running on the server. */
  function detach() {
    const c = cur;
    if (!c) return;
    cur = null;
    c.ro.disconnect();
    if (c.ws) { const ws = c.ws; c.ws = null; try { ws.close(1000); } catch { /* closed */ } }
    c.term.dispose();
    host.replaceChildren();
    showErr('');
  }

  function attach(a) {
    if (cur?.id === a.id) { cur.term.focus(); return; }
    detach();
    const term = new Terminal({
      fontFamily: token('--mono') || 'ui-monospace, Menlo, monospace', fontSize: 13, lineHeight: 1.15,
      theme: theme(), cursorBlink: true, scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Shift+Esc closes the terminal view; every other key (Esc included) belongs to the terminal.
    term.attachCustomKeyEventHandler(e => {
      if (e.key === 'Escape' && e.shiftKey) {
        if (e.type === 'keydown') { e.preventDefault(); close(); }
        return false;
      }
      return true;
    });
    cur = { id: a.id, name: a.name, term, fit, ws: null, exited: false, state: '', cols: 0, rows: 0 };
    stage._sig = '';
    header();
    term.open(host);
    const c = cur;
    term.onData(d => { if (c.ws?.readyState === 1) c.ws.send(JSON.stringify({ type: 'input', data: d })); });
    c.ro = new ResizeObserver(() => fitNow());
    c.ro.observe(host);
    fitNow();
    connect();
    term.focus();
  }

  function close() { onClose(); }

  stage.addEventListener('click', async e => {
    const b = e.target.closest('[data-tact]');
    if (!b) return;
    const c = cur;
    const act = b.dataset.tact;
    if (act === 'close') return close();
    if (!c) return;
    if (act === 'reconnect') return connect();
    if (b.disabled) return;
    const label = b.textContent;
    b.disabled = true; b.setAttribute('aria-busy', 'true');
    if (act === 'popout') b.textContent = 'Popping out…';
    showErr('');
    try {
      const res = await fetch(`/api/term/${encodeURIComponent(c.id)}${act === 'popout' ? '/popout' : ''}`, act === 'popout'
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.closed && cur === c) { c.exited = true; setStatus('Process ended', { again: 'Start again' }); }
        throw new Error(body.error || `Server returned ${res.status}`);
      }
      if (act === 'popout') { app.toast(`Opened ${c.name} in ${termName()}`); if (cur === c) close(); }
    } catch (err) {
      if (cur === c) showErr(err instanceof TypeError ? "Couldn't reach the Agentville server." : err.message);
    } finally {
      b.disabled = false; b.removeAttribute('aria-busy');
      if (b.dataset.tact === 'popout') b.textContent = `Pop out to ${termName()}`; else b.textContent = label;
    }
  });

  return {
    attach,
    detach,
    header,
    fit: fitNow,
    activeId: () => cur?.id || null,
    focus: () => cur?.term.focus(),
  };
}
