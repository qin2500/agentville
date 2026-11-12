// Village peek. When the village is hidden (the expanded panel, or the terminal view), a toggle at the
// top right shows the same village (the one #village element, moved by CSS, never a copy) in a
// resizable column on the right; on a narrow screen, a sheet over the bottom of the screen. Its
// width, and whether it's open in each of the two layouts, are remembered.
const $ = id => document.getElementById(id);
const MIN_W = 260, DEF_W = 380, MIN_CENTRE = 420;

export function createPeek(app, { store, village }) {
  const { S } = app;
  const main = $('main'), host = $('village');
  const narrow = matchMedia('(max-width: 900px)');
  let open = store.get('va.peek', {});
  if (!open || typeof open !== 'object') open = {};
  let width = Number(store.get('va.peekW', DEF_W)) || DEF_W;

  const btn = document.createElement('button');
  btn.className = 'iconbtn peekbtn';
  btn.id = 'btn-peek';
  btn.type = 'button';
  btn.hidden = true;
  btn.setAttribute('aria-controls', 'village');
  btn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 7.5 8 2.5l6 5M3.5 6.5V13.5h3.5v-4h2v4h3.5V6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  $('btn-settings').before(btn);

  const head = document.createElement('div');
  head.className = 'peekhead';
  head.innerHTML = `<span class="peektitle">Village</span><button class="iconbtn peekclose" type="button" aria-label="Close village peek (Esc)" title="Close (Esc)">×</button>`;
  const grip = document.createElement('div');
  grip.className = 'peekgrip';
  grip.tabIndex = 0;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-controls', 'village');
  grip.setAttribute('aria-label', 'Resize village peek');
  grip.title = 'Drag to resize';
  host.append(head, grip);

  /** Which hidden-village layout we're in: 'term', 'full', or null when the village is on screen anyway. */
  const layout = () => (S.term ? 'term' : S.panel === 'full' ? 'full' : null);
  const maxW = () => Math.max(MIN_W, Math.min(Math.round(main.clientWidth * 0.6), main.clientWidth - MIN_CENTRE));
  const clampW = w => Math.round(Math.max(MIN_W, Math.min(maxW(), w)));

  function applyWidth() {
    const w = clampW(width);
    main.style.setProperty('--peek-w', `${w}px`);
    grip.setAttribute('aria-valuemin', MIN_W);
    grip.setAttribute('aria-valuemax', maxW());
    grip.setAttribute('aria-valuenow', w);
    grip.setAttribute('aria-valuetext', `${w} pixels wide`);
  }

  /** Called from the app's render(), after it has set the main area's classes. */
  function render() {
    const l = layout(), was = !!S.peek;
    S.peek = !!l && !!open[l];
    main.classList.toggle('peek', S.peek);
    btn.hidden = !l;
    btn.setAttribute('aria-pressed', String(S.peek));
    const label = S.peek ? 'Hide the village' : 'Peek at the village';
    btn.setAttribute('aria-label', label);
    btn.title = `${label} (Village)`;
    if (S.peek) applyWidth();
    if (S.peek !== was) {
      // Once the new columns have laid out: draw (or stop drawing) and fit the camera to the new size.
      requestAnimationFrame(() => { village.setActive(); if (S.peek) village.refit(); });
    }
  }

  function set(on, { focus } = {}) {
    const l = layout();
    if (!l) return;
    open = { ...open, [l]: on };
    store.set('va.peek', open);
    app.render();
    village.setActive();
    if (focus === 'button') btn.focus({ preventScroll: true });
    else if (focus === 'village' && S.peek) host.querySelector('canvas')?.focus({ preventScroll: true });
  }

  btn.addEventListener('click', () => set(!S.peek));
  head.querySelector('.peekclose').addEventListener('click', () => set(false, { focus: 'button' }));

  // ---------- resize: drag the left edge, or arrow keys on it ----------
  let drag = false;
  function resizeTo(w, persist) {
    width = clampW(w);
    applyWidth();
    if (persist) { store.set('va.peekW', width); village.refit(); }
  }
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0 || narrow.matches) return;
    e.preventDefault();
    e.stopPropagation(); // not a pan of the village
    grip.setPointerCapture(e.pointerId);
    drag = true;
    document.body.classList.add('resizing');
  });
  grip.addEventListener('pointermove', e => {
    if (!drag) return;
    resizeTo(main.getBoundingClientRect().right - e.clientX, false);
  });
  const endDrag = () => {
    if (!drag) return;
    drag = false;
    document.body.classList.remove('resizing');
    resizeTo(width, true);
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('keydown', e => {
    const step = e.shiftKey ? 80 : 16, cur = clampW(width);
    if (e.key === 'ArrowLeft') resizeTo(cur + step, true);
    else if (e.key === 'ArrowRight') resizeTo(cur - step, true);
    else if (e.key === 'Home') resizeTo(MIN_W, true);
    else if (e.key === 'End') resizeTo(maxW(), true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  addEventListener('resize', () => { if (S.peek) applyWidth(); });

  return {
    render,
    /** Close the peek in one layout ('term' or 'full') without touching the others. */
    close(l) {
      if (!open[l]) return;
      open = { ...open, [l]: false };
      store.set('va.peek', open);
      app.render();
      village.setActive();
    },
    /** Esc with the keyboard inside the peek closes it (and hands focus to the toggle). */
    escape(e) {
      if (!S.peek || !e.target.closest?.('#village')) return false;
      e.preventDefault();
      set(false, { focus: 'button' });
      return true;
    },
  };
}
