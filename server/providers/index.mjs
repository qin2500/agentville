// Provider registry (docs/providers-design.md section 1.1).
// Adapters are loaded lazily: a missing adapter file is skipped, so pieces can land in any order.
// Adapter modules must not import this file (top-level await below would deadlock).
import { assertAdapter, PROVIDER_IDS } from './contract.mjs';

export { PROVIDER_IDS };

const HARNESS_TO_PROVIDER = { 'claude-code': 'claude', 'gemini-cli': 'gemini', codex: 'codex' };
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

/** 'claude-code' -> 'claude', etc. Null for harnesses with no provider (opencode, cursor, ...). */
export function providerOfHarness(h) { return HARNESS_TO_PROVIDER[h] || null; }

/** The provider id of an agent: its `provider` field, else derived from `harness`. Null if neither maps. */
export function providerOfAgent(a) {
  if (!a) return null;
  if (PROVIDER_IDS.includes(a.provider)) return a.provider;
  return providerOfHarness(a.harness);
}

await loadProviders();
