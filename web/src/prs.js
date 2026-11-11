// PR and changed-files wording shared by the rows and the agent menu (ctxmenu.js).
const PR_STATE = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const REVIEW = { approved: 'Approved', changes: 'Changes requested', required: 'Review required' };
const num = n => (n || 0).toLocaleString();
/** "+412 −37 · 6 files" */
export const changesLabel = c => `+${num(c.added)} −${num(c.removed)} · ${c.files} file${c.files === 1 ? '' : 's'}`;
/** A PR's checks in words: "1 failed, 2 pending, 7 passed". */
export function checksText(c) {
  if (!c) return '';
  const parts = [c.failed && `${c.failed} failed`, c.pending && `${c.pending} pending`, c.passed && `${c.passed} passed`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no checks';
}
/** Chip class + words for a PR: failing checks are amber (needs attention), never red. */
export function prTone(p) {
  if (!p.state) return { cls: '', words: '' };
  const failing = p.checks?.failed > 0 && ['open', 'draft'].includes(p.state);
  const words = [PR_STATE[p.state], failing ? `${p.checks.failed} check${p.checks.failed === 1 ? '' : 's'} failing` : p.checks?.pending && ['open', 'draft'].includes(p.state) ? 'checks running' : '', REVIEW[p.review] || ''].filter(Boolean).join(', ');
  return { cls: ` pr-${p.state}${failing ? ' pr-failing' : ''}`, words };
}
