// Which agents go in the "For you" strip. Pure: no DOM, no fetch. An item stays until the user marks
// it Done (doneAt); looking at it (seenAt) only clears its unseen dot. `since` is a number (ms epoch).
// The three state definitions are copied from notify.js so both agree.

const TURN = /^Turn finished/;
const FINISHED_MAX_AGE = 3 * 24 * 3600e3;
const needsInput = a => a.bucket === 'stalled' && a.severity !== 'error' && !a.prompt && (!!a.ask || /^Needs your/.test(a.reason || '') || /send "continue"/.test(a.reason || ''));
const finished = a => (a.bucket === 'stalled' && TURN.test(a.reason || '')) || (a.bucket === 'resting' && a.reason === 'Done');
const failingPrs = a => (a.prs || []).filter(p => p.checks?.failed > 0 && ['open', 'draft'].includes(p.state));

const toMs = v => (typeof v === 'number' ? v : Date.parse(v)) || 0;

function kindOf(a) {
  if (needsInput(a)) return 'needs';
  if (a.severity === 'error') return 'error';
  if (failingPrs(a).length) return 'checks';
  if (finished(a)) return 'finished';
  return null;
}

const LABELS = { needs: 'Needs you', error: 'Error', checks: 'Checks failing', finished: 'Finished' };

function rank(kind, unseen, due) {
  let r = kind === 'needs' ? 0 : kind === 'finished' ? (unseen ? 1 : 5) : kind === 'error' ? 2 : 3;
  if (due) r = Math.min(r, 4);
  return r;
}

export function loopItems(agents, loops, now = Date.now()) {
  const out = [];
  for (const a of agents || []) {
    if (!a || a.hidden) continue;
    const kind = kindOf(a);
    if (!kind) continue;
    const since = toMs(a.since);
    const l = loops?.[a.id] || {};
    if (!(since > (l.doneAt || 0))) continue;
    if (kind === 'finished' && a.prs?.length && a.prs.every(p => ['merged', 'closed'].includes(p.state))) continue;
    // Sub-agents report to their lead, not to you; and an old finish is history, not an open loop.
    if (kind === 'finished' && (a.role === 'sub' || now - since > FINISHED_MAX_AGE)) continue;
    if (l.snoozeUntil > now) continue;
    const unseen = since > (l.seenAt || 0);
    const due = !!l.snoozeUntil;
    const label = kind === 'finished' && a.bucket === 'resting' ? 'Done' : LABELS[kind];
    const item = { id: a.id, agent: a, kind, unseen, label };
    if (due) item.due = true;
    out.push({ item, r: rank(kind, unseen, due), since });
  }
  out.sort((x, y) => x.r - y.r || y.since - x.since);
  return out.map(x => x.item);
}

export function unseenIds(items) {
  return new Set((items || []).filter(i => i.unseen).map(i => i.id));
}

export function snoozeOptions(now = Date.now()) {
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  t.setHours(9, 0, 0, 0);
  return [
    { label: 'Snooze 2 hours', until: now + 2 * 3600e3 },
    { label: 'Snooze until tomorrow', until: t.getTime() },
  ];
}
