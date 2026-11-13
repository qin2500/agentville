// Labels & status bubbles toggle: a button in the village's zoom group that shows/hides the badges and all text on the village canvas (hover/selection still show theirs).
// Default on; remembered in localStorage `va.bubbles` ('0' = off).
const KEY = 'va.bubbles';

export function createBubbles(village) {
  let on = true;
  try { on = localStorage.getItem(KEY) !== '0'; } catch { /* storage blocked: stay on */ }

  const btn = document.createElement('button');
  btn.className = 'iconbtn bubblesbtn';
  btn.id = 'btn-bubbles';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Labels & status bubbles');
  btn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 3h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H9l-3 2.5V11H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path class="off" d="M2 14L14 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  document.querySelector('.zoom').append(btn);

  function apply(save) {
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Labels & status bubbles: on (B)' : 'Labels & status bubbles: off (B)';
    btn.classList.toggle('is-off', !on);
    village.setBubbles(on);
    if (save) { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ } }
  }
  function toggle() { on = !on; apply(true); }

  btn.addEventListener('click', toggle);
  apply(false);
  return { toggle };
}
