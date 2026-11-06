/**
 * Fleet actions. The server composes per-agent messages and, on the user's explicit, previewed
 * confirm, delivers them to live Claude sessions' inboxes (inbox.mjs). It never runs a command.
 * Its one write is `fleet.json` in our own data dir, recording what was sent.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { REASONS } from './classify.mjs'

export const ACTIONS = ['offline', 'reboot', 'resume', 'continue']
export const PREP_MS = 24 * 60 * 60 * 1000 // a pause lasts at most this long
export const PENDING_MS = 48 * 60 * 60 * 1000 // a prep stays "pending resume" this long
export const PAUSED = { offline: 'Paused for internet loss', reboot: 'Paused for reboot prep' }
/** Marks a prep message in a transcript, so a later prompt can be told apart from it. */
export const PREP_MARKER = /\[(?:Agentville|Village AI) · prep for / // the old name too, for preps sent before the rename

const STEPS_1_2 = `1. Finish or drop the step you are on. Don't start anything that needs the network (push, installs, web fetches, API calls, PR or CI work).
2. Commit your work in progress locally on your current branch with a message starting "WIP:". Do not push.`

export const TEMPLATES = {
  offline: `[Agentville · prep for internet loss]
Your user is about to lose internet access for a while. Get to a safe stopping point now:
${STEPS_1_2}
3. Write a resume note to {notePath} (don't commit it): what you were doing, branch and last commit, what is done, the exact next step, and anything waiting on the network.
4. Reply with one line, "Paused: <what you were doing>", then stop. Don't retry or poll while offline.`,
  reboot: `[Agentville · prep for laptop reboot]
Your user is about to restart the laptop. This session may end. Get to a safe stopping point now:
${STEPS_1_2}
3. Stop the background processes you started (dev servers, watchers, containers, tail -f). For each, record the exact command and directory needed to restart it.
4. Write a resume note to {notePath} (don't commit it): what you were doing, branch and last commit, what is done, the exact next step, and the restart commands from step 3.
5. Reply with one line, "Paused for reboot: <what you were doing>", then stop.`,
  resume: `[Agentville · resume]
Your user is back{after a reboot}. Read your resume note at {notePath}. If it's missing, use git log -1 and your recent history. Check that the branch and working tree match the note, restart any background processes it lists, then continue from the next step.
Reply with one line: "Resumed: <next step>".`,
  continue: 'continue',
}

export const RELAY = {
  boss: 'You run other agents. Forward this exact message to every lead under you with your cross-session messaging, and ask each lead to pass it on to its own subagents and teammates that are still working. Wait for each lead to confirm, and include their one-line status in your note.',
  lead: 'You lead other agents. Pass this message on to each of your subagents and teammates that is still working, wait for each to confirm, and include their one-line status in your note.',
}

const fill = (text, vars) => text.replace(/\{(name|notePath|project|after a reboot)\}/g, (_, k) => vars[k] ?? '')
const safe = (id) => id.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 120)
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * Inside the agent's own workspace, so a sandboxed or default-mode agent can write it without an
 * approval prompt: `<cwd>/.git/` when that is a real git dir (untracked by construction), else the
 * workspace root (a worktree's `.git` is a file). No cwd: our data dir.
 */
export function notePathFor(a, dataDir) {
  if (!a.cwd) return path.join(dataDir, 'notes', `${safe(a.id)}.md`)
  const git = fs.statSync(path.join(a.cwd, '.git'), { throwIfNoEntry: false })
  return git?.isDirectory() ? path.join(a.cwd, '.git', 'agentville-note.md') : path.join(a.cwd, '.agentville-note.md')
}

/**
 * Who gets a copy, what it says and how to reach them. `agents` are `build()` output.
 * Bosses get one message with the relay paragraph; leads under a boss and every sub are reached by
 * relay; other non-resting top-level agents get their own copy.
 */
export function preview({ action, agents, store, dataDir, text, problemOf = () => '', now = Date.now() }) {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const pending = currentPending(store, now)
  const visible = agents.filter((a) => !a.hidden)
  // "continue": exactly that word, to every agent showing an error. No relay paragraph.
  if (action === 'continue') return continuePlan(visible, problemOf)
  const inPlay = (a) => a.bucket !== 'resting' || (action === 'resume' && pending?.ids.includes(a.id))
  const top = visible.filter((a) => inPlay(a) && !(a.parentId && byId.get(a.parentId) && inPlay(byId.get(a.parentId))))
  const template = typeof text === 'string' && text.trim() ? text : TEMPLATES[action]
  const after = action !== 'resume' ? '' : pending?.kind === 'reboot' ? ' after a reboot' : pending?.kind === 'offline' ? ' online' : ''

  const targets = top.map((a) => {
    const relay = a.childIds.length ? (a.role === 'boss' ? RELAY.boss : RELAY.lead) : ''
    const body = fill(template, { name: a.name, project: a.project, notePath: notePathFor(a, dataDir), 'after a reboot': after })
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      harness: a.harness,
      project: a.project,
      live: a.live,
      channel: 'inbox',
      problem: sendProblem(a, problemOf),
      reach: reachOf(a),
      text: relay ? `${body}\n\n${relay}` : body,
      relayTo: descendants(a.id, byId).filter((d) => inPlay(byId.get(d))),
    }
  })
  const covered = new Set(targets.flatMap((t) => [t.id, ...t.relayTo]))
  const relayed = targets.flatMap((t) => t.relayTo.map((id) => ({ id, name: byId.get(id).name, viaId: byId.get(id).parentId, rootId: t.id })))
  const commands = action === 'offline' ? [] : resumeCommands(targets.map((t) => byId.get(t.id)))
  return {
    mode: 'send',
    action,
    template,
    addendum: RELAY,
    targets,
    relayed,
    excluded: {
      resting: visible.filter((a) => !covered.has(a.id) && a.bucket === 'resting').length,
      hidden: agents.length - visible.length,
    },
    commands,
  }
}

/** Why this agent can't be messaged ('' when it can). Fixed strings only. */
function sendProblem(a, problemOf) {
  if (a.harness !== 'claude-code') return "Can't be messaged: Codex"
  if (!a.live) return 'Not running'
  return problemOf(a.id)
}

/** Who "continue" is for: an error, or a job restarted mid-task that is waiting for a prompt. */
export const continuable = (a) => a.severity === 'error' || [REASONS.restarted, REASONS.slept, REASONS.offline].includes(a.reason)

function continuePlan(visible, problemOf) {
  const targets = visible.filter(continuable).map((a) => ({
    id: a.id, name: a.name, role: a.role, harness: a.harness, project: a.project, live: a.live, channel: 'inbox',
    problem: ['subagent', 'teammate'].includes(a.kind) ? 'Subagent: its lead handles it' : sendProblem(a, problemOf),
    reason: a.reason, reach: reachOf(a), text: TEMPLATES.continue, relayTo: [],
  }))
  return { mode: 'send', action: 'continue', template: TEMPLATES.continue, addendum: null, targets, relayed: [], excluded: { resting: 0, hidden: 0 }, commands: [] }
}

/** Shown as text only; the server never runs any of it. */
function reachOf(a) {
  if (a.harness === 'codex') return { how: 'Open the thread in Codex', command: a.resume }
  if (a.jobId) return { how: 'Attach to the background job', command: `claude attach ${a.jobId}` }
  return { how: a.live ? 'Switch to its terminal' : 'Resume it in a terminal', command: a.cwd ? `cd ${quote(a.cwd)} && ${a.resume}` : a.resume }
}

function resumeCommands(targets) {
  const jobs = targets.filter((a) => a.harness === 'claude-code' && a.jobId)
  const sessions = targets.filter((a) => a.harness === 'claude-code' && !a.jobId && a.resume)
  return [
    ...(jobs.length ? [{ id: null, name: 'All background jobs', command: 'claude respawn --all' }] : []),
    ...jobs.map((a) => ({ id: a.id, name: a.name, command: `claude respawn ${a.jobId}` })),
    ...sessions.map((a) => ({ id: a.id, name: a.name, command: a.cwd ? `cd ${quote(a.cwd)} && ${a.resume}` : a.resume })),
  ]
}

function descendants(id, byId, seen = new Set([id])) {
  const out = []
  for (const c of byId.get(id)?.childIds || []) {
    if (seen.has(c)) continue
    seen.add(c)
    out.push(c, ...descendants(c, byId, seen))
  }
  return out
}

export function currentPending(store, now = Date.now()) {
  const p = store?.pending
  return p && now - p.at < PENDING_MS ? p : null
}

/** `fleet.json`: `{ last, pending }`. Written only here, atomically, one write at a time. */
export function createFleetStore(dir) {
  const file = path.join(dir, 'fleet.json')
  let data = null
  let queue = Promise.resolve()
  const marks = []

  async function load() {
    if (data) return data
    try {
      const d = JSON.parse(await fsp.readFile(file, 'utf8'))
      data = { last: d?.last || null, pending: d?.pending || null }
    } catch { data = { last: null, pending: null } }
    return data
  }

  function mark(body, now = Date.now()) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 })
    if (!body || typeof body !== 'object') throw bad('Body must be a JSON object')
    if (!ACTIONS.includes(body.action)) throw bad('Unknown action')
    if (!Array.isArray(body.ids) || body.ids.length > 1000 || !body.ids.every((i) => typeof i === 'string' && i && i.length <= 300)) throw bad('ids must be a list of agent ids')
    // ponytail: one global window, fine for a single local user.
    while (marks.length && now - marks[0] > 60_000) marks.shift()
    if (marks.length >= 10) throw Object.assign(new Error('Too many marks; wait a minute'), { status: 429 })
    marks.push(now)
    const record = { kind: body.action, at: now, ids: [...new Set(body.ids)] }
    const run = queue.then(async () => {
      await load()
      // A second prep of the same kind adds to the batch (keeping the first time, so the first
      // batch stays paused); a different kind replaces it; resume clears it.
      const prev = data.pending
      const pending = record.kind === 'resume' ? null
        : prev?.kind === record.kind && now - prev.at < PENDING_MS ? { ...prev, ids: [...new Set([...prev.ids, ...record.ids])] }
        : record
      const next = { last: record, pending }
      await fsp.mkdir(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
      await fsp.rename(tmp, file)
      data = next
      return record
    })
    queue = run.catch(() => {})
    return run
  }

  return { load, mark }
}
