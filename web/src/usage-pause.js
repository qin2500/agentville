// Usage pause: when every Claude account is out of usage the server pauses all agents and waits
// for one to come back (GET/POST /api/usage-pause). This shows a banner under the top bar and
// supplies the "Pause agents when all accounts are out" toggle for the account menu.
// Quiet when the server doesn't have the endpoint yet (404).
const POLL_MS = 30000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3:40 PM" style local time, or '' when `ms` isn't a usable epoch. */
export function formatTime(ms, locale) {
  const at = Number(ms);
  return at > 0 ? new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : '';
}
/** Banner text for a /api/usage-pause body; '' means hidden. */
export function bannerText(d, locale) {
  if (!d || d.enabled === false) return d?.state === 'resuming' ? 'Usage is back — resuming agents…' : '';
  if (d.state === 'resuming') return 'Usage is back — resuming agents…';
  if (d.state !== 'paused') return '';
  const n = Array.isArray(d.agents) ? d.agents.length : 0;
  const t = formatTime(d.until, locale);
  return `All accounts are out of usage — ${plural(n, 'agent')} paused.${t ? ` Resumes automatically ~${t}.` : ' Resumes automatically when an account has room.'}`;
}

let state = null; // last good body
export const pauseToggleHTML = () => state
  ? `<label class="acct-note usage-pause-toggle" style="display:flex;gap:8px;align-items:center;margin:8px 0"><input type="checkbox" data-usage-pause data-key="usage-pause" ${state.enabled ? 'checked' : ''}> Pause agents when all accounts are out</label>`
  : '';

export function createUsagePause() {
  const bar = document.createElement('div');
  bar.id = 'usage-pause'; bar.className = 'nudge'; bar.setAttribute('role', 'status'); bar.hidden = true;
  bar.style.fontWeight = '600';
  const anchor = document.getElementById('nudge');
  if (anchor) anchor.before(bar); else document.getElementById('app')?.prepend(bar);

  const render = () => {
    const text = bannerText(state);
    bar.hidden = !text;
    if (bar.textContent !== text) bar.textContent = text;
  };
  async function poll() {
    try {
      const res = await fetch('/api/usage-pause', { cache: 'no-store' });
      if (res.ok) state = await res.json(); else if (res.status === 404) state = null;
    } catch { /* server unreachable: keep what we have */ }
    render();
  }
  document.getElementById('pop-account')?.addEventListener('change', async e => {
    const box = e.target.closest?.('[data-usage-pause]');
    if (!box || !state) return;
    const enabled = box.checked;
    try {
      const res = await fetch('/api/usage-pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
      if (!res.ok) throw new Error(String(res.status));
      state = { ...state, ...(await res.json().catch(() => ({ enabled }))) };
    } catch { box.checked = !enabled; }
    render();
  });
  poll();
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  return { poll };
}
