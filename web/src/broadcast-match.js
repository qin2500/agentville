// "Message agents": which agents a filter picks, and whether each can receive a message.
// Pure (no DOM), so test/broadcast.test.mjs runs it under node. Filters combine with AND across
// kinds and OR within one; an empty kind (or no filter at all, "Everyone") doesn't narrow.

/** Mirrors server/broadcast.mjs MAX_RECIPIENTS; the server enforces it. */
export const MAX_RECIPIENTS = 50;
export const TEXT_MAX = 8000;
export const RANKS = ['boss', 'lead', 'sub', 'solo'];
// The status categories the counters and pills use: Stalled splits into errors, dialogs waiting for
// a click, and the rest that need you.
export const STATUSES = ['error', 'prompt', 'stalled', 'waiting', 'building', 'resting'];
export const STATUS_NAME = { error: 'Error', prompt: 'Needs a click', stalled: 'Needs you', waiting: 'Waiting', building: 'Building', resting: 'Resting' };
export const SELF_WHY = 'This is the session Agentville is running in.';

export function statusOf(a) {
  if (a.bucket !== 'stalled') return a.bucket;
  return a.severity === 'error' ? 'error' : a.prompt ? 'prompt' : 'stalled';
}

const any = (list, v) => !list || !list.length || list.includes(v);

/** f = { name, ranks: [], statuses: [], projects: [] }. */
export function matches(a, f = {}) {
  const name = String(f.name || '').trim().toLowerCase();
  return (!name || String(a.name || '').toLowerCase().includes(name))
    && any(f.ranks, a.role)
    && any(f.statuses, statusOf(a))
    && any(f.projects, a.project || 'unknown');
}

/** '' when it can be messaged; otherwise the reason (the server's, so it matches the agent menu). */
export const whyNot = a => (a.self ? SELF_WHY : a.messageWhy || '');

export const isFiltered = f => !!(String(f.name || '').trim() || f.ranks?.length || f.statuses?.length || f.projects?.length);

/**
 * The agents a filter picks, split into who can receive it and who can't (with why). Hidden agents
 * are left out unless `showHidden`. Order: rank (Boss first), then name.
 */
export function pick(agents, f = {}, { showHidden = false } = {}) {
  const order = (x, y) => RANKS.indexOf(x.role) - RANKS.indexOf(y.role) || String(x.name).localeCompare(String(y.name)) || (x.id < y.id ? -1 : 1);
  const hit = agents.filter(a => (showHidden || !a.hidden) && matches(a, f)).sort(order);
  return {
    eligible: hit.filter(a => !whyNot(a)),
    ineligible: hit.filter(a => whyNot(a)).map(a => ({ agent: a, why: whyNot(a) })),
  };
}
