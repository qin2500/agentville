import './support/ensure-mods-index.mjs';
// Every live ship was a dinghy (2026-11-16): the server's PR poll asked GitHub about all 60 PRs in one GraphQL query, which
// GitHub answers with HTTP 504, so no dock entry ever carried a `size`; WorldInput fills a missing size with zeros and the
// fantasy mod drew zeros as the smallest ship. Classic (web/src/dock-art.js shipClass) draws a PR with no size as a sloop,
// the middle class. Fixed on both sides: the poll asks in batches, and the mod reads an all-zero size as unknown (a cutter).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrPoll, parsePrUrl, BATCH, MAX_TARGETS } from '../server/prpoll.mjs';
import { createPrStatus } from '../server/prstatus.mjs';
import { createDock } from '../server/dock.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.location ??= { search: '', href: 'http://x/' };
globalThis.window ??= globalThis;
const classic = await import('../web/src/dock-art.js').catch(() => null);
const { shipClass, representPr } = await import('../mods/agentville.fantasy/represent-pr.js');
const { dockPrs } = await import('../web/src/engine-host/dock-input.js');

const url = n => `https://github.com/acme/app/pull/${n}`;
const node = (n, size) => ({ state: 'OPEN', isDraft: false, reviewDecision: null, commits: { nodes: [] }, ...(size ? { additions: size[0], deletions: size[1], changedFiles: size[2] } : {}) });
/** A fake `gh api graphql` that answers like GitHub: HTTP 504 for a query over `limit` PRs. */
function fakeGitHub(limit = 20, sizes = n => [n, n, 1]) {
  const asked = [];
  const run = async q => {
    const ids = [...q.matchAll(/pullRequest\(number:(\d+)\)/g)].map(m => +m[1]);
    asked.push(ids.length);
    if (ids.length > limit) throw new Error('gh: HTTP 504');
    return { data: Object.fromEntries(ids.map((n, i) => [`p${i}`, { pullRequest: node(n, sizes(n)) }])) };
  };
  return { run, asked };
}

test('the PR poll asks GitHub in batches, so a full target list (60 PRs) still gets its sizes', async () => {
  const hrefs = Array.from({ length: MAX_TARGETS }, (_, i) => url(i + 1));
  const gh = fakeGitHub(20);
  const poll = createPrPoll({ targets: () => hrefs, run: gh.run, intervalMs: 1000, log: () => {} });
  assert.equal(await poll.poll(), MAX_TARGETS, 'every PR refreshed');
  assert.ok(BATCH <= 20 && gh.asked.every(n => n <= BATCH), `batches of at most ${BATCH}: ${gh.asked}`);
  assert.deepEqual(poll.get(url(7)).size, { additions: 7, deletions: 7, files: 1 });
  assert.equal(poll.delay(), 1000, 'no back-off');
});

test('one failing batch loses only its own PRs; all failing backs off', async () => {
  const hrefs = Array.from({ length: 2 * BATCH }, (_, i) => url(i + 1));
  let calls = 0;
  const run = async q => { if (calls++ === 0) throw new Error('boom'); return fakeGitHub(99).run(q); };
  const logs = [];
  const poll = createPrPoll({ targets: () => hrefs, run, intervalMs: 1000, log: m => logs.push(m) });
  assert.equal(await poll.poll(), BATCH);
  assert.equal(poll.get(url(1)), undefined); assert.ok(poll.get(url(BATCH + 1)));
  assert.equal(poll.delay(), 1000);
  const dead = createPrPoll({ targets: () => hrefs, run: async () => { throw new Error('x'); }, intervalMs: 1000, log: () => {} });
  assert.equal(await dead.poll(), -1); assert.equal(dead.delay(), 2000);
});

test('end to end: polled sizes reach the dock entries and pick the ship class', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipsize-'));
  const sizes = { 1: [10, 5, 1], 2: [200, 100, 4], 3: [900, 0, 3], 4: [1, 1, 30] };
  const gh = fakeGitHub(20, n => sizes[n]);
  const hrefs = Array.from({ length: MAX_TARGETS }, (_, i) => url(i + 1));
  const poll = createPrPoll({ targets: () => hrefs, run: gh.run, intervalMs: 1000, log: () => {} });
  await poll.poll();
  const agents = [{ id: 'a1', name: 'A', prs: [1, 2, 3, 4, 5].map(n => ({ id: String(n), href: url(n) })) }];
  await createPrStatus(() => dir, poll).annotate(agents);
  const dock = await createDock({ dataDir: dir, now: () => 1000 }).update(agents);
  const byId = Object.fromEntries(dock.loading.map(e => [e.id, e]));
  assert.deepEqual(byId['3'].size, { additions: 900, deletions: 0, files: 3 });
  assert.equal(byId['5'].size, undefined, 'GitHub sent no size for #5');
  const view = { dock, byId: new Map([['a1', { id: 'a1', project: 'app' }]]) };
  const prs = dockPrs(view, [], { loading: true }).prs;
  const model = n => representPr(prs.find(p => p.number === n)).model;
  assert.deepEqual([1, 2, 3, 4, 5].map(model), ['dinghy', 'cutter', 'brig', 'brig', 'cutter']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ship class matches classic dock-art: a PR with no size is the middle class, not the smallest', { skip: !classic && 'classic dock-art.js not importable' }, () => {
  const CLASSIC = { dinghy: 'dinghy', sloop: 'cutter', cargo: 'brig' };
  assert.equal(CLASSIC[classic.shipClass(undefined)], 'cutter');
  assert.equal(shipClass({ additions: 0, deletions: 0, files: 0 }), 'cutter', 'WorldInput zero-fills a missing size');
  assert.equal(shipClass(undefined), 'cutter');
  for (const [a, d, f] of [[10, 39, 1], [25, 25, 1], [300, 200, 20], [300, 201, 1], [1, 1, 21], [0, 1, 1], [3, 0, 1]])
    assert.equal(shipClass({ additions: a, deletions: d, files: f }), CLASSIC[classic.shipClass({ additions: a, deletions: d, files: f })], `${a}+${d} lines, ${f} files`);
  assert.equal(parsePrUrl(url(3)).number, 3);
});
