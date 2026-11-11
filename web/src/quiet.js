// Which projects the village shows (docs/ARCHITECTURE.md, "The village"). Pure, so node tests can import it.
//
// A project is "quiet" when every agent in it is resting and none has done anything for QUIET_MS.
// It is all or nothing per project: one agent that is building, stalled or waiting, that was active
// inside the window, or that is marked Important, keeps the whole neighbourhood. The village never
// goes empty: if every project is quiet, it shows the QUIET_FALLBACK most recently active ones. The
// agent list is not affected.
import { folds } from './important.js';

export const QUIET_MS = 24 * 60 * 60 * 1000;
export const QUIET_FALLBACK = 3;

/**
 * @param {Array<{project?: string, bucket: string, lastActivityAt?: number}>} agents
 * @param {{ hideQuiet?: boolean, now?: number, keep?: Iterable<string> }} opts  keep: projects that
 *   must stay visible regardless (the selected agent's).
 * @returns {{ shown: Set<string>, quiet: string[] }} quiet: the hidden projects, most recent first
 */
export function visibleProjects(agents, { hideQuiet = true, now = Date.now(), keep = [] } = {}) {
  const last = new Map(), awake = new Set();
  for (const a of agents) {
    const p = a.project || '—';
    last.set(p, Math.max(last.get(p) ?? 0, a.lastActivityAt || 0));
    if (!folds(a)) awake.add(p); // an Important agent keeps its neighbourhood
  }
  const names = [...last.keys()];
  if (!hideQuiet) return { shown: new Set(names), quiet: [] };
  const shown = new Set(names.filter(p => awake.has(p) || now - last.get(p) < QUIET_MS));
  for (const p of keep) if (last.has(p)) shown.add(p);
  const byRecent = names.filter(p => !shown.has(p)).sort((a, b) => last.get(b) - last.get(a) || a.localeCompare(b));
  if (!shown.size) for (const p of byRecent.splice(0, QUIET_FALLBACK)) shown.add(p);
  return { shown, quiet: byRecent };
}
