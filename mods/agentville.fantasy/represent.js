// Fantasy mod: declarative `behaviour` seam (and the `represent` re-export) (design v2 §4.2). Plain data, no functions.
// place: 'home.forecourt' | 'pr.site' | 'anchor:<sit|work|stand|vend>' | 'venue:<square|dock>'

export const BEHAVIOUR = {
  // building with a live PR: the PR site's work anchors (engine falls back to the forecourt)
  working: { place: 'pr.site', pose: 'hammer', idle: ['carry-crate'], walk: true },
  // building with no PR: the home's work anchor (workbench, woodpile, anvil)
  building: { place: 'anchor:work', pose: 'hammer', idle: ['saw'], walk: true },
  // waiting: a bench, fountain rim or doorstep near home
  waiting: { place: 'anchor:sit', pose: 'sit', idle: ['look-around'], idleEvery: [6, 10], walk: true },
  // stalled agents never wander: they stay on their own forecourt, facing the viewer
  'stalled:attention': { place: 'home.forecourt', pose: 'stand', idle: ['bob', 'wave'], idleEvery: [4, 4], walk: false },
  'stalled:prompt': { place: 'home.forecourt', pose: 'wave-both', idle: [], walk: false },
  'stalled:error': { place: 'home.forecourt', pose: 'stand', idle: ['smoke-puff'], walk: false },
  // resting: indoors (window lit, zZ at night)
  resting: { place: 'home.forecourt', pose: 'indoors', idle: [], walk: false },
  // resting with PRs loading: porter, home -> crate yard -> ship -> home
  'resting:prs-loading': { place: 'venue:dock', pose: 'carry', idle: ['wave-at-ship'], walk: true },
  // sub-agent: nearest free slot in the parent's yard; pose follows its own bucket
  sub: { place: 'anchor:stand', pose: 'stand', idle: [], look: 'ninja', walk: true },
};

// Pose vocabulary (mod data `represent.poses`): this mod's pose / idle-cue names -> the engine anim enum.
// The lead wires it with `represent: { ...REPRESENT, poses: POSES, cues: CUES }` in index.js.
export const POSES = {
  stand: 'idle', doorstep: 'idle', indoors: 'idle', 'look-around': 'idle', bob: 'idle',
  'smoke-puff': 'idle', smoke: 'idle', sparks: 'idle',
  saw: 'hammer', 'carry-crate': 'carry',
  'wave-both': 'wave', 'wave-at-ship': 'wave',
};

// Idle-tag timing (mod data `represent.cues`): `bob` is shown all the time, `smoke-puff` is a timed cue.
export const CUES = {
  bob: { continuous: true },
  'smoke-puff': { every: [3, 5], len: 1.0 },
};

// REPRESENT lives in represent-pr.js; re-exported here for existing importers.
export { REPRESENT } from './represent-pr.js';

// A live PR site takes at most SITE_CREW_MAX hammering builders (classic world.js: `n < 4`, spots either side of the front,
// then either side of the walls). Extra builders get no spot and wait at their own forecourt (the yard). The engine's
// `pr.site` place claims `work` anchors; this returns the (at most 4) work anchors a PR site's footprint offers, in
// classic order, as tiles OUTSIDE the footprint (face 0 N, 1 E, 2 S, 3 W). Pure.
export const SITE_CREW_MAX = 4;
/** @param {{tx:number,ty:number,w?:number,h?:number}} site @returns {{tx:number,ty:number,sub:number,face:number}[]} */
export function siteWorkAnchors(site) {
  if (!site || !Number.isFinite(site.tx) || !Number.isFinite(site.ty)) return [];
  const w = Math.max(1, site.w | 0), h = Math.max(1, site.h | 0), by = site.ty + h;
  return [
    { tx: site.tx - 1, ty: by, sub: 0, face: 1 },          // left of the front, facing the walls
    { tx: site.tx + w, ty: by, sub: 0, face: 3 },          // right of the front
    { tx: site.tx - 1, ty: by - 1, sub: 0, face: 1 },      // left of the wall
    { tx: site.tx + w, ty: by - 1, sub: 0, face: 3 },      // right of the wall
  ].slice(0, SITE_CREW_MAX);
}
/** The builders (ids, in arrival order) who get a hammering spot at a site; the rest wait at the yard. */
export function crewAt(builderIds) {
  const ids = [...new Set(builderIds || [])];
  return { hammering: ids.slice(0, SITE_CREW_MAX), waiting: ids.slice(SITE_CREW_MAX) };
}
