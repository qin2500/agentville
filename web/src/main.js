import { BUCKETS, icon, esc, clock, h, reducedMotionQuery, isPrompt, PROMPT_NAME } from './ui.js';
import { createPanel } from './panel.js';
import { createVillage } from './village.js';
import { createFleet } from './fleet.js';
import { createAccount } from './account.js';
import { createSpend } from './spend.js';
import { observe } from './order.js';
import { createTermView } from './term.js';
import { loadModels } from './models.js';
import { createUpdate } from './update.js';
import { createLaunch } from './launch.js';
import { createBroadcast } from './broadcast.js';
import { transitions } from './notify.js';

// Dev-only fake API (`npm run dev:web` then ?mock); the branch is dropped from production builds.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) await import('./dev/mock.js');

const $ = id => document.getElementById(id);
const narrowQuery = matchMedia('(max-width: 900px)');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: settings just don't persist */ } },
};

const S = {
  data: null,            // last good payload
  agents: [],            // visible agents (hidden removed unless showHidden)
  byId: new Map(),
  kids: new Map(),       // id -> visible children (from parentId)
  status: 'loading',     // loading | ok | offline
  failures: 0,
  lastOk: 0,
  // First run opens on the expanded Team view; the village is one click away (Dock). Remembered after.
  panel: ['docked', 'collapsed', 'full'].includes(store.get('va.panel')) ? store.get('va.panel') : 'full',
  // 'va.view' once also held the village's 'iso'/'flat' string; only an object is the panel's views.
  views: { docked: 'status', full: 'team', ...(typeof store.get('va.view') === 'object' ? store.get('va.view') : {}) },
  panelW: store.get('va.panelW', null), // user-dragged docked width (px); null = the CSS default
  compact: store.get('va.density', 'comfortable') === 'compact',
  sound: store.get('va.sound', false),
  notify: store.get('va.notify', false), // desktop notification when an agent starts waiting for a click
  // More desktop notifications (notify.js), each off until turned on in Settings.
  notifyOn: { input: false, finished: false, checks: false, ...store.get('va.notifyOn', {}) },
  conv: null,            // conversation search results for the current query: { q, results }
  reduceSetting: store.get('va.motion', false),
  hideQuiet: store.get('va.hideQuiet', true), // the village leaves out projects quiet for a day (quiet.js)
  query: '',
  filters: { projects: new Set(), harness: new Set(), roles: new Set(), bucket: null, showHidden: false },
  selected: null,
  detail: false,
  restingOpen: false,
  collapsed: new Set(),
  term: null,            // agent id shown in the terminal view, or null
  get view() { return this.views[this.panel === 'full' ? 'full' : 'docked']; },
  get reduceMotion() { return this.reduceSetting || reducedMotionQuery.matches; },
};

const app = {
  S,
  render,
  // Below 900px the docked panel covers the village, so rows open the detail instead of panning a
  // village nobody can see; "Show in village" collapses the panel and pans there.
  narrow: () => narrowQuery.matches,
  select(id, { pan = true, fromVillage = false, reveal = fromVillage } = {}) {
    S.selected = id && S.byId.has(id) ? id : null;
    if (!S.selected) S.detail = false;
    writeHash();
    if (reveal && S.selected) {
      if (fromVillage && S.panel === 'collapsed' && !app.narrow()) setPanel('docked');
      panel.reveal(S.selected);
    }
    village.setSelected(S.selected, { pan });
    render();
    // In the terminal view, picking another agent opens it in the terminal too, when it can be
    // (subagents and sessions running elsewhere just show their inspector with the reason).
    if (S.term && S.selected && S.selected !== S.term && !panel.termBlock(S.selected)) app.openTerminal(S.selected);
  },
  /** Double-click: open it in the built-in terminal when it can be, else its inspector (which says why). */
  activate(id) {
    if (!S.byId.has(id)) return;
    if (S.data?.term?.available && !panel.termBlock(id)) {
      if (S.selected !== id) app.select(id, { pan: false });
      if (S.term !== id) app.openTerminal(id);
      return;
    }
    app.openDetail(id);
  },
  openDetail(id) {
    closePops();
    if (id !== S.selected) app.select(id, { pan: S.panel !== 'full' && !app.narrow() });
    S.detail = !!S.selected;
    render();
    panel.focusDetail();
  },
  showInVillage(id) {
    if (app.narrow()) setPanel('collapsed');
    else if (S.panel === 'full') setPanel('docked');
    app.select(id);
  },
  closeDetail() {
    if (!S.detail) return;
    S.detail = false;
    render();
    panel.focusSelectedRow();
  },
  async patch(id, body) {
    const res = await fetch(`/api/overrides/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned ${res.status}`);
    }
    await poll();
  },
  toast,
  say: text => { $('live').textContent = text; },
  setPanel,
  closePops: () => closePops(),
  refresh: () => poll(),
  setShowHidden(on) {
    S.filters.showHidden = on;
    if (S.data) ingest(S.data);
    render();
  },  // Settings → Hide quiet projects, and the village's "Show" link.
  setHideQuiet(on) {
    S.hideQuiet = on;
    store.set('va.hideQuiet', on);
    const box = document.querySelector('#pop-settings [data-set="quiet"]');
    if (box) box.checked = on;
    render();
  },
};

const panel = createPanel(app);
const village = createVillage(app);
const fleet = createFleet(app);
const account = createAccount(app, panel);
const spend = createSpend(app);
const update = createUpdate(app);
const launch = createLaunch(app);
const broadcast = createBroadcast(app);

// ---------- terminal view ----------
// Terminal takes the centre; the village (or the full-screen list) and the inspector compress to the
// sides. Entering saves the view; leaving puts back exactly that view. The PTY outlives both.
const termView = createTermView(app, { termName: () => panel.termName(), terminal: () => S.data?.open?.terminal || null, onClose: () => app.closeTerminal() });
// The layout moves in 150 ms (styles.css); the terminal is fitted once it has settled, never to a
// column caught mid-transition.
let termPrev = null, tvAnim = false, tvTimer = 0;
const reducedMotion = () => S.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
function animateLayout() {
  if (reducedMotion()) return;
  tvAnim = true;
  clearTimeout(tvTimer);
  tvTimer = setTimeout(() => { tvAnim = false; $('main').classList.remove('tv-anim'); termView.fit(); }, 170);
}
app.openTerminal = id => {
  const a = S.byId.get(id);
  if (!a) return;
  closePops();
  if (!S.term) {
    // Where the keyboard was, to give it back exactly there on close.
    const f = document.activeElement;
    termPrev = {
      focus: f && f !== document.body && !f.closest('#stage') ? { el: f, key: focusKey(f) } : null,
      panel: S.panel, views: { ...S.views }, selected: S.selected, detail: S.detail, panelW: S.panelW,
      table: { sort: S.table.sort, dir: S.table.dir, flat: S.table.flat, resting: S.table.resting },
      cam: village.camera(), scroll: panel.scrollState(),
    };
    if (S.panel === 'collapsed') S.panel = 'docked'; // the inspector needs its column (not saved)
    animateLayout();
  }
  S.term = id;
  S.selected = id;
  S.detail = true;
  writeHash();
  village.setSelected(id, { pan: false });
  render();
  termView.attach(a);
  village.setActive();
};
app.closeTerminal = () => {
  if (!S.term) return;
  const p = termPrev;
  termPrev = null;
  S.term = null;
  termView.detach();
  animateLayout();
  if (p) {
    Object.assign(S, { panel: p.panel, views: p.views, panelW: p.panelW });
    Object.assign(S.table, p.table);
    S.selected = p.selected && S.byId.has(p.selected) ? p.selected : null;
    S.detail = !!S.selected && p.detail;
    writeHash();
    village.setSelected(S.selected, { pan: false });
  }
  render();
  village.setActive();
  if (p) {
    // Again once the layout has settled: resizing on the way back can clamp the camera.
    const put = () => {
      village.setCamera(p.cam);
      panel.restoreScroll(p.scroll);
      if (document.activeElement === document.body || document.activeElement?.closest('#stage')) refocus(p);
    };
    put();
    setTimeout(put, reducedMotion() ? 0 : 180);
  }
  refocus(p);
};
/** Back to the control that had the keyboard before the terminal opened (or its re-rendered twin). */
function refocus(p) {
  const { el, key } = p?.focus || {};
  const f = el?.isConnected ? el : key ? document.querySelector(key) : null;
  if (f && f.offsetParent !== null && !f.disabled) { f.focus({ preventScroll: true }); if (document.activeElement === f) return; }
  if (S.detail) panel.focusTermButton(); else panel.focusSelectedRow();
}
/** A selector for the same control after a re-render: its id, or what it acts on inside an id'd part. */
function focusKey(f) {
  if (f.id) return `#${CSS.escape(f.id)}`;
  const attr = ['data-id', 'data-act', 'data-bucket', 'data-key', 'data-view'].find(a => f.hasAttribute(a));
  if (!attr) return null;
  const part = f.parentElement?.closest('[id]');
  return `${part ? `#${CSS.escape(part.id)} ` : ''}${f.tagName.toLowerCase()}[${attr}="${CSS.escape(f.getAttribute(attr))}"]`;
}
// ?debug exposes the world layout for e2e checks (positions, bounds, zoom).
if (new URLSearchParams(location.search).has('debug')) window.villageDebug = village.debug;

// ---------- data ----------
function ingest(data) {
  const prevStalled = S.data ? visibleCount(S.data, 'stalled') : null;
  S.data = data;
  observe(data.agents || []);
  S.agents = (data.agents || []).filter(a => S.filters.showHidden || !a.hidden);
  S.byId = new Map(S.agents.map(a => [a.id, a]));
  S.kids = new Map();
  for (const a of S.agents) if (a.parentId && S.byId.has(a.parentId)) {
    if (!S.kids.has(a.parentId)) S.kids.set(a.parentId, []);
    S.kids.get(a.parentId).push(a);
  }
  if (S.selected && !S.byId.has(S.selected)) { S.selected = null; S.detail = false; writeHash(); }
  notifyPrompts(prevStalled != null);
  notifyChanges();
  const stalled = visibleCount(data, 'stalled');
  if (prevStalled != null && stalled !== prevStalled) {
    $('live').textContent = `Stalled: ${stalled}`;
    if (stalled > prevStalled) chime();
  }
}
const visibleCount = (data, b) => data.counts?.[b] ?? (data.agents || []).filter(a => a.bucket === b && !a.hidden).length;

let timer = 0, inflight = null;
const BACKOFF = [2000, 5000, 10000, 30000];
function schedule() {
  clearTimeout(timer);
  const delay = S.status === 'offline'
    ? BACKOFF[Math.min(S.failures - 3, BACKOFF.length - 1)]
    : document.hidden ? 15000 : 2000;
  timer = setTimeout(poll, delay);
}
function poll() {
  if (inflight) return inflight;
  clearTimeout(timer);
  inflight = (async () => {
    try {
      // The Models view refreshes with every poll while it is showing (no button to press).
      const models = S.view === 'models' ? loadModels(S) : null;
      const res = await fetch('/api/agents', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.agents)) throw new Error('Malformed response');
      ingest(data);
      await models;
      S.status = 'ok'; S.failures = 0; S.lastOk = Date.now();
    } catch {
      S.failures++;
      if (S.failures >= 3) S.status = 'offline';
    }
    inflight = null;
    render();
    schedule();
  })();
  return inflight;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.status !== 'offline') poll(); else schedule();
  village.setActive();
});

// ---------- render ----------
function render() {
  const off = S.status === 'offline', loading = !S.data;
  $('app').classList.toggle('offline', off);
  $('app').classList.toggle('reduce-motion', S.reduceMotion);
  const main = $('main');
  main.className = 'main' + (S.panel === 'collapsed' ? ' collapsed' : S.panel === 'full' ? ' full' : '') + (S.term ? ' termview' : '') + (tvAnim ? ' tv-anim' : '');
  $('stage').hidden = !S.term;
  termView.header();
  renderTop(loading, off);
  panel.render({ loading });
  fleet.update();
  launch.update();
  broadcast.update();
  village.update({ loading, offline: off });
}

function counts() {
  const c = S.data?.counts || {};
  return Object.fromEntries(BUCKETS.map(b => [b, c[b] ?? 0]));
}

function renderTop(loading, off) {
  const c = counts();
  const n = b => (loading ? '–' : c[b]);
  const st = c.stalled, errs = S.data?.counts?.errors || 0; // errors are the red subset of Stalled
  const clicks = S.data?.counts?.prompts || 0; // …and these the subset waiting on a dialog
  const pressed = b => String(S.filters.bucket === b);
  $('counters').innerHTML =
    `<span class="pillgroup${!loading && (errs || clicks) ? ' split' : ''}"><button class="counter stalled ${loading || st === 0 ? 'zero' : ''}" data-bucket="stalled" aria-pressed="${pressed('stalled')}" aria-label="${n('stalled')} Stalled${loading ? ', loading' : st ? ', needs you' : ''}">${!loading && st === 0 ? icon('check') : icon('stalled')}<b class="num">${n('stalled')}</b> <span class="lbl">Stalled</span></button>
${!loading && errs ? `<button class="counter errors" data-bucket="error" aria-pressed="${pressed('error')}" aria-label="${errs} ${errs === 1 ? 'Error' : 'Errors'}, included in Stalled" title="${errs} of the ${st} stalled agents ${errs === 1 ? 'hit an error' : 'hit errors'}">${icon('error')}<b class="num">${errs}</b> <span class="lbl">${errs === 1 ? 'Error' : 'Errors'}</span></button>` : ''}${!loading && clicks ? `<button class="counter prompts${S.reduceMotion ? ' still' : ''}" data-bucket="prompt" aria-pressed="${pressed('prompt')}" aria-label="${clicks} need${clicks === 1 ? 's' : ''} a click, included in Stalled" title="${clicks} of the ${st} stalled agents ${clicks === 1 ? 'is' : 'are'} sitting in a permission prompt, a question with options, a plan to approve, or another dialog">${icon('prompt')}<b class="num">${clicks}</b> <span class="lbl">Need${clicks === 1 ? 's' : ''} a click</span></button>` : ''}</span>
     <button class="counter" data-bucket="waiting" aria-pressed="${pressed('waiting')}" aria-label="${n('waiting')} Waiting${loading ? ', loading' : ''}"><span class="w">${icon('waiting')}</span><b class="num">${n('waiting')}</b> <span class="lbl">Waiting</span></button>
     <button class="counter" data-bucket="building" aria-pressed="${pressed('building')}" aria-label="${n('building')} Building${loading ? ', loading' : ''}"><span class="bu">${icon('building')}</span><b class="num">${n('building')}</b> <span class="lbl">Building</span></button>`;
  $('rail').innerHTML = `<button class="iconbtn" id="btn-expand" aria-label="Open panel (\\)" title="Open panel (\\)">«</button>
    ${['stalled', 'waiting', 'building'].map(b => `<button class="iconbtn" data-bucket="${b}" style="color:var(--${b});height:auto;padding:2px 0;display:flex;flex-direction:column;gap:2px" aria-label="${n(b)} ${b}">${icon(b)}<b class="num">${n(b)}</b></button>`).join('')}`;

  const conn = $('conn');
  conn.className = 'conn' + (off ? ' off' : S.status === 'ok' ? ' ok' : '');
  conn.lastElementChild.textContent = off ? 'Offline' : S.status === 'ok' ? 'Live' : 'Connecting…';
  conn.title = S.lastOk ? `Updated ${clock(S.lastOk)}` : '';

  const warnings = S.data?.warnings || [];
  const wb = $('btn-warnings');
  wb.hidden = !warnings.length;
  wb.textContent = `⚠ ${warnings.length}`;
  wb.setAttribute('aria-label', `${warnings.length} server warning${warnings.length === 1 ? '' : 's'}`);

  const banner = $('banner');
  banner.hidden = !off;
  if (off && !banner.dataset.on) {
    banner.innerHTML = `<span>Can't reach the Agentville server on ${esc(location.host || '127.0.0.1:5275')}. ${S.lastOk ? `Showing data from ${clock(S.lastOk)}.` : ''} Retrying…</span><span class="spacer"></span><button class="ghost" id="btn-retry">Retry now</button>`;
  }
  banner.dataset.on = off ? '1' : '';

  document.title = clicks ? `(${clicks} to click) Agentville` : st > 0 ? `(${st}) Agentville` : 'Agentville';
  setFavicon(clicks ? 'prompt' : errs ? 'error' : st > 0 ? 'stalled' : '');
  $('view-status').setAttribute('aria-pressed', String(S.view === 'status'));
  $('view-team').setAttribute('aria-pressed', String(S.view === 'team'));
  $('view-tree').setAttribute('aria-pressed', String(S.view === 'tree'));
  $('view-table').setAttribute('aria-pressed', String(S.view === 'table'));
  $('view-models').setAttribute('aria-pressed', String(S.view === 'models'));
  $('btn-new').hidden = S.view !== 'team';
  const full = S.panel === 'full';
  $('btn-full').textContent = full ? '⤡ Dock' : '⤢ Expand';
  $('btn-full').title = full ? 'Dock the panel beside the village (F or Esc)' : 'Expand to full screen (F)';
  applyPanelWidth();
  // Hidden agents are easy to lose: a muted "N hidden" button is always there while any exist.
  const nh = hiddenAgents().length, hb = $('btn-hidden');
  hb.hidden = !nh;
  if (nh) { hb.textContent = `${nh} hidden`; hb.title = 'Hidden agents: see and unhide them'; }
  if (!nh && openPop === 'hidden') closePops();
  else if (openPop === 'hidden') fillPop('hidden');
  const nf = S.filters.projects.size + S.filters.harness.size + S.filters.roles.size + (S.filters.showHidden ? 1 : 0);
  $('btn-filters').textContent = nf ? `Filters · ${nf} ▾` : 'Filters ▾';
}

// The tab icon is the app icon (tools/icon), with a coloured dot when something needs you.
let favState = null;
const favImg = new Image();
favImg.src = '/icon-32.png';
function setFavicon(alert) {
  if (favState === alert) return;
  favState = alert;
  if (!alert) { $('favicon').href = '/icon-32.png'; return; }
  if (!favImg.complete) { favImg.onload = () => { const a = favState; favState = null; setFavicon(a); }; return; }
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (favImg.naturalWidth) g.drawImage(favImg, 0, 0, 32, 32);
  g.fillStyle = alert === 'prompt' ? '#c39bff' : alert === 'error' ? '#ff7262' : '#f2b84b'; g.beginPath(); g.arc(24, 8, 7, 0, 7); g.fill(); g.strokeStyle = '#0f1115'; g.lineWidth = 2; g.stroke();
  $('favicon').href = c.toDataURL();
}

// Agents sitting in a dialog (permission prompt, options, plan): the ones that are easy to miss.
// A desktop notification for each one that newly starts waiting, when turned on in Settings.
let promptIds = new Set();
function notifyPrompts(announce) {
  const now = S.agents.filter(a => isPrompt(a) && !a.hidden);
  const fresh = now.filter(a => !promptIds.has(a.id));
  promptIds = new Set(now.map(a => a.id));
  if (!announce || !fresh.length) return;
  $('live').textContent = `${fresh.length === 1 ? `${fresh[0].name} needs` : `${fresh.length} agents need`} a click`;
  chime();
  if (!S.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const a of fresh.slice(0, 3)) {
    try {
      const n = new Notification(`${a.name} needs a click`, { body: `${PROMPT_NAME[a.prompt] || 'Waiting on a dialog'} · ${a.project || ''}`, tag: `va-prompt:${a.id}` });
      n.onclick = () => { window.focus(); app.select(a.id); n.close(); };
    } catch { /* notifications unavailable */ }
  }
}

// Needs your input / finished / PR checks failing (Settings, each off by default). The differ in
// notify.js decides; each transition fires once (`fired`), and its tag keeps one notification per agent.
let lastAgents = null;
const fired = new Set();
function notifyChanges() {
  const next = S.agents;
  const prev = lastAgents;
  lastAgents = next;
  if (!prev || !Object.values(S.notifyOn).some(Boolean)) return;
  const fresh = transitions(prev, next, S.notifyOn).filter(n => !fired.has(n.key));
  fresh.forEach(n => fired.add(n.key));
  if (fired.size > 2000) [...fired].slice(0, 1000).forEach(k => fired.delete(k));
  if (!fresh.length || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const x of fresh.slice(0, 3)) {
    try {
      const n = new Notification(x.title, { body: x.body, tag: x.tag });
      n.onclick = () => { window.focus(); app.openDetail(x.id); n.close(); };
    } catch { /* notifications unavailable */ }
  }
}

let lastChime = 0, audio;
function chime() {
  if (!S.sound || Date.now() - lastChime < 60e3) return;
  lastChime = Date.now();
  try {
    audio ||= new AudioContext();
    [660, 880].forEach((f, i) => {
      const o = audio.createOscillator(), gn = audio.createGain(), t = audio.currentTime + i * 0.18;
      o.frequency.value = f; o.type = 'sine';
      gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(0.08, t + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(gn).connect(audio.destination); o.start(t); o.stop(t + 0.45);
    });
  } catch { /* audio unavailable */ }
}

// ---------- panel modes / hash ----------
function setPanel(mode) {
  if (S.panel === mode) return;
  S.panel = mode;
  store.set('va.panel', mode);
  closePops();
  render();
  village.setActive();
}
// ---------- resizable panel: drag or arrow the splitter; past 75% of the window snaps to full ----------
const MIN_W = 320;
const splitter = $('splitter');
const maxW = () => Math.max(MIN_W, $('main').clientWidth - 160);
function applyPanelWidth() {
  const w = S.panelW && Math.min(S.panelW, maxW());
  if (w) $('main').style.setProperty('--panel-w', `${w}px`); else $('main').style.removeProperty('--panel-w');
  const now = Math.round($('panel').getBoundingClientRect().width) || w || 400;
  splitter.setAttribute('aria-valuemin', MIN_W);
  splitter.setAttribute('aria-valuemax', maxW());
  splitter.setAttribute('aria-valuenow', now);
  splitter.setAttribute('aria-valuetext', `${now} pixels wide`);
}
function setPanelW(w, persist = true) {
  S.panelW = Math.round(Math.max(MIN_W, Math.min(maxW(), w)));
  if (persist) store.set('va.panelW', S.panelW);
  applyPanelWidth();
  panel.resized();
}
let dragW = null;
splitter.addEventListener('pointerdown', e => {
  if (e.button !== 0 || S.panel !== 'docked') return;
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  dragW = { snap: false };
  document.body.classList.add('resizing');
});
splitter.addEventListener('pointermove', e => {
  if (!dragW) return;
  const right = $('main').getBoundingClientRect().right;
  const w = right - e.clientX;
  dragW.snap = w > innerWidth * 0.75;
  splitter.classList.toggle('snap', dragW.snap);
  setPanelW(dragW.snap ? maxW() : w, false);
});
splitter.addEventListener('pointerup', () => {
  if (!dragW) return;
  const snap = dragW.snap;
  dragW = null;
  document.body.classList.remove('resizing');
  splitter.classList.remove('snap');
  if (snap) { S.panelW = store.get('va.panelW', null); applyPanelWidth(); setPanel('full'); }
  else store.set('va.panelW', S.panelW);
});
splitter.addEventListener('dblclick', () => setPanel(S.panel === 'full' ? 'docked' : 'full'));
splitter.addEventListener('keydown', e => {
  const step = e.shiftKey ? 80 : 16, cur = S.panelW || $('panel').getBoundingClientRect().width;
  if (e.key === 'ArrowLeft') setPanelW(cur + step);
  else if (e.key === 'ArrowRight') setPanelW(cur - step);
  else if (e.key === 'Home') setPanelW(MIN_W);
  else if (e.key === 'End') setPanelW(maxW());
  else if (e.key === 'Enter') setPanel(S.panel === 'full' ? 'docked' : 'full');
  else return;
  e.preventDefault();
  e.stopPropagation();
});
addEventListener('resize', () => applyPanelWidth());

function setView(v) {
  S.views[S.panel === 'full' ? 'full' : 'docked'] = v;
  store.set('va.view', S.views);
  render();
  if (v === 'models') poll(); // its data comes with the next poll; don't wait 2 s for it
}
function writeHash() {
  const want = S.selected ? `#agent=${encodeURIComponent(S.selected)}` : '';
  if (location.hash !== want) history.replaceState(null, '', want || location.pathname + location.search);
}
function readHash() {
  const m = location.hash.match(/^#agent=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
addEventListener('hashchange', () => app.select(readHash(), { reveal: true }));

// ---------- popovers ----------
const pops = { filters: $('pop-filters'), settings: $('pop-settings'), warnings: $('pop-warnings'), fleet: $('pop-fleet'), hidden: $('pop-hidden'), account: $('pop-account'), spend: $('pop-spend') };
const popBtn = { filters: $('btn-filters'), settings: $('btn-settings'), warnings: $('btn-warnings'), fleet: $('btn-fleet'), hidden: $('btn-hidden'), account: $('btn-account'), spend: $('btn-spend') };
let openPop = null;
function closePops({ restoreFocus = false } = {}) {
  if (!openPop) return false;
  pops[openPop].hidden = true;
  popBtn[openPop].setAttribute('aria-expanded', 'false');
  if (restoreFocus) popBtn[openPop].focus();
  openPop = null;
  return true;
}
function togglePop(name) {
  if (openPop === name) return closePops({ restoreFocus: true });
  closePops();
  if (name === 'filters' && S.detail) { S.detail = false; render(); }
  const el = pops[name], btn = popBtn[name];
  fillPop(name);
  el.hidden = false;
  const r = btn.getBoundingClientRect();
  el.style.top = `${r.bottom + 6}px`;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8))}px`;
  btn.setAttribute('aria-expanded', 'true');
  openPop = name;
  el.querySelector('input,button')?.focus();
}
function fillPop(name) {
  const el = pops[name];
  if (name === 'fleet') { el.innerHTML = fleet.menuHTML() + broadcast.menuItemHTML(); return; }
  if (name === 'account') { account.fillMenu(el); return; }
  if (name === 'spend') { spend.fillMenu(el); return; }
  if (name === 'hidden') { el.innerHTML = hiddenHTML(); return; }
  if (name === 'warnings') {
    el.innerHTML = `<div><h4>Server warnings</h4><ul>${(S.data?.warnings || []).map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
    return;
  }
  if (name === 'settings') {
    el.innerHTML = `<div><h4>Settings</h4>
      <label><input type="checkbox" data-set="sound" ${S.sound ? 'checked' : ''}>Chime when an agent stalls</label>
      <label><input type="checkbox" data-set="notify" ${S.notify ? 'checked' : ''}>Desktop notification when an agent needs a click</label>
      <label><input type="checkbox" data-set="notify-input" ${S.notifyOn.input ? 'checked' : ''}>…when an agent needs your input</label>
      <label><input type="checkbox" data-set="notify-finished" ${S.notifyOn.finished ? 'checked' : ''}>…when an agent finishes (its turn or its job)</label>
      <label><input type="checkbox" data-set="notify-checks" ${S.notifyOn.checks ? 'checked' : ''}>…when a PR's checks start failing</label>
      <p class="helper" id="notify-note" ${typeof Notification !== 'undefined' && Notification.permission === 'denied' && (S.notify || Object.values(S.notifyOn).some(Boolean)) ? '' : 'hidden'}>Notifications are blocked for this page in your browser's site settings.</p>
      <label><input type="checkbox" data-set="motion" ${S.reduceSetting ? 'checked' : ''}>Reduce motion${reducedMotionQuery.matches ? ' (system setting is on)' : ''}</label>
      <label><input type="checkbox" data-set="quiet" ${S.hideQuiet ? 'checked' : ''}>Hide quiet projects</label></div>${update.menuHTML()}`;
    return;
  }
  const all = S.data?.agents || [];
  const byProject = new Map();
  all.forEach(a => byProject.set(a.project || '—', (byProject.get(a.project || '—') || 0) + 1));
  const f = S.filters;
  const box = (group, value, label, n) =>
    `<label><input type="checkbox" data-f="${group}" value="${esc(value)}" ${f[group].has(value) ? 'checked' : ''}>${esc(label)}${n != null ? `<span class="n num">${n}</span>` : ''}</label>`;
  el.innerHTML = `
    <div><h4>Project</h4>${[...byProject].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p, n]) => box('projects', p, p, n)).join('') || '<span class="helper">No projects yet</span>'}</div>
    <div><h4>Harness</h4>${box('harness', 'claude-code', 'Claude Code')}${box('harness', 'codex', 'Codex')}</div>
    <div><h4>Role</h4>${box('roles', 'boss', 'Boss')}${box('roles', 'lead', 'Lead')}${box('roles', 'sub', 'Sub')}${box('roles', 'solo', 'Solo')}</div>
    <div><h4>Display</h4>
      <label><input type="checkbox" data-set="hidden" ${f.showHidden ? 'checked' : ''}>Show hidden agents</label>
      <label><input type="checkbox" data-set="compact" ${S.compact ? 'checked' : ''}>Compact rows</label></div>`;
}
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.f) {
    const set = S.filters[t.dataset.f];
    t.checked ? set.add(t.value) : set.delete(t.value);
    render();
  } else if (t.dataset.set === 'hidden') {
    app.setShowHidden(t.checked);
  } else if (t.dataset.set === 'compact') {
    S.compact = t.checked; store.set('va.density', S.compact ? 'compact' : 'comfortable'); render();
  } else if (t.dataset.set === 'sound') {
    S.sound = t.checked; store.set('va.sound', S.sound);
  } else if (t.dataset.set === 'notify' || t.dataset.set?.startsWith('notify-')) {
    if (t.dataset.set === 'notify') { S.notify = t.checked; store.set('va.notify', S.notify); }
    else { S.notifyOn[t.dataset.set.slice(7)] = t.checked; store.set('va.notifyOn', S.notifyOn); }
    const any = S.notify || Object.values(S.notifyOn).some(Boolean);
    const note = $('notify-note');
    const show = () => { if (note) note.hidden = !(any && Notification.permission === 'denied'); };
    if (t.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().then(show, show);
    else if (typeof Notification !== 'undefined') show();
  } else if (t.dataset.set === 'quiet') {
    app.setHideQuiet(t.checked);
  } else if (t.dataset.set === 'motion') {
    S.reduceSetting = t.checked; store.set('va.motion', S.reduceSetting); render(); village.setActive();
  }
});
reducedMotionQuery.addEventListener('change', () => { render(); village.setActive(); });

// ---------- hidden agents ----------
const hiddenAgents = () => (S.data?.agents || []).filter(a => a.hidden);
// Hiding is per agent: its team members stay on screen, just without it.
function teamOf(a) {
  const all = S.data?.agents || [], out = [];
  const walk = id => all.filter(k => k.parentId === id).forEach(k => { if (!k.hidden && !out.includes(k)) { out.push(k); walk(k.id); } });
  walk(a.id);
  return out;
}
function hiddenHTML() {
  const list = hiddenAgents();
  const ROLE = { boss: 'Boss', lead: 'Lead', sub: 'Subagent', solo: 'Solo' };
  return `<div><h4>Hidden agents · ${list.length}</h4>
    <p class="helper" style="margin:0 0 8px">Hidden agents are left out of the counts, the list and the village.</p>
    <ul class="hiddenlist">${list.map(a => {
      const team = teamOf(a).length;
      return `<li><div><b>${esc(a.name)}</b><span>${esc(ROLE[a.role] || a.role)} · ${esc(a.project || '—')}</span>${team ? `<span>Its ${team} team member${team === 1 ? '' : 's'} stay${team === 1 ? 's' : ''} visible without it.</span>` : ''}</div>
        <button class="ghost" type="button" data-unhide="${esc(a.id)}" aria-label="Unhide ${esc(a.name)}">Unhide</button></li>`;
    }).join('')}</ul>
    ${list.length > 1 ? '<button class="ghost" type="button" data-unhide="*">Unhide all</button>' : ''}
    <p class="err" id="hidden-err" role="alert" hidden></p></div>`;
}
async function unhide(ids, btn) {
  btn.disabled = true; btn.textContent = 'Unhiding…';
  try {
    for (const id of ids) await app.patch(id, { hidden: null });
    // Keep keyboard users in place: the next Unhide if any remain, else the search box.
    (openPop === 'hidden' && pops.hidden.querySelector('[data-unhide]')) ? pops.hidden.querySelector('[data-unhide]').focus() : $('q').focus();
  } catch (e) {
    fillPop('hidden');
    const p = $('hidden-err');
    if (p) { p.textContent = e instanceof TypeError ? "Couldn't unhide: server not reachable." : `Couldn't unhide: ${e.message}`; p.hidden = false; }
  }
}

// ---------- toast ----------
let toastTimer = 0;
function toast(text, action, ms = 6000) {
  const el = $('toast');
  el.replaceChildren(h('span', {}, text));
  if (action) el.append(h('button', { class: 'textbtn', onclick: () => { el.hidden = true; action.run(); } }, action.label));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- clicks ----------
document.addEventListener('click', e => {
  const t = e.target;
  // A control a menu just re-rendered away is no longer in the page: that click was inside it.
  if (openPop && t.isConnected && !t.closest('.pop') && !t.closest(`#${popBtn[openPop].id}`)) closePops();
  const bucket = t.closest('[data-bucket]')?.dataset.bucket;
  if (bucket) {
    S.filters.bucket = S.filters.bucket === bucket ? null : bucket;
    if (S.panel === 'collapsed') setPanel('docked');
    S.detail = false;
    if (S.filters.bucket) S.views[S.panel === 'full' ? 'full' : 'docked'] = 'status';
    render();
    return;
  }
  if (t.closest('#btn-expand')) return setPanel('docked');
  if (t.closest('#btn-collapse')) return setPanel('collapsed');
  if (t.closest('#btn-full')) return setPanel(S.panel === 'full' ? 'docked' : 'full');
  if (t.closest('#view-status')) return setView('status');
  if (t.closest('#view-team')) return setView('team');
  if (t.closest('#view-tree')) return setView('tree');
  if (t.closest('#view-table')) return setView('table');
  if (t.closest('#view-models')) return setView('models');
  if (t.closest('#btn-retry')) return poll();
  if (t.closest('#btn-filters')) return togglePop('filters');
  if (t.closest('#btn-settings')) return togglePop('settings');
  if (t.closest('#btn-warnings')) return togglePop('warnings');
  if (t.closest('#btn-fleet')) return togglePop('fleet');
  if (t.closest('#btn-account')) return togglePop('account');
  if (t.closest('#btn-spend')) return togglePop('spend');
  if (t.closest('#btn-hidden')) return togglePop('hidden');
  if (t.closest('#btn-new')) return launch.open();
  if (t.closest('[data-update="open"]')) { closePops(); return update.open(popBtn.settings); }
  const un = t.closest('[data-unhide]');
  if (un) return unhide(un.dataset.unhide === '*' ? hiddenAgents().map(a => a.id) : [un.dataset.unhide], un);
  const chip = t.closest('[data-clear]');
  if (chip) {
    const { clear: group, value } = chip.dataset;
    if (group === 'bucket') S.filters.bucket = null;
    else if (group === 'hidden') return app.setShowHidden(false);
    else if (group === 'query') { S.query = ''; $('q').value = ''; }
    else S.filters[group].delete(value);
    render();
  }
});

// Conversation search (names and titles, resting sessions too): the server's index, asked at most
// every 250 ms while typing, never a scan per keystroke.
let convTimer = 0, convSeq = 0;
function searchConversations() {
  clearTimeout(convTimer);
  const q = S.query.trim().toLowerCase();
  if (q.length < 2) { S.conv = null; return; }
  convTimer = setTimeout(async () => {
    const seq = ++convSeq;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const body = res.ok ? await res.json() : null;
      if (seq !== convSeq || !body) return;
      S.conv = { q, results: body.results || [] };
      render();
    } catch { /* offline: the list search still works */ }
  }, 250);
}
$('q').addEventListener('input', e => { S.query = e.target.value.trim(); searchConversations(); render(); });
$('q').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const first = panel.firstMatch();
    if (first) app.select(first);
  }
});

// ---------- keyboard ----------
let altDown = false;
document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return; // a modal sheet owns the keyboard (native Esc closes it)
  // The built-in terminal owns every key while focused, Esc included; Shift+Esc leaves it (term.js).
  if (e.target.closest?.('#stage .xterm, #stage .termfind')) return;
  if (e.key === 'Alt' && !altDown) { altDown = true; village.showAllTags(true); }
  const inField = e.target.matches('input, select, textarea');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return focusSearch(); }
  if (e.key === 'Escape') return escape(e, inField);
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); focusSearch(); }
  else if (k === '\\') setPanel(S.panel === 'collapsed' ? 'docked' : S.panel === 'docked' ? 'collapsed' : 'docked');
  else if (k === 'f' || k === 'F') setPanel(S.panel === 'full' ? 'docked' : 'full');
  else if ((k === 'r' || k === 'R') && S.view === 'table') panel.tableResort();
  else if (k === 'o' || k === 'O') { // open the focused row's agent, else the selected one, in a terminal
    const id = e.target.closest?.('[data-id]')?.dataset.id || S.selected;
    if (id) panel.open(id);
  }
  else if (k === 'v' || k === 'V') setView({ status: 'team', team: 'tree', tree: 'table', table: 'models', models: 'status' }[S.view] || 'status');
  else if (k === 'j' || k === 'J' || k === 'k' || k === 'K') panel.jumpStalled(k.toLowerCase() === 'j' ? 1 : -1);
  else if (k === 'Backspace' && S.detail) { e.preventDefault(); app.closeDetail(); }
  else if ((k === '+' || k === '=' || k === '-' || k === '0' || k === 'i' || k === 'I') && S.panel !== 'full' && !e.target.closest('.panel')) village.key(k);
});
document.addEventListener('keyup', e => { if (e.key === 'Alt') { altDown = false; village.showAllTags(false); } });
addEventListener('blur', () => { if (altDown) { altDown = false; village.showAllTags(false); } });

function focusSearch() {
  if (S.panel === 'collapsed') setPanel('docked');
  if (S.detail) { S.detail = false; render(); }
  $('q').focus();
  $('q').select();
}
function escape(e, inField) {
  if (closePops({ restoreFocus: true })) return;
  if (e.target.id === 'q') {
    if (S.query) { S.query = ''; e.target.value = ''; render(); } else e.target.blur();
    e.preventDefault();
    return;
  }
  if (inField) { e.target.blur(); return; }
  if (S.detail) return app.closeDetail();
  if (S.query) { S.query = ''; $('q').value = ''; return render(); }
  if (S.selected) return app.select(null);
  if (S.filters.bucket) { S.filters.bucket = null; return render(); }
  if (S.panel === 'full') setPanel('docked');
}

// ---------- boot ----------
S.selected = readHash();
render();
village.setActive();
poll().then(() => { if (S.selected) app.select(S.selected, { reveal: true }); update.start(); });
