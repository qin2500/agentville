// The terminal view: the agent's terminal takes the centre of the app (#stage) while the village or
// list compresses to a column on the left (main.js owns the layout and the saved view). The
// server runs the agent's own command in a PTY (it chooses the command; we only name the agent) and
// streams it over a one-ticket WebSocket.
//
// The last few terminals opened stay alive, hidden, with their sockets open (KEEP): switching back
// to one, or closing and reopening it, shows it at once exactly as it was (content, scroll
// position, selection), with no reset, replay or "Connecting…". Leaving the view only hides; the
// PTY lives on, and a terminal evicted from the set (or hidden for HIDDEN_MS) only detaches. A
// (re-)attach gets a snapshot of the screen from the server (server/term-screen.mjs), never a replay
// of raw output: that kept the modes an app set (mouse tracking: the wheel) only while the start of
// the stream was still in the buffer, and redrew output meant for other widths.
//
// Sizes: only the terminal on screen is ever fitted, and only while its host is laid out (not
// hidden, not mid-transition, not zero-sized); nothing below MIN_COLS × MIN_ROWS ever reaches the
// PTY (the server refuses it too). A terminal shown again, or (re-)attached, asks the server for a
// repaint (SIGWINCH at its real size), so a TUI redraws whatever was drawn while it was away.
//
// A socket that drops while the process is still running (a server restart, sleep, a network
// blip) reconnects on its own, with backoff, and at once when the page comes back (online,
// visible, focused) or when a key is pressed. Keys pressed while disconnected are dropped, never
// queued: replaying them blind (an Enter, a "y") into whatever the agent shows after the reconnect
// could submit or approve something nobody saw. The overlay says so instead. A reconnect only
// re-attaches: a process that exited, was stopped or ended idle stays ended (the server checks, by
// boot id); "Start again" starts it.
//
// Splits (multiplex), as in Ghostty: dragging an agent from the list onto the terminal splits the
// pane under the pointer on the edge nearest to it (the half it will take is highlighted), and the
// agent's terminal opens there. The layout is a binary tree (mux-model.js); panes nest without
// limit, dividers drag, a click focuses a pane (the header, Stop and the find bar follow the focused
// one), × closes one and its sibling takes the space. Every pane is its own live session; the KEEP
// set is on top of the panes on screen. Leaving the view keeps the layout; opening one of its
// agents again brings it all back. "Pop out layout to Ghostty" ends every pane's embedded process
// (the one-place rule of Pop out) and rebuilds the same splits in one Ghostty window
// (server/ghostty-layout.mjs). Keys: ⌘⌥-arrows focus the pane that way, ⌘[ / ⌘] the previous or
// next, ⌘⌃-arrows move a divider, ⌘⌃= equalizes, ⌘⇧W closes the focused pane (Ctrl+Alt / Ctrl+Shift
// elsewhere).
import * as Mux from './mux-model.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { BUCKET_NAME, ROLE_NAME, isError, bucketIcon, icon, esc } from './ui.js';

const MIN_COLS = 20, MIN_ROWS = 5; // as server/term-screen.mjs
const MAX_COLS = 500, MAX_ROWS = 300;
const KEEP = 4; // live terminals kept for instant switching (the one on screen included)
const HIDDEN_MS = 10 * 60_000; // a terminal hidden this long detaches, so its PTY can end idle
const BACKOFF = [500, 1000, 2000, 4000, 8000, 10000];
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
// The DOM renderer by default: WebGL mis-measured cells in the desktop app (tiny, widely spaced glyphs).
// WebGL only on request with ?webgl.
const WEBGL = params.has('webgl');
const HOLD_MS = 2000; // keys typed while a terminal is still attaching are held this long, then dropped
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? '⌘' : 'Ctrl+';
const token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createTermView(app, { termName, terminal, onClose, onFocus = () => {}, termBlock = () => null }) {
  const { S } = app;
  const stage = document.getElementById('stage');
  const live = new Map(); // agentId -> session, least recently shown first
  let cur = null; // the focused session (the header, Stop, find and the overlays are its)
  let layout = null; // the split tree of agent ids on screen (mux-model.js), kept while the view is closed
  let open = false; // the view is showing
  let lastSize = null; // the size the focused terminal last had: a new one starts at it
  let resizing = false; // a divider is being dragged: fits wait for it to rest

  stage.innerHTML = `<header class="termhead">
      <button class="ghost tback" type="button" data-tact="close" aria-label="Back (Shift+Esc)">← Back</button>
      <span class="tglyph"></span><h2 class="tname" tabindex="0" title="Right-click (or Shift+F10) for its actions"></h2><span class="tbadge"></span>
      <span class="termstatus" role="status" aria-live="polite"></span>
      <span class="spacer"></span>
      <button class="ghost" type="button" data-tact="popout"></button>
      <button class="ghost" type="button" data-tact="stop" title="End the process running in this terminal">Stop</button>
      <button class="ghost tclose" type="button" data-tact="close" title="Close (Shift+Esc). The session keeps running for 10 minutes.">Close</button>
    </header>
    <p class="helper term-err" role="alert" hidden></p>
    <div class="termwrap">
      <div class="mux"></div>
      <div class="mpark" hidden></div>
      <div class="mcatch" aria-hidden="true"></div>
      <div class="mdrop" aria-hidden="true" hidden><span></span></div>
      <div class="termfind" role="search" hidden>
        <input type="search" aria-label="Find in terminal" placeholder="Find" spellcheck="false" autocomplete="off">
        <span class="findcount" aria-live="polite"></span>
        <button class="iconbtn" type="button" data-tact="findprev" aria-label="Previous match (Shift+Enter)" title="Previous (Shift+Enter)">↑</button>
        <button class="iconbtn" type="button" data-tact="findnext" aria-label="Next match (Enter)" title="Next (Enter)">↓</button>
        <button class="iconbtn" type="button" data-tact="findclose" aria-label="Close find (Esc)" title="Close (Esc)">×</button>
      </div>
      <div class="termnotice" role="status" aria-live="polite" hidden></div>
      <button class="termjump" type="button" data-tact="bottom" hidden>↓ Latest</button>
    </div>
    <p class="helper termhint">Every key goes to the terminal, Esc included. Shift+Esc closes it; the session keeps running. ${MOD}F finds, ${MOD}K clears the view, ${MOD}-click opens a link. Drag an agent from the list onto the terminal to split it.</p>`;
  const wrap = stage.querySelector('.termwrap');
  const notice = stage.querySelector('.termnotice');
  const jump = stage.querySelector('.termjump');
  const find = stage.querySelector('.termfind');
  const findInput = find.querySelector('input');
  const findCount = find.querySelector('.findcount');
  const mux = stage.querySelector('.mux');
  const park = stage.querySelector('.mpark');
  const catcher = stage.querySelector('.mcatch');
  const drop = stage.querySelector('.mdrop');
  const main = () => document.getElementById('main');

  function theme() {
    return {
      background: token('--bg'), foreground: token('--text'), cursor: token('--text'), cursorAccent: token('--bg'),
      selectionBackground: token('--surface-3'), black: token('--surface-2'), brightBlack: token('--text-dim'),
      red: token('--error'), green: token('--building'), yellow: token('--stalled'), blue: token('--waiting'),
      white: token('--text-muted'), brightWhite: token('--text'),
    };
  }

  // ---------- the header and overlays show the state of the session on screen ----------
  function setStatus(c, text, { again = null } = {}) {
    c.status = { text, again };
    if (c === cur) paintStatus();
    paintBar(c);
  }
  function paintStatus() {
    const s = stage.querySelector('.termstatus');
    const { text = '', again = null } = cur?.status || {};
    s.innerHTML = `${esc(text)}${again ? ` — <button class="linkbtn inline" type="button" data-tact="reconnect">${esc(again)}</button>` : ''}`;
  }
  /** The overlay over the terminal while it can't take keys; `dropped` once a key was not sent. */
  function setNotice(c, text, { dropped = false } = {}) {
    c.notice = text ? { text, dropped } : null;
    if (c === cur) paintNotice();
  }
  function paintNotice() {
    const n = cur?.notice;
    notice.hidden = !n;
    notice.textContent = n?.text || '';
    notice.classList.toggle('dropped', !!n?.dropped);
  }
  const reconnecting = c => (c.restarting ? 'Server restarting — reconnecting…' : 'Reconnecting…');
  function showErr(c, msg) {
    c.err = msg || '';
    if (c === cur) paintErr();
  }
  function paintErr() {
    const p = stage.querySelector('.term-err');
    p.textContent = cur?.err || '';
    p.hidden = !cur?.err;
  }
  /** "↓ Latest" while scrolled up from the bottom; "↓ New output" once more arrived meanwhile. */
  function paintJump() {
    const c = cur;
    const b = c?.term.buffer.active;
    const up = !!b && b.viewportY < b.baseY;
    if (!up && c) c.unseen = false;
    jump.hidden = !up;
    jump.textContent = c?.unseen ? '↓ New output' : '↓ Latest';
    jump.classList.toggle('fresh', !!c?.unseen);
  }

  const agentOf = id => S.byId.get(id) || S.data?.agents?.find(x => x.id === id);
  /** A pane's own bar (shown once there are two or more): its name, and its state unless attached. */
  function paintBar(c) {
    if (!c.bar) return;
    const name = agentOf(c.id)?.name || c.name;
    const st = c.status?.text && c.status.text !== 'Attached' ? c.status.text : '';
    const sig = `${name}|${st}`;
    if (c.bar._sig === sig) return;
    c.bar._sig = sig;
    c.bar.querySelector('.tpname').textContent = name;
    c.bar.querySelector('.tpstat').textContent = st;
    c.bar.querySelector('.tpclose').setAttribute('aria-label', `Close the ${name} pane`);
    c.pane.setAttribute('aria-label', `Terminal: ${name}`);
  }
  const panes = () => Mux.count(layout);
  /** Header from the latest data: role glyph, name, bucket badge (called on every render). */
  function header() {
    if (!cur) return;
    for (const id of Mux.leaves(layout)) { const c = live.get(id); if (c) paintBar(c); }
    const a = agentOf(cur.id);
    const name = a?.name || cur.name;
    const sig = [cur.id, name, a?.role, a?.bucket, a?.severity, terminal(), panes()].join('|');
    if (stage._sig === sig) return;
    stage._sig = sig;
    stage.setAttribute('aria-label', `Terminal: ${name}`);
    stage.querySelector('.tglyph').innerHTML = a ? icon(a.role in ROLE_NAME ? a.role : 'solo', 'px role') : '';
    stage.querySelector('.tname').textContent = name;
    stage.querySelector('.tbadge').innerHTML = a ? `<span class="pill b-${isError(a) ? 'error' : a.bucket}">${icon(bucketIcon(a))}${isError(a) ? 'Error' : BUCKET_NAME[a.bucket]}</span>` : '';
    const pop = stage.querySelector('[data-tact="popout"]');
    pop.hidden = !terminal();
    if (pop.getAttribute('aria-busy') !== 'true') pop.textContent = popLabel();
    pop.title = whole() ? `Open these ${panes()} terminals in one ${termName()} window with the same splits` : '';
  }
  /** Pop out takes the whole layout when there are splits and the terminal can make them (Ghostty). */
  const whole = () => panes() > 1 && terminal() === 'ghostty';
  const popLabel = () => (whole() ? `Pop out layout to ${termName()}` : `Pop out to ${termName()}`);

  // ---------- sizes ----------
  /** Only a terminal on screen (a pane of the layout), laid out at a real size and not mid-transition, is measured. */
  const onScreen = c => !!c && open && !c.disposed && !c.pane.hidden && live.get(c.id) === c && Mux.has(layout, c.id);
  function measurable(c) {
    return onScreen(c) && !document.hidden && !stage.hidden && !c.host.hidden &&
      c.host.isConnected && c.host.offsetParent !== null && c.host.clientWidth > 0 && c.host.clientHeight > 0 &&
      !main()?.classList.contains('tv-anim');
  }
  function proposed(c) {
    let d;
    try { d = c.fit.proposeDimensions(); } catch { return null; }
    if (!d || !(d.cols >= MIN_COLS) || !(d.rows >= MIN_ROWS)) return null; // NaN, or a host collapsing
    return { cols: Math.min(d.cols, MAX_COLS), rows: Math.min(d.rows, MAX_ROWS) };
  }
  /** Fit a terminal on screen to its host; the PTY hears the final size (or a repaint) soon after. */
  function fitNow(c, { repaint = false } = {}) {
    if (c && repaint) c.repaint = true; // owed until it can be sent (after a transition, once shown)
    if (!measurable(c)) return;
    const d = proposed(c);
    if (!d) return;
    if (d.cols !== c.term.cols || d.rows !== c.term.rows) c.term.resize(d.cols, d.rows);
    if (c === cur) lastSize = d;
    clearTimeout(c.sizeTimer); // the PTY hears the final size, not every frame of a drag
    c.sizeTimer = setTimeout(() => sendSize(c), repaint ? 0 : 60);
  }
  function sendSize(c) {
    if (!measurable(c) || !c.live || c.ws?.readyState !== 1) return;
    const { cols, rows } = c.term;
    if (cols < MIN_COLS || rows < MIN_ROWS) return;
    if (cols === c.cols && rows === c.rows && !c.repaint) return;
    const repaint = c.repaint;
    c.repaint = false;
    c.ws.send(JSON.stringify({ type: 'resize', cols, rows, ...(repaint && { repaint: true }) }));
    c.cols = cols; c.rows = rows;
  }
  const fitAll = (opts) => { for (const id of Mux.leaves(layout)) fitNow(live.get(id), opts); };
  // Each pane's host is watched on its own: a pane is fitted when its own size really changes. While
  // a divider is dragged the fits wait until it rests a moment (the PTY hears only the final size).
  let roTimer = 0;
  const ro = new ResizeObserver(entries => {
    const changed = entries.map(e => e.target._session).filter(Boolean);
    if (!resizing) { for (const c of changed) fitNow(c); return; }
    clearTimeout(roTimer);
    roTimer = setTimeout(fitAll, 80);
  });

  // ---------- connection ----------
  /**
   * Get a ticket and open the socket. `auto`: a reconnect after the socket dropped, which only
   * re-attaches (the server refuses with 410 if the session ended meanwhile) and keeps retrying.
   */
  async function connect(c, { auto = false } = {}) {
    if (!c || c.disposed || c.busy) return;
    clearTimeout(c.timer); c.timer = 0;
    dropSocket(c);
    c.busy = true;
    showErr(c, '');
    if (!auto) { c.exited = false; c.restarting = false; c.tries = 0; c.boot = null; setNotice(c, ''); }
    setStatus(c, auto ? reconnecting(c) : 'Connecting…');
    let res, body;
    try {
      const size = { cols: c.term.cols, rows: c.term.rows }; // a new PTY starts at the size we show
      res = await fetch(`/api/term/${encodeURIComponent(c.id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(auto && c.boot ? { reattach: c.boot, ...size } : size),
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      res = null; body = { error: e?.message };
    }
    c.busy = false;
    if (c.disposed) return;
    if (!res || !res.ok) {
      if (auto && res?.status === 410 && body.ended) return ended(c, body.why);
      // Unreachable, restarting (5xx), closing (409) or busy (429): try again while it is kept.
      if (auto && (!res || res.status >= 500 || res.status === 409 || res.status === 429)) return retry(c);
      setStatus(c, "Couldn't start the terminal", { again: 'Try again' });
      setNotice(c, '');
      waiting(c, false);
      showErr(c, !res ? "Couldn't connect: the Agentville server isn't reachable." : body.error || `Server returned ${res.status}`);
      return;
    }
    c.boot = body.boot || c.boot;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/term/ws?ticket=${encodeURIComponent(body.ticket)}`);
    ws.binaryType = 'arraybuffer';
    c.ws = ws;
    let attached = false;
    ws.onmessage = ev => {
      if (c.disposed || c.ws !== ws) return;
      if (typeof ev.data !== 'string') {
        const bytes = new Uint8Array(ev.data);
        if (!c.snapshot) { c.term.write(bytes, () => noteOutput(c)); return; }
        // The snapshot: the screen as it is now, at the PTY's size. A full reset (RIS) in the same
        // batch of writes replaces what was there without an empty frame in between.
        c.snapshot = false;
        c.term.write('\x1bc');
        c.term.write(bytes, () => {
          if (c.disposed || c.ws !== ws) return;
          c.live = true;
          waiting(c, false);
          flushHeld(c);
          fitNow(c, { repaint: true }); // our real size, and a SIGWINCH so a TUI redraws at it
          if (c === cur) paintJump();
        });
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'attached') {
        attached = true;
        c.snapshot = true;
        // Draw the snapshot at the size it was taken; the fit after it reflows to ours.
        if (m.cols >= MIN_COLS && m.rows >= MIN_ROWS && (m.cols !== c.term.cols || m.rows !== c.term.rows)) c.term.resize(Math.min(m.cols, MAX_COLS), Math.min(m.rows, MAX_ROWS));
        c.cols = m.cols; c.rows = m.rows; // what the PTY has
        c.repaint = true;
        c.tries = 0; c.restarting = false;
        setStatus(c, 'Attached');
        setNotice(c, '');
        // The Reconnect / Start again button had the keyboard: give it back to the terminal.
        const f = document.activeElement;
        if (c === cur && (!f || f === document.body || (stage.contains(f) && !f.closest('.xterm, .termfind')))) c.term.focus();
      } else if (m.type === 'pong') { clearTimeout(c.ping); c.ping = 0; }
      else if (m.type === 'ending') {
        if (m.why === 'server-restart') { c.restarting = true; setStatus(c, reconnecting(c)); }
        else setStatus(c, m.why === 'popout' ? `Moving to ${termName()}…` : 'Ending…');
      } else if (m.type === 'exit') {
        if (m.why === 'shutdown') { c.restarting = true; return; } // the server going down, not the process
        c.exited = true; c.live = false;
        setNotice(c, '');
        setStatus(c, m.why === 'popout' ? `Popped out to ${termName()}` : m.why === 'idle' ? 'Ended after 10 idle minutes'
          : `Process exited (${m.signal ? `signal ${m.signal}` : `code ${m.code}`})`, { again: 'Start again' });
        app.refresh?.();
      }
    };
    ws.onclose = ev => {
      if (c.disposed || c.ws !== ws) return;
      c.ws = null; c.live = false;
      if (c.held) { c.held = null; if (!c.exited) setNotice(c, 'Reconnecting — what you just typed was not sent. Typing works again in a moment.', { dropped: true }); }
      clearTimeout(c.ping); c.ping = 0;
      if (c.exited) return;
      if (ev.code === 1012) c.restarting = true;
      // Closed as "exited" without the exit message: ended, and never restarted for it.
      if (attached && ev.code === 1000 && ev.reason === 'exited') return ended(c, 'exit');
      if (attached) reconnectSoon(c); else retry(c); // refused before attaching: back off
    };
  }
  /** Output arrived: while scrolled up, the jump button says there is more below. */
  function noteOutput(c) {
    if (c !== cur || c.unseen) return;
    const b = c.term.buffer.active;
    if (b.viewportY < b.baseY) { c.unseen = true; paintJump(); }
  }

  /** Forget a socket without waiting for it to close (a dead one can take minutes to say so). */
  function dropSocket(c) {
    clearTimeout(c.ping); c.ping = 0;
    c.live = false; c.snapshot = false; c.held = null;
    const ws = c.ws;
    if (!ws) return;
    c.ws = null;
    ws.onmessage = ws.onclose = null;
    try { ws.close(1000); } catch { /* closed */ }
  }

  /** The session ended while the page was away: say why, and leave it to "Start again". */
  function ended(c, why) {
    c.exited = true;
    setNotice(c, '');
    waiting(c, false);
    setStatus(c, why === 'idle' ? 'Ended after 10 idle minutes' : why === 'stop' ? 'Stopped'
      : why === 'popout' ? `Popped out to ${termName()}` : 'Process ended', { again: 'Start again' });
    app.refresh?.();
  }

  /** The first reconnect goes out at once; failures back off 0.5 s, 1 s, 2 s … up to 10 s. */
  function reconnectSoon(c) {
    if (c.disposed || c.exited) return;
    setStatus(c, reconnecting(c));
    if (!c.notice) setNotice(c, `${reconnecting(c)} The process is still running.`);
    connect(c, { auto: true });
  }
  function retry(c) {
    if (c.disposed || c.exited) return;
    const ms = BACKOFF[Math.min(c.tries++, BACKOFF.length - 1)];
    setStatus(c, reconnecting(c));
    if (!c.notice) setNotice(c, `${reconnecting(c)} The process is still running.`);
    clearTimeout(c.timer);
    c.timer = setTimeout(() => { c.timer = 0; connect(c, { auto: true }); }, ms);
  }

  /** Back from sleep, offline or another app: reconnect now if dropped, or check an open socket. */
  function wake(c) {
    if (!c || c.disposed || c.exited || c.busy) return;
    if (!c.ws) {
      if (c.timer) { c.tries = 0; connect(c, { auto: true }); }
      return;
    }
    if (c.ws.readyState !== 1 || c.ping) return;
    // A socket can look open after sleep yet be dead: no pong in 3 s and it is replaced.
    try { c.ws.send('{"type":"ping"}'); } catch { /* closing */ }
    c.ping = setTimeout(() => { c.ping = 0; if (!c.disposed && c.ws) { dropSocket(c); reconnectSoon(c); } }, 3000);
  }
  const wakeAll = () => { for (const c of live.values()) wake(c); };
  addEventListener('online', wakeAll);
  addEventListener('focus', wakeAll);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wakeAll(); fitAll(); } });

  /** A key while there is no socket: it is not sent (see the top); say so and reconnect now. */
  function dropped(c) {
    if (c.exited) {
      setNotice(c, 'Not sent: this session has ended. Use Start again to run it again.', { dropped: true });
      return;
    }
    setNotice(c, 'Reconnecting — what you just typed was not sent. Typing works again in a moment.', { dropped: true });
    if (!c.busy && !c.ws) { c.tries = 0; connect(c, { auto: true }); }
  }

  /** Keys typed in the moment between the socket opening and the screen arriving: sent once it is live. */
  function hold(c, d) {
    if (!c.held) { c.held = { data: '', at: Date.now() }; setTimeout(() => expireHeld(c), HOLD_MS); }
    if (c.held.data.length < 4096) c.held.data += d;
  }
  function expireHeld(c) {
    if (!c.held || c.disposed) return;
    c.held = null; // never live within the window: not sent, and said so
    dropped(c);
  }
  function flushHeld(c) {
    if (c.notice?.dropped) setNotice(c, '');
    const h = c.held; c.held = null;
    if (h && Date.now() - h.at <= HOLD_MS && c.ws?.readyState === 1) c.ws.send(JSON.stringify({ type: 'input', data: h.data }));
  }

  /** A quiet "Starting…" inside a terminal that has nothing to show yet, after a beat (no flash). */
  function waiting(c, on) {
    clearTimeout(c.waitTimer);
    if (on) c.waitTimer = setTimeout(() => { if (!c.live && !c.disposed) c.wait.hidden = false; }, 150);
    else c.wait.hidden = true;
  }

  // ---------- links, clipboard, find ----------
  /** Cmd-click (Ctrl-click) opens a link outside the app; the desktop app sends window.open to the browser. */
  function openLink(e, uri) {
    if (!(MAC ? e?.metaKey : e?.ctrlKey)) return;
    let u;
    try { u = new URL(uri); } catch { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    e.preventDefault?.();
    window.open(u.href, '_blank', 'noopener,noreferrer');
  }
  const linkHint = get => ({
    hover: (_e, uri) => { const c = get(); if (c) c.host.title = `${MOD}-click to open ${uri}`; },
    leave: () => { const c = get(); if (c) c.host.title = ''; },
  });

  async function copySelection(c) {
    const text = c.term.getSelection();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch {
      // No clipboard permission: the browser's own copy, from a scratch field.
      const t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.append(t); t.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      t.remove(); c.term.focus();
    }
  }

  function openFind() {
    if (!cur) return;
    find.hidden = false;
    const sel = cur.term.getSelection();
    if (sel && !sel.includes('\n')) findInput.value = sel;
    findInput.focus();
    findInput.select();
    if (findInput.value) runFind('next', { incremental: true });
  }
  function closeFind({ refocus = true } = {}) {
    if (find.hidden) return;
    find.hidden = true;
    findCount.textContent = '';
    for (const c of live.values()) { try { c.search.clearDecorations(); } catch { /* disposed */ } }
    if (refocus) cur?.term.focus();
  }
  const findColors = () => ({ matchBackground: token('--surface-3'), matchOverviewRuler: token('--text-muted'), activeMatchBackground: token('--stalled'), activeMatchColorOverviewRuler: token('--stalled') });
  function runFind(dir, { incremental = false } = {}) {
    if (!cur) return;
    const q = findInput.value;
    if (!q) { cur.search.clearDecorations(); findCount.textContent = ''; return; }
    const opts = { incremental, decorations: findColors() };
    const hit = dir === 'prev' ? cur.search.findPrevious(q, opts) : cur.search.findNext(q, opts);
    if (!hit) findCount.textContent = 'No matches';
  }
  findInput.addEventListener('input', () => runFind('next', { incremental: true }));
  findInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); runFind(e.shiftKey ? 'prev' : 'next'); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
    else if ((MAC ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); findInput.select(); }
  });

  // ---------- the set of live terminals ----------
  // A session's pane: its own bar (name, state, ×; shown with two or more panes) over its xterm. The
  // xterm opens once the pane is laid out (never measured in a hidden host).
  function create(a) {
    const pane = document.createElement('div');
    pane.className = 'tpane';
    pane.dataset.id = a.id;
    pane.setAttribute('role', 'group');
    const bar = document.createElement('div');
    bar.className = 'tpbar';
    bar.innerHTML = `<span class="tpname"></span><span class="tpstat"></span><button class="iconbtn tpclose" type="button" data-tact="pclose" title="Close this pane (${MAC ? '⌘⇧W' : 'Ctrl+Shift+W'}). The session keeps running for 10 minutes.">×</button>`;
    const host = document.createElement('div');
    host.className = 'termhost';
    const wait = document.createElement('div');
    wait.className = 'termwait';
    wait.hidden = true;
    wait.innerHTML = `<span class="dot" aria-hidden="true"></span>Starting ${esc(a.name || 'the terminal')}…`;
    pane.append(bar, host);
    park.append(pane);
    const size = lastSize || { cols: 100, rows: 30 };
    let c = null;
    const hint = linkHint(() => c);
    const term = new Terminal({
      fontFamily: token('--mono') || 'ui-monospace, Menlo, monospace', fontSize: 13, lineHeight: 1.15,
      theme: theme(), cursorBlink: true, cursorInactiveStyle: 'outline', scrollback: 5000,
      cols: size.cols, rows: size.rows, allowProposedApi: true, macOptionClickForcesSelection: true,
      // OSC 8 hyperlinks (Claude Code prints them): the same Cmd-click rule as plain URLs.
      linkHandler: { activate: openLink, ...hint },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon(openLink, hint));
    try { term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11'; } catch { /* the default widths */ }
    c = {
      id: a.id, name: a.name, pane, bar, host, wait, term, fit, search, ws: null, exited: false, status: null, notice: null, err: '',
      cols: 0, rows: 0, boot: null, tries: 0, timer: 0, busy: false, restarting: false, ping: 0, live: false, opened: false,
      snapshot: false, repaint: false, sizeTimer: 0, waitTimer: 0, hideTimer: 0, unseen: false, disposed: false, renderer: 'dom',
    };
    host._session = c;
    term.attachCustomKeyEventHandler(e => keys(c, e));
    const send = d => { if (c.live && c.ws?.readyState === 1) { c.ws.send(JSON.stringify({ type: 'input', data: d })); return true; } return false; };
    term.onData(d => {
      if (send(d)) { if (c.notice?.dropped) setNotice(c, ''); return; }
      // An open socket that is still attaching (the snapshot is on its way): hold the keys a moment.
      if (!c.exited && c.ws?.readyState === 1) { hold(c, d); return; }
      dropped(c);
    });
    term.onBinary(d => { send(d); }); // mouse reports in the legacy encoding
    term.onScroll(() => { if (c === cur) paintJump(); });
    search.onDidChangeResults?.(({ resultIndex, resultCount }) => {
      if (c !== cur || find.hidden) return;
      findCount.textContent = resultCount ? `${resultIndex + 1} of ${resultCount}${resultCount >= 1000 ? '+' : ''}` : 'No matches';
    });
    // A click or the keyboard landing in a pane focuses it.
    pane.addEventListener('pointerdown', () => focusPane(c), true);
    pane.addEventListener('focusin', () => focusPane(c));
    ro.observe(host);
    live.set(a.id, c);
    return c;
  }
  /** Open the xterm in its host, once, after the layout has placed the pane. */
  function openTerm(c) {
    if (c.opened || c.disposed) return;
    c.opened = true;
    c.term.open(c.host);
    c.host.append(c.wait);
    if (WEBGL) loadWebgl(c);
  }
  async function loadWebgl(c) {
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      if (c.disposed) return;
      const gl = new WebglAddon();
      gl.onContextLoss(() => { try { gl.dispose(); } catch { /* gone */ } c.renderer = 'dom'; }); // back to the DOM renderer
      c.term.loadAddon(gl);
      c.renderer = 'webgl';
    } catch { c.renderer = 'dom'; }
  }

  /** Keys the terminal does not get: Shift+Esc (close), the split keys, copy with a selection, paste, clear, find. */
  function keys(c, e) {
    if (e.key === 'Escape' && e.shiftKey) {
      if (e.type === 'keydown') { e.preventDefault(); close(); }
      return false;
    }
    // Shift+Enter: a new line, not send. ESC CR is what Claude Code's own terminal setup binds it to.
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.type === 'keydown') { e.preventDefault(); c.term.input('\x1b\r', true); }
      return false;
    }
    const split = muxKey(c, e);
    if (split) { if (e.type === 'keydown') { e.preventDefault(); split(); } return false; }
    const mod = MAC ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && e.shiftKey && !e.altKey;
    if (!mod) return true;
    const k = e.key.toLowerCase();
    if (k === 'c') {
      // With a selection it is copied; without one the key is the terminal's (Ctrl-C interrupts).
      if (!c.term.hasSelection()) return true;
      if (e.type === 'keydown') { e.preventDefault(); copySelection(c); }
      return false;
    }
    if (k === 'v') return false; // the browser's paste event: xterm brackets it if the app asked
    if (k === 'k') { if (e.type === 'keydown') { e.preventDefault(); c.term.clear(); paintJump(); } return false; }
    if (k === 'f') { if (e.type === 'keydown') { e.preventDefault(); openFind(); } return false; }
    return true;
  }
  const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  /**
   * Ghostty's split keys, only with two or more panes (alone, every key stays the terminal's).
   * macOS: ⌘⌥-arrow goto_split, ⌘[ ⌘] previous/next, ⌘⌃-arrow resize_split, ⌘⌃= equalize_splits,
   * ⌘⇧W close. Elsewhere Ctrl+Alt-arrow, Ctrl+Shift+[ ], Ctrl+Shift-arrow, Ctrl+Shift+=, Ctrl+Shift+W
   * (plain Ctrl+[ is Esc in a terminal).
   */
  function muxKey(c, e) {
    if (panes() < 2 || !Mux.has(layout, c.id)) return null;
    const dir = ARROWS[e.key], code = e.code;
    const go = id => () => { if (id) focusPane(live.get(id), { keys: true }); };
    if (MAC) {
      if (!e.metaKey) return null;
      if (dir && e.altKey && !e.ctrlKey && !e.shiftKey) return go(Mux.neighbor(layout, c.id, dir));
      if (dir && e.ctrlKey && !e.altKey && !e.shiftKey) return () => nudge(c, dir);
      if (code === 'Equal' && e.ctrlKey && !e.altKey) return equalize;
      if ((code === 'BracketLeft' || code === 'BracketRight') && !e.ctrlKey && !e.altKey && !e.shiftKey) return go(Mux.cycle(layout, c.id, code === 'BracketRight' ? 1 : -1));
      if (code === 'KeyW' && e.shiftKey && !e.ctrlKey && !e.altKey) return () => closePane(c);
      return null;
    }
    if (!e.ctrlKey || e.metaKey) return null;
    if (dir && e.altKey && !e.shiftKey) return go(Mux.neighbor(layout, c.id, dir));
    if (dir && e.shiftKey && !e.altKey) return () => nudge(c, dir);
    if (!e.shiftKey || e.altKey) return null;
    if (code === 'Equal') return equalize;
    if (code === 'BracketLeft' || code === 'BracketRight') return go(Mux.cycle(layout, c.id, code === 'BracketRight' ? 1 : -1));
    if (code === 'KeyW') return () => closePane(c);
    return null;
  }

  // ---------- the layout ----------
  /** Put the layout on screen: each pane into its split, the rest parked (hidden, kept live). */
  function renderLayout() {
    const ids = new Set(Mux.leaves(layout));
    const f = document.activeElement;
    const hadKeys = !!f && stage.contains(f) && !!f.closest('.tpane');
    const build = (n, path) => {
      if (Mux.isLeaf(n)) {
        const c = live.get(n.id);
        c.pane.hidden = false; c.host.hidden = false;
        return c.pane;
      }
      const el = document.createElement('div');
      el.className = 'msplit';
      el.dataset.dir = n.dir; // not a class: .row is the list's row
      const a = build(n.a, path + 'a'), b = build(n.b, path + 'b');
      a.style.flex = `${n.ratio} 1 0px`;
      b.style.flex = `${1 - n.ratio} 1 0px`;
      const d = document.createElement('div');
      d.className = 'mdiv';
      d.dataset.path = path;
      d.tabIndex = 0;
      d.setAttribute('role', 'separator');
      d.setAttribute('aria-orientation', n.dir === 'row' ? 'vertical' : 'horizontal');
      d.setAttribute('aria-valuenow', String(Math.round(n.ratio * 100)));
      d.setAttribute('aria-label', 'Resize the panes (drag, or the arrow keys)');
      el.append(a, d, b);
      return el;
    };
    for (const c of live.values()) if (!ids.has(c.id) && c.pane.parentElement !== park) park.append(c.pane);
    const root = layout ? build(layout, '') : null;
    if (root) root.style.flex = '1 1 0px';
    mux.replaceChildren(...(root ? [root] : []));
    mux.classList.toggle('single', ids.size <= 1);
    for (const id of ids) {
      const c = live.get(id);
      openTerm(c);
      paintBar(c);
      c.pane.classList.toggle('focused', c === cur);
    }
    if (hadKeys && cur && document.activeElement !== cur.term.textarea) cur.term.focus();
  }

  /** The session for agent `a`, kept or new; one that has ended starts afresh, as opening it always has. */
  function ensure(a) {
    let c = live.get(a.id);
    if (c && (c.exited || c.disposed)) { dispose(c); c = null; }
    const fresh = !c;
    if (fresh) c = create(a);
    clearTimeout(c.hideTimer); c.hideTimer = 0;
    live.delete(c.id); live.set(c.id, c); // most recently shown last
    return { c, fresh, hidden: fresh || c.pane.hidden };
  }

  /** Show the layout with `focusId` focused: start what is new, redraw what was hidden, hide what left. */
  function place(focusId) {
    const ids = Mux.leaves(layout);
    const placed = ids.map(id => ensure(agentOf(id) || { id, name: live.get(id)?.name || id }));
    for (const c of [...live.values()]) if (!ids.includes(c.id) && !c.pane.hidden) hide(c);
    renderLayout();
    focusPane(live.get(focusId) || live.get(ids[0]));
    for (const { c, fresh, hidden } of placed) {
      if (hidden) {
        // Draw what arrived while it was hidden, fit it to its pane, and have the app redraw at it.
        try { c.term.refresh(0, c.term.rows - 1); } catch { /* disposed */ }
        fitNow(c, { repaint: true });
      }
      if (fresh) { waiting(c, true); connect(c); }
      else if (!c.ws && !c.busy && !c.timer) connect(c, { auto: !!c.boot });
    }
    evict();
    cur?.term.focus();
  }

  /** Make `c` the focused pane: the header, Stop, find and the overlays follow it; the app hears. */
  function focusPane(c, { keys: giveKeys = false } = {}) {
    if (!c || !onScreen(c)) return;
    if (cur !== c) {
      if (cur) closeFind({ refocus: false });
      cur = c;
      c.pane.append(find, notice, jump);
      for (const id of Mux.leaves(layout)) { const p = live.get(id); p?.pane.classList.toggle('focused', p === c); }
      stage._sig = '';
      header();
      paintStatus(); paintNotice(); paintErr(); paintJump();
      onFocus(c.id);
    }
    if (giveKeys) c.term.focus();
  }

  function hide(c) {
    if (c.pane.contains(notice)) wrap.append(find, notice, jump);
    park.append(c.pane);
    c.pane.hidden = true;
    c.host.hidden = true;
    clearTimeout(c.sizeTimer);
    clearTimeout(c.hideTimer);
    c.hideTimer = setTimeout(() => dispose(c), HIDDEN_MS);
    if (cur === c) { closeFind({ refocus: false }); cur = null; }
  }
  /** Close its socket and drop the xterm; the PTY is left running on the server. */
  function dispose(c) {
    if (c.disposed) return;
    c.disposed = true;
    for (const t of [c.timer, c.sizeTimer, c.waitTimer, c.hideTimer]) clearTimeout(t);
    dropSocket(c);
    ro.unobserve(c.host);
    if (c.pane.contains(notice)) wrap.append(find, notice, jump);
    try { c.term.dispose(); } catch { /* gone */ }
    c.pane.remove();
    if (live.get(c.id) === c) live.delete(c.id);
    if (cur === c) { cur = null; paintStatus(); paintNotice(); paintErr(); paintJump(); }
  }
  /** KEEP terminals stay live besides the panes of the layout; the least recently shown go first. */
  function evict() {
    const limit = Mux.count(layout) + KEEP - 1;
    for (const c of [...live.values()]) {
      if (live.size <= limit) break;
      if (!Mux.has(layout, c.id)) dispose(c);
    }
  }

  /**
   * Show agent `a` (the list, its menu, a double-click). In the open view: its pane is focused if it
   * has one, else it takes the focused pane (as one terminal always did). Opening the view: the
   * layout it was left with comes back when it holds this agent; otherwise `a` opens alone.
   */
  function attach(a) {
    if (open && cur?.id === a.id && onScreen(cur)) { cur.term.focus(); return; }
    if (!open) {
      open = true;
      for (const id of Mux.leaves(layout)) if (id !== a.id && !agentOf(id)) layout = Mux.remove(layout, id);
      if (!Mux.has(layout, a.id)) layout = Mux.leaf(a.id);
    } else if (!Mux.has(layout, a.id)) {
      layout = cur && Mux.has(layout, cur.id) ? Mux.replace(layout, cur.id, a.id) : Mux.leaf(a.id);
    }
    place(a.id);
  }

  /** A drop: agent `id` beside the pane of `target`, on `side` of it (left / right / top / bottom). */
  function split(id, target, side) {
    if (!open || !layout) return false;
    const block = termBlock(id);
    if (block) { app.toast(block); return false; }
    const next = Mux.insert(layout, target, id, side);
    if (next === layout) return false;
    layout = next;
    place(id);
    return true;
  }

  /** × on a pane: it leaves the layout (its session kept live, as Close keeps it); its sibling takes the space. */
  function closePane(c) {
    if (!c || !Mux.has(layout, c.id)) return;
    const rest = Mux.remove(layout, c.id);
    if (!rest) return close();
    // The pane that takes its place gets the focus when the focused one closes.
    const route = Mux.pathTo(layout, c.id);
    const sib = Mux.leaves(Mux.at(layout, route.slice(0, -1) + (route.at(-1) === 'a' ? 'b' : 'a')))[0];
    const keep = cur && cur !== c ? cur.id : sib;
    layout = rest;
    hide(c);
    place(keep);
  }
  function nudge(c, dir) {
    const next = Mux.nudge(layout, c.id, dir, 0.05);
    if (next === layout) return;
    layout = next;
    renderLayout();
  }
  function equalize() {
    layout = Mux.equalize(layout);
    renderLayout();
  }

  /** Leave the view: every pane is hidden, kept live, and the layout comes back next time. */
  function detach() {
    open = false;
    for (const id of Mux.leaves(layout)) { const c = live.get(id); if (c && !c.pane.hidden) hide(c); }
    cur = null;
  }

  function close() { onClose(); }

  // ---------- dividers ----------
  mux.addEventListener('pointerdown', e => {
    const d = e.target.closest('.mdiv');
    if (!d || e.button !== 0) return;
    const path = d.dataset.path, node = Mux.at(layout, path);
    if (!node || Mux.isLeaf(node)) return;
    e.preventDefault();
    e.stopPropagation();
    const box = d.parentElement.getBoundingClientRect();
    const row = node.dir === 'row';
    const a = d.previousElementSibling, b = d.nextElementSibling;
    let ratio = node.ratio;
    d.setPointerCapture(e.pointerId);
    resizing = true;
    stage.classList.add('mux-resizing');
    const move = ev => {
      const r = row ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
      ratio = Math.min(Mux.MAX_RATIO, Math.max(Mux.MIN_RATIO, r));
      a.style.flex = `${ratio} 1 0px`;
      b.style.flex = `${1 - ratio} 1 0px`;
    };
    const up = () => {
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
      d.removeEventListener('pointercancel', up);
      layout = Mux.resize(layout, path, ratio);
      d.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      resizing = false;
      stage.classList.remove('mux-resizing');
      clearTimeout(roTimer);
      fitAll();
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', up);
  });
  // A focused divider moves with the arrow keys along its own axis.
  mux.addEventListener('keydown', e => {
    const d = e.target.closest?.('.mdiv');
    if (!d) return;
    const node = Mux.at(layout, d.dataset.path);
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!node || Mux.isLeaf(node) || !step || (node.dir === 'row') !== (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    e.preventDefault();
    const path = d.dataset.path;
    layout = Mux.resize(layout, path, node.ratio + step * 0.05);
    renderLayout();
    mux.querySelector(`.mdiv[data-path="${path}"]`)?.focus();
  });

  // ---------- drag an agent from the list onto the terminal ----------
  // Rows are draggable only while the terminal is open (elsewhere a drag pans or selects as before).
  // While one is dragged a catcher covers the panes (an xterm would not take the drop); the half the
  // new pane would take is highlighted, with what the drop does (or why it can't).
  const DRAG_TYPE = 'application/x-village-agent';
  const ROWS = '#list .row[data-id], #list .mrow[data-id], #list .tnode[data-id]';
  let dragId = null, dropAt = null;
  document.addEventListener('pointerdown', e => {
    const r = e.target.closest?.(ROWS);
    if (r) r.draggable = open && !!layout;
  }, true);
  document.addEventListener('dragstart', e => {
    const r = e.target.closest?.(ROWS);
    if (!r) return;
    if (!open || !layout) { e.preventDefault(); return; }
    dragId = r.dataset.id;
    e.dataTransfer.setData(DRAG_TYPE, dragId);
    e.dataTransfer.effectAllowed = 'copyMove';
    stage.classList.add('mux-dragging');
  });
  function endDrag() {
    dragId = null; dropAt = null;
    stage.classList.remove('mux-dragging');
    drop.hidden = true;
  }
  document.addEventListener('dragend', endDrag);
  /** The pane under a point, and the side of it nearest to the point. */
  function dropTarget(x, y) {
    for (const id of Mux.leaves(layout)) {
      const c = live.get(id);
      if (!c) continue;
      const r = c.pane.getBoundingClientRect();
      if (r.width && r.height && x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
        return { id, side: Mux.dropSide((x - r.left) / r.width, (y - r.top) / r.height), r };
      }
    }
    return null;
  }
  const SIDE_SAYS = { left: 'Split left', right: 'Split right', top: 'Split up', bottom: 'Split down' };
  catcher.addEventListener('dragover', e => {
    if (!dragId) return;
    const t = dropTarget(e.clientX, e.clientY);
    if (!t || t.id === dragId) { drop.hidden = true; dropAt = null; return; } // onto itself: nothing to do
    const block = termBlock(dragId);
    e.preventDefault();
    e.dataTransfer.dropEffect = block ? 'none' : 'move';
    dropAt = block ? null : t;
    const w = wrap.getBoundingClientRect(), h = Mux.sideRect(t.side);
    const appearing = drop.hidden; // it slides between zones, but appears where it is
    if (appearing) drop.style.transition = 'none';
    Object.assign(drop.style, {
      left: `${t.r.left - w.left + h.x * t.r.width}px`, top: `${t.r.top - w.top + h.y * t.r.height}px`,
      width: `${h.w * t.r.width}px`, height: `${h.h * t.r.height}px`,
    });
    drop.classList.toggle('no', !!block);
    drop.dataset.side = t.side;
    drop.dataset.target = t.id;
    drop.firstElementChild.textContent = block || SIDE_SAYS[t.side];
    drop.hidden = false;
    if (appearing) { void drop.offsetWidth; drop.style.transition = ''; }
  });
  catcher.addEventListener('dragleave', e => { if (!e.relatedTarget || !catcher.contains(e.relatedTarget)) { drop.hidden = true; dropAt = null; } });
  catcher.addEventListener('drop', e => {
    e.preventDefault();
    const t = dropAt, id = dragId;
    endDrag();
    if (t && id) split(id, t.id, t.side);
  });

  // A click anywhere in the terminal area that isn't a control gives the keyboard to the terminal.
  stage.addEventListener('mouseup', e => {
    if (!cur || e.button !== 0 || e.target.closest('button, a, input, textarea, select, .termfind, .mdiv')) return;
    cur.term.focus();
  });

  /** One Ghostty window with the same splits; every pane's embedded process ends first (server). */
  async function popoutLayout(b) {
    const c = cur;
    const n = panes();
    b.disabled = true; b.setAttribute('aria-busy', 'true'); b.textContent = 'Popping out…';
    showErr(c, '');
    try {
      const screen = c.host.querySelector('.xterm-screen') || c.host;
      const cell = { w: screen.clientWidth / c.term.cols, h: screen.clientHeight / c.term.rows };
      const res = await fetch('/api/termlayout/popout', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout, focus: c.id, cell, size: { w: mux.clientWidth, h: mux.clientHeight } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
      app.toast(`Opened ${n} terminals in one ${termName()} window`);
      if (open) close();
      layout = null; // it lives in Ghostty now: opening one of them again starts a single pane
    } catch (err) {
      if (!c.disposed) showErr(c, err instanceof TypeError ? "Couldn't reach the Village server." : err.message);
    } finally {
      b.disabled = false; b.removeAttribute('aria-busy');
      b.textContent = popLabel();
    }
  }

  stage.addEventListener('click', async e => {
    const b = e.target.closest('[data-tact]');
    if (!b) return;
    const act = b.dataset.tact;
    if (act === 'pclose') return closePane(live.get(b.closest('.tpane')?.dataset.id));
    const c = cur;
    if (act === 'close') return close();
    if (!c) return;
    if (act === 'reconnect') return connect(c);
    if (act === 'bottom') { c.term.scrollToBottom(); c.unseen = false; paintJump(); c.term.focus(); return; }
    if (act === 'findnext' || act === 'findprev') { runFind(act === 'findprev' ? 'prev' : 'next'); return; }
    if (act === 'findclose') return closeFind();
    if (b.disabled) return;
    if (act === 'popout' && whole()) return popoutLayout(b);
    const label = b.textContent;
    b.disabled = true; b.setAttribute('aria-busy', 'true');
    if (act === 'popout') b.textContent = 'Popping out…';
    showErr(c, '');
    try {
      const res = await fetch(`/api/term/${encodeURIComponent(c.id)}${act === 'popout' ? '/popout' : ''}`, act === 'popout'
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.closed && !c.disposed) { c.exited = true; setStatus(c, 'Process ended', { again: 'Start again' }); }
        throw new Error(body.error || `Server returned ${res.status}`);
      }
      if (act === 'popout') {
        app.toast(`Opened ${c.name} in ${termName()}`);
        // Alone it closes the view, as before; one pane of several just leaves the layout.
        if (open && Mux.has(layout, c.id)) { if (panes() > 1) closePane(c); else close(); }
      }
    } catch (err) {
      if (!c.disposed) showErr(c, err instanceof TypeError ? "Couldn't reach the Agentville server." : err.message);
    } finally {
      b.disabled = false; b.removeAttribute('aria-busy');
      if (b.dataset.tact === 'popout') b.textContent = popLabel(); else b.textContent = label;
    }
  });

  // ?debug: the state of the terminal on screen, for e2e checks.
  if (DEBUG) {
    window.villageTerm = () => {
      if (!cur) return { kept: [...live.keys()], layout };
      const b = cur.term.buffer.active;
      const rows = [];
      for (let y = b.viewportY; y < b.viewportY + cur.term.rows; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
      return {
        id: cur.id, kept: [...live.keys()], size: { cols: cur.term.cols, rows: cur.term.rows }, pty: { cols: cur.cols, rows: cur.rows },
        viewportY: b.viewportY, baseY: b.baseY, buffer: b.type, renderer: cur.renderer, live: cur.live,
        mouse: cur.term.modes.mouseTrackingMode, bracketedPaste: cur.term.modes.bracketedPasteMode, rows, layout,
      };
    };
  }

  /** Every pane on screen: its agent, xterm and PTY sizes, whether it is live and focused. */
  if (DEBUG) window.villageMux = () => ({
    layout, focus: cur?.id || null,
    panes: Mux.leaves(layout).map(id => {
      const c = live.get(id);
      return c && { id, size: { cols: c.term.cols, rows: c.term.rows }, pty: { cols: c.cols, rows: c.rows }, live: c.live, hidden: c.pane.hidden };
    }),
  });

  return {
    attach,
    detach,
    header,
    split,
    fit: () => fitAll(),
    activeId: () => cur?.id || null,
    focus: () => cur?.term.focus(),
  };
}
