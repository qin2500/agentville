// mods/index.js is generated and gitignored. Import this FIRST in a test that loads the mod registry, so a direct
// `node --test test/x.test.mjs` works in a fresh clone (npm's `pretest` is bypassed then).
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeModsIndex } from '../../tools/mods-index.mjs';

writeModsIndex(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
