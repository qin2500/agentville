// Keyed DOM layer for the engine's labels. Elements are reused by data-key ("t:<serverId>", "v:<name>",
// "c:<id>", "p:<id>"); nothing is rebuilt per frame unless its content changed. All text is escaped:
// agent and project names are untrusted.
//   createLabelLayer(el, { icon }) -> { render(placed), clear() }
// `icon(kind)` returns the classic 12x12 pixel icon svg (web/src/ui.js `icon`); it is injected because ui.js
// is not importable outside the browser. Without it the plate shows counts only.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

const KINDS = new Set(['prompt', 'error', 'stalled', 'waiting']);

export function plateHtml(p, icon = () => '') {
  const parts = (p.parts || []).filter(([k]) => KINDS.has(k));
  return `<b>${esc(p.text)}</b><span class="cnt">${parts.map(([k, n]) => `<i class="k-${k}">${icon(k)}${Number(n) | 0}</i>`).join('')}</span>`;
}

export function createLabelLayer(el, { icon } = {}) {
  const doc = el.ownerDocument || globalThis.document;
  const els = new Map();
  const setStyle = (node, prop, val) => { if (node.style[prop] !== val) node.style[prop] = val; };
  function render(placed) {
    const want = new Set(placed.map(p => p.key));
    for (const [k, node] of els) if (!want.has(k)) { node.remove(); els.delete(k); }
    for (const p of placed) {
      let node = els.get(p.key);
      if (!node) { node = doc.createElement('div'); node.dataset.key = p.key; els.set(p.key, node); el.append(node); }
      if (node.className !== p.cls) node.className = p.cls;
      if (p.parts) {
        const html = plateHtml(p, icon);
        if (node.dataset.html !== html) { node.innerHTML = html; node.dataset.html = html; }
      } else if (node.textContent !== p.text || node.dataset.html) { node.textContent = p.text; delete node.dataset.html; }
      if (p.accent && node.style.getPropertyValue('--accent') !== p.accent) node.style.setProperty('--accent', p.accent);
      setStyle(node, 'left', `${Math.round(p.left)}px`);
      setStyle(node, 'top', `${Math.round(p.top)}px`);
    }
  }
  return { render, clear: () => render([]) };
}
