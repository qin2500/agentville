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

/** True when the village runs on engine v2 (?engine=2, or Settings va.engine = 2 unless ?engine=1). */
export function engineActive(search, store) {
  const e = new URLSearchParams(search || '').get('engine');
  return e ? e === '2' : store.get('va.engine', 1) === 2;
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
