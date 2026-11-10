// Token spend (server/spend.mjs) and the session projection (server/projection.mjs, autoswitch.mjs):
// a sparkline and the last-60-minute number in the top bar, details in #pop-spend. Polls
// GET /api/spend every 5 s while the tab is visible; nothing to refresh by hand. Also announces
// automatic account switches with Undo. Only counts, times and account labels reach the page.
import { esc } from './ui.js';

const POLL_MS = 5000;
const WHY = { five_hour: '5-hour limit reached', weekly: 'weekly limit reached', limit: 'agents hit a usage limit', quarantine: 'quarantine account on the work Wi-Fi', prefer: 'off the work Wi-Fi, quarantine accounts come first' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* not persisted */ } },
};
/** 1234 -> "1.2k", 3_400_000 -> "3.4M". */
export function fmt(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}
const words = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n >= 1e3 ? `${Math.round(n / 1e3)} thousand` : String(Math.round(n)));
/** "3:42 pm", or "Thu 3:42 pm" when it isn't today. */
function when(t) {
  const d = new Date(t), today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  return today ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Inline SVG line (with a faint area) of `values`; `w`×`h` user units, scaled by CSS. */
function line(values, w, h, label) {
  const max = Math.max(1, ...values), step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`);
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" ${a11y}>
    <polygon class="area" points="0,${h} ${pts.join(' ')} ${w},${h}"/><polyline points="${pts.join(' ')}"/></svg>`;
}

const pct = x => `${Math.round(x)}%/h`;
/** The 5-hour window's main line in the details. */
export function projectionText(p) {
  if (!p) return '';
  if (p.none || p.state === 'none') return 'No 5-hour limit';
  if (p.state === 'out') return `Out of usage${p.resetsAt ? ` · resets ${when(p.resetsAt)}` : ''}`;
  if (p.state === 'runsOut') return `Runs out ≈ ${when(p.at)}${p.resetsAt ? ` (resets ${when(p.resetsAt)})` : ''}`;
  if (p.state === 'lasts') return p.resetsAt ? `Lasts until the reset at ${when(p.resetsAt)}` : 'Not running out';
  return 'Gathering data…';
}
/** How the 5-hour time was worked out: the blended pace and its two parts. */
export function paceText(p) {
  if (!p || p.perHour == null || p.state === 'out') return '';
  if (p.perHourRecent == null || p.perHourAvg == null) return `At ${pct(p.perHour)}, the pace over the last 30 min.`;
  return `At ${pct(p.perHour)}: ${pct(p.perHourRecent)} over the last 30 min, ${pct(p.perHourAvg)} on average this window.`;
}
/** The weekly window's main line: the earliest it can run out, given the 5-hour cap. */
export function weeklyText(w) {
  if (!w) return '';
  if (w.state === 'out') return `Out of usage${w.resetsAt ? ` · resets ${when(w.resetsAt)}` : ''}`;
  if (w.basis !== 'flatOut') return projectionText(w);
  if (w.state === 'runsOut') return `At this pace, earliest ≈ ${when(w.at)}`;
  if (w.state === 'lasts') return w.resetsAt ? `Lasts until the reset at ${when(w.resetsAt)}` : 'Not running out';
  return 'Gathering data…';
}
/** Under the weekly line: what "earliest" assumes, and the week's own average for contrast. */
export function weeklyDetail(w) {
  if (!w || w.state === 'out' || w.state === 'gathering') return '';
  const parts = [];
  if (w.basis === 'flatOut' && w.ratio != null) {
    const each = `each ${w.ratioFrom === 'samples' ? '≈' : 'assumed ≈'} ${Math.round(w.ratio * 100)}% of the week`;
    parts.push(`${w.state === 'runsOut' ? 'If' : 'Even if'} every 5-hour window is used in full (${each}).`);
  }
  const a = w.average;
  if (a) parts.push(`At this week's average (${a.perHour}%/h): ${a.state === 'runsOut' ? `≈ ${when(a.at)}` : 'lasts until the reset'}.`);
  return parts.join(' ');
}
/** The top bar's short text for the window that runs out first (server: projection.mjs binding()). */
export function headerText(p) {
  const b = p?.binding;
  if (!b) return '';
  const k = b.window === 'weekly' ? 'week' : '5h';
  return b.state === 'out' ? `${k} out of usage` : `${k} out ≈ ${when(b.at)}`;
}

export function createSpend(app) {
  const $ = id => document.getElementById(id);
  const btn = $('btn-spend'), pop = $('pop-spend');
  const P = { data: null, minutes: 60, timer: 0, inflight: null, err: '', autoErr: '', detail: store.get('va.spend.detail') === '1' };

  async function poll() {
    if (P.inflight) return P.inflight;
    clearTimeout(P.timer);
    P.inflight = (async () => {
      try {
        const res = await fetch(`/api/spend?minutes=${P.minutes}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        P.data = await res.json();
        P.err = '';
      } catch (e) { P.err = e instanceof TypeError ? "The Agentville server isn't reachable." : e.message; }
      P.inflight = null;
      renderBtn();
      renderPop();
      announce();
      P.timer = setTimeout(poll, document.hidden ? 30000 : POLL_MS);
    })();
    return P.inflight;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();

  // ---------- top bar ----------
  function renderBtn() {
    const d = P.data;
    btn.hidden = !d?.spend;
    if (!d?.spend) return;
    const s = d.spend, n = s.last60.tokens, five = d.projection?.fiveHour, b = d.projection?.binding;
    const last60 = s.recent || s.series.slice(-60).map(x => x.tokens);
    const proj = headerText(d.projection);
    const html = `${line(last60, 60, 16, '')}<b class="num">${fmt(n)}</b><span class="sp-k">/60m</span>${proj ? `<span class="sp-proj${b.state === 'out' ? ' out' : ''}"> · ${esc(proj)}</span>` : ''}<span class="caret"> ▾</span>`;
    if (btn.dataset.html !== html) { btn.dataset.html = html; btn.innerHTML = html; }
    // The visible text first (WCAG 2.5.3), then what it means.
    btn.setAttribute('aria-label', `${fmt(n)}/60m${proj ? ` · ${proj}` : ''}: token spend, ${words(n)} tokens in the last 60 minutes${five ? `. Session: ${projectionText(five)}` : ''}${d.projection?.weekly ? `. Weekly: ${weeklyText(d.projection.weekly)}` : ''}. Show details`);
  }

  // ---------- details (in #pop-spend, opened by main.js) ----------
  function popHTML() {
    const d = P.data;
    if (!d?.spend) return `<p class="helper">${esc(P.err || 'Loading…')}</p>`;
    const s = d.spend, D = s.day || s.last60, values = s.series.map(x => x.tokens);
    const peak = Math.max(0, ...values), nowRate = values.at(-1) || 0;
    const summary = `Tokens per minute over the past hour: now ${words(nowRate)}, peak ${words(peak)}.`;
    const p = d.projection, a = d.autoSwitch;
    const row = (k, v, cls = '') => `<div class="${cls}"><dt>${k}</dt><dd class="num">${v}</dd></div>`;
    const last = a?.last;
    const lastLine = last ? `Last: ${when(last.at)}, ${esc(last.fromLabel || 'account')} → ${esc(last.toLabel || last.to)} (${esc(WHY[last.why] || last.why)})${last.error ? ` — failed: ${esc(last.error)}` : last.restored ? ' — rolled back' : ''}` : '';
    return `<div class="spendpop">
      <div class="sp-head"><h4 id="sp-h">Token spend</h4>
        <span class="sp-k">Last hour <b class="num">${fmt(s.last60.tokens)}</b> tokens</span></div>
      <div class="sp-chart" tabindex="0" aria-describedby="sp-tip" title="Hover or use ← → to read a minute">${line(values, 300, 72, summary)}<i class="sp-guide" hidden></i><span class="sp-tip num" id="sp-tip" role="status" hidden></span><div class="sp-axis"><span>${when(s.series[0].t)}</span><span>peak ${fmt(peak)}/min</span><span>now</span></div></div>
      <p class="sr">${esc(summary)}</p>
      <dl class="sp-nums">
        ${row('Last 7 days', `<b>${fmt(s.week?.tokens || 0)}</b> tokens`, 'head')}
        ${row('Last 24 hours', `<b>${fmt(D.tokens)}</b> tokens`, 'head')}
      </dl>
      <button type="button" class="sp-more" data-sp-detail aria-expanded="${P.detail}" aria-controls="sp-detail">${P.detail ? 'Hide breakdown' : 'Show breakdown'}<span class="caret" aria-hidden="true"> ${P.detail ? '▴' : '▾'}</span></button>
      ${P.detail ? breakdownHTML(s) : ''}
      <button type="button" class="sp-more" data-sp-models>Which models your agents use →</button>
      ${s.catchingUp ? '<p class="helper">Catching up on earlier transcripts…</p>' : ''}
      <section class="sp-proj-box" aria-labelledby="sp-proj-h"><h4 id="sp-proj-h">Projection</h4>
        ${!p ? '<p class="helper">On the pool, or no reading yet: there is no account limit to project.</p>'
          : p.pending ? '<p class="helper">Checking the new account…</p>'
          : p.error && !p.fiveHour ? `<p class="helper bad">Couldn't read usage: ${esc(p.error)}</p>`
          : `<p class="sp-line" data-sp-five><span>Session (5-hour)</span><b>${esc(projectionText(p.fiveHour))}</b><span class="dim num">${p.fiveHour && !p.fiveHour.none ? `${Math.round(p.fiveHour.used)}% used` : ''}</span></p>
             ${paceText(p.fiveHour) ? `<p class="helper sp-why" data-sp-five-why>${esc(paceText(p.fiveHour))}</p>` : ''}
             <p class="sp-line" data-sp-week><span>Weekly</span><b>${esc(weeklyText(p.weekly))}</b><span class="dim num">${p.weekly ? `${Math.round(p.weekly.used)}% used` : ''}</span></p>
             ${weeklyDetail(p.weekly) ? `<p class="helper sp-why" data-sp-week-why>${esc(weeklyDetail(p.weekly))}</p>` : ''}
             ${p.binding && p.next ? `<p class="helper" data-sp-next>Then auto-switches to ${esc(p.next.label)}.</p>` : ''}
             <p class="helper">Checked ${when(p.at)}, every minute. Times assume the agents keep going.</p>`}
      </section>
      <section aria-label="Auto-switch">
        <label><input type="checkbox" data-sp-auto ${a?.enabled ? 'checked' : ''}>Auto-switch when an account runs out</label>
        <p class="helper">Moves running agents to the saved account whose 5-hour window resets soonest, or to the pool if none has room.</p>
        ${lastLine ? `<p class="helper">${lastLine}</p>` : ''}
        <p class="err" role="alert" ${P.autoErr ? '' : 'hidden'}>${esc(P.autoErr)}</p>
      </section></div>`;
  }
  /** Totals split by kind, for the last hour, 24 hours and 7 days. Every row adds into Total. */
  function breakdownHTML(s) {
    const cols = [s.last60, s.day || s.last60, s.week || s.day || s.last60];
    const cx = [s.codex, s.dayCodex || s.codex, s.weekCodex || s.dayCodex || s.codex];
    const tr = (k, vals, cls = '') => `<tr class="${cls}"><th scope="row">${k}</th>${vals.map(v => `<td class="num">${fmt(v || 0)}</td>`).join('')}</tr>`;
    const codex = cx.some(c => c?.tokens) ? `<tbody class="sp-codex">
        ${tr('Codex input', cx.map(c => c?.input))}${tr('Codex output', cx.map(c => c?.output))}${tr('Codex cache reads', cx.map(c => c?.cacheRead))}
        ${tr('Codex total', cx.map(c => c?.tokens), 'total')}</tbody>` : '';
    return `<table class="sp-table" id="sp-detail"><caption class="sr">Tokens by kind</caption>
      <thead><tr><td></td><th scope="col">Last hour</th><th scope="col">24 h</th><th scope="col">7 days</th></tr></thead>
      <tbody>${tr('Input', cols.map(c => c.input))}${tr('Output', cols.map(c => c.output))}${tr('Cache writes', cols.map(c => c.cacheCreation))}${tr('Cache reads', cols.map(c => c.cacheRead))}
        ${tr('Total', cols.map(c => c.tokens), 'total')}</tbody>${codex}</table>`;
  }
  // ---------- chart readout: hover (or ← → when focused) shows that minute's spend ----------
  function showTip(i) {
    const chart = pop.querySelector('.sp-chart'), series = P.data?.spend?.series;
    if (!chart || !series?.length) return;
    const tip = chart.querySelector('.sp-tip'), guide = chart.querySelector('.sp-guide');
    if (i == null) { tip.hidden = guide.hidden = true; P.hover = null; return; }
    i = Math.max(0, Math.min(series.length - 1, i));
    P.hover = series[i].t;
    const x = series.length > 1 ? (i / (series.length - 1)) * 100 : 0, pt = series[i];
    guide.style.left = `${x}%`; guide.hidden = false;
    tip.textContent = `${when(pt.t)} · ${fmt(pt.tokens)} tokens${pt.cacheRead ? ` (${fmt(pt.cacheRead)} cache reads)` : ''}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(x, 18), 82)}%`;
  }
  const hoverIndex = () => { const ser = P.data?.spend?.series || []; const i = ser.findIndex(p => p.t === P.hover); return i < 0 ? null : i; };
  pop.addEventListener('pointermove', e => {
    const chart = e.target.closest('.sp-chart');
    if (!chart) return;
    const r = chart.getBoundingClientRect(), n = P.data?.spend?.series?.length || 0;
    showTip(Math.round(((e.clientX - r.left) / r.width) * (n - 1)));
  });
  pop.addEventListener('pointerleave', e => { if (e.target.closest?.('.sp-chart')) showTip(null); }, true);
  pop.addEventListener('keydown', e => {
    if (!e.target.matches?.('.sp-chart') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const n = P.data?.spend?.series?.length || 0, cur = hoverIndex() ?? n - 1;
    showTip(e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : cur + (e.key === 'ArrowLeft' ? -1 : 1));
  });
  pop.addEventListener('focusout', e => { if (e.target.matches?.('.sp-chart')) showTip(null); });

  function renderPop() {
    if (pop.hidden) return;
    const f = document.activeElement, key = pop.contains(f) ? ['[data-sp-auto]', '[data-sp-detail]', '.sp-chart'].find(k => f.matches(k)) || null : null;
    pop.innerHTML = popHTML();
    if (key) pop.querySelector(key)?.focus();
    if (P.hover != null) showTip(hoverIndex());
  }
  function fillMenu(el) { el.innerHTML = popHTML(); poll(); }
  pop.addEventListener('click', e => {
    // The Models view lives in the agent panel; this is a shortcut to it from the usage menu.
    if (e.target.closest('[data-sp-models]')) { document.getElementById('view-models')?.click(); return; }
    if (!e.target.closest('[data-sp-detail]')) return;
    P.detail = !P.detail;
    store.set('va.spend.detail', P.detail ? '1' : '0');
    renderPop();
  });
  pop.addEventListener('change', async e => {
    if (!e.target.matches('[data-sp-auto]')) return;
    P.autoErr = '';
    try {
      const res = await fetch('/api/autoswitch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server returned ${res.status}`);
    } catch (err) { P.autoErr = `Couldn't save: ${err instanceof TypeError ? "the Agentville server isn't reachable" : err.message}`; }
    poll();
  });

  // ---------- automatic switches: tell the user once, with Undo ----------
  function announce() {
    const last = P.data?.autoSwitch?.last;
    if (!last) return;
    const seen = Number(store.get('va.autoswitch.seen')) || 0;
    if (last.at <= seen) return;
    store.set('va.autoswitch.seen', String(last.at));
    window.dispatchEvent(new CustomEvent('va:account-changed'));
    if (Date.now() - last.at > 3600e3) return; // long ago: the details are in the menu
    const to = last.to === 'pool' ? 'the pool' : last.toLabel || 'another account';
    const text = last.error ? `Auto-switch to ${to} failed: ${last.error}`
      : last.restored ? `Auto-switch to ${to} was rolled back: the first job didn't come back healthy`
      : `Switched automatically to ${to}: ${last.fromLabel || 'the account'} — ${WHY[last.why] || 'out of usage'}. ${last.respawned} job${last.respawned === 1 ? '' : 's'} restarted.`;
    app.toast(text, last.error || last.restored ? null : { label: 'Undo', run: undo }, 30000);
    const l = $('live'); if (l) l.textContent = text;
  }
  async function undo() {
    try {
      const res = await fetch('/api/account/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Server returned ${res.status}`);
      app.toast('Account settings restored. Running jobs move back when they next restart.');
    } catch (e) { app.toast(`Couldn't undo: ${e instanceof TypeError ? "the Agentville server isn't reachable" : e.message}`); }
    window.dispatchEvent(new CustomEvent('va:account-changed'));
    app.refresh();
    poll();
  }

  return { fillMenu, poll };
}
