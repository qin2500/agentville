// Town plan sync (M7 P2): the village layout keys in localStorage are mirrored to the server (GET/PUT /api/world-plan),
// so every window and browser on this machine shows the same town.
//
// hydratePlan runs once at startup, before the village is created; it never blocks longer than `timeoutMs` and never
// throws. Per sync key it takes one of five branches:
//   migrate   local only (server empty)              -> PUT at baseRev 0, local untouched
//   adopt     server only, or server newer while the local copy is unchanged since the last sync -> written locally
//   same      server and local hold the same plan    -> rev recorded, nothing pushed
//   conflict  both differ and they were never synced (first contact), or both changed -> local kept for this load,
//             the server copy saved to va.worldplan.backup.<k>, the key is a follower (never pushed) until the person
//             picks one in Settings (useOtherPlan / keepThisPlan). Never auto-switches.
//   offline   no server (timeout, network, 404, bad reply) -> local only; local edits stay dirty and flush later.
// A local edit since the last sync on an unchanged server rev is pushed (the dirty flush).
//
// installPlanMirror pushes later edits (store.set -> onStoreSet) debounced. 200 records the rev; 409 marks the key stale
// for the rest of the session and saves the server copy as a backup (Settings offers the choice); the live village is
// never re-laid-out. Bookkeeping: va.worldplan.revs { k: { rev, h, s, at? } } (h: hash of the synced JSON; s: hash of its
// townKey; at: when this browser last pushed it, or saw another window push the same town), va.worldplan.dirty { k: 1 },
// va.worldplan.backup.<k> { rev, value }. `ls` is a localStorage-like object (getItem/setItem/removeItem/key/length).
//
// Tabs (review M7 must-fix 1): every tab of one browser shares that localStorage, so va.worldplan.revs says what the
// browser last synced, not what THIS tab shows. A PUT's baseRev therefore comes from the tab's own record (createPlanTab:
// the rev and town hash this tab hydrated, adopted or pushed), never from the shared revs. A tab still showing an older
// town than another tab adopted or kept gets a 409 and goes stale (backup + the Settings choice) instead of pushing its
// town over the other window's. A dirty mark carries the rev its writer was based on ({ b }), so a later startup only
// flushes it when the server is still at that rev. Only a server file of version 1 is read (must-fix 2).
//
// Same town (townKey / sameTown, below): every comparison that decides same / adopt / conflict, and whether a 409 is a
// real conflict, ignores the per-build bookkeeping a layout carries (each shown block's `seen`, rewritten on every build).
// A change to that bookkeeping alone is pushed at most once per SEEN_PUSH_MS (it only keeps the server's copy of `seen`
// fresh enough for the 14-day reserve of hidden blocks), never per rebuild. Any other change is pushed at once.

/** The keys that sync: engine v2 layouts, classic layouts, the engine seed and first-seen order. Never a `.demo` key. */
export const SYNC_KEY_RE = /^(?!.*\.demo$)va\.(engine2\.world(\.[a-z0-9.-]+)?|world\d+|engine2\.seed|seen)$/;
const syncable = k => typeof k === 'string' && SYNC_KEY_RE.test(k) && !k.endsWith('.demo');

export const REVS_KEY = 'va.worldplan.revs';
export const DIRTY_KEY = 'va.worldplan.dirty';
export const BACKUP_PREFIX = 'va.worldplan.backup.';
const SEED_KEY = 'va.engine2.seed';
const API = '/api/world-plan';

// ---- localStorage helpers (never throw) ----
const getRaw = (ls, k) => { try { return ls.getItem(k); } catch { return null; } };
const setRaw = (ls, k, v) => { try { ls.setItem(k, v); return true; } catch { return false; } };
const delRaw = (ls, k) => { try { ls.removeItem(k); } catch { /* blocked */ } };
const readJson = (ls, k, d) => { const r = getRaw(ls, k); if (r == null) return d; try { return JSON.parse(r) ?? d; } catch { return d; } };
const parse = raw => { try { return { ok: true, v: JSON.parse(raw) }; } catch { return { ok: false }; } };
function localKeys(ls) {
  const out = [];
  try { for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (syncable(k)) out.push(k); } } catch { /* blocked */ }
  return out;
}
const edit = (ls, k, fn) => { const o = readJson(ls, k, {}); fn(o); setRaw(ls, k, JSON.stringify(o)); };
// at: pass a time to record a push (or another window's push of the same town); else the old one is kept.
const setRev = (ls, k, rev, raw, at) => edit(ls, REVS_KEY, o => {
  const prev = o[k], t = at ?? (prev && prev.rev <= rev ? prev.at : undefined);
  o[k] = { rev, h: hash(raw), s: townHash(k, raw), ...(Number.isFinite(t) ? { at: t } : {}) };
});
const dropRev = (ls, k) => edit(ls, REVS_KEY, o => { delete o[k]; });
// b: the rev the writing tab's copy is based on (its own record), so another tab's startup never flushes it over a newer town.
const markDirty = (ls, k, b) => edit(ls, DIRTY_KEY, o => { o[k] = Number.isInteger(b) ? { b } : 1; });
const clearDirty = (ls, k) => edit(ls, DIRTY_KEY, o => { delete o[k]; });
const backupKey = k => BACKUP_PREFIX + k;
const getBackup = (ls, k) => { const b = readJson(ls, backupKey(k), null); return b && typeof b === 'object' && Number.isInteger(b.rev) ? b : null; };
const setBackup = (ls, k, rev, value) => setRaw(ls, backupKey(k), JSON.stringify({ rev, value }));

/** This tab's own sync record, in memory only, never shared between tabs:
 *   revs       k -> { rev, s }  the rev and town hash this tab hydrated, adopted or pushed;
 *   own        k -> raw         the value this tab itself loaded or last saved (its town, whatever other tabs write);
 *   conflicts  k -> { rev, value }  the server copy this tab was refused for: only this tab shows the Settings choice;
 *   off        hydrate found no plan API or a plan file of another version -> the mirror never pushes. */
export function createPlanTab() { return { revs: new Map(), own: new Map(), conflicts: new Map(), off: false }; }
const tabRev = (tab, k) => tab?.revs.get(k)?.rev ?? 0;
// Seed a tab's record from the shared revs for keys it has no record of (what this tab loads from localStorage now).
// withLocal (a mirror installed without hydrate): also this tab's own values and the backups waiting on a choice.
function seedTab(tab, ls, withLocal = false) {
  for (const [k, e] of Object.entries(readJson(ls, REVS_KEY, {}))) if (!tab.revs.has(k) && Number.isInteger(e?.rev)) tab.revs.set(k, { rev: e.rev, s: e.s ?? null });
  if (!withLocal) return;
  for (const k of localKeys(ls)) if (!tab.own.has(k)) tab.own.set(k, getRaw(ls, k));
  for (const k of lsConflicts(ls)) if (!tab.conflicts.has(k)) tab.conflicts.set(k, getBackup(ls, k));
}
// A server copy this tab was refused for: kept in the tab (its Settings choice) and in localStorage (for a reload).
const conflictOn = (ls, tab, k, rev, value) => { setBackup(ls, k, rev, value); tab?.conflicts.set(k, { rev, value }); };
// The browser and this tab both synced `raw` at `rev`.
const synced = (ls, tab, k, rev, raw, at) => { setRev(ls, k, rev, raw, at); tab?.revs.set(k, { rev, s: townHash(k, raw) }); };

// ---- Same town: the one place that says which fields of a saved layout do not make it a different town ----
/** The layout keys (engine v2 and classic): their values are { v?, seed?, blocks, lots, venues? }. */
const LAYOUT_KEY_RE = /^va\.(engine2\.world(\.[a-z0-9.-]+)?|world\d+)$/;
/** How often a change to volatile fields alone (see townKey) is pushed: at most once an hour per browser and key. The
 * server's `seen` only has to be fresh against the 14-day reserve of hidden blocks (world/sites.js RESERVE_MS). */
export const SEEN_PUSH_MS = 60 * 60 * 1000;
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
// JSON with every object's keys sorted, so two windows that wrote the same town in another key order still match.
const canon = v => JSON.stringify(v, (_, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
/**
 * The town a saved value describes, as a string: equal strings are the same town. For a layout key it leaves out the
 * per-window bookkeeping that differs between windows showing the same town:
 *   blocks[p].seen       last time the project was shown; every build rewrites it (world/sites.js placeBlocks,
 *                        classic world.js layout) -> dropped;
 *   lots[p].h[item]      when a window noticed the item gone (lots.js; each window's own poll time) -> presence only;
 *   venues[id].low       when a window noticed the venue's level wanting to drop (venue.js) -> presence only.
 * Everything else (positions, sizes, tiers, lots, the seed, venue levels, unknown fields) counts. Other sync keys
 * (va.engine2.seed, va.seen) compare whole. Never throws.
 */
export function townKey(k, value) {
  if (!LAYOUT_KEY_RE.test(k) || !isObj(value)) return canon(value) ?? 'undefined';
  const v = JSON.parse(JSON.stringify(value));
  if (isObj(v.blocks)) for (const b of Object.values(v.blocks)) if (isObj(b)) delete b.seen;
  if (isObj(v.lots)) for (const l of Object.values(v.lots)) if (isObj(l) && isObj(l.h)) for (const id of Object.keys(l.h)) l.h[id] = 1;
  if (isObj(v.venues)) for (const e of Object.values(v.venues)) if (isObj(e) && e.low != null) e.low = 1;
  return canon(v);
}
/** Do two saved values of key k describe the same town (townKey)? */
export const sameTown = (k, a, b) => townKey(k, a) === townKey(k, b);
const townHash = (k, raw) => { const p = parse(raw); return p.ok ? hash(townKey(k, p.v)) : null; };

/** FNV-1a 32 over the string, with its length: cheap equality check for the synced copy. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}
const sameValue = (k, raw, value) => { const p = parse(raw); return p.ok && sameTown(k, p.v, value); };
/** Is local `raw` still the town last synced (known: its revs entry)? An entry from before townKey has no `s`: whole JSON. */
const sameAsSynced = (k, known, raw) => !!known && (known.s ? known.s === townHash(k, raw) : known.h === hash(raw));
/** Should the mirror send `raw`? A different town: yes. The same town with only volatile fields changed: once the last
 * push is SEEN_PUSH_MS old. Byte-identical: no. */
function wantsPush(k, known, raw, now) {
  if (!known || !sameAsSynced(k, known, raw)) return true;
  if (known.h === hash(raw)) return false;
  return !(now - (known.at || 0) < SEEN_PUSH_MS);
}
// Volatile fields kept from the newer side when local takes (or keeps) the same town: each block's latest `seen`.
function freshestSeen(k, into, from) {
  if (!LAYOUT_KEY_RE.test(k) || !isObj(into?.blocks) || !isObj(from?.blocks)) return into;
  for (const [n, b] of Object.entries(into.blocks)) {
    const o = from.blocks[n];
    if (isObj(b) && isObj(o) && Number.isFinite(o.seen) && !(b.seen >= o.seen)) b.seen = o.seen;
  }
  return into;
}

// One PUT per key at a time, shared by hydrate and the mirror (so a mirror push never races a migration).
const inflight = new Map();
function serial(k, fn) {
  const prev = inflight.get(k) || Promise.resolve();
  const p = prev.then(fn, fn);
  inflight.set(k, p);
  p.finally(() => { if (inflight.get(k) === p) inflight.delete(k); }).catch(() => {});
  return p;
}

/** fetch keepalive (pagehide) carries at most 64 KiB of bodies in flight; a bigger one is sent plainly and stays dirty
 * if the page is gone before it lands. */
export const KEEPALIVE_MAX = 64 * 1024;
const bytes = s => { try { return new TextEncoder().encode(s).length; } catch { return s.length * 3; } };

/** PUT one key at baseRev. -> { status: 'ok', rev } | { status: 'conflict', rev, value } | 'disabled' | 'refused' | 'offline'.
 * opts.keepalive: a budget { left } in bytes; the request uses keepalive when its body fits (and takes it from the budget). */
async function put(fetch, ls, k, raw, baseRev, now = Date.now, tab = null, opts = {}) {
  const p = parse(raw);
  if (!p.ok) return { status: 'refused' };
  let res;
  try {
    const body = JSON.stringify({ key: k, value: p.v, baseRev });
    const ka = opts.keepalive, n = ka ? bytes(body) : 0, keepalive = !!ka && n <= ka.left;
    if (keepalive) ka.left -= n;
    res = await fetch(API, { method: 'PUT', headers: { 'content-type': 'application/json' }, body, ...(keepalive ? { keepalive: true } : {}) });
  } catch { return { status: 'offline' }; }
  const body = await Promise.resolve(res.json?.()).catch(() => null);
  if (res.status === 200 && Number.isInteger(body?.rev)) {
    synced(ls, tab, k, body.rev, raw, now());
    if (getRaw(ls, k) === raw) clearDirty(ls, k);
    else edit(ls, DIRTY_KEY, o => { if (o[k]?.b === baseRev) o[k] = { b: body.rev }; }); // this tab's later edit now builds on the new rev
    return { status: 'ok', rev: body.rev };
  }
  if (res.status === 409) return { status: 'conflict', rev: Number.isInteger(body?.rev) ? body.rev : 0, value: body?.value };
  if (res.status === 404) return { status: 'disabled' };
  if (res.status >= 400 && res.status < 500) return { status: 'refused' };
  return { status: 'offline' };
}

// A 409: the same town (another window pushed it, perhaps with other `seen` stamps) just records the rev, and counts as
// a fresh push (that window just refreshed the server copy) -> 'same'; else the server copy becomes the backup the
// Settings choice offers -> 'backup'. A 409 with no value (reason version / corrupt, or the server lost the key: nothing
// to choose) -> 'none'. Local is never replaced here.
function onConflict(ls, k, raw, r, now = Date.now, tab = null) {
  if (r.value == null) return 'none';
  if (sameValue(k, raw, r.value)) { synced(ls, tab, k, r.rev, raw, now()); clearDirty(ls, k); return 'same'; }
  conflictOn(ls, tab, k, r.rev, r.value);
  return 'backup';
}

const deadline = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

/**
 * Startup sync, before the village is created. Never throws, resolves within ~timeoutMs.
 * @returns {Promise<{ source: 'server'|'local'|'offline', migrated: string[], adopted: string[], conflicts: string[], tab }>}
 *   'local': the server has no plan API (404: disabled or a static build) or keeps a plan file of another version (an
 *   M7 client never adopts or overwrites that); 'offline': unreachable / timed out / bad reply.
 *   tab: this tab's own record (createPlanTab; pass it to installPlanMirror and keepThisPlan).
 */
export async function hydratePlan({ fetch, ls, timeoutMs = 800, now = Date.now, tab = createPlanTab() } = {}) {
  const out = { source: 'offline', migrated: [], adopted: [], conflicts: [], tab };
  if (!ls || typeof fetch !== 'function') return out;
  try { seedTab(tab, ls); } catch { /* storage blocked */ }
  const t0 = Date.now();
  let server;
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const get = (async () => {
      const res = await fetch(API, { method: 'GET', headers: { accept: 'application/json' }, ...(ctl ? { signal: ctl.signal } : {}) });
      if (res.status === 404) return 'local';
      if (!res.ok) return null;
      const body = await res.json();
      if (body && typeof body === 'object' && body.v !== 1) return 'local'; // another file version: hands off
      return body && typeof body === 'object' && body.keys && typeof body.keys === 'object' && !Array.isArray(body.keys) ? body : null;
    })().catch(() => null);
    const r = await Promise.race([get, deadline(timeoutMs).then(() => 'timeout')]);
    if (r === 'timeout') { ctl?.abort(); return out; }
    if (r === 'local') { out.source = 'local'; tab.off = true; return out; }
    if (!r) return out;
    server = r;
  } catch { return out; }
  out.source = 'server';

  try {
    const revs = readJson(ls, REVS_KEY, {}), dirty = readJson(ls, DIRTY_KEY, {});
    const local = localKeys(ls);
    // A seed with no engine layout beside it lays out nothing yet: the server's seed (which matches its layout) wins.
    const hasEngineLayout = local.some(k => k.startsWith('va.engine2.world'));
    const keys = [...new Set([...local, ...Object.keys(server.keys).filter(syncable)])].sort((a, b) => (a === SEED_KEY) - (b === SEED_KEY));
    const pushes = [];
    const push = (k, raw, baseRev, isMigrate) => {
      markDirty(ls, k, baseRev);
      pushes.push(serial(k, () => put(fetch, ls, k, raw, baseRev, now, tab)).then(r => {
        if (r.status === 'conflict' && onConflict(ls, k, raw, r, now, tab) === 'backup' && !out.conflicts.includes(k)) out.conflicts.push(k);
        if (r.status === 'ok' && isMigrate) out.migrated.push(k);
      }));
    };
    const adopt = (k, s, localRaw) => {
      const mine = localRaw != null ? parse(localRaw) : { ok: false };
      const raw = JSON.stringify(mine.ok ? freshestSeen(k, JSON.parse(JSON.stringify(s.value)), mine.v) : s.value);
      setRaw(ls, k, raw); synced(ls, tab, k, s.rev, raw); clearDirty(ls, k);
      out.adopted.push(k);
    };
    for (const k of keys) {
      const s = server.keys[k];
      const srv = s && Number.isInteger(s.rev) && s.value !== undefined ? s : null;
      let raw = getRaw(ls, k);
      if (raw != null && !parse(raw).ok) raw = null;
      const backup = getBackup(ls, k);
      if (backup) {
        // Still waiting on the person's choice: refresh the backup if the server moved on; never push.
        if (srv && raw != null && sameValue(k, raw, srv.value)) { synced(ls, tab, k, srv.rev, raw); clearDirty(ls, k); delRaw(ls, backupKey(k)); continue; }
        if (srv) { conflictOn(ls, tab, k, srv.rev, srv.value); out.conflicts.push(k); continue; }
        delRaw(ls, backupKey(k)); // the server lost it: plain migrate below
      }
      if (!srv) { if (raw != null) push(k, raw, 0, true); continue; }                     // migrate
      if (raw == null || (k === SEED_KEY && !hasEngineLayout)) { adopt(k, srv); continue; } // adopt (client lacks it)
      if (sameValue(k, raw, srv.value)) {                                                  // same (townKey)
        const p = parse(raw).v, fresh = JSON.stringify(freshestSeen(k, p, srv.value));
        if (fresh !== raw) { setRaw(ls, k, fresh); raw = fresh; }
        synced(ls, tab, k, srv.rev, raw); clearDirty(ls, k); continue;
      }
      const known = revs[k];
      // Unchanged since the last sync: the same town as synced (volatile fields aside, so a seen-only dirty mark is not
      // an edit); an entry from before townKey needs the identical JSON and no dirty mark.
      const unchanged = sameAsSynced(k, known, raw) && (!!known.s || !dirty[k]);
      // Dirty flush: an edit on an unchanged server rev. The mark says which rev its writer (maybe another tab) was on.
      const base = Number.isInteger(dirty[k]?.b) ? dirty[k].b : known?.rev;
      if (known && known.rev === srv.rev && base === srv.rev) { push(k, raw, srv.rev, false); continue; }
      if (known && srv.rev > known.rev && unchanged) { adopt(k, srv, raw); continue; }   // adopt newer
      conflictOn(ls, tab, k, srv.rev, srv.value);                                         // conflict: keep local
      out.conflicts.push(k);
    }
    // What this tab loads: its own town from here on, whatever other tabs later write to the shared localStorage.
    for (const k of keys) { const r = getRaw(ls, k); if (r != null) tab.own.set(k, r); }
    if (pushes.length) await Promise.race([Promise.all(pushes), deadline(timeoutMs - (Date.now() - t0))]);
  } catch { /* storage trouble: the village still starts on what is local */ }
  return out;
}

/**
 * Mirrors later store.set calls of sync keys to the server, debounced. `onStoreSet(cb)` registers cb(key, value).
 * `tab`: this tab's record from hydratePlan (else one seeded from the shared revs now). Every PUT is based on the rev
 * THIS tab synced, so a tab showing an older town than another tab gets a 409 and goes stale, never overrides it.
 * flush({ keepalive: true }) (pagehide) sends bodies up to KEEPALIVE_MAX in all with fetch keepalive.
 * onChoice(k): a push of this tab was refused for a different town; the Settings choice is now this tab's (toast it).
 * Pushes send this tab's own value (tab.own, recorded on each of its saves), never another tab's later write.
 * @returns {{ flush(opts?): Promise<void>, resume(keys?: string[]): void, stop(): void, stale: Set<string>, tab }}
 */
export function installPlanMirror({ onStoreSet, fetch, ls, debounceMs = 1500, now = Date.now, tab = null, onChoice = null } = {}) {
  const stale = new Set(), pending = new Set();
  if (!tab) { tab = createPlanTab(); try { if (ls) seedTab(tab, ls, true); } catch { /* blocked */ } }
  let timer = 0, disabled = false, stopped = false;
  const ready = () => !stopped && !disabled && !tab.off && !!ls && typeof fetch === 'function';
  async function flush({ keepalive = false } = {}) {
    clearTimeout(timer); timer = 0;
    const keys = [...pending]; pending.clear();
    const budget = keepalive ? { left: KEEPALIVE_MAX } : null;
    await Promise.all(keys.map(k => serial(k, async () => {
      if (!ready() || stale.has(k) || tab.conflicts.has(k)) return;
      const raw = tab.own.get(k) ?? getRaw(ls, k); // this tab's town, not another tab's later write
      if (raw == null) return;
      const known = readJson(ls, REVS_KEY, {})[k];
      if (!wantsPush(k, known, raw, now())) { clearDirty(ls, k); return; }
      const r = await put(fetch, ls, k, raw, tabRev(tab, k), now, tab, { keepalive: budget });
      if (r.status === 'conflict') {
        const c = onConflict(ls, k, raw, r, now, tab);
        if (c !== 'same') stale.add(k);
        if (c === 'backup') try { onChoice?.(k); } catch { /* the caller's toast */ }
      }
      else if (r.status === 'disabled') disabled = true;
      else if (r.status === 'refused') stale.add(k);
      // 'offline': stays dirty; the next edit or the next startup pushes it.
    })));
  }
  const hook = k => {
    if (!syncable(k) || !ls) return;
    const raw = getRaw(ls, k); // read straight after this tab's own store.set: this tab's value
    if (raw != null) tab.own.set(k, raw);
    if (!ready() || stale.has(k)) return;
    if (raw == null || tab.conflicts.has(k)) return;
    const known = readJson(ls, REVS_KEY, {})[k];
    if (!wantsPush(k, known, raw, now())) return; // the same town saved again (every rebuild re-stamps `seen`): nothing to send
    markDirty(ls, k, tabRev(tab, k));
    pending.add(k);
    clearTimeout(timer);
    timer = setTimeout(() => { flush(); }, debounceMs);
  };
  onStoreSet?.(hook);
  return {
    flush, stale, tab,
    resume(keys) { for (const k of keys || [...stale]) stale.delete(k); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}

/** The keys waiting on THIS tab's Settings choice: with `tab`, only keys this tab itself was refused for or loaded in
 * conflict (another tab's conflict is not this tab's choice); without, every backup in localStorage. */
export function planConflicts(ls, tab = null) {
  if (tab) return [...tab.conflicts.keys()].sort();
  return lsConflicts(ls);
}
function lsConflicts(ls) {
  const out = [];
  try { for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k?.startsWith(BACKUP_PREFIX) && getBackup(ls, k.slice(BACKUP_PREFIX.length))) out.push(k.slice(BACKUP_PREFIX.length)); } } catch { /* blocked */ }
  return out.sort();
}

/** "Use the town saved by your other window": the backups become the local plan (the caller reloads). */
export function useOtherPlan({ ls, tab = null, keys = planConflicts(ls, tab) } = {}) {
  for (const k of keys) {
    const b = tab?.conflicts.get(k) ?? getBackup(ls, k);
    if (!b) continue;
    const raw = JSON.stringify(b.value);
    setRaw(ls, k, raw); synced(ls, tab, k, b.rev, raw); clearDirty(ls, k); delRaw(ls, backupKey(k));
    tab?.conflicts.delete(k); tab?.own.set(k, raw);
  }
}

/** "Keep this one": push THIS tab's own town (tab.own: what it loaded or last saved, so the caller has the engine re-save
 * first; never another tab's later write to localStorage) at the backup's rev, the server copy the person was shown.
 * A server that moved since then is never overwritten unseen: the 409 refreshes the backup to the new server copy, the
 * key stays in conflict (moved) and nothing is pushed. On success localStorage holds this tab's town again.
 * -> { kept: string[], failed: string[], moved: string[] } (moved: also in failed; the choice is to be shown again) */
export async function keepThisPlan({ fetch, ls, tab = null, keys = planConflicts(ls, tab) } = {}) {
  const kept = [], failed = [], moved = [];
  for (const k of keys) {
    const b = tab?.conflicts.get(k) ?? getBackup(ls, k);
    if (!b) continue;
    const raw = tab?.own.get(k) ?? getRaw(ls, k);
    const done = () => { delRaw(ls, backupKey(k)); tab?.conflicts.delete(k); kept.push(k); };
    if (raw == null) { dropRev(ls, k); done(); continue; }
    const r = await serial(k, () => put(fetch, ls, k, raw, b.rev, Date.now, tab));
    const c = r.status === 'conflict' ? onConflict(ls, k, raw, r, Date.now, tab) : null;
    if (r.status === 'ok' || c === 'same') {
      if (getRaw(ls, k) !== raw) { setRaw(ls, k, raw); clearDirty(ls, k); }
      done();
    } else { failed.push(k); if (c === 'backup') moved.push(k); }
  }
  return { kept, failed, moved };
}

// Settings → "Sync town layout across windows": opt-in (default off) until two windows with separate storage stop
// disagreeing. Read once at load, so a change takes effect on the next load.
export const PLAN_SYNC_KEY = 'va.planSync';
/** True only when the stored setting is exactly `true`; unset, false or anything else is off. */
export const planSyncEnabled = store => store.get(PLAN_SYNC_KEY, false) === true;
/** A <input data-set="plansync"> checkbox with a one-line helper. */
export function planSyncToggleHtml(store) {
  return `<label><input type="checkbox" data-set="plansync" ${planSyncEnabled(store) ? 'checked' : ''}>Sync town layout across windows</label>
      <p class="helper">Takes effect the next time you open Agentville.</p>`;
}
