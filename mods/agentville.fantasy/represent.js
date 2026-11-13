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
