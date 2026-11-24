// Settings > Providers: default provider, order (up/down buttons), handoff mode, minWait, agent-start limits.
// Reads GET /api/providers, saves with PUT /api/providers/settings. A 404 (server without providers) hides the section.
import { esc } from './ui.js';

const LABEL = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' };
const label = id => LABEL[id] || id;
const MODES = [['auto', 'Automatic'], ['ask', 'Ask first'], ['off', 'Off']];

// Move item i by dir (-1/+1); keeps the default pinned first.
export function reorder(order, i, dir, def) {
  const o = order.slice(), j = i + dir;
  if (j < 0 || j >= o.length) return o;
  [o[i], o[j]] = [o[j], o[i]];
  if (def && o.includes(def)) return [def, ...o.filter(x => x !== def)];
  return o;
}
export const pinDefault = (order, def) => [def, ...order.filter(x => x !== def)];
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function providersSettingsHTML(p) {
  const order = pinDefault(p.providerOrder || [], p.defaultProvider);
  const ids = (p.providers || []).map(x => x.id);
  const opts = ids.map(id => `<option value="${esc(id)}" ${id === p.defaultProvider ? 'selected' : ''}>${esc(label(id))}</option>`).join('');
  const ho = p.handoff || {}, st = p.agentStarts || {};
  const rows = order.map((id, i) => `<li><span>${esc(label(id))}${i === 0 ? ' (default)' : ''}</span>
      <button type="button" class="textbtn" data-prov="up" data-i="${i}" aria-label="Move ${esc(label(id))} up" ${i < 2 ? 'disabled' : ''}>↑</button>
      <button type="button" class="textbtn" data-prov="down" data-i="${i}" aria-label="Move ${esc(label(id))} down" ${i === 0 || i === order.length - 1 ? 'disabled' : ''}>↓</button></li>`).join('');
  return `<h4>Providers</h4>
    <label>Default provider <select data-prov="default">${opts}</select></label>
    <p class="helper">Order to try when a provider runs out (the default is always first)</p>
    <ol class="prov-order">${rows}</ol>
    <label>Handoff when a provider is out <select data-prov="mode">${MODES.map(([v, t]) => `<option value="${v}" ${ho.mode === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label>Wait for a reset under <input type="number" min="0" max="1440" step="1" data-prov="minwait" value="${Math.round((ho.minWaitMs ?? 1800000) / 60000)}" style="width:4.5em"> min</label>
    <label><input type="checkbox" data-prov="starts-on" ${st.enabled !== false ? 'checked' : ''}>Let agents start other agents</label>
    <label>Starts per hour, per agent <input type="number" min="1" max="60" data-prov="perhour" value="${st.perHour ?? 20}" style="width:4.5em"></label>
    <label>Max start depth <input type="number" min="1" max="10" data-prov="depth" value="${st.maxDepth ?? 3}" style="width:4.5em"></label>
    <p class="helper" data-prov="status" role="status"></p>`;
}

// Fill `el` and wire it. Returns a promise that resolves once loaded. `fetchFn` is injectable for tests.
export async function mountProvidersSettings(el, fetchFn = (...a) => fetch(...a)) {
  if (!el) return;
  const status = msg => { const s = el.querySelector('[data-prov="status"]'); if (s) s.textContent = msg || ''; };
  let p;
  try {
    const r = await fetchFn('/api/providers', { cache: 'no-store' });
    if (r.status === 404) { el.hidden = true; return; } // older server: no Providers section
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    p = await r.json();
  } catch (e) { el.innerHTML = `<h4>Providers</h4><p class="helper">Couldn't load providers${e instanceof TypeError ? ': server not reachable' : `: ${esc(e.message)}`}.</p>`; return; }
  const draw = () => { el.innerHTML = providersSettingsHTML(p); };
  draw();
  async function save(patch, revert) {
    el.querySelectorAll('select,input,button').forEach(n => { n.disabled = true; });
    try {
      const r = await fetchFn('/api/providers/settings', { method: 'PUT', headers: { 'content-type': 'application/json', 'X-Agentville-UI': '1' }, body: JSON.stringify(patch) });
      if (r.status === 404) throw new Error('this server has no provider settings yet');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json().catch(() => null);
      const s = j && (j.settings || j);
      for (const k of ['defaultProvider', 'providerOrder', 'handoff', 'agentStarts']) if (s && s[k] !== undefined) p[k] = s[k];
      draw();
    } catch (e) {
      revert?.();
      draw();
      status(`Couldn't save: ${e instanceof TypeError ? 'server not reachable' : e.message}`);
    }
  }
  el.addEventListener('click', e => {
    const b = e.target.closest?.('button[data-prov]');
    if (!b || b.disabled) return;
    const i = Number(b.dataset.i), dir = b.dataset.prov === 'up' ? -1 : 1;
    save({ providerOrder: reorder(pinDefault(p.providerOrder, p.defaultProvider), i, dir, p.defaultProvider) });
  });
  el.addEventListener('change', e => {
    const t = e.target, k = t.dataset?.prov;
    if (k === 'default') save({ defaultProvider: t.value, providerOrder: pinDefault(p.providerOrder, t.value) });
    else if (k === 'mode') save({ handoff: { mode: t.value } });
    else if (k === 'minwait') save({ handoff: { minWaitMs: clampInt(t.value, 0, 1440, 30) * 60000 } });
    else if (k === 'starts-on') save({ agentStarts: { enabled: t.checked } });
    else if (k === 'perhour') save({ agentStarts: { perHour: clampInt(t.value, 1, 60, 20) } });
    else if (k === 'depth') save({ agentStarts: { maxDepth: clampInt(t.value, 1, 10, 3) } });
  });
}
