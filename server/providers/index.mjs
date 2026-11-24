// Provider registry (docs/providers-design.md section 1.1).
// Adapters are loaded lazily: a missing adapter file is skipped, so pieces can land in any order.
// Adapter modules must not import this file (top-level await below would deadlock).
import { assertAdapter, PROVIDER_IDS, providerOfHarness, providerOfAgent } from './contract.mjs';

export { PROVIDER_IDS, providerOfHarness, providerOfAgent };

const registry = new Map();

/** Register an adapter (validated). Used by loadProviders and by tests. */
export function registerProvider(adapter) {
  assertAdapter(adapter);
  registry.set(adapter.id, adapter);
  return adapter;
}

export function unregisterProvider(id) { return registry.delete(id); }

/** Import every adapter file that exists; skip files that are absent. Safe to call again. */
export async function loadProviders() {
  for (const id of PROVIDER_IDS) {
    if (registry.has(id)) continue;
    let mod;
    try { mod = await import(`./${id}.mjs`); }
    catch (e) {
      if (e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(`${id}.mjs`)) continue;
      throw e;
    }
    registerProvider(mod.default);
  }
  return providers();
}

/** @returns the adapter, or null when the id is unknown or its adapter is not present. */
export function getProvider(id) { return registry.get(id) || null; }

/** All registered adapters, in PROVIDER_IDS order. */
export function providers() { return PROVIDER_IDS.map((id) => registry.get(id)).filter(Boolean); }

await loadProviders();
