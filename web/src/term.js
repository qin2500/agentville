// The terminal view: the agent's terminal takes the centre of the app (#stage) while the village or
// list and the inspector compress to the sides (main.js owns the layout and the saved view). The
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

export function createTermView(app, { termName, terminal, onClose }) {
  const { S } = app;
  const stage = document.getElementById('stage');
  const live = new Map(); // agentId -> session, least recently shown first
  let cur = null; // the session on screen
  let lastSize = null; // the size the terminal on screen last had: a new one starts at it

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
    <div class="termwrap">
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
    <p class="helper termhint">Every key goes to the terminal, Esc included. Shift+Esc closes it; the session keeps running. ${MOD}F finds, ${MOD}K clears the view, ${MOD}-click opens a link.</p>`;
  const wrap = stage.querySelector('.termwrap');
  const notice = stage.querySelector('.termnotice');
  const jump = stage.querySelector('.termjump');
  const find = stage.querySelector('.termfind');
  const findInput = find.querySelector('input');
  const findCount = find.querySelector('.findcount');
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

  /** Header from the latest data: role glyph, name, bucket badge (called on every render). */
  function header() {
    if (!cur) return;
    const a = S.byId.get(cur.id) || S.data?.agents?.find(x => x.id === cur.id);
    const name = a?.name || cur.name;
    const sig = [cur.id, name, a?.role, a?.bucket, a?.severity, terminal()].join('|');
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

  // ---------- sizes ----------
  /** Only the terminal on screen, laid out at a real size and not mid-transition, is measured. */
  function measurable(c) {
    return !!c && c === cur && !c.disposed && !document.hidden && !stage.hidden && !c.host.hidden &&
      c.host.isConnected && c.host.offsetParent !== null && c.host.clientWidth > 0 && c.host.clientHeight > 0 &&
      !main()?.classList.contains('tv-anim');
  }
  function proposed(c) {
    let d;
    try { d = c.fit.proposeDimensions(); } catch { return null; }
    if (!d || !(d.cols >= MIN_COLS) || !(d.rows >= MIN_ROWS)) return null; // NaN, or a host collapsing
    return { cols: Math.min(d.cols, MAX_COLS), rows: Math.min(d.rows, MAX_ROWS) };
  }
  /** Fit the terminal on screen to its host; the PTY hears the final size (or a repaint) soon after. */
  function fitNow({ repaint = false } = {}) {
    const c = cur;
    if (c && repaint) c.repaint = true; // owed until it can be sent (after a transition, once shown)
    if (!measurable(c)) return;
    const d = proposed(c);
    if (!d) return;
    if (d.cols !== c.term.cols || d.rows !== c.term.rows) c.term.resize(d.cols, d.rows);
    lastSize = d;
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
  const ro = new ResizeObserver(() => fitNow());
  ro.observe(wrap);

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
          fitNow({ repaint: true }); // our real size, and a SIGWINCH so a TUI redraws at it
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wakeAll(); fitNow(); } });

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
  const linkHint = {
    hover: (_e, uri) => { if (cur) cur.host.title = `${MOD}-click to open ${uri}`; },
    leave: () => { if (cur) cur.host.title = ''; },
  };

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
  function create(a) {
    const host = document.createElement('div');
    host.className = 'termhost';
    const wait = document.createElement('div');
    wait.className = 'termwait';
    wait.hidden = true;
    wait.innerHTML = `<span class="dot" aria-hidden="true"></span>Starting ${esc(a.name || 'the terminal')}…`;
    wrap.prepend(host);
    const size = lastSize || { cols: 100, rows: 30 };
    const term = new Terminal({
      fontFamily: token('--mono') || 'ui-monospace, Menlo, monospace', fontSize: 13, lineHeight: 1.15,
      theme: theme(), cursorBlink: true, cursorInactiveStyle: 'outline', scrollback: 5000,
      cols: size.cols, rows: size.rows, allowProposedApi: true, macOptionClickForcesSelection: true,
      // OSC 8 hyperlinks (Claude Code prints them): the same Cmd-click rule as plain URLs.
      linkHandler: { activate: openLink, ...linkHint },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon(openLink, linkHint));
    try { term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11'; } catch { /* the default widths */ }
    const c = {
      id: a.id, name: a.name, host, wait, term, fit, search, ws: null, exited: false, status: null, notice: null, err: '',
      cols: 0, rows: 0, boot: null, tries: 0, timer: 0, busy: false, restarting: false, ping: 0, live: false,
      snapshot: false, repaint: false, sizeTimer: 0, waitTimer: 0, hideTimer: 0, unseen: false, disposed: false, renderer: 'dom',
    };
    term.attachCustomKeyEventHandler(e => keys(c, e));
    term.open(host);
    host.append(wait);
    if (WEBGL) loadWebgl(c);
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
    live.set(a.id, c);
    return c;
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

  /** Keys the terminal does not get: Shift+Esc (close), copy with a selection, paste, clear, find. */
  function keys(c, e) {
    if (e.key === 'Escape' && e.shiftKey) {
      if (e.type === 'keydown') { e.preventDefault(); close(); }
      return false;
    }
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

  function show(c) {
    if (cur && cur !== c) hide(cur);
    cur = c;
    clearTimeout(c.hideTimer); c.hideTimer = 0;
    live.delete(c.id); live.set(c.id, c); // most recently shown last
    c.host.hidden = false;
    stage._sig = '';
    header();
    paintStatus(); paintNotice(); paintErr(); paintJump();
    // Draw what arrived while it was hidden, fit it to our size, and have the app redraw at it.
    try { c.term.refresh(0, c.term.rows - 1); } catch { /* disposed */ }
    if (c.live) fitNow({ repaint: true });
    else c.repaint = true;
  }
  function hide(c) {
    c.host.hidden = true;
    clearTimeout(c.sizeTimer);
    clearTimeout(c.hideTimer);
    c.hideTimer = setTimeout(() => dispose(c), HIDDEN_MS);
    closeFind({ refocus: false });
    if (cur === c) cur = null;
  }
  /** Close its socket and drop the xterm; the PTY is left running on the server. */
  function dispose(c) {
    if (c.disposed) return;
    c.disposed = true;
    for (const t of [c.timer, c.sizeTimer, c.waitTimer, c.hideTimer]) clearTimeout(t);
    dropSocket(c);
    try { c.term.dispose(); } catch { /* gone */ }
    c.host.remove();
    if (live.get(c.id) === c) live.delete(c.id);
    if (cur === c) { cur = null; paintStatus(); paintNotice(); paintErr(); paintJump(); }
  }
  function evict() {
    for (const c of [...live.values()]) {
      if (live.size <= KEEP) break;
      if (c !== cur) dispose(c);
    }
  }

  function attach(a) {
    let c = live.get(a.id);
    if (c && c === cur && !c.host.hidden) { c.term.focus(); return; }
    // One that has ended starts afresh, as opening it always has; anything else is shown as it was.
    if (c && (c.exited || c.disposed)) { dispose(c); c = null; }
    const fresh = !c;
    if (fresh) c = create(a);
    show(c);
    evict();
    if (fresh) { waiting(c, true); connect(c); }
    else if (!c.ws && !c.busy && !c.timer) connect(c, { auto: !!c.boot });
    c.term.focus();
  }

  /** Leave the view: the terminal on screen is hidden, kept live, and shown as it was next time. */
  function detach() {
    if (cur) hide(cur);
    cur = null;
  }

  function close() { onClose(); }

  // A click anywhere in the terminal area that isn't a control gives the keyboard to the terminal.
  stage.addEventListener('mouseup', e => {
    if (!cur || e.button !== 0 || e.target.closest('button, a, input, textarea, select, .termfind')) return;
    cur.term.focus();
  });

  stage.addEventListener('click', async e => {
    const b = e.target.closest('[data-tact]');
    if (!b) return;
    const c = cur;
    const act = b.dataset.tact;
    if (act === 'close') return close();
    if (!c) return;
    if (act === 'reconnect') return connect(c);
    if (act === 'bottom') { c.term.scrollToBottom(); c.unseen = false; paintJump(); c.term.focus(); return; }
    if (act === 'findnext' || act === 'findprev') { runFind(act === 'findprev' ? 'prev' : 'next'); return; }
    if (act === 'findclose') return closeFind();
    if (b.disabled) return;
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
      if (act === 'popout') { app.toast(`Opened ${c.name} in ${termName()}`); if (cur === c) close(); }
    } catch (err) {
      if (!c.disposed) showErr(c, err instanceof TypeError ? "Couldn't reach the Agentville server." : err.message);
    } finally {
      b.disabled = false; b.removeAttribute('aria-busy');
      if (b.dataset.tact === 'popout') b.textContent = `Pop out to ${termName()}`; else b.textContent = label;
    }
  });

  // ?debug: the state of the terminal on screen, for e2e checks.
  if (DEBUG) {
    window.villageTerm = () => {
      if (!cur) return { kept: [...live.keys()] };
      const b = cur.term.buffer.active;
      const rows = [];
      for (let y = b.viewportY; y < b.viewportY + cur.term.rows; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
      return {
        id: cur.id, kept: [...live.keys()], size: { cols: cur.term.cols, rows: cur.term.rows }, pty: { cols: cur.cols, rows: cur.rows },
        viewportY: b.viewportY, baseY: b.baseY, buffer: b.type, renderer: cur.renderer, live: cur.live,
        mouse: cur.term.modes.mouseTrackingMode, bracketedPaste: cur.term.modes.bracketedPasteMode, rows,
      };
    };
  }

  return {
    attach,
    detach,
    header,
    fit: () => fitNow(),
    activeId: () => cur?.id || null,
    focus: () => cur?.term.focus(),
  };
}
