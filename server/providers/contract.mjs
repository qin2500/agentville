// Provider adapter contract (docs/providers-design.md section 1.2).
/** @typedef {'claude'|'gemini'|'codex'} ProviderId */
/** @typedef {{ kind:'start'|'stop'|'resume'|'fork', provider:ProviderId, args:string[], cwd:string,
 *   env?:Record<string,string>, name?:string, project?:string, id?:string, jobId?:string }} Plan */
/** @typedef {{ ok:boolean, ref?:{ jobId?:string, sessionId?:string, runId?:string }, error?:string }} RunResult */
/** @typedef {'busy'|'idle'|'limit'|'dialog'|'gone'} Activity */
/** @typedef {{ role:'user'|'assistant'|'tool', at:number, text?:string,
 *   tool?:{ name:string, files:string[], done:boolean }, todo?:{ text:string, done:boolean }[] }} TxEvent */
/** @typedef {{ fiveHour:{used:number,resetsAt:number|null,none?:boolean}|null,
 *   weekly:{used:number,resetsAt:number|null}|null, error?:string, stale?:boolean, asOf?:number }} Reading */

export const PROVIDER_IDS = ['claude', 'gemini', 'codex'];
// 'estimate': the Gemini adapter synthesizes readings from limit hits (errors-only mode, §1.4).
// Pure provider lookups live here (no imports) so modules on an adapter's import chain (classify.mjs,
// usage-pause.mjs) can use them without a cycle through index.mjs's top-level await. index.mjs re-exports them.
const HARNESS_TO_PROVIDER = { 'claude-code': 'claude', 'gemini-cli': 'gemini', codex: 'codex' };
/** 'claude-code' -> 'claude', etc. Null for harnesses with no provider (opencode, cursor, ...). */
export function providerOfHarness(h) { return HARNESS_TO_PROVIDER[h] || null; }
/** The provider id of an agent: its `provider` field, else derived from `harness`. Null if neither maps. */
export function providerOfAgent(a) {
  if (!a) return null;
  if (PROVIDER_IDS.includes(a.provider)) return a.provider;
  return providerOfHarness(a.harness);
}

export const USAGE_MODES = ['api', 'errors', 'estimate', 'none'];

const FUNCTIONS = ['home', 'available', 'bin', 'scan', 'configure', 'activity', 'options', 'startPlan',
  'resumePlan', 'stopPlan', 'display', 'run', 'isLimitText', 'limitModel', 'readTranscript'];
const CAPS = ['start', 'stop', 'resume', 'fork', 'message', 'accounts', 'handoffTarget'];
// capability -> functions that must exist when it is true
const NEEDS = { start: ['startPlan'], stop: ['stopPlan'], resume: ['resumePlan'], fork: ['forkPlan'] };
const ACCOUNT_OPS = ['load', 'list', 'usage', 'cachedUsage', 'activeUsage', 'capture', 'addStart', 'addFinish',
  'addCancel', 'rename', 'remove', 'readLive', 'identify', 'activate', 'restoreLive', 'checkActive', 'headroom'];
const SWITCH_OPS = ['profile', 'status', 'switchTo', 'undo', 'lastChangeAt', 'isBusy'];

const isFn = (x) => typeof x === 'function';
const isObj = (x) => x !== null && typeof x === 'object';

/** Throws an Error listing every problem, or returns the adapter. */
export function assertAdapter(a) {
  const bad = [];
  if (!isObj(a)) throw new Error('adapter: not an object');
  if (!PROVIDER_IDS.includes(a.id)) bad.push(`id must be one of ${PROVIDER_IDS.join('|')}`);
  if (typeof a.label !== 'string' || !a.label) bad.push('label must be a non-empty string');
  if (typeof a.harness !== 'string' || !a.harness) bad.push('harness must be a non-empty string');
  const c = a.capabilities;
  if (!isObj(c)) bad.push('capabilities missing');
  else {
    for (const k of CAPS) if (typeof c[k] !== 'boolean') bad.push(`capabilities.${k} must be boolean`);
    if (!USAGE_MODES.includes(c.usage)) bad.push(`capabilities.usage must be ${USAGE_MODES.join('|')}`);
    for (const [cap, fns] of Object.entries(NEEDS)) {
      if (c[cap] === true) for (const f of fns) if (!isFn(a[f])) bad.push(`capabilities.${cap} needs ${f}()`);
    }
  }
  for (const f of FUNCTIONS) if (!isFn(a[f])) bad.push(`${f} must be a function`);
  if (a.forkPlan !== undefined && !isFn(a.forkPlan)) bad.push('forkPlan must be a function');
  if (!Array.isArray(a.sessionEnv) || a.sessionEnv.some((s) => typeof s !== 'string')) {
    bad.push('sessionEnv must be string[]');
  }
  if (!isObj(a.tuning)) bad.push('tuning must be an object');
  const hasAccounts = !!(c && c.accounts === true);
  // A lazy getter (Claude binds its account module in configure()) is checked by presence only: invoking it
  // here would throw before configure() runs. A plain value is checked in full.
  const lazy = (k) => typeof Object.getOwnPropertyDescriptor(a, k)?.get === 'function';
  const opsOk = (k, ops, required) => {
    if (lazy(k)) return;
    const v = a[k];
    if (v == null) { if (required) bad.push(`${k} missing`); return; }
    if (!isObj(v)) { bad.push(`${k} must be an object`); return; }
    for (const f of ops) if (!isFn(v[f])) bad.push(`${k}.${f} must be a function`);
  };
  // Without accounts (capabilities.accounts=false) credentials, accounts and switcher may be null. With accounts,
  // `switcher: null` (explicitly) means a display-only account list with nothing to switch between (Gemini/agy).
  opsOk('credentials', ['read', 'write', 'identify'], hasAccounts);
  opsOk('accounts', ACCOUNT_OPS, hasAccounts);
  opsOk('switcher', SWITCH_OPS, hasAccounts && (lazy('switcher') || a.switcher !== null));
  if (bad.length) throw new Error(`adapter ${a && a.id}: ${bad.join('; ')}`);
  return a;
}
