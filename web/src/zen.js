// "Village only": one class on <body> hides every piece of UI so just the village fills the window
// (see the "village only" block in styles.css). Layout underneath is untouched (hidden, not removed), so
// Esc restores the panel width/state and an open terminal exactly. Never persisted.
const CLS = 'village-only';

export function createZen() {
  const body = document.body;
  const zoom = document.querySelector('.zoom');
  let timer = 0;

  const btn = document.createElement('button');
  btn.className = 'iconbtn zenbtn';
  btn.id = 'btn-zen';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Show only the village');
  btn.title = 'Show only the village';
  btn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  zoom.append(btn);

  const pill = document.createElement('div');
  pill.className = 'zenpill';
  pill.setAttribute('role', 'status');
  pill.hidden = true;
  pill.textContent = 'Press Esc to bring everything back';
  body.append(pill);

  const on = () => body.classList.contains(CLS);

  function enter() {
    if (on()) return;
    body.classList.add(CLS);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
    pill.hidden = false;
    pill.classList.remove('out');
    void pill.offsetWidth; // so the fade-in runs
    pill.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => { pill.classList.add('out'); timer = setTimeout(() => { pill.hidden = true; }, 600); }, 3000);
  }
  function exit() {
    clearTimeout(timer);
    body.classList.remove(CLS);
    pill.hidden = true;
    pill.classList.remove('show', 'out');
    btn.focus({ preventScroll: true });
  }

  btn.addEventListener('click', enter);
  // Window-capture: runs before every other Esc handler (panel, ctxmenu, terminal) and swallows the key,
  // so nothing underneath also reacts to this press.
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !on()) return;
    e.preventDefault(); e.stopImmediatePropagation();
    exit();
  }, true);
}
