// The terminal view: the agent's terminal takes the centre of the app (#stage) while the village or
// list and the inspector compress to the sides (main.js owns the layout and the saved view). The
// server runs the agent's own command in a PTY (it chooses the command; we only name the agent) and
// streams it over a one-ticket WebSocket. One terminal at a time: switching agents or leaving the
// view only detaches; the PTY lives on for 10 min and re-attaching replays its recent output.
//
// A socket that drops while the process is still running (a server restart, sleep, a network
// blip) reconnects on its own, with backoff, for as long as the view is open, and at once when
// the page comes back (online, visible, focused) or when a key is pressed. Keys pressed while
// disconnected are dropped, never queued: replaying them blind (an Enter, a "y") into whatever
// the agent shows after the reconnect could submit or approve something nobody saw. The overlay
// says so instead. A reconnect only re-attaches: a process that exited, was stopped or ended idle
// while the page was away stays ended (the server checks, by boot id); "Start again" starts it.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { BUCKET_NAME, ROLE_NAME, isError, bucketIcon, icon, esc } from './ui.js';

const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createTermView(app, { termName, terminal, onClose }) {
  const { S } = app;
  const stage = document.getElementById('stage');
  let cur = null; // { id, name, term, fit, ws, ro, exited, state, cols, rows, boot, tries, timer, busy, restarting, ping }

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
    <div class="termwrap"><div class="termhost"></div><div class="termnotice" role="status" aria-live="polite" hidden></div></div>
    <p class="helper termhint">Every key goes to the terminal, Esc included. Shift+Esc closes it; the session keeps running.</p>`;
  const host = stage.querySelector('.termhost');
  const notice = stage.querySelector('.termnotice');
  const BACKOFF = [500, 1000, 2000, 4000, 8000, 10000];

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
  /** The overlay over the terminal while it can't take keys; `dropped` once a key was not sent. */
  function setNotice(text, { dropped = false } = {}) {
    notice.hidden = !text;
    notice.textContent = text || '';
    notice.classList.toggle('dropped', !!text && dropped);
  }
  const reconnecting = c => (c.restarting ? 'Server restarting — reconnecting…' : 'Reconnecting…');
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

  /**
   * Get a ticket and open the socket. `auto`: a reconnect after the socket dropped, which only
   * re-attaches (the server refuses with 410 if the session ended meanwhile) and keeps retrying.
   */
  async function connect({ auto = false } = {}) {
    const c = cur;
    if (!c || c.busy) return;
    clearTimeout(c.timer); c.timer = 0;
    dropSocket(c);
    c.busy = true;
    showErr('');
    if (!auto) { c.exited = false; c.restarting = false; c.tries = 0; c.boot = null; setNotice(''); }
    setStatus(auto ? reconnecting(c) : 'Connecting…');
    let res, body;
    try {
      res = await fetch(`/api/term/${encodeURIComponent(c.id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(auto && c.boot ? { reattach: c.boot } : {}),
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      res = null; body = { error: e?.message };
    }
    c.busy = false;
    if (cur !== c) return;
    if (!res || !res.ok) {
      if (auto && res?.status === 410 && body.ended) return ended(c, body.why);
      // Unreachable, restarting (5xx), closing (409) or busy (429): try again while the view is open.
      if (auto && (!res || res.status >= 500 || res.status === 409 || res.status === 429)) return retry(c);
      setStatus("Couldn't start the terminal", { again: 'Try again' });
      setNotice('');
      showErr(!res ? "Couldn't connect: the Agentville server isn't reachable." : body.error || `Server returned ${res.status}`);
      return;
    }
    c.boot = body.boot || c.boot;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/term/ws?ticket=${encodeURIComponent(body.ticket)}`);
    ws.binaryType = 'arraybuffer';
    c.ws = ws;
    c.cols = c.rows = 0;
    let attached = false;
    ws.onmessage = ev => {
      if (cur !== c || c.ws !== ws) return;
      if (typeof ev.data !== 'string') { c.term.write(new Uint8Array(ev.data)); return; }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'attached') {
        attached = true; c.live = true;
        c.term.reset(); // the replay that follows redraws the screen
        c.tries = 0; c.restarting = false;
        setStatus('Attached');
        setNotice('');
        fitNow();
        // The Reconnect / Start again button had the keyboard: give it back to the terminal.
        const f = document.activeElement;
        if (!f || f === document.body || (stage.contains(f) && !f.closest('.xterm'))) c.term.focus();
      } else if (m.type === 'pong') { clearTimeout(c.ping); c.ping = 0; }
      else if (m.type === 'ending') {
        if (m.why === 'server-restart') { c.restarting = true; setStatus(reconnecting(c)); }
        else setStatus(m.why === 'popout' ? `Moving to ${termName()}…` : 'Ending…');
      } else if (m.type === 'exit') {
        if (m.why === 'shutdown') { c.restarting = true; return; } // the server going down, not the process
        c.exited = true;
        setNotice('');
        setStatus(m.why === 'popout' ? `Popped out to ${termName()}` : m.why === 'idle' ? 'Ended after 10 idle minutes'
          : `Process exited (${m.signal ? `signal ${m.signal}` : `code ${m.code}`})`, { again: 'Start again' });
        app.refresh?.();
      }
    };
    ws.onclose = ev => {
      if (cur !== c || c.ws !== ws) return;
      c.ws = null; c.live = false;
      clearTimeout(c.ping); c.ping = 0;
      if (c.exited) return;
      if (ev.code === 1012) c.restarting = true;
      // Closed as "exited" without the exit message: ended, and never restarted for it.
      if (attached && ev.code === 1000 && ev.reason === 'exited') return ended(c, 'exit');
      if (attached) reconnectSoon(c); else retry(c); // refused before attaching: back off
    };
  }

  /** Forget a socket without waiting for it to close (a dead one can take minutes to say so). */
  function dropSocket(c) {
    clearTimeout(c.ping); c.ping = 0;
    c.live = false;
    const ws = c.ws;
    if (!ws) return;
    c.ws = null;
    ws.onmessage = ws.onclose = null;
    try { ws.close(1000); } catch { /* closed */ }
  }

  /** The session ended while the page was away: say why, and leave it to "Start again". */
  function ended(c, why) {
    c.exited = true;
    setNotice('');
    setStatus(why === 'idle' ? 'Ended after 10 idle minutes' : why === 'stop' ? 'Stopped'
      : why === 'popout' ? `Popped out to ${termName()}` : 'Process ended', { again: 'Start again' });
    app.refresh?.();
  }

  /** The first reconnect goes out at once; failures back off 0.5 s, 1 s, 2 s … up to 10 s. */
  function reconnectSoon(c) {
    if (cur !== c || c.exited) return;
    setStatus(reconnecting(c));
    if (notice.hidden) setNotice(`${reconnecting(c)} The process is still running.`);
    connect({ auto: true });
  }
  function retry(c) {
    if (cur !== c || c.exited) return;
    const ms = BACKOFF[Math.min(c.tries++, BACKOFF.length - 1)];
    setStatus(reconnecting(c));
    if (notice.hidden) setNotice(`${reconnecting(c)} The process is still running.`);
    clearTimeout(c.timer);
    c.timer = setTimeout(() => { c.timer = 0; if (cur === c) connect({ auto: true }); }, ms);
  }

  /** Back from sleep, offline or another app: reconnect now if dropped, or check an open socket. */
  function wake() {
    const c = cur;
    if (!c || c.exited || c.busy) return;
    if (!c.ws) {
      if (c.timer) { c.tries = 0; connect({ auto: true }); }
      return;
    }
    if (c.ws.readyState !== 1 || c.ping) return;
    // A socket can look open after sleep yet be dead: no pong in 3 s and it is replaced.
    try { c.ws.send('{"type":"ping"}'); } catch { /* closing */ }
    c.ping = setTimeout(() => { c.ping = 0; if (cur === c && c.ws) { dropSocket(c); reconnectSoon(c); } }, 3000);
  }
  addEventListener('online', wake);
  addEventListener('focus', wake);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

  /** A key while there is no socket: it is not sent (see the top); say so and reconnect now. */
  function dropped(c) {
    if (c.exited) {
      setNotice('Not sent: this session has ended. Use Start again to run it again.', { dropped: true });
      return;
    }
    setNotice('Reconnecting — what you just typed was not sent. Typing works again in a moment.', { dropped: true });
    if (!c.busy && !c.ws) { c.tries = 0; connect({ auto: true }); }
  }

  /** Close the socket and drop the xterm; the PTY is left running on the server. */
  function detach() {
    const c = cur;
    if (!c) return;
    cur = null;
    clearTimeout(c.timer);
    c.ro.disconnect();
    dropSocket(c);
    c.term.dispose();
    host.replaceChildren();
    setNotice('');
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
    cur = { id: a.id, name: a.name, term, fit, ws: null, exited: false, state: '', cols: 0, rows: 0, boot: null, tries: 0, timer: 0, busy: false, restarting: false, ping: 0, live: false };
    stage._sig = '';
    header();
    term.open(host);
    const c = cur;
    term.onData(d => {
      if (c.live && c.ws?.readyState === 1) c.ws.send(JSON.stringify({ type: 'input', data: d }));
      else dropped(c);
    });
    c.ro = new ResizeObserver(() => fitNow());
    c.ro.observe(host);
    fitNow();
    connect();
    term.focus();
  }

  function close() { onClose(); }

  // A click anywhere in the terminal area that isn't a control gives the keyboard to the terminal.
  stage.addEventListener('mouseup', e => {
    if (!cur || e.button !== 0 || e.target.closest('button, a, input, textarea, select')) return;
    cur.term.focus();
  });

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
