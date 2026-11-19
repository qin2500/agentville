// Plain terminals: "+ Terminal" (your login shell) and "+ Claude" (an interactive claude) open a pane
// in the terminal view with no agent behind it. The page only says which kind and, optionally, one
// of the folders the server already offers; the server builds the command (server/plain-term.mjs).
// A plain terminal is not an agent: it is not in the list or the village. When a claude or codex
// session starts inside one, the server links that agent to the pane (`S.data.term.plain[].agentId`):
// the agent's row then opens this pane, and the pane takes the agent's name while it runs.
const PREFIX = 'shell:';

export function createPlainTerm(app) {
  const { S } = app;
  const known = new Map(); // id -> { id, name }: made here, before the server's list has it
  const list = () => S.data?.term?.plain || [];
  const isPlain = id => typeof id === 'string' && id.startsWith(PREFIX);
  const entry = id => list().find(p => p.id === id) || null;
  const linkedAgent = id => { const a = entry(id)?.agentId; return (a && S.byId.get(a)) || null; };
  const stub = id => (isPlain(id) ? { id, name: entry(id)?.title || known.get(id)?.name || 'Terminal' } : null);

  async function open(kind, cwd) {
    try {
      const res = await fetch('/api/term-plain', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...(cwd ? { cwd } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Server returned ${res.status}`);
      known.set(body.id, { id: body.id, name: body.name });
      app.openTerminal(body.id);
    } catch (e) {
      app.toast(`Couldn't open it: ${e instanceof TypeError ? "the Agentville server isn't reachable." : e.message}`);
    }
  }
  /** The ended shell goes (DELETE): closing a plain pane ends it, as it would a window. */
  const end = id => { fetch(`/api/term/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {}); known.delete(id); };

  return {
    isPlain,
    stub,
    open,
    /** The plain pane an agent runs in, or null. */
    paneOf: agentId => list().find(p => p.agentId === agentId)?.id || null,
    /** The agent running in a plain pane, or null. */
    agentOf: linkedAgent,
    /** The × on a pane. */
    paneClosed(id) { if (isPlain(id)) end(id); },
    /** Leaving the view: shells nobody can find again (no agent in them) end; one with an agent stays, in the list. */
    viewClosed(ids) { for (const id of ids) if (isPlain(id) && !entry(id)?.agentId) end(id); },
    /** Toolbar buttons: shown with "+ New agent", when the built-in terminal exists. */
    update() {
      const show = S.view === 'team' && !!S.data?.term?.available;
      for (const id of ['btn-term', 'btn-claude']) { const b = document.getElementById(id); if (b) b.hidden = !show; }
    },
  };
}
