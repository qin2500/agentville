// Dev-only fake API, loaded only with ?mock in the URL. Shaped exactly like GET /api/agents.
// ?mock            ~25 agents in two teams
// ?mock=big        ~170 agents (a heavy user's scale)
// ?mock=empty      no agents
// ?mock=down       server unreachable
// ?mock=slow       first response after 3s (loading state)
// ?mock=rebooted   a reboot prep is pending and the server restarted since (fleet strip)

const mode = new URLSearchParams(location.search).get('mock') || 'small';
const NOW = Date.now(), M = 60e3;
const agents = [];
const overrides = new Map();
let n = 0;

function add(name, role, parent, project, bucket, reason, mins, extra = {}) {
  const id = `claude-code:${(++n).toString(16).padStart(8, '0')}-mock`;
  const a = {
    id, harness: 'claude-code', name, title: `Work on ${name.toLowerCase()} in ${project}`, project,
    cwd: `/home/dev/code/${project}`, role, roleSource: 'detected', parentId: parent?.id ?? null, childIds: [],
    bucket, reason, reasonSource: reason ? 'tool' : '', since: NOW - mins * M, lastActivityAt: NOW - mins * M / 2,
    live: bucket !== 'resting', prs: [], resume: `claude --resume ${id.slice(12)}`, ...extra,
  };
  parent?.childIds.push(id);
  agents.push(a);
  return a;
}

if (mode !== 'empty') {
  const boss = add('Big Boss', 'boss', null, 'my-app', 'waiting', 'Waiting on 9 agents', 34, { reasonSource: 'children', prs: [{ id: '6856', href: 'https://github.com/example/repo/pull/6856' }] });
  const auth = add('Auth Lead', 'lead', boss, 'my-app', 'stalled', 'Needs your answer', 41, { roleSource: 'override', prs: [{ id: '6861', href: 'https://github.com/example/repo/pull/6861' }, { id: '6870', href: 'https://github.com/example/repo/pull/6870' }, { id: '6871', href: 'https://github.com/example/repo/pull/6871' }] });
  add('auth-schema-engineer', 'sub', auth, 'my-app', 'building', '', 6);
  add('auth-test-engineer', 'sub', auth, 'my-app', 'resting', 'Done', 300, { live: false });
  const search = add('Search Lead', 'lead', boss, 'my-app', 'waiting', 'Waiting for CI or checks', 12, { prs: [{ id: '6873', href: 'https://github.com/example/repo/pull/6873' }] });
  add('search-backend', 'sub', search, 'my-app', 'building', '', 3);
  add('search-reviewer', 'sub', search, 'my-app', 'waiting', 'Waiting on another agent', 9);
  const wf = add('Reports Lead', 'lead', boss, 'reports-backend', 'building', '', 2);
  add('reports-api', 'sub', wf, 'reports-backend', 'building', '', 2);
  add('reports-migrations', 'sub', wf, 'reports-backend', 'stalled', 'Permission request', 4);
  add('reports-docs', 'sub', wf, 'reports-backend', 'building', '', 11);
  const pay = add('Payments Lead', 'lead', boss, 'payments-service', 'building', '', 18);
  add('payments-ledger', 'sub', pay, 'payments-service', 'waiting', 'Waiting on a background job', 7);
  add('payments-webhooks', 'sub', pay, 'payments-service', 'building', '', 1);
  const tf = add('Terraform Lead', 'lead', boss, 'infra-terraform', 'waiting', 'Waiting on 2 agents', 22, { reasonSource: 'children' });
  add('tf-plan-runner', 'sub', tf, 'infra-terraform', 'waiting', 'Waiting for CI or checks', 22);
  add('tf-reviewer', 'sub', tf, 'infra-terraform', 'building', '', 5);
  add('Agentville scratch', 'solo', null, 'agentville', 'stalled', 'Turn finished — awaiting your reply', 3, { harness: 'codex', resume: 'codex resume 0199-mock' });
  add('Web store fixes', 'solo', null, 'web-store', 'building', '', 9);
  add('Log viewer', 'solo', null, 'log-viewer', 'resting', 'Done', 900, { live: false, resume: null });
  add('Onboarding spike', 'solo', null, 'my-app', 'resting', 'Stopped', 2000, { live: false });
  add('Crashed refactor', 'solo', null, 'web-store', 'stalled', 'Stopped unexpectedly', 95, { live: false });
  // Namesakes: a resting copy (no suffix on the live one) and two live copies (suffixed), plus long names.
  add('Search Lead', 'solo', null, 'my-app', 'resting', 'Done', 3000, { live: false });
  add('Agentville scratch', 'solo', null, 'agentville', 'building', '', 2, { harness: 'codex' });
  const lib = add('Library migration and dependency upgrades Lead', 'lead', boss, 'my-app', 'building', '', 6);
  add('library-migration-compatibility-reviewer', 'sub', lib, 'my-app', 'waiting', 'Waiting for CI or checks', 3);
  const boss2 = add('Infra Boss', 'boss', null, 'infra', 'building', '', 15, { harness: 'codex' });
  const net = add('Network Lead', 'lead', boss2, 'infra', 'building', '', 4, { harness: 'codex' });
  add('dns-sub', 'sub', net, 'infra', 'building', '', 4, { harness: 'codex' });
}

if (mode === 'big') {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'kappa', 'sigma', 'omega', 'zeta'];
  const projects = ['my-app', 'reports-backend', 'payments-service', 'mobile-app', 'docs-site', 'data-pipeline', 'marketing-web', 'ml-experiments', 'ops-scripts', 'design-tokens', 'search-service', 'billing'];
  const bosses = agents.filter(a => a.role === 'boss');
  const pick = (i, arr) => arr[i % arr.length];
  for (let i = 0; i < 14; i++) {
    const lb = pick(i, ['building', 'waiting', 'stalled', 'building']);
    const lead = add(`${pick(i, words)} Lead ${i}`, 'lead', bosses[i % 2], pick(i, projects), lb,
      { stalled: 'Needs your answer', waiting: 'Waiting on 3 agents', building: '' }[lb], 3 + i * 7);
    for (let j = 0; j < 6; j++) {
      const b = pick(i + j, ['building', 'building', 'waiting', 'resting', 'stalled', 'resting', 'building']);
      add(`${pick(j, words)}-${pick(i + j, ['api', 'ui', 'tests', 'review', 'docs'])}-${i}${j}`, 'sub', lead, lead.project, b,
        { stalled: 'Permission request', waiting: 'Waiting for CI or checks', resting: 'Done', building: '' }[b], 1 + j * 13 + i);
    }
  }
  for (let i = 0; i < 60; i++) {
    const b = i < 45 ? 'resting' : pick(i, ['building', 'stalled', 'waiting']);
    add(`Session ${pick(i, words)} ${i}`, 'solo', null, pick(i * 7, projects), b,
      { stalled: 'Turn finished — awaiting your reply', waiting: 'Waiting on a background job', resting: 'Done', building: '' }[b],
      i < 45 ? 1500 + i * 600 : 10 + i, { live: b !== 'resting', harness: i % 3 ? 'claude-code' : 'codex' });
  }
  for (const a of agents) if (a.bucket === 'resting') a.live = false;
}

let tick = 0;
function payload() {
  tick++;
  const now = Date.now();
  // A little churn so in-place updates can be seen: one agent flips bucket every few polls.
  const flip = agents.find(a => a.name === 'reports-docs');
  if (flip && tick % 5 === 0) {
    const toWait = flip.bucket === 'building';
    Object.assign(flip, toWait ? { bucket: 'waiting', reason: 'Waiting for CI or checks', since: now } : { bucket: 'building', reason: '', since: now });
  }
  const out = agents.map(a => {
    const o = overrides.get(a.id) || {};
    const r = { ...a, lastActivityAt: a.bucket === 'building' ? now - 5000 : a.lastActivityAt, hidden: !!o.hidden, overrides: Object.keys(o).length ? { ...o } : null };
    if (o.name != null) r.name = o.name;
    if (o.role != null) { r.role = o.role; r.roleSource = 'override'; }
    if (o.parentId !== undefined && o.parentId !== null) r.parentId = o.parentId;
    return r;
  });
  const byId = new Map(out.map(a => [a.id, a]));
  out.forEach(a => { a.childIds = []; });
  out.forEach(a => { if (a.parentId) byId.get(a.parentId)?.childIds.push(a.id); });
  const counts = { building: 0, stalled: 0, waiting: 0, resting: 0, errors: 0 };
  out.forEach(a => {
    a.severity = a.bucket !== 'stalled' ? null : /unexpectedly|error/i.test(a.reason) ? 'error' : 'attention';
    if (!a.hidden) { counts[a.bucket]++; if (a.severity === 'error') counts.errors++; }
  });
  out.forEach(a => { a.kind = a.role === 'sub' ? 'subagent' : a.role === 'solo' ? 'session' : 'job'; });
  // Per-project history for the world view (server: projects.mjs), from the agents' PRs.
  const projects = [...new Set(out.map(a => a.project))].map(name => {
    const here = out.filter(a => a.project === name), prs = new Map();
    for (const a of here) for (const p of a.prs || []) {
      const e = prs.get(p.id) || { id: p.id, href: p.href, agentIds: [], live: false };
      e.agentIds.push(a.id); e.live ||= a.live && a.bucket !== 'resting'; prs.set(p.id, e);
    }
    if (mode === 'big') for (let i = 0; i < (name.length % 5) * 2; i++) prs.set(`${900 + name.length * 10 + i}`, { id: `${900 + name.length * 10 + i}`, agentIds: [], live: false });
    return { name, prs: [...prs.values()], agentsEver: here.length * 3, transcriptBytes: here.length * 4e6 };
  });
  return { serverTime: now, counts, agents: out, projects, fleet: fleetState, open: { terminal: 'ghostty' }, sources: { claude: true, codex: mode !== 'empty' }, warnings: mode === 'small' ? ['Codex sessions directory not found (~/.codex/sessions)'] : [] };
}

const realFetch = window.fetch.bind(window);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith('/api/')) return realFetch(url, opts);
  if (mode === 'down') throw new TypeError('Failed to fetch');
  if (mode === 'slow' && tick === 0) await new Promise(r => setTimeout(r, 3000));
  const m = u.match(/^\/api\/overrides\/(.+)$/);
  if (m && opts.method === 'PATCH') {
    const id = decodeURIComponent(m[1]);
    if (!agents.some(a => a.id === id)) return json({ error: 'Unknown agent' }, 404);
    const o = { ...overrides.get(id), ...JSON.parse(opts.body) };
    for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
    overrides.set(id, o);
    return json({ ok: true });
  }
  if (u.startsWith('/api/fleet/preview')) {
    const b = opts.method === 'POST' ? JSON.parse(opts.body) : { action: new URL(u, location.href).searchParams.get('action') };
    const p = fleetPreview(b.action, b.text);
    return p ? json(p) : json({ error: 'Unknown action' }, 400);
  }
  const om = u.match(/^\/api\/open\/(.+)$/);
  if (om && opts.method === 'POST') {
    const a = agents.find(x => x.id === decodeURIComponent(om[1]));
    if (!a) return json({ error: 'No such agent' }, 404);
    if (a.role === 'sub') return json({ error: 'Open its lead instead' }, 409);
    await new Promise(r => setTimeout(r, 400));
    return a.name === 'Crashed refactor' ? json({ error: 'macOS denied Automation access to Ghostty. Allow it in System Settings > Privacy & Security > Automation, then try again.' }, 502) : json({ ok: true, terminal: 'ghostty' });
  }
  if (u === '/api/fleet/mark' && opts.method === 'POST') return fleetMark(JSON.parse(opts.body));
  if (u.startsWith('/api/account')) return accountMock(u, opts);
  if (u.startsWith('/api/agents')) return json(payload());
  return json({ error: 'Not found' }, 404);
};

// ---------- fleet actions: copy-only contract (server/fleet.mjs is the real one) ----------
const ADDENDUM = {
  boss: 'You run other agents. Forward this exact message to every lead under you with your cross-session messaging, and ask each lead to pass it on to its own subagents and teammates that are still working.',
  lead: 'You lead other agents. Pass this message on to each of your subagents and teammates that is still working, wait for each to confirm, and include their one-line status in your note.',
};
const TEMPLATES = {
  offline: '[Agentville · prep for internet loss]\nYour user is about to lose internet access for a while. Commit WIP locally, write a resume note to {notePath}, reply "Paused: <what you were doing>", then stop.',
  reboot: '[Agentville · prep for laptop reboot]\nYour user is about to restart the laptop. Stop background processes, commit WIP locally, write a resume note to {notePath}, reply "Paused for reboot: <what you were doing>", then stop.',
  resume: '[Agentville · resume]\nYour user is back{after a reboot}. Read your resume note at {notePath} and continue from the next step.',
};
let fleetState = { mode: 'copy', last: null, pending: null };
if (mode === 'rebooted') fleetState.pending = { kind: 'reboot', at: NOW - 20 * M, ids: agents.filter(a => !a.parentId && a.bucket !== 'resting').map(a => a.id), rebootDetected: true };
function fleetPreview(action, text) {
  if (!TEMPLATES[action]) return null;
  const byId = new Map(agents.map(a => [a.id, a]));
  const live = agents.filter(a => a.bucket !== 'resting' && !overrides.get(a.id)?.hidden);
  const top = live.filter(a => !a.parentId || !live.includes(byId.get(a.parentId)));
  const desc = a => agents.filter(k => k.parentId === a.id && live.includes(k)).flatMap(k => [k.id, ...desc(k)]);
  const template = text || TEMPLATES[action];
  const after = action === 'resume' && fleetState.pending ? ' after a reboot' : '';
  const targets = top.map(a => {
    const relay = a.childIds.length ? (a.role === 'boss' ? ADDENDUM.boss : ADDENDUM.lead) : '';
    const body = template.replace('{name}', a.name).replace('{project}', a.project).replace('{notePath}', `${a.cwd}/.git/agentville-note.md`).replace('{after a reboot}', after);
    return { id: a.id, name: a.name, role: a.role, harness: a.harness, project: a.project, live: a.live, channel: 'copy',
      reach: a.harness === 'codex' ? { how: 'Open the thread in Codex', command: a.resume } : { how: a.live ? 'Switch to its terminal' : 'Resume it in a terminal', command: `cd '${a.cwd}' && ${a.resume}` },
      text: relay ? `${body}\n\n${relay}` : body, relayTo: desc(a) };
  });
  return { mode: 'copy', action, template: TEMPLATES[action], addendum: ADDENDUM, targets,
    relayed: targets.flatMap(t => t.relayTo.map(id => ({ id, name: byId.get(id).name, viaId: byId.get(id).parentId, rootId: t.id }))),
    excluded: { resting: agents.filter(a => a.bucket === 'resting').length, hidden: [...overrides.values()].filter(o => o.hidden).length },
    commands: action === 'offline' ? [] : top.filter(a => a.harness === 'claude-code' && a.resume).map(a => ({ id: a.id, name: a.name, command: `cd '${a.cwd}' && ${a.resume}` })) };
}
function fleetMark({ action, ids }) {
  if (!TEMPLATES[action] || !Array.isArray(ids)) return json({ error: 'Bad request' }, 400);
  const record = { kind: action, at: Date.now(), ids };
  fleetState = { mode: 'copy', last: record, pending: action === 'resume' ? null : { ...record, rebootDetected: false } };
  for (const a of agents) if (ids.includes(a.id) && a.bucket !== 'resting') Object.assign(a, action === 'resume' ? { bucket: 'building', reason: '' } : { bucket: 'waiting', reason: action === 'reboot' ? 'Paused for reboot prep' : 'Paused for internet loss', since: Date.now() });
  return json({ ok: true, record });
}

// ---------- account switch (server/account.mjs is the real one) ----------
// ?account=notready: no personal login yet · ?account=fail: the canary fails and everything rolls back
const acct = { profile: 'pool', stashed: false };
async function accountMock(u, opts) {
  const how = new URLSearchParams(location.search).get('account');
  const all = payload().agents;
  const auth = all.filter(a => a.kind === 'job' && a.bucket !== 'resting').slice(0, 5).map((a, i) => ({ id: `job0000${i}`, name: a.name, live: true, model: 'opus' }));
  const sessions = all.filter(a => a.kind === 'session' && a.harness === 'claude-code' && a.bucket !== 'resting').slice(0, 3).map(a => ({ id: a.id, name: a.name, cwd: a.cwd || '/home/you/work', resume: `claude --resume ${a.id.split(':')[1]}` }));
  if (u === '/api/account') {
    return json({ profile: acct.profile, personalReady: how === 'notready' ? false : acct.profile === 'pool' ? 'unknown' : true, poolStashed: acct.stashed, blocked: '', plan: { jobs, sessions }, confirm: 'mock-confirm' });
  }
  if (u === '/api/account/switch') {
    const { to } = JSON.parse(opts.body);
    await new Promise(r => setTimeout(r, 2500));
    if (how === 'fail') return json({ to, restored: true, results: [{ id: jobs[0]?.id, status: 'failed', detail: 'Verification failed: the first reply after the restart was an API error', restarted: 'back on the previous settings' }, ...jobs.slice(1).map(j => ({ id: j.id, status: 'skipped', detail: 'Not attempted after the first respawn failed' }))], sessions: [] });
    Object.assign(acct, { profile: to, stashed: to === 'personal' });
    return json({ to, restored: false, results: jobs.map((j, i) => ({ id: j.id, status: 'respawned', ...(i === 0 && { verified: 'reply seen' }) })), sessions });
  }
  if (u === '/api/account/undo') { acct.profile = acct.profile === 'pool' ? 'personal' : 'pool'; acct.stashed = acct.profile === 'personal'; return json({ profile: acct.profile, restoredFrom: 'switch' }); }
  return json({ error: 'Not found' }, 404);
}
