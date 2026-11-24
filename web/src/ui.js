// Shared constants, formatting and the 12×12 pixel-map icons (same art as the village).

export const BUCKETS = ['stalled', 'waiting', 'building', 'resting'];
export const BUCKET_RANK = { stalled: 0, waiting: 1, building: 2, resting: 3 };
// Stalled splits by severity: 'error' (crashed, failed: red ×) vs 'attention' (needs you: amber !).
export const isError = a => a.bucket === 'stalled' && a.severity === 'error';
// …and 'attention' with a `prompt`: a dialog in the session waiting for a click (purple cursor).
export const isPrompt = a => a.bucket === 'stalled' && !!a.prompt && !isError(a);
export const PROMPT_NAME = { permission: 'Permission prompt', question: 'Pick an option', plan: 'Approve the plan', dialog: 'A dialog is open' };
export const bucketIcon = a => (isError(a) ? 'error' : isPrompt(a) ? 'prompt' : a.bucket);
// A notice an agent pushed for the user (`a.notice`, see server/notify): a display state ABOVE the bucket
// (it trumps stalled/error/prompt in the panel and on the villager) that never changes `a.bucket`.
export const hasNotice = a => !!a?.notice;
export const noticeLine = n => String(n?.title || n?.message || '').split('\n').find(l => l.trim())?.trim() || 'Notification';
/** What the row/villager shows: 'notice' above everything, else the real bucket (a.bucket itself is never changed). */
export const displayState = a => (hasNotice(a) ? 'notice' : a?.bucket ?? a?.state);
/** Sort rank where a notice sits above stalled (-1); everything else is BUCKET_RANK. */
export const displayRank = a => (hasNotice(a) ? -1 : BUCKET_RANK[a?.bucket] ?? 4);
/** Comparator: notice agents first, then the bucket order (stable for equal ranks). */
export const byDisplayRank = (x, y) => displayRank(x) - displayRank(y);
/** POST /api/notify/clear for one agent; fetchImpl is injectable. Resolves true on 200, never throws. */
export async function clearNotice(id, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('/api/notify/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    return !!res?.ok;
  } catch { return false; }
}
export const BUCKET_NAME = { stalled: 'Stalled', waiting: 'Waiting', building: 'Building', resting: 'Resting' };
export const ROLE_NAME = { boss: 'Boss', lead: 'Lead', sub: 'Subagent', solo: 'Solo' };
export const HARNESS_NAME = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI' };
export const PROVIDER_NAME = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' };
// Claude Code's `/color` names (the server's `a.color`), a step lighter than the CLI's so they read on
// the dark panels. No color (unset, Codex, subagents) is nothing: '' removes `--agent-color`, so no bar
// and the plain default highlight. Used as `--agent-color` on a row.
export const AGENT_COLOR = { red: '#ef5350', orange: '#f5873a', yellow: '#e8b931', green: '#3fbf6f', cyan: '#22b8cf', blue: '#4c8df6', purple: '#a873f0', pink: '#ec5f9e' };
export const agentColor = a => AGENT_COLOR[a?.color] || '';

const MAPS = {
  stalled: ['....xxxx....', '....xxxx....', '....xxxx....', '....xxxx....', '....xxxx....', '....xxxx....', '....xxxx....', '............', '............', '....xxxx....', '....xxxx....', '............'],
  waiting: ['.xxxxxxxxxx.', '..x......x..', '..xx....xx..', '...xx..xx...', '....xxxx....', '.....xx.....', '.....xx.....', '....x..x....', '...x....x...', '..x..xx..x..', '..xxxxxxxx..', '.xxxxxxxxxx.'],
  building: ['.xxxxxxx....', '.xxxxxxxx...', '.xxxxxxx....', '....xx......', '....xx......', '....xx......', '....xx......', '....xx......', '....xx......', '....xx......', '....xx......', '............'],
  resting: ['.....xxx....', '...xxx......', '..xxx.......', '..xx........', '.xx.........', '.xx.........', '.xx.........', '.xx.........', '..xx......x.', '..xxx...xx..', '...xxxxxx...', '.....xx.....'],
  boss: ['............', 'x....xx....x', 'xx..xxxx..xx', 'xxx.xxxx.xxx', 'xxxxxxxxxxxx', 'xxxxxxxxxxxx', 'xxxxxxxxxxxx', 'xxxxxxxxxxxx', '............', 'xxxxxxxxxxxx', 'xxxxxxxxxxxx', '............'],
  lead: ['xx..........', 'xxxxxxxxx...', 'xxxxxxxxxxx.', 'xxxxxxxxxxx.', 'xxxxxxxxx...', 'xx..........', 'xx..........', 'xx..........', 'xx..........', 'xx..........', 'xx..........', 'xxxx........'],
  sub: ['............', '............', '............', '...xxxxxx...', '...xxxxxx...', '...xxxxxx...', '...xxxxxx...', '...xxxxxx...', '...xxxxxx...', '............', '............', '............'],
  solo: ['............', '............', '..xxxxxxxx..', '..x......x..', '..x......x..', '..x......x..', '..x......x..', '..x......x..', '..x......x..', '..xxxxxxxx..', '............', '............'],
  error: ['............', '.xx......xx.', '.xxx....xxx.', '..xxx..xxx..', '...xxxxxx...', '....xxxx....', '....xxxx....', '...xxxxxx...', '..xxx..xxx..', '.xxx....xxx.', '.xx......xx.', '............'],
  prompt: ['x...........', 'xx..........', 'xxx.........', 'xxxx........', 'xxxxx.......', 'xxxxxx......', 'xxxxxxx.....', 'xxxxxxxx....', 'xxxx........', 'xx.xx.......', 'x...xx......', '....xx......'],
  note: ['............', '............', '.xxxxxxxxxx.', '.xx......xx.', '.x.x....x.x.', '.x..x..x..x.', '.x...xx...x.', '.x........x.', '.x........x.', '.xxxxxxxxxx.', '............', '............'],
  check: ['............', '............', '..........xx', '.........xx.', '........xx..', '.......xx...', 'xx....xx....', '.xx..xx.....', '..xxxx......', '...xx.......', '............', '............'],
};
const PATHS = Object.fromEntries(Object.entries(MAPS).map(([k, rows]) => {
  let d = '';
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === 'x') d += `M${x} ${y}h1v1h-1z`; }));
  return [k, d];
}));
export const icon = (k, cls = 'px') =>
  `<svg class="${cls}" viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="${PATHS[k]}"/></svg>`;

const MIN = 60e3;
export function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / MIN);
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
export function agoLong(ms) {
  const m = Math.floor(Math.max(0, ms) / MIN);
  const n = m < 1 ? 0 : m < 60 ? m : m < 1440 ? Math.floor(m / 60) : Math.floor(m / 1440);
  if (m < 1) return 'under a minute';
  const unit = m < 60 ? 'minute' : m < 1440 ? 'hour' : 'day';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
export const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

// Only http(s) links from the server are rendered as hrefs.
export const safeHref = h => (/^https?:\/\//i.test(h || '') ? h : null);

// One element builder for the few places that need real nodes.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}

export const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');

// localStorage that never throws (private mode, blocked storage): values are JSON.
// onStoreSet(fn): fn(key, value) after each persisted set (plan-sync.js mirrors the layout keys); returns an unsubscribe.
const storeHooks = new Set();
export function onStoreSet(fn) { storeHooks.add(fn); return () => storeHooks.delete(fn); }
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { return; /* not persisted */ }
    for (const fn of storeHooks) { try { fn(k, v); } catch { /* a hook never breaks a save */ } }
  },
};
