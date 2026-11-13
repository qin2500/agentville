/**
 * Start, stop and fork Claude Code background agents, on the user's explicit, previewed confirm.
 *
 * The server builds every argv itself from allowlisted values; the page never supplies a command,
 * a flag or an executable. Each preview returns the exact command; a one-time confirm token (2 min)
 * runs exactly that argv, in exactly that folder, once. The prompt is passed as one argv element
 * after `--` (no shell, so nothing in it is ever interpreted). Nothing runs under test unless a
 * fake Claude home and a fake `claude` are both named (AGENTVILLE_CLAUDE_HOME + AGENTVILLE_CLAUDE_BIN).
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findExecutable, shQuote } from './terminal.mjs'

const HOME = os.homedir()
const CLAUDE_DIRS = [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), path.join(HOME, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
const RUN_MS = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUB_KINDS = ['subagent', 'teammate', 'thread']

/** Allowlists. '' means "leave it to Claude Code's default" (the flag is left out). */
export const MODELS = ['', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable']
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']
// bypassPermissions is deliberately not offered for new launches from the web form. A running
// background job can be switched to it explicitly, one at a time: POST /api/agents/<id>/bypass (permmode.mjs).
export const MODES = ['', 'acceptEdits', 'auto', 'plan', 'manual', 'dontAsk']
export const PROMPT_MAX = 8000
export const NAME_MAX = 80

const testing = () => process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test'
const bad = (message, status = 400) => Object.assign(new Error(message), { status })

/** Why starting/stopping/forking can't run here ('' = it can). */
export function actionsBlocked() {
  if (process.platform === 'win32') return 'Starting and stopping agents is not supported on Windows'
  if (testing() && !(process.env.AGENTVILLE_CLAUDE_HOME && process.env.AGENTVILLE_CLAUDE_BIN)) return 'Starting and stopping agents is disabled in tests'
  return ''
}

/** The real `claude` executable (never a shell function or alias), or the test fake. */
export const claudeBin = async () => process.env.AGENTVILLE_CLAUDE_BIN || findExecutable('claude', CLAUDE_DIRS)

/** The folder agents of this project run in: a worktree's main checkout, if it's one. */
export function projectRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  const m = /[\\/]\.claude[\\/]worktrees[\\/]/.exec(cwd)
  return m ? cwd.slice(0, m.index) : cwd
}

/** Known project folders, from the agents we see: existing directories, most recently used first. */
export function knownProjects(agents) {
  const by = new Map()
  for (const a of agents) {
    const dir = projectRoot(a.cwd)
    if (!dir) continue
    const prev = by.get(dir)
    if (!prev || (a.lastActivityAt || 0) > prev.at) by.set(dir, { dir, name: path.basename(dir) || dir, at: a.lastActivityAt || 0 })
  }
  return [...by.values()].filter((p) => fs.statSync(p.dir, { throwIfNoEntry: false })?.isDirectory()).sort((a, b) => b.at - a.at).slice(0, 60)
}

const text = (v, max, what) => {
  if (v == null || v === '') return ''
  if (typeof v !== 'string') throw bad(`${what} must be text`)
  if (v.length > max) throw bad(`${what} can be at most ${max} characters`)
  if (/\0/.test(v)) throw bad(`${what} can't contain a NUL character`)
  return v
}
/** A display name: one line, no control characters. */
export function cleanName(v) {
  const s = text(v, NAME_MAX, 'The name').trim()
  if (/[\u0000-\u001f\u007f]/.test(s)) throw bad('The name must be one line of text')
  return s
}
const pick = (v, list, what) => {
  const s = v == null ? '' : v
  if (!list.includes(s)) throw bad(`Unknown ${what}`)
  return s
}

/** `claude --bg …` for a new agent. `body` comes from the page; every field is checked. */
export function startPlan(body, projects) {
  if (!body || typeof body !== 'object') throw bad('Body must be a JSON object')
  const project = projects.find((p) => p.dir === body.cwd)
  if (!project) throw bad('Pick one of the listed projects')
  const prompt = text(body.prompt, PROMPT_MAX, 'The prompt')
  if (!prompt.trim()) throw bad('Write a prompt for the new agent')
  const name = cleanName(body.name)
  const model = pick(body.model, MODELS, 'model')
  const effort = pick(body.effort, EFFORTS, 'effort')
  const mode = pick(body.permissionMode, MODES, 'permission mode')
  if (body.worktree != null && typeof body.worktree !== 'boolean') throw bad('worktree must be true or false')
  const args = ['--bg']
  // `--flag=value`, so a value can never be read as another option.
  if (name) args.push(`--name=${name}`)
  if (model) args.push(`--model=${model}`)
  if (effort) args.push(`--effort=${effort}`)
  if (mode) args.push(`--permission-mode=${mode}`)
  if (body.worktree) args.push('--worktree')
  args.push('--', prompt)
  return { kind: 'start', args, cwd: project.dir, name, project: project.name }
}

/** `claude stop <job>`: background jobs only. */
export function stopPlan(a) {
  if (!a) throw bad('No such agent', 404)
  if (a.harness !== 'claude-code') throw bad("Codex threads can't be stopped from here. Stop it in Codex.", 409)
  if (SUB_KINDS.includes(a.kind)) throw bad('A subagent stops with its lead. Stop the lead instead.', 409)
  if (a.kind !== 'job') throw bad("This is an interactive session, not a background job. Stop it in its own terminal (Esc to interrupt, /exit to quit).", 409)
  if (a.reopened && a.live) throw bad('This job is open in a terminal. Stop it there (Esc to interrupt, /exit to quit).', 409)
  if (!/^[0-9a-f]{8}$/.test(a.jobId || '')) throw bad("This job has no id to stop", 409)
  if (a.bucket === 'resting' && !a.live) throw bad("This job isn't running", 409)
  return { kind: 'stop', args: ['stop', a.jobId], cwd: HOME, id: a.id, name: a.name, jobId: a.jobId }
}

/** `claude --resume <session> --fork-session --bg`: a copy of the conversation as a new background job. */
export function forkPlan(a, fork, rawName) {
  if (!a) throw bad('No such agent', 404)
  if (a.harness !== 'claude-code') throw bad('Fork works for Claude Code sessions only', 409)
  if (SUB_KINDS.includes(a.kind)) throw bad("A subagent's conversation can't be forked. Fork its lead instead.", 409)
  if (a.neverStarted) throw bad("This launch failed before it started, so there's nothing to fork", 409)
  if (!fork || !UUID.test(fork.sid || '')) throw bad('This agent has no saved conversation to fork', 409)
  const cwd = fork.cwd && path.isAbsolute(fork.cwd) && fs.statSync(fork.cwd, { throwIfNoEntry: false })?.isDirectory() ? fork.cwd : null
  if (!cwd) throw bad('Its folder no longer exists', 409)
  const name = cleanName(rawName)
  const args = ['--resume', fork.sid, '--fork-session', '--bg']
  if (name) args.push(`--name=${name}`)
  return { kind: 'fork', args, cwd, id: a.id, name: name || `${a.name} (fork)` }
}

/** What the confirm step shows: the command exactly as it will run (with `claude` for the binary). */
export const display = (plan) => ['claude', ...plan.args].map((x) => (/^[\w@%+=:,./[\]-]+$/.test(x) ? x : shQuote(x))).join(' ')

/** Runs a confirmed plan once. Resolves `{ ok, jobId?, error? }`; output is never returned as is. */
export async function run(plan) {
  const bin = await claudeBin()
  if (!bin) return { ok: false, error: 'Claude Code CLI not found' }
  return new Promise((resolve) => {
    execFile(bin, plan.args, { cwd: plan.cwd, timeout: RUN_MS, maxBuffer: 256 * 1024, env: process.env, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`
      const jobId = /(?:backgrounded ·|claude (?:attach|logs|stop))\s+([0-9a-f]{8})\b/.exec(out)?.[1] || (plan.kind === 'stop' ? plan.jobId : null)
      if (err) return resolve({ ok: false, error: err.killed ? 'Claude Code took too long to answer' : `Claude Code exited with code ${typeof err.code === 'number' ? err.code : 1}` })
      resolve({ ok: true, jobId })
    })
  })
}
