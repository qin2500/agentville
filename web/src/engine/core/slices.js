// Run a generator of work steps either at once or in slices (PERF M7). No DOM needed.
// A step generator does its work between `yield`s; the driver decides whether to keep going or hand the main thread back.
// drainSync runs it all now (the same result, the same order of work); drainSliced gives the event loop a turn whenever
// the current slice has run budgetMs or more, so input and frames are not held up behind one long task. Work inside one
// step is never split: a step longer than the budget is one task.
//
//   drainSync(gen) -> return value
//   drainSliced(gen, { budgetMs?, yieldTo?, now? }) -> Promise<return value>   (rejects with what the generator threw)

export function drainSync(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

/** Hand the main thread back for one turn: scheduler.yield where there is one, else a message-channel macrotask, else
 * setTimeout 0. */
export function yieldTurn() {
  const s = globalThis.scheduler;
  if (s && typeof s.yield === 'function') return s.yield();
  if (typeof MessageChannel === 'function') {
    return new Promise(res => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); res(); }; ch.port2.postMessage(0); });
  }
  return new Promise(res => setTimeout(res, 0));
}

export async function drainSliced(gen, { budgetMs = 40, yieldTo = yieldTurn, now = () => performance.now() } = {}) {
  let t = now(), r = gen.next();
  while (!r.done) {
    if (now() - t >= budgetMs) { await yieldTo(); t = now(); }
    r = gen.next();
  }
  return r.value;
}
