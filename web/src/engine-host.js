// Host seams for the v2 engine: names that belong to the classic app (its PR panel event and the hit kinds that open
// it). Kept outside web/src/engine/** so the engine stays free of world words (test/mod-ready-ratchet).
export const PANEL_HIT_KINDS = new Set(['dock', 'ship']);
export function openPrPanel(href = null) { window.dispatchEvent(new CustomEvent('va:dock', { detail: { href } })); }
export { dockPrs as venuePrs } from './engine-host/dock-input.js';
export { dockParams as venueParams } from './engine-host/dock-input.js';
export { dockHref as venueHref } from './engine-host/dock-input.js';
export { venueDebug, harbourOf } from './engine-host/dock-debug.js';
/** Actor kind of the people who carry loads between a berth and the yard (the mod's ambient behaviour of this name). */
export const CARRIER_KIND = 'porter';
