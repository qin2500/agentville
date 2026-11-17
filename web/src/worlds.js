// World selection: Settings → World, ?world=<id>, and the persisted choice (va.world.mod). Engine v2 only.
// Classic never imports the engine: the registry is loaded on demand (loadWorlds), and pickWorld is pure.
export const DEFAULT_WORLD = 'agentville.fantasy';
export const WORLD_KEY = 'va.world.mod';

/** Never throws. The first of param, stored that is a bundled id (in `ids`); else the default world. */
export function pickWorld(param, stored, ids = [DEFAULT_WORLD]) {
  const list = Array.isArray(ids) ? ids : [];
  for (const c of [param, stored]) if (typeof c === 'string' && list.includes(c)) return c;
  return DEFAULT_WORLD;
}

let cached = null;
/** The bundled worlds, [{ id, name }]. Cached; resolves to the default world alone if the registry cannot load. */
export function loadWorlds() {
  cached ||= import('./engine/mod/registry.js')
    .then(r => r.listMods().map(m => ({ id: m.id, name: m.name || m.id })))
    .catch(() => [{ id: DEFAULT_WORLD, name: DEFAULT_WORLD }]);
  return cached;
}

/** True when the village runs on engine v2: ?engine=1|2 for the page, else the stored setting (default v2). */
export function engineActive(search, store) {
  const e = new URLSearchParams(search || '').get('engine');
  return e === '1' || e === '2' ? e === '2' : storedEngine(store) === 2;
}

/** A <select data-set="world"> listing the worlds, `current` selected. */
export function worldPickerHtml({ current, worlds, esc = s => String(s) }) {
  const opts = worlds.map(w => `<option value="${esc(w.id)}"${w.id === current ? ' selected' : ''}>${esc(w.name)}</option>`).join('');
  return `<label>World <select data-set="world">${opts}</select></label>`;
}

/** Settings template line: '' on classic; else a slot that fills in once the registry has loaded. */
export function worldSlotHtml(store, esc, search = location.search) {
  if (!engineActive(search, store)) return '';
  loadWorlds().then(worlds => {
    const slot = document.getElementById('world-slot');
    if (!slot) return;
    const ids = worlds.map(w => w.id);
    const current = pickWorld(new URLSearchParams(search).get('world'), store.get(WORLD_KEY, undefined), ids);
    slot.innerHTML = worldPickerHtml({ current, worlds, esc });
  });
  return '<div id="world-slot"></div>';
}

/** Persist the choice and reload. A ?world= param would win over it, so the reload drops the param. */
export function applyWorld(id, store, reload = defaultReload) {
  store.set(WORLD_KEY, id);
  reload();
}
function defaultReload() {
  const u = new URL(location.href);
  u.searchParams.delete('world');
  location.assign(u.href);
}

// Settings → Advanced → "Use classic village (old engine)", bound to va.engine (1 classic, 2 new). Since M7 the new engine
// is the default: unset (or 2) is v2, only an explicit stored 1 keeps classic. ?engine=1|2 overrides it for the page;
// the choice reloads without that param so the setting takes effect. Picking never touches a layout key.
export const ENGINE_KEY = 'va.engine';
/** The engine the stored setting picks (ignores ?engine): 1 or 2. Rollback: default back to 1 here. */
export const storedEngine = store => (store.get(ENGINE_KEY, 2) === 1 ? 1 : 2);
/** The classic-village opt-out: a checkbox inside a collapsed <details class="settings-advanced"> at the bottom of Settings. */
export function classicToggleHtml(store) {
  const classic = storedEngine(store) === 1;
  return `<details class="settings-advanced"><summary>Advanced</summary>
        <label><input type="checkbox" data-set="engine"${classic ? ' checked' : ''}>Use classic village (old engine)</label>
        <p class="helper">The old village. It will be removed in a later version.</p></details>`;
}
/** Persist the choice (1 | 2) and reload without ?engine. */
export function applyEngine(value, store, reload = engineReload) {
  store.set(ENGINE_KEY, +value === 2 ? 2 : 1);
  reload();
}
function engineReload() {
  const u = new URL(location.href);
  u.searchParams.delete('engine');
  location.assign(u.href);
}
