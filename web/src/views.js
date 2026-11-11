// The agent panel's views, in the order V cycles through them. Pure: no DOM, no storage.
export const VIEWS = ['team', 'tree', 'models'];
const DEFAULT = { docked: 'team', full: 'team' };

// The saved 'va.view' value -> { docked, full }. It once also held the village's 'iso'/'flat' string,
// and views that no longer exist (the old Status and Table views) fall back to Team.
export function viewsFrom(saved) {
  const out = { ...DEFAULT };
  if (!saved || typeof saved !== 'object') return out;
  for (const k of ['docked', 'full']) if (k in saved) out[k] = VIEWS.includes(saved[k]) ? saved[k] : 'team';
  return out;
}

export const nextView = v => VIEWS[(VIEWS.indexOf(v) + 1) % VIEWS.length];
