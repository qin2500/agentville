import { fileURLToPath } from 'node:url';

import modsIndex from '../tools/vite-mods-index.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));

export default {
  root,
  plugins: [modsIndex()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:5275' },
  },
};
