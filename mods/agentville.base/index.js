// agentville.base: the tiny reference world and last-resort fallback (village-mods.md §2.3).
// Every MOD0 hook has a minimal correct answer here, written to be read; copy it as a template.
// Pure: no Math.random, no clock, no DOM. Imports only files in this folder.
import { planGrid, GROUND } from './plan.js';
import { layout } from './layout.js';

const DAY = 24 * 3600 * 1000;
const MAX_PRS = 8;

// Terrain: our own small table (codes 0..4), deliberately unlike fantasy's.
const terrain = {
  types: [
    { code: GROUND.NONE, name: 'none', cost: 255 },
    { code: GROUND.GRASS, name: 'grass', cost: 3, color: '#6aa84f' },
    { code: GROUND.PATH, name: 'path', cost: 1, color: '#c9b68a', tags: ['street', 'walk'] },
    { code: GROUND.PLAZA, name: 'plaza', cost: 1, color: '#d9d2c0', tags: ['street', 'walk'] },
    { code: GROUND.WATER, name: 'water', cost: 255, color: '#4a7fb5', tags: ['water'] },
  ],
  byName: { none: 0, grass: 1, path: 2, plaza: 3, water: 4 },
  wildCost: 3,
  classes: [{ code: 0, name: 'void' }, { code: 1, name: 'land', wild: true, grows: true, color: '#6aa84f' }],
};

const objects = {
  props: { marker: { w: 1, h: 1, walk: 'block', z: 8 } },
  buildings: { box: { z: 24 } },
};

const rules = {
  layout: {
    square: { x: -3, y: -3, w: 6, h: 6 }, gap: 2,
    accents: ['#e06666', '#6fa8dc', '#93c47d', '#f6b26b'],
    searchX: 120, searchY: 90, aspect: 1.25, reserveMs: 14 * DAY,
  },
  holdMs: 12 * 3600 * 1000,
};

// Pull requests: only a building one shows (a flag lot); no venues, scatter or persist, by design.
const represent = { pr: { building: { as: 'lot', model: 'flag' }, loading: { as: 'none' }, merged: { as: 'none' }, closed: { as: 'none' } } };

const hooks = {
  growth: project => project.stats.prsEver + project.stats.agentsNow,
  tier: () => 0,
  capacity: (tier, need) => Math.max(4, Math.ceil(need / 4) * 4),
  lots(project, agents, prs) {
    const out = [];
    for (const a of agents) {
      if (a.parent && a.role !== 'boss' && a.role !== 'lead') continue;
      out.push({ item: `home:${a.id}`, owner: 'home', rank: a.role === 'boss' ? 'L' : 'S', agent: a.id });
    }
    for (const pr of prs.filter(p => p.state === 'building').slice(0, MAX_PRS)) {
      out.push({ item: `pr:${pr.id}`, owner: 'pr', rank: 'S', pr: pr.id, building: true });
    }
    return out;
  },
  layout,
  crowns: () => 1,
  planSettlement: (req, ctx) => planGrid(req, ctx),
  style(projectKey, ctx) {
    const accents = rules.layout.accents;
    return { key: 'base', accent: accents[ctx.hash(projectKey) % accents.length] };
  },
};

export default {
  id: 'agentville.base', name: 'Agentville Base', version: '1.0.0', apiVersion: 1, extends: null,
  rules, terrain, objects, represent, hooks,
};
