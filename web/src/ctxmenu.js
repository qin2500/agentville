// The agent menu: right-click an agent anywhere it appears (a village villager or house, a Status or
// Team row, a Team card, a Tree node, a Table row, the terminal's name) for a short header about it and
// the things you can do to it. It replaces the old inspector. Also opened by the ContextMenu key or
// Shift+F10 on a focused row, a long press on touch, the small "⋯" button on a row, and a double-click
// on an agent that can't be opened in the terminal (its "Open in terminal" says why).
//
// Actions keep their old rules and confirm steps: Fork, Stop job and Edit open a sheet (agentsheet.js)
// that shows the exact command or form first. No conversation text is shown here.
import { BUCKET_NAME, ROLE_NAME, HARNESS_NAME, isError, bucketIcon, icon, ago, esc, safeHref } from './ui.js';
import { prTone } from './prs.js';
import { stoppedNote } from './important.js';

const SUBS = ['subagent', 'teammate', 'thread'];
const LONG_PRESS_MS = 500;

/**
 * deps (from panel.js): openBlock(a), termBlock(a), embedded(id), terminal(), termName(),
 * openAgent(id), hide(a, on), sheet: { open(kind, a, opener) }.
 */
export function createMenu(app, deps) {
  const { S } = app;
  const el = document.createElement('div');
  el.id = 'ctxmenu';
  el.className = 'ctxmenu';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  document.body.append(el);
  const M = { id: null, opener: null, openedAt: 0, sig: '', at: null };

  /** The agent a page element stands for, if any (rows, cards, tree nodes, table rows, the terminal's name). */
  function agentAt(t) {
    if (!t?.closest) return null;
    const r = t.closest('#list .row[data-id], #list .trow[data-id], #list .tnode[data-id], #list .menubtn[data-menu]');
    if (r) return r.dataset.id || r.dataset.menu;
    if (t.closest('#stage .termhead .tname, #stage .termhead .tglyph')) return S.term;
    return null;
  }

  // ---------- content ----------
  function items(a) {
    const out = [];
    const sub = SUBS.includes(a.kind);
    const builtIn = !!S.data?.term?.available, term = deps.terminal();
    if (builtIn) {
      const why = deps.termBlock(a);
      const there = S.term === a.id || deps.embedded(a.id);
      out.push({ act: 'term', label: there ? 'In the terminal' : 'Open in terminal', why, pressed: S.term === a.id });
    } else if (term) {
      out.push({ act: 'open', label: `Open in ${deps.termName()}`, why: deps.openBlock(a) });
    }
    out.push({ act: 'showvillage', label: 'Show in village' });
    if (a.resume) out.push({ act: 'copy', label: /^claude attach /.test(a.resume) ? 'Copy attach command' : 'Copy resume command', title: a.resume });
    if (a.harness === 'claude-code' && !sub && !a.neverStarted) out.push({ act: 'fork', label: 'Fork…', popup: true });
    if (!sub && (a.bucket !== 'resting' || a.live)) out.push({ act: 'stop', label: a.kind === 'job' ? 'Stop job…' : 'Stop…', popup: true });
    if (!sub) out.push({ act: 'important', label: a.important ? 'Unmark important' : 'Mark important', title: 'Important agents are never folded away or tidied out of view (only Hide removes them), and come back with Restore after crash' });
    out.push({ act: 'edit', label: 'Edit…', popup: true });
    out.push(a.hidden ? { act: 'unhide', label: 'Show in village again' } : { act: 'hide', label: 'Hide in village', danger: true });
    return out;
  }
  function headHTML(a) {
    const now = S.data?.serverTime || Date.now();
    const err = isError(a);
    const status = stoppedNote(a) || a.reason || BUCKET_NAME[a.bucket];
    const meta = [a.project || 'No project', ROLE_NAME[a.role] || a.role, HARNESS_NAME[a.harness] || a.harness,
      a.lastActivityAt ? `active ${ago(now - a.lastActivityAt)} ago` : ''].filter(Boolean);
    const prs = (a.prs || []).map(p => {
      const href = safeHref(p.href), t = prTone(p);
      const words = t.words ? ` (${t.words})` : '';
      return href
        ? `<a class="chip${t.cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-cmpr title="Open PR #${esc(p.id)}${esc(words)} in a new tab">#${esc(p.id)}<span class="sr">${esc(words)}, opens in a new tab</span></a>`
        : `<span class="chip${t.cls}" title="PR #${esc(p.id)}${esc(words)}">#${esc(p.id)}</span>`;
    }).join('');
    return `<div class="cm-head">
      <p class="cm-title">${icon(a.role in ROLE_NAME ? a.role : 'solo', 'px role')}<span class="cm-name" id="cm-name">${esc(a.name)}</span>${a.important ? '<span class="star" title="Important" aria-label="Important">★</span>' : ''}${a.hidden ? '<span class="htag">Hidden</span>' : ''}</p>
      <p class="cm-status"><span class="pill b-${err ? 'error' : a.bucket}">${icon(bucketIcon(a))}${err ? 'Error' : BUCKET_NAME[a.bucket]} · <span class="num">${ago(now - (a.since || now))}</span></span><span class="cm-why">${esc(status)}</span></p>
      <p class="cm-meta">${meta.map(esc).join(' · ')}</p>
      ${stoppedNote(a) ? `<p class="cm-stop"><b>${esc(stoppedNote(a))}</b>. It isn't running; it stays in view because it's Important. ${S.data?.term?.available || deps.terminal() ? 'Open it in the terminal to resume it.' : ''}</p>` : ''}
      ${prs ? `<p class="cm-prs" aria-label="Pull requests">${prs}</p>` : ''}
    </div>`;
  }
  function itemHTML(it, i) {
    const why = it.why ? `<span class="cm-note" id="cm-why-${i}">${esc(it.why)}</span>` : '';
    return `<button type="button" role="menuitem" class="cm-item${it.danger ? ' danger' : ''}" data-cm="${it.act}" tabindex="-1"${it.why ? ` aria-disabled="true" aria-describedby="cm-why-${i}"` : ''}${it.popup ? ' aria-haspopup="dialog"' : ''}${it.pressed ? ' aria-current="true"' : ''}${it.title ? ` title="${esc(it.title)}"` : ''}><span class="cm-label">${esc(it.label)}</span>${why}</button>`;
  }
  function render() {
    const a = S.byId.get(M.id) || S.data?.agents?.find(x => x.id === M.id);
    if (!a) return close();
    const list = items(a);
    const GROUP = { fork: 1, stop: 1, important: 2, edit: 2, hide: 2, unhide: 2 };
    let g = 0;
    const body = list.map((it, i) => { const k = GROUP[it.act] || 0, sep = i && k !== g ? '<div class="cm-sep" role="separator"></div>' : ''; g = k; return sep + itemHTML(it, i); }).join('');
    const html = `${headHTML(a)}<div class="cm-items" role="menu" aria-labelledby="cm-name">${body}</div>`;
    if (html === M.sig) return;
    const focused = el.contains(document.activeElement) ? (document.activeElement.dataset.cm || (document.activeElement.matches('[data-cmpr]') ? `pr:${document.activeElement.getAttribute('href')}` : null)) : null;
    M.sig = html;
    el.innerHTML = html;
    el.setAttribute('aria-label', `${a.name}: actions`);
    if (focused) (focused.startsWith('pr:') ? [...el.querySelectorAll('[data-cmpr]')].find(x => `pr:${x.getAttribute('href')}` === focused) : el.querySelector(`[data-cm="${CSS.escape(focused)}"]`))?.focus();
  }

  // ---------- open / close / place ----------
  /** at: { x, y } (a pointer) or { el } (a focused row or a button: the menu opens under it). */
  function open(id, at = {}) {
    if (!id || !(S.byId.has(id) || S.data?.agents?.some(x => x.id === id))) return;
    // The ContextMenu key and Shift+F10 can also fire a contextmenu event: one open, not two.
    if (!el.hidden && M.id === id && Date.now() - M.openedAt < 400) return;
    app.closePops?.();
    if (!el.hidden) mark(false);
    M.opener = at.el || (document.activeElement !== document.body ? document.activeElement : null);
    M.id = id; M.openedAt = Date.now(); M.sig = ''; M.at = at;
    el.hidden = false;
    render();
    mark(true);
    place(at);
    first()?.focus({ preventScroll: true });
  }
  function anchorOf(at) {
    if (at.el?.isConnected) {
      const r = at.el.getBoundingClientRect();
      const btn = at.el.matches('.menubtn');
      return { x: btn ? r.right : Math.min(r.left + 24, r.right), y: r.bottom + 2, alignRight: btn, above: r.top - 2 };
    }
    return { x: at.x ?? innerWidth / 2, y: at.y ?? innerHeight / 3, above: at.y };
  }
  function place(at) {
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
  /** The thing the menu is for gets a ring while it is open. */
  function mark(on) {
    for (const x of document.querySelectorAll('.cm-target')) x.classList.remove('cm-target');
    if (!on || !M.id) return;
    const sel = `#list [data-id="${CSS.escape(M.id)}"]:is(.row, .trow, .tnode)`;
    for (const x of document.querySelectorAll(sel)) x.classList.add('cm-target');
  }
  function close({ restore = false } = {}) {
    if (el.hidden) return false;
    el.hidden = true;
    mark(false);
    const opener = M.opener;
    M.id = null; M.sig = ''; M.opener = null;
    if (restore && opener?.isConnected && opener.offsetParent !== null) opener.focus({ preventScroll: true });
    return true;
  }
  const isOpen = () => !el.hidden;
  const menuItems = () => [...el.querySelectorAll('.cm-item')];
  const first = () => menuItems().find(b => b.getAttribute('aria-disabled') !== 'true') || menuItems()[0];

  // ---------- actions ----------
  async function run(btn) {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    const a = S.byId.get(M.id) || S.data?.agents?.find(x => x.id === M.id);
    if (!a) return close();
    const act = btn.dataset.cm, opener = M.opener;
    close();
    switch (act) {
      case 'term':
        if (S.term === a.id) return app.focusTerminal?.();
        if (!deps.termBlock(a)) app.openTerminal(a.id);
        return;
      case 'open': return deps.openAgent(a.id);
      case 'showvillage': return app.showInVillage(a.id);
      case 'copy':
        try { await navigator.clipboard.writeText(a.resume); app.toast(`Copied: ${a.resume}`); } catch { app.toast("Couldn't copy to the clipboard."); }
        return;
      case 'fork': case 'stop': case 'edit': return deps.sheet.open(act, a, opener);
      case 'important':
        try { await app.patch(a.id, { important: a.important ? null : true }); app.say(a.important ? `${a.name} is no longer marked important` : `${a.name} marked important`); } catch (e) { app.toast(saveError(e)); }
        return;
      case 'hide': return deps.hide(a, true);
      case 'unhide': return deps.hide(a, false);
    }
  }
  const saveError = e => (e instanceof TypeError ? "Couldn't save: the server isn't reachable." : `Couldn't save: ${e.message}`);

  el.addEventListener('click', e => {
    const b = e.target.closest('.cm-item');
    if (b) { e.preventDefault(); run(b); return; }
    if (e.target.closest('[data-cmpr]')) setTimeout(() => close(), 0); // the link opens on its own
  });
  el.addEventListener('keydown', e => {
    const its = menuItems(), i = its.indexOf(document.activeElement);
    const go = j => its[(j + its.length) % its.length]?.focus();
    switch (e.key) {
      case 'ArrowDown': go(i < 0 ? 0 : i + 1); break;
      case 'ArrowUp': go(i < 0 ? its.length - 1 : i - 1); break;
      case 'Home': go(0); break;
      case 'End': go(its.length - 1); break;
      case 'Escape': close({ restore: true }); break;
      case 'Tab': {
        // Tab stays inside: the PR links in the header, then the menu.
        const stops = [...el.querySelectorAll('[data-cmpr]'), its[Math.max(0, i)] || its[0]].filter(Boolean);
        const k = stops.indexOf(document.activeElement);
        stops[(k + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
        break;
      }
      case 'Enter': case ' ': {
        const b = document.activeElement?.closest?.('.cm-item');
        if (!b) return;
        run(b);
        break;
      }
      default:
        // Type-ahead: the first letter jumps to the next item starting with it.
        if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const k = e.key.toLowerCase(), from = i + 1;
          const hit = [...its.slice(from), ...its.slice(0, from)].find(b => b.textContent.trim().toLowerCase().startsWith(k));
          if (hit) hit.focus();
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  // ---------- triggers ----------
  document.addEventListener('contextmenu', e => {
    if (el.contains(e.target)) { e.preventDefault(); return; }
    const id = agentAt(e.target);
    if (!id) return;
    e.preventDefault();
    // A keyboard-made event (ContextMenu key, Shift+F10) has no pointer position: open under the row.
    const kb = e.clientX === 0 && e.clientY === 0;
    open(id, kb ? { el: e.target.closest('.row, .trow, .tnode, .tname') || e.target } : { x: e.clientX, y: e.clientY });
  });
  document.addEventListener('keydown', e => {
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    if (e.target.closest?.('#stage .xterm')) return; // the terminal owns its keys
    const id = agentAt(e.target);
    if (!id) return;
    e.preventDefault();
    open(id, { el: e.target.closest('.row, .trow, .tnode, .tname') || e.target });
  });
  // "⋯" on a row.
  document.addEventListener('click', e => {
    const b = e.target.closest?.('.menubtn[data-menu]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (isOpen() && M.id === b.dataset.menu) return close({ restore: true });
    open(b.dataset.menu, { el: b });
  }, true);
  // Long press (touch or pen) on a row, card, tree node or the terminal's name.
  let press = null, swallow = 0;
  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const id = agentAt(e.target);
    if (!id || e.target.closest('.menubtn')) return;
    clearTimeout(press?.timer);
    press = { id, x: e.clientX, y: e.clientY, timer: setTimeout(() => { swallow = Date.now(); open(id, { x: press.x, y: press.y }); press = null; }, LONG_PRESS_MS) };
  }, true);
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  document.addEventListener('pointermove', e => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress(); }, true);
  document.addEventListener('pointerup', cancelPress, true);
  document.addEventListener('pointercancel', cancelPress, true);
  // The tap that ends a long press is not also a click on the row underneath.
  document.addEventListener('click', e => { if (Date.now() - swallow < 800 && !el.contains(e.target)) { swallow = 0; e.preventDefault(); e.stopPropagation(); } }, true);

  // Outside click, Esc (from anywhere), scroll, resize: close.
  document.addEventListener('pointerdown', e => { if (isOpen() && !el.contains(e.target) && !e.target.closest?.('.menubtn')) close(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) { e.preventDefault(); e.stopPropagation(); close({ restore: true }); } }, true);
  addEventListener('scroll', e => { if (isOpen() && !el.contains(e.target)) close(); }, true);
  addEventListener('wheel', e => { if (isOpen() && !el.contains(e.target)) close(); }, { capture: true, passive: true });
  addEventListener('resize', () => close());
  addEventListener('blur', () => close());

  return {
    open,
    close,
    isOpen,
    agentAt,
    /** Called on every app render: keeps the header and actions current while it is open. */
    update() { if (isOpen()) { render(); mark(true); } },
    get id() { return isOpen() ? M.id : null; },
  };
}
