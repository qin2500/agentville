// Which desktop notifications a new snapshot calls for, compared with the last one. Pure: no DOM,
// so it is unit-tested on snapshot fixtures (test/notify.test.mjs). Each notification carries a
// per-agent `tag` (the OS replaces, never stacks, notifications with one tag) and a `key` naming
// the exact transition, so the same event never fires twice even if an agent flaps.
//
// Kinds (each its own Settings toggle, all off by default):
//   input    — it now needs your input (a question or approval; "needs a click" has its own toggle)
//   finished — it was building and its turn ended (awaiting your reply), or its job finished
//   checks   — a PR it holds has failing CI checks that were passing (or pending) before

const TURN = /^Turn finished/;
const needsInput = a => a.bucket === 'stalled' && a.severity !== 'error' && !a.prompt && (!!a.ask || /^Needs your/.test(a.reason || '') || /send "continue"/.test(a.reason || ''));
const finished = a => (a.bucket === 'stalled' && TURN.test(a.reason || '')) || (a.bucket === 'resting' && a.reason === 'Done');
const failingPrs = a => (a.prs || []).filter(p => p.checks?.failed > 0 && ['open', 'draft'].includes(p.state));

/**
 * `prev`/`next`: agent lists from two polls. `on`: { input, finished, checks } booleans.
 * Agents absent from `prev` never notify (nothing fires for what was already true at page load).
 */
export function transitions(prev, next, on = {}) {
  const before = new Map((prev || []).map(a => [a.id, a]));
  const out = [];
  for (const a of next || []) {
    const p = before.get(a.id);
    if (!p || a.hidden) continue;
    const where = a.project ? ` · ${a.project}` : '';
    if (on.input && needsInput(a) && !needsInput(p)) {
      out.push({ kind: 'input', id: a.id, key: `input:${a.id}:${a.since}`, tag: `va-input:${a.id}`, title: `${a.name} needs your input`, body: `${a.ask?.needs || a.reason || 'Needs your input'}${where}` });
    }
    if (on.finished && finished(a) && p.bucket === 'building') {
      const done = a.bucket === 'resting';
      out.push({ kind: 'finished', id: a.id, key: `finished:${a.id}:${a.since}`, tag: `va-finished:${a.id}`, title: done ? `${a.name} is done` : `${a.name} finished its turn`, body: `${done ? 'Job finished' : 'Awaiting your reply'}${where}` });
    }
    if (on.checks) {
      const was = new Map((p.prs || []).map(x => [x.href, x]));
      for (const pr of failingPrs(a)) {
        const o = was.get(pr.href);
        if (!o?.checks || o.checks.failed > 0) continue; // unknown before, or already failing
        out.push({ kind: 'checks', id: a.id, key: `checks:${pr.href}:${pr.checks.failed}`, tag: `va-checks:${pr.href}`, title: `PR #${pr.id} checks failing`, body: `${pr.checks.failed} failed · ${a.name}${where}` });
      }
    }
  }
  return out;
}
