// Vite plugin: (re)generates the gitignored mods/index.js before a build and when the dev server starts.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeModsIndex } from './mods-index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default function modsIndex() {
  return {
    name: 'mods-index',
    buildStart() { writeModsIndex(ROOT); },
    configureServer() { writeModsIndex(ROOT); },
  };
}
