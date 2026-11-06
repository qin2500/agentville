#!/bin/bash
# Run by the Agentville.app launcher: start the local server if it isn't up, then open the page.
# build.sh writes the repo path to repo-path next to this script (a plain file, so any character
# in the path is safe). Run from the repo itself, it falls back to the checkout it lives in.
# `--check` starts the server without opening a browser.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/repo-path" ]; then REPO="$(/bin/cat "$HERE/repo-path")"; else REPO="$(cd "$HERE/../.." && pwd)"; fi
PORT="${AGENTVILLE_PORT:-5275}"
URL="http://127.0.0.1:$PORT/"
# Apps launched from Finder get a minimal PATH; add the usual Node install locations, including
# version managers (volta, fnm's default alias, and nvm's newest installed version).
NVM_BIN="$(/bin/ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | /usr/bin/sort -V | /usr/bin/tail -n 1 || true)"
export PATH="$HOME/.local/bin:$HOME/.volta/bin:$HOME/.fnm/aliases/default/bin${NVM_BIN:+:$NVM_BIN}:/opt/homebrew/bin:/usr/local/bin:$PATH"
LOGDIR="${AGENTVILLE_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/agentville}"
LOG="$LOGDIR/launcher.log"

fail() { echo "$1" >&2; [ -f "$LOG" ] && echo "Details: $LOG" >&2; exit 1; }
ready() { /usr/bin/curl --silent --fail --max-time 1 "$URL" | grep -q '<title>Agentville</title>'; }

[ -f "$REPO/server/cli.mjs" ] || fail "Agentville isn't at $REPO any more. Rebuild the launcher from the new location."
# Else the Node build.sh found (recorded next to this script).
if ! command -v node >/dev/null && [ -f "$HERE/node-path" ] && [ -x "$(/bin/cat "$HERE/node-path")" ]; then
  export PATH="$(dirname "$(/bin/cat "$HERE/node-path")"):$PATH"
fi
command -v node >/dev/null || fail 'Node.js was not found. Install Node 22.13 or newer (https://nodejs.org, or: brew install node).'
[ -d "$REPO/node_modules" ] || fail "Dependencies are missing. Run: cd \"$REPO\" && ./setup.sh"
# Move the data folder from before the rename (village-ai) first, so the log below doesn't start a new one.
(cd "$REPO" && node server/datadir.mjs) || true
mkdir -p "$LOGDIR"

if ! ready; then
  # Only one simultaneous double-click starts a server; a second one just waits for it.
  # A lock left behind by a crashed launch is ignored after 90 s.
  LOCK="$LOGDIR/launch.lock"
  if [ -d "$LOCK" ] && [ $(( $(/bin/date +%s) - $(/usr/bin/stat -f %m "$LOCK") )) -gt 90 ]; then rmdir "$LOCK" 2>/dev/null || true; fi
  if mkdir "$LOCK" 2>/dev/null; then
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
    if ! ready; then
      if /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
        fail "Port $PORT is in use by another app."
      fi
      (cd "$REPO" && /usr/bin/nohup node server/cli.mjs >"$LOG" 2>&1 </dev/null &)
    fi
  fi
  # The first run builds the web app, so allow up to a minute.
  for ((i = 0; i < 120; i++)); do ready && break; /bin/sleep 0.5; done
  ready || fail 'The local server did not start in time.'
fi

echo "Agentville is ready: $URL"
[ "${1:-}" = '--check' ] || /usr/bin/open "$URL" || fail 'macOS could not open your default browser.'
