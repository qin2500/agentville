// agentville.fantasy world events (M6 P4): what the village does when something happens. Pure data out: the engine
// (render/event-fx.js) validates, times and draws the specs. Contract: api.js EventSpec / EventsCtx.
//   merge  -> confetti over the village plaza, in the village's accent colour
//   found  -> the new village's banner is raised (scaffolds for 3 s) and a ring of dust rolls out of the plaza
//   tierUp -> scaffolds on what the village grew for 8 s, and its agents cheer
const DUST = '#d8c8a8', GOLD = '#ffd23f', CREAM = '#f4efe4';
export const SITE_SECONDS = 8, BANNER_SECONDS = 3, CHEER_SECONDS = 4, MAX_SITES = 12, MAX_CHEERS = 12;

const sitesOf = (ctx, project, pred) => (ctx?.newObjects || []).filter(o => o.project === project && pred(o)).map(o => o.id).sort();

export function events(diff, ctx) {
  const out = [];
  for (const e of diff || []) {
    if (!e || !e.project) continue;
    const accent = ctx?.accentOf?.(e.project) || GOLD;
    if (e.type === 'merge') {
      out.push({ kind: 'merge', at: `plaza:${e.project}`, effect: 'burst', seconds: 2.5, colors: [accent, CREAM, GOLD, accent] });
    } else if (e.type === 'found') {
      for (const id of sitesOf(ctx, e.project, o => o.model === 'banner').slice(0, 4)) out.push({ kind: 'found', at: `plaza:${e.project}`, effect: `site:${id}`, seconds: BANNER_SECONDS });
      out.push({ kind: 'found', at: `plaza:${e.project}`, effect: 'ring', seconds: 1.8, colors: [DUST] });
    } else if (e.type === 'tierUp') {
      for (const id of sitesOf(ctx, e.project, o => o.kind === 'building').slice(0, MAX_SITES)) out.push({ kind: 'tierUp', at: `plaza:${e.project}`, effect: `site:${id}`, seconds: SITE_SECONDS });
      for (const id of [...(ctx?.actorsOf?.(e.project) || [])].sort().slice(0, MAX_CHEERS)) out.push({ kind: 'tierUp', at: `actor:${id}`, effect: 'anim:cheer', seconds: CHEER_SECONDS });
    }
  }
  return out;
}
export default events;
