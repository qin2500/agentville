# Agentville CLI for agents

Paste this into your CLAUDE.md or GEMINI.md so agents know the command exists.

```
## Agentville
Agentville runs your session. The `agentville` command (tools/agentville in the Agentville repo) talks to it:

- `agentville start [--provider gemini|claude] [--cwd DIR] [--name N] [--model M] [--mode P] "prompt"`
  starts another agent and prints its id. It needs `agentStarts.enabled` in Agentville settings.
  `--cwd` must be your own directory, inside it, or a known project.
- `agentville status <agent-id>` prints `{ id, provider, bucket, live, handoff }` as JSON.
- `agentville notify "message" [--title T]` pushes a notice onto your own agent in the village.

The session comes from `--session`, else `CLAUDE_CODE_SESSION_ID`, else `AGENTVILLE_AGENT_ID`.
The port comes from `--port`, else `AGENTVILLE_PORT`, else 5275.
Exit codes: 0 ok, 1 server or network error (message on stderr), 2 bad usage.
```
