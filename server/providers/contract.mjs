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
export const USAGE_MODES = ['api', 'errors', 'none'];

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
  if (!isObj(a.credentials)) bad.push('credentials missing');
  else for (const f of ['read', 'write', 'identify']) if (!isFn(a.credentials[f])) bad.push(`credentials.${f} must be a function`);
  if (c && c.accounts === true) {
    if (!isObj(a.accounts)) bad.push('accounts missing');
    else for (const f of ACCOUNT_OPS) if (!isFn(a.accounts[f])) bad.push(`accounts.${f} must be a function`);
  }
  if (!isObj(a.switcher)) { if (c && c.accounts === true) bad.push('switcher missing'); }
  else for (const f of SWITCH_OPS) if (!isFn(a.switcher[f])) bad.push(`switcher.${f} must be a function`);
  if (bad.length) throw new Error(`adapter ${a && a.id}: ${bad.join('; ')}`);
  return a;
}
