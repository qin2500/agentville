// The public mod API: the ONE engine file a mod may import (as `#agentville/mod`, package.json "imports", or by its
// relative path). A barrel of `export … from` lines only; each line's area file has its own owner. Anything not
// re-exported here is engine-internal. A mod never imports another mod: it uses `extends` and `ctx.parent`.
export { API_VERSION, MOD_CODE_MAX, FEATURES, MOD1_HOOKS } from './api.js';
export { hash } from '../core/rng.js';
export { ROAD, LAYOUT_GROUND, LOT } from '../core/grid.js';
export { createRaster, routeOnRaster, noise, flood4, distance4, rectsBounds, near, inRect } from './kit/layout.js';
export { checkClasses, classByName } from './kit/terrain.js';
