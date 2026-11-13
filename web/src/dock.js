// The dock sheet: opens when the village's dock is clicked (the canvas fires `va:dock`). Shows the PRs
// loading now and the ones that sailed. Only names, repos, numbers and statuses; never conversation text.
// Data comes from S.dock (/api/agents `.dock`); `?dockdemo=1` fakes it when the server sends none.
import './dock.css';
import { esc } from './ui.js';

const DEMO = () => {
  const now = Date.now(), m = n => new Date(now - n * 60000).toISOString();
  return {
    loading: [
      { href: 'https://github.com/example/app/pull/42', id: 42, repo: 'example/app', agentId: 'demo-1', agentName: 'Mira', state: 'open', checks: { passed: 3, failed: 0, pending: 1 }, review: 'approved', since: m(25) },
      { href: 'https://github.com/example/api/pull/7', id: 7, repo: 'example/api', agentId: 'demo-2', agentName: 'Odo', state: 'open', checks: { passed: 1, failed: 2, pending: 0 }, review: null, since: m(190) },
    ],
    sailed: [{ href: 'https://github.com/example/app/pull/40', id: 40, repo: 'example/app', agentId: 'demo-1', agentName: 'Mira', at: m(12) }],
    total: 9, level: 2,
  };
};

const ago = t => {
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
};
const sameDay = t => new Date(t).toDateString() === new Date().toDateString();

export function createDock(app) {
  const { S } = app;
  const demo = new URLSearchParams(location.search).has('dockdemo');
  let demoData = null;
  const sheet = document.createElement('dialog');
  sheet.className = 'sheet docksheet';
  sheet.setAttribute('aria-labelledby', 'dk-title');
  document.body.appendChild(sheet);
  let opener = null;

  const data = () => S.dock || (demo ? (demoData ||= DEMO()) : null);

  function render() {
    const d = data() || { loading: [], sailed: [], total: 0, level: 1 };
    const loading = d.loading || [], sailed = d.sailed || [];
    const today = sailed.filter(x => sameDay(x.at)).length;
    const summary = `${loading.length} loading · ${today} delivered today · ${d.total ?? sailed.length} delivered in all · Dock level ${d.level ?? 1}`;
    const prBtn = x => `<button type="button" class="dkpr" data-href="${esc(x.href || '')}" title="Open on GitHub">${esc(x.repo)} #${esc(x.id)}</button>`;
    const agentBtn = x => x.agentName ? `<button type="button" class="dkagent" data-agent="${esc(x.agentId || '')}" title="Show this agent">${esc(x.agentName)}</button>` : '';
    const row = x => {
      const c = x.checks || {}, total = (c.passed || 0) + (c.failed || 0) + (c.pending || 0);
      return `<li class="dkrow">${prBtn(x)}${agentBtn(x)}
        ${x.review === 'approved' ? '<span class="pill">approved</span>' : ''}${c.failed ? '<span class="pill bad">checks failing</span>' : ''}
        <span class="when">${esc(ago(x.since))}</span>
        <div class="dkbar"><progress max="${total || 1}" value="${c.passed || 0}" aria-label="Checks passed"></progress><span>${c.passed || 0}/${total} checks</span></div></li>`;
    };
    sheet.innerHTML = `<header><div class="titlerow"><h2 id="dk-title" tabindex="-1">The dock</h2></div><p class="lede">${esc(summary)}</p></header>
      <div class="body">
        <section aria-labelledby="dk-lh"><h3 id="dk-lh">Loading now</h3>
          ${loading.length ? `<ul class="dklist">${loading.map(row).join('')}</ul>` : '<p class="dkempty">No ships loading. Open a PR and a porter starts carrying crates.</p>'}</section>
        <section aria-labelledby="dk-dh"><h3 id="dk-dh">Delivered</h3>
          ${sailed.length ? `<ul class="dklist">${sailed.map(x => `<li class="dkrow">${prBtn(x)}${agentBtn(x)}<span class="when">${esc(ago(x.at))}${ago(x.at) === 'just now' ? '' : ' ago'}</span></li>`).join('')}</ul>` : '<p class="dkempty">Nothing has sailed yet.</p>'}</section>
      </div>
      <footer><span class="spacer"></span><button class="ghost" type="button" data-dk="close">Close</button></footer>`;
  }

  function open() {
    if (sheet.open) return;
    opener = document.activeElement;
    app.closePops?.();
    render();
    sheet.showModal();
    sheet.querySelector('#dk-title')?.focus();
  }
  sheet.addEventListener('close', () => { if (opener?.isConnected && opener.offsetParent !== null) opener.focus({ preventScroll: true }); opener = null; });
  sheet.addEventListener('click', e => {
    if (e.target === sheet) return sheet.close(); // click on the backdrop
    if (e.target.closest('[data-dk="close"]')) return sheet.close();
    const pr = e.target.closest('[data-href]');
    if (pr?.dataset.href) return void window.open(pr.dataset.href, '_blank', 'noopener');
    const ag = e.target.closest('[data-agent]');
    if (ag) {
      const id = ag.dataset.agent;
      if (id && S.byId?.has(id)) { sheet.close(); app.select(id, { reveal: true }); }
    }
  });
  window.addEventListener('va:dock', open);

  return { open, update() { if (sheet.open) render(); } };
}
