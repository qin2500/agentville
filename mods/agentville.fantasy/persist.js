// agentville.fantasy persistence declaration (api.js PersistDecl; top-only, never inherited by a child mod).
// These are the keys fantasy used before MOD-4e, unchanged, so every saved layout carries over:
//   key/demoKey  the engine v2 layout, read first and the only key ever written;
//   also         its per-mod key (va.engine2.world.<id>), read if the key above holds no layout;
//   import       the classic app's layouts (va.world9, then va.world8; demo: `.demo`), read-only, tried last.
export const PERSIST = {
  key: 'va.engine2.world',
  demoKey: 'va.engine2.world.demo',
  also: ['va.engine2.world.agentville.fantasy'],
  import: ['va.world9', 'va.world8'],
};
