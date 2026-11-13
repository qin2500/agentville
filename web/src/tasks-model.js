// Display rows for the Team view "Tasks" list. Pure: no DOM, unit-tested (test/tasks-model.test.mjs).
// A task is one top-level agent the user started (its helpers belong to it) or a free-text idea.

const TURN = /^Turn finished/;
const needsInput = a => a.bucket === 'stalled' && a.severity !== 'error' && !a.prompt && (!!a.ask || /^Needs your/.test(a.reason || '') || /send "continue"/.test(a.reason || ''));
const finished = a => (a.bucket === 'stalled' && TURN.test(a.reason || '')) || (a.bucket === 'resting' && a.reason === 'Done');
const ORDER = ['needs', 'merged', 'finished', 'error', 'pr', 'working', 'idea', 'muted'];
const rank = t => ORDER.indexOf(t);
const OPEN_PR = p => ['open', 'draft'].includes(p.state);

function family(root, byId) {
  const seen = new Set([root.id]);
  const kids = [];
  const queue = [root];
  while (queue.length) {
    const a = queue.shift();
    const ids = new Set(a.childIds || []);
    for (const x of byId.values()) if (x.parentId === a.id) ids.add(x.id);
    for (const id of ids) {
      const c = byId.get(id);
      if (!c || seen.has(id)) continue;
      seen.add(id);
      kids.push(c);
      queue.push(c);
    }
  }
  return kids;
}

function statusFor(agent, kids) {
  const all = [agent, ...kids];
  const helpers = kids.filter(k => k.bucket === 'building').length;
  if (all.some(needsInput)) return { status: 'Waiting on you', tone: 'needs', helpers };
  if (agent.severity === 'error') return { status: 'Error', tone: 'error', helpers };
  if (all.some(a => a.bucket === 'building')) return { status: 'Working' + (helpers > 0 ? ` (${helpers} helper${helpers === 1 ? '' : 's'})` : ''), tone: 'working', helpers };
  const prs = agent.prs || [];
  if (prs.some(p => OPEN_PR(p) && p.checks?.failed > 0)) return { status: 'Checks failing', tone: 'error', helpers };
  if (prs.length && prs.every(p => ['merged', 'closed'].includes(p.state)) && prs.some(p => p.state === 'merged')) return { status: 'PR merged · check it off?', tone: 'merged', helpers };
  const open = prs.filter(OPEN_PR);
  if (open.length) return { status: 'PR open' + (open.some(p => p.review === 'approved') ? ' · approved' : ''), tone: 'pr', helpers };
  return { status: 'Finished · follow up', tone: 'finished', helpers };
}

export function taskRows(tasks, agents, loops, now = Date.now()) {
  const byId = new Map((agents || []).map(a => [a.id, a]));
  const rows = (tasks || []).map(t => {
    const linked = t.kind === 'agent' || (t.kind === 'idea' && t.agentId);
    const agent = linked ? byId.get(t.agentId) : null;
    const title = t.rename || (t.kind === 'idea' ? t.text : (agent?.title || t.title || agent?.name || t.name)) || 'Untitled';
    const base = { id: t.id, kind: t.kind, agentId: t.agentId || null, title, helpers: 0, unseen: false, since: t.addedAt, gone: false, doneAt: t.doneAt };
    if (!linked) return { ...base, status: 'Idea', tone: 'idea' };
    if (!agent) return { ...base, status: 'Agent gone', tone: 'muted', gone: true };
    const s = statusFor(agent, family(agent, byId));
    const since = agent.since || t.addedAt;
    const unseen = (agent.since || 0) > (loops?.[agent.id]?.seenAt || 0) && ['needs', 'finished', 'merged', 'error'].includes(s.tone);
    return { ...base, ...s, unseen, since };
  });
  const strip = ({ doneAt, ...r }) => r;
  const open = rows.filter(r => !r.doneAt).sort((a, b) => rank(a.tone) - rank(b.tone) || (b.since || 0) - (a.since || 0)).map(strip);
  const done = rows.filter(r => r.doneAt).sort((a, b) => b.doneAt - a.doneAt).map(strip);
  return { open, done };
}

export function taskCounts(rows) {
  const r = rows || [];
  return {
    total: r.length,
    needs: r.filter(x => x.tone === 'needs').length,
    followUp: r.filter(x => ['merged', 'finished', 'error'].includes(x.tone)).length,
  };
}
