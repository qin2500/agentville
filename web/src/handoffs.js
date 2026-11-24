// Handoffs list for the Accounts menu (docs/providers-design.md 3.5): old agent -> new agent, state, note link,
// and Undo / Retry / Dismiss / Approve. Pure helpers plus small fetch wrappers; account.js owns the DOM.
// GET /api/handoffs may not exist yet on an older server: a 404 reads as "no handoffs", never as an error.

const STATE = {
  planned: 'Planned', waiting_idle: 'Waiting for a turn boundary', noted: 'Note written', starting: 'Starting',
  started: 'Running', stopping: 'Stopping old agent', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', undone: 'Undone',
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PROVIDER = { claude: 'Claude', gemini: 'Gemini' };

export const handoffStateLabel = s => STATE[s] || String(s || 'Unknown');

/** The buttons a record offers, by state. */
export function handoffActions(h) {
  const a = [];
  if (h.state === 'planned') a.push({ act: 'approve', label: 'Approve' });
  if (h.state === 'started' || h.state === 'done') a.push({ act: 'undo', label: 'Undo' });
  if (h.state === 'failed') a.push({ act: 'retry', label: 'Retry' });
  if (['planned', 'failed', 'cancelled', 'undone', 'done'].includes(h.state)) a.push({ act: 'dismiss', label: 'Dismiss' });
  return a;
}

const agentName = (side) => (side && (side.name || side.label || side.id)) || 'agent';
const provName = (side) => PROVIDER[side?.provider] || side?.provider || '';

/** One list item. `h`: { id, state, from:{name,id,provider}, to:{name,id,provider}, notePath|noteUrl, note, warning }. */
export function handoffRowHTML(h, { busy = false } = {}) {
  const from = `${esc(agentName(h.from))}${provName(h.from) ? ` (${esc(provName(h.from))})` : ''}`;
  const to = h.to ? `${esc(agentName(h.to))}${provName(h.to) ? ` (${esc(provName(h.to))})` : ''}` : '…';
  const link = h.noteUrl ? `<a href="${esc(h.noteUrl)}" target="_blank" rel="noopener">Note</a>` : h.notePath ? `<code title="Handoff note">${esc(h.notePath)}</code>` : '';
  const extra = [h.warning, h.note].filter(Boolean).map(esc).join(' · ');
  const btns = handoffActions(h).map(b => `<button class="ghost sm" type="button" data-am="handoff-${b.act}" data-id="${esc(h.id)}" data-key="handoff-${b.act}:${esc(h.id)}" ${busy ? 'disabled' : ''}>${b.label}</button>`).join('');
  return `<li class="acct-row handoff" data-handoff="${esc(h.id)}">
    <div class="acct-l1"><b class="acct-nm" title="${from} → ${to}">${from} → ${to}</b><span class="acct-pill">${esc(handoffStateLabel(h.state))}</span></div>
    ${link || extra ? `<p class="acct-note acct-l2">${link}${link && extra ? ' · ' : ''}${extra}</p>` : ''}
    ${btns ? `<div class="acct-l2 acct-acts">${btns}</div>` : ''}</li>`;
}

/** The section, or '' when there is nothing to show. A one-line summary; the rows show once `open` (the list stays in the markup either way). */
export function handoffsHTML(list, opts = {}) {
  if (!Array.isArray(list) || !list.length) return '';
  const open = !!opts.open;
  return `<div class="acct-handoffs acct-sec"><button class="acct-sh" type="button" data-am="toggle-handoffs" data-id="" data-key="toggle-handoffs:" aria-expanded="${open}" aria-label="Handoffs, ${list.length}, ${open ? 'collapse' : 'expand'}"><svg class="acct-chev${open ? ' open' : ''}" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Handoffs · ${list.length}</span></button><ul class="acct-rows" aria-label="Handoffs"${open ? '' : ' hidden'}>${list.map(h => handoffRowHTML(h, opts)).join('')}</ul></div>`;
}

/** Fetch the list. A 404 (endpoint not built yet) or a network failure gives []. */
export async function loadHandoffs(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/api/handoffs', { cache: 'no-store' });
    if (!res.ok) return [];
    const body = await res.json().catch(() => ({}));
    return Array.isArray(body) ? body : Array.isArray(body.handoffs) ? body.handoffs : [];
  } catch { return []; }
}

/** POST /api/handoffs/:id/(undo|retry|dismiss|approve). Throws Error(message) on failure; a 404 says the server doesn't support it yet. */
export async function handoffAction(fetchImpl, id, act) {
  const res = await fetchImpl(`/api/handoffs/${encodeURIComponent(id)}/${act}`, { cache: 'no-store', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const out = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error('This server does not support handoffs yet');
  if (!res.ok) throw new Error(out.error || `Server returned ${res.status}`);
  return out;
}
