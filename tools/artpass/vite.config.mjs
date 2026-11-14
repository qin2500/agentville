// Dev server for the art-pass capture harness: its own port and cache dir, so it never disturbs a
// running app or another worktree's vite (node_modules is often a shared symlink).
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import modsIndex from '../vite-mods-index.mjs';

// GET /__fixtures/engine/<name>.json serves e2e/fixtures/engine/<name>.json (engine dev page: ?fixture=<name>).
const FIX_DIR = fileURLToPath(new URL('../../e2e/fixtures/engine/', import.meta.url));
const fixtures = {
  name: 'engine-fixtures',
  configureServer(server) {
    server.middlewares.use('/__fixtures/engine/', (req, res) => {
      const m = /^\/([a-z0-9-]+)\.json$/.exec((req.url || '').split('?')[0]);
      const file = m && path.join(FIX_DIR, `${m[1]}.json`);
      if (!file || !fs.existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(fs.readFileSync(file));
    });
  },
};

export default {
  plugins: [modsIndex(), fixtures],
  root: fileURLToPath(new URL('../../web/', import.meta.url)),
  cacheDir: path.join(os.tmpdir(), 'artpass-vite-cache'),
  server: { host: '127.0.0.1', port: Number(process.env.ARTPASS_PORT || 5391), strictPort: true },
};
