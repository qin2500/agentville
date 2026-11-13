// ?citydemo=1: a showcase town of four made-up projects, one per growth tier (hamlet, village, town,
// city), with plausible agents (a boss, leads with crews, solos in every state) and PR history.
// village.js lays these out instead of the real agents (in a layout store of its own, see world.js
// plan({ demo })), so a settlement of every tier can be seen side by side. Demo villagers can be hovered
// and clicked safely; they open nothing (their ids start with DEMO_PREFIX and are not in S.byId).
export const DEMO_PREFIX = 'citydemo:';
export const isDemoId = id => typeof id === 'string' && id.startsWith(DEMO_PREFIX);

// [project, growth inputs, crews]. A crew is [role, bucket, subs?]: subs is a list of sub buckets.
// Each project has a fixed architectural style (styles-pool.js FAMILIES): thatch 5, mediterranean 1, stone 2, canal 4.
// The City has two bosses, so its plan gets two crown estates.
// growth = 3·PRs + agentsEver + log2(transcript MB + 1): Hamlet 7, Village 30, Town 96, City 407.
const PROJECTS = [
  { name: 'Hamlet', style: 5, prs: 1, live: 1, agentsEver: 4, mb: 2, crews: [['solo', 'building'], ['solo', 'waiting'], ['solo', 'resting']] },
  { name: 'Village', style: 1, prs: 4, live: 2, agentsEver: 18, mb: 40, crews: [['lead', 'waiting', ['building', 'building']], ['solo', 'stalled'], ['solo', 'building'], ['solo', 'resting'], ['solo', 'resting']] },
  { name: 'Town', style: 2, prs: 12, live: 3, agentsEver: 60, mb: 300, crews: [['lead', 'building', ['building', 'waiting', 'resting']], ['lead', 'stalled', ['building']],
    ['solo', 'waiting'], ['solo', 'building'], ['solo', 'building'], ['solo', 'stalled'], ['solo', 'waiting'], ['solo', 'resting'], ['solo', 'resting']] },
  { name: 'City', style: 4, prs: 45, live: 6, agentsEver: 260, mb: 4000, crews: [['boss', 'waiting'], ['boss', 'building'], ['lead', 'building', ['building', 'building', 'waiting']], ['lead', 'waiting', ['building', 'stalled', 'resting']],
    ['lead', 'building', ['building', 'building']], ['lead', 'stalled', ['waiting']], ['solo', 'building'], ['solo', 'building'], ['solo', 'waiting'], ['solo', 'waiting'],
    ['solo', 'stalled'], ['solo', 'building'], ['solo', 'waiting'], ['solo', 'building'], ['solo', 'resting', null, true], ['solo', 'resting'], ['solo', 'resting']] },
];
const NAMES = ['Ada', 'Bram', 'Cora', 'Dov', 'Elin', 'Fenn', 'Gus', 'Hale', 'Ivo', 'Juno', 'Kit', 'Lark', 'Milo', 'Nell', 'Oren', 'Pia', 'Quill', 'Rue', 'Sol', 'Tam', 'Una', 'Vale', 'Wren', 'Yara'];

/** The demo's agents (shaped like /api/agents entries), a byId map, and per-project meta. */
export function cityDemo(now = Date.now()) {
  const agents = [], projects = [];
  let n = 0;
  for (const P of PROJECTS) {
    const base = P.name === 'City' ? 7000 : P.name === 'Town' ? 3000 : P.name === 'Village' ? 900 : 100;
    const prs = Array.from({ length: P.prs }, (_, i) => ({ id: String(base + i), href: `https://example.invalid/${P.name}/pull/${base + i}`, live: i >= P.prs - P.live, agentIds: [] }));
    const livePrs = prs.filter(p => p.live);
    let nextLive = 0;
    const add = (role, bucket, parent, important) => {
      const i = n++, id = `${DEMO_PREFIX}${P.name.toLowerCase()}:${i}`;
      const a = {
        id, harness: 'claude-code', name: role === 'boss' ? `${P.name} Boss` : role === 'lead' ? `${NAMES[i % NAMES.length]} Lead` : `${P.name.toLowerCase()}-${NAMES[i % NAMES.length].toLowerCase()}`,
        title: `Demo agent in ${P.name}`, project: P.name, role, parentId: parent?.id ?? null, childIds: [], bucket,
        severity: bucket === 'stalled' ? (i % 3 === 0 ? 'error' : 'attention') : null, prompt: bucket === 'stalled' && i % 3 === 1 ? 'permission' : null,
        reason: '', since: now - (5 + i) * 6e4, lastActivityAt: now - (2 + i) * 6e4, live: bucket !== 'resting', prs: [], hidden: false, important: !!important,
      };
      if (bucket === 'building' && livePrs.length) { const p = livePrs[nextLive++ % livePrs.length]; a.prs.push({ id: p.id, href: p.href }); p.agentIds.push(id); }
      parent?.childIds.push(id);
      agents.push(a);
      return a;
    };
    let boss = null;
    for (const [role, bucket, subs, important] of P.crews) {
      const a = add(role, bucket, role === 'lead' ? boss : null, important);
      if (role === 'boss') boss = a;
      for (const sb of subs || []) add('sub', sb, a);
    }
    projects.push({ name: P.name, style: { family: P.style }, prs, agentsEver: P.agentsEver, transcriptBytes: P.mb * 1e6 });
  }
  return { agents, byId: new Map(agents.map(a => [a.id, a])), projects };
}
