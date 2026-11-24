// Pieces the right-click menus share (the agent menu, ctxmenu.js, and the account row menu,
// acctmenu.js): the menu-item markup, where a menu opens, and the keyboard walk through its items.
import { esc } from './ui.js';

/** One menu item: { act, label, why?, danger?, popup?, pressed?, title? }. `why` disables it and says why. */
export function itemHTML(it, i) {
  const why = it.why ? `<span class="cm-note" id="cm-why-${i}">${esc(it.why)}</span>` : '';
  return `<button type="button" role="menuitem" class="cm-item${it.danger ? ' danger' : ''}" data-cm="${it.act}" tabindex="-1"${it.why ? ` aria-disabled="true" aria-describedby="cm-why-${i}"` : ''}${it.popup ? ' aria-haspopup="dialog"' : ''}${it.pressed ? ' aria-current="true"' : ''}${it.title ? ` title="${esc(it.title)}"` : ''}><span class="cm-label">${esc(it.label)}</span>${why}</button>`;
}

/** at: { x, y } (a pointer) or { el } (a focused row or a button: the menu opens under it). */
function anchorOf(at) {
  if (at.el?.isConnected) {
    const r = at.el.getBoundingClientRect();
    const btn = at.el.matches('.menubtn, .acct-more');
    return { x: btn ? r.right : Math.min(r.left + 24, r.right), y: r.bottom + 2, alignRight: btn, above: r.top - 2 };
  }
  return { x: at.x ?? innerWidth / 2, y: at.y ?? innerHeight / 3, above: at.y };
}
/** Position a fixed menu element inside the viewport. */
export function placeMenu(el, at) {
  const m = 8, vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  el.style.maxHeight = `${vh - 2 * m}px`;
  el.style.left = '0px'; el.style.top = '0px';
  const w = el.offsetWidth, hgt = el.offsetHeight, p = anchorOf(at);
  let x = p.alignRight ? p.x - w : p.x, y = p.y;
  if (y + hgt > vh - m) y = p.above != null && p.above - hgt >= m ? p.above - hgt : vh - m - hgt;
  x = Math.max(m, Math.min(x, vw - m - w));
  y = Math.max(m, y);
  el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
}

/**
 * Keys inside a menu (items are `.cm-item`): arrows, Home/End, type-ahead, Enter/Space to pick, Esc
 * to close. Returns true when it handled the key.
 */
export function menuKeys(el, e, { close, run }) {
  const its = [...el.querySelectorAll('.cm-item')], i = its.indexOf(document.activeElement);
  const go = j => its[(j + its.length) % its.length]?.focus();
  switch (e.key) {
    case 'ArrowDown': go(i < 0 ? 0 : i + 1); break;
    case 'ArrowUp': go(i < 0 ? its.length - 1 : i - 1); break;
    case 'Home': go(0); break;
    case 'End': go(its.length - 1); break;
    case 'Escape': close({ restore: true }); break;
    case 'Tab': go(i < 0 ? 0 : i); break; // Tab stays inside
    case 'Enter': case ' ': { const b = document.activeElement?.closest?.('.cm-item'); if (!b) return false; run(b); break; }
    default:
      if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase(), from = i + 1;
        const hit = [...its.slice(from), ...its.slice(0, from)].find(b => b.textContent.trim().toLowerCase().startsWith(k));
        if (hit) hit.focus();
        break;
      }
      return false;
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}
