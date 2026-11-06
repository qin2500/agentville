import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default {
  root,
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:5275' },
  },
};
