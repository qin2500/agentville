// Dev server for the art-pass capture harness: its own port and cache dir, so it never disturbs a
// running app or another worktree's vite (node_modules is often a shared symlink).
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export default {
  root: fileURLToPath(new URL('../../web/', import.meta.url)),
  cacheDir: path.join(os.tmpdir(), 'artpass-vite-cache'),
  server: { host: '127.0.0.1', port: Number(process.env.ARTPASS_PORT || 5391), strictPort: true },
};
