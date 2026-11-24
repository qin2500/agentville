// The right-click menu on a saved account row in the Account menu: Rename, Quarantine, Low priority and
// Remove. It reuses the agent menu's look (.ctxmenu / .cm-item) and keyboard walk (menu-kit.js). Opened by
// a right-click, the ContextMenu key or Shift+F10 on a focused row, or the row's "⋯" button.
import { esc } from './ui.js';
import { itemHTML, placeMenu, menuKeys } from './menu-kit.js';
import { accountMenuItems } from './acct-items.js';

/** host: the Account pop element. deps: { accountOf(id), pick(act, id), isRow(rowEl) }. */
export function createAccountMenu(host, deps) {
  const el = document.createElement('div');
  el.id = 'acctctx';
  el.className = 'ctxmenu acctctx';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  document.body.append(el);
  const M = { id: null, openedAt: 0, back: null };
  const rowOf = id => host.querySelector(`.acct-row[data-row="${CSS.escape(id)}"]`);
  const isOpen = () => !el.hidden;

  function open(id, at) {
    const a = deps.accountOf(id);
    if (!a) return;
    if (isOpen() && M.id === id && Date.now() - M.openedAt < 400) return; // the key also fires a contextmenu event
    if (isOpen()) mark(false);
    M.id = id; M.openedAt = Date.now(); M.back = at.el?.dataset?.key || null;
    let i = 0;
    const body = accountMenuItems(a).map(it => it.sep ? '<div class="cm-sep" role="separator"></div>' : itemHTML(it, i++)).join('');
    el.innerHTML = `<div class="cm-head"><p class="cm-title"><span class="cm-name" id="acm-name">${esc(a.label)}</span></p></div><div class="cm-items" role="menu" aria-labelledby="acm-name">${body}</div>`;
    el.setAttribute('aria-label', `${a.label}: actions`);
    el.hidden = false;
    mark(true);
    placeMenu(el, at);
    el.querySelector('.cm-item')?.focus({ preventScroll: true });
  }
  function mark(on) {
    for (const x of host.querySelectorAll('.cm-target')) x.classList.remove('cm-target');
    if (on && M.id) rowOf(M.id)?.classList.add('cm-target');
  }
  function close({ restore = false } = {}) {
    if (!isOpen()) return false;
    const id = M.id, back = M.back;
    el.hidden = true; M.id = null; mark(false);
    // The Account menu re-renders its rows, so find the row again by its key.
    if (restore) (host.querySelector(`[data-key="${CSS.escape(back || `more:${id}`)}"]`) || rowOf(id))?.focus({ preventScroll: true });
    return true;
  }
  function run(btn) {
    const id = M.id, act = btn.dataset.cm;
    close();
    deps.pick(act, id);
  }

  el.addEventListener('click', e => { const b = e.target.closest('.cm-item'); if (b) { e.preventDefault(); run(b); } });
  el.addEventListener('keydown', e => { menuKeys(el, e, { close, run }); });
  el.addEventListener('contextmenu', e => e.preventDefault());

  // Triggers on the rows of the Account menu.
  const target = t => { const r = t?.closest?.('.acct-row[data-acct-menu]'); return r ? r.dataset.row : null; };
  host.addEventListener('contextmenu', e => {
    if (e.target.closest('input, textarea')) return; // keep the browser's text menu
    const id = target(e.target);
    if (!id) return;
    e.preventDefault();
    const kb = e.clientX === 0 && e.clientY === 0; // a keyboard-made event has no pointer position
    open(id, kb ? { el: e.target.closest('.acct-row') } : { x: e.clientX, y: e.clientY });
  });
  host.addEventListener('keydown', e => {
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    if (e.target.closest('input, textarea')) return;
    const id = target(e.target);
    if (!id) return;
    e.preventDefault();
    open(id, { el: e.target.closest('.acct-row') });
  });
  host.addEventListener('click', e => {
    const b = e.target.closest('.acct-more[data-more]');
    if (!b) return;
    e.preventDefault();
    if (isOpen() && M.id === b.dataset.more) return close({ restore: true });
    open(b.dataset.more, { el: b });
  });
  // Close on an outside press, Esc, scroll, resize.
  document.addEventListener('pointerdown', e => { if (isOpen() && !el.contains(e.target) && !e.target.closest?.('.acct-more')) close(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) { e.preventDefault(); e.stopPropagation(); close({ restore: true }); } }, true);
  addEventListener('scroll', e => { if (isOpen() && !el.contains(e.target)) close(); }, true);
  addEventListener('resize', () => close());

  return { open, close, isOpen, el };
}
