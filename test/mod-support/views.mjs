// Shared in-memory helpers for the MOD0 tests: a canary-laden SnapshotView, a fake store. No real storage or sessions.
import { makeView } from '../../web/src/engine/snapshot.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CANARIES = ['CANARY-ASK', 'CANARY-REASON', 'CANARY-RESUME', 'CANARY-CWD', '/Users/canary-home', 'CANARY-HREF',
  'https://canary.example', 'CANARY-ACCOUNT', 'CANARY-MODEL', 'CANARY-SPEND', 'CANARY-TEXT', 'CANARY-TRANSCRIPT', 'CANARY-COLOR'];
export const RAW_IDS = ['sess-CANARY-boss', 'sess-CANARY-lead', 'sess-CANARY-sub', 'sess-CANARY-solo', 'sess-CANARY-wait', 'sess-CANARY-err', 'sess-CANARY-rest', 'sess-CANARY-orphan'];

const mk = (id, over = {}) => ({
  id, name: `Name ${id.slice(-4)}`, shortName: `Name ${id.slice(-4)}`, project: 'alpha', bucket: 'building', severity: null, prompt: null, role: 'solo', live: true,
  lastActivityAt: NOW - 60_000, since: NOW - 3_600_000, harness: 'claude', prs: [],
  ask: 'CANARY-ASK do the thing', reason: 'CANARY-REASON', resume: 'claude --resume CANARY-RESUME', cwd: '/Users/canary-home/CANARY-CWD',
  title: 'fix /Users/canary-home/CANARY-CWD/x.js', text: 'CANARY-TEXT CANARY-TRANSCRIPT', account: 'CANARY-ACCOUNT', model: 'CANARY-MODEL',
  spend: 'CANARY-SPEND', href: 'https://canary.example/CANARY-HREF', color: 'CANARY-COLOR', ...over,
});

/** @returns {{ view: object, ids: Record<string,string> }} */
export function canaryView({ now = NOW } = {}) {
  const agents = [
    mk('sess-CANARY-boss', { role: 'boss', bucket: 'waiting', prompt: 'permission', prs: [{ id: '7', href: 'https://canary.example/pr/7', url: 'https://canary.example/CANARY-HREF' }] }),
    mk('sess-CANARY-lead', { role: 'lead', parentId: 'sess-CANARY-boss' }),
    mk('sess-CANARY-sub', { role: 'sub', parentId: 'sess-CANARY-lead' }),
    mk('sess-CANARY-solo', { role: 'solo' }),
    mk('sess-CANARY-wait', { bucket: 'waiting', prompt: 'question' }),
    mk('sess-CANARY-err', { bucket: 'stalled', severity: 'error' }),
    mk('sess-CANARY-stall', { bucket: 'stalled', severity: null }),
    mk('sess-CANARY-rest', { bucket: 'resting', live: false }),
    mk('sess-CANARY-orphan', { role: 'sub', parentId: 'sess-CANARY-gone-from-server' }),
  ];
  const projects = [{ name: 'alpha', prs: [{ id: '7', live: true, href: 'https://canary.example/CANARY-HREF', title: 'Add widget' }, { id: '8', live: false }], transcriptBytes: 3e6, agentsEver: 9 }];
  const dock = { loading: [{ id: 'sess-CANARY-boss', href: 'https://canary.example/CANARY-HREF', url: 'https://canary.example', title: 'CANARY-TEXT' }],
    sailed: [{ id: 'x', href: 'https://canary.example/CANARY-HREF' }], total: 3, level: 1 };
  const view = makeView({ agents, projects, dock }, { now, demo: true });
  const ids = Object.fromEntries(agents.map(a => [a.id.replace('sess-CANARY-', ''), a.id]));
  return { view, ids };
}

export const fakeStore = (init = {}) => {
  const m = new Map(Object.entries(init)), reads = [], writes = [];
  return { m, reads, writes,
    get(k, d) { reads.push(k); return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : d; },
    set(k, v) { writes.push(k); m.set(k, JSON.parse(JSON.stringify(v))); } };
};

export function listFiles(dir, ext = ['.js', '.mjs']) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (ext.some(x => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
