#!/usr/bin/env bash
# One-command setup for Agentville. Safe to run again at any time.
#
#   ./setup.sh                    check Node, install dependencies, build the web app, and on macOS
#                                 offer a double-click launcher on your Desktop
#   ./setup.sh --no-launcher      skip the launcher
#   ./setup.sh --launcher         make the launcher without asking
#   ./setup.sh --launcher-dir D   put the launcher in folder D instead of ~/Desktop
#
# Then: npm start   (serves http://127.0.0.1:5275/; AGENTVILLE_PORT picks another port)
set -euo pipefail
cd "$(dirname "$0")"

LAUNCHER=ask
LAUNCHER_DIR="$HOME/Desktop"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-launcher) LAUNCHER=no ;;
    --launcher) LAUNCHER=yes ;;
    --launcher-dir) shift; LAUNCHER_DIR="${1:?--launcher-dir needs a folder}"; [ "$LAUNCHER" = ask ] && LAUNCHER=yes ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

# 1. Node 22.13 or newer.
say "Checking Node.js…"
INSTALL_HELP="Install Node 22.13 or newer, then run ./setup.sh again:
  - macOS with Homebrew:  brew install node
  - with nvm:             nvm install 22 && nvm use 22
  - or download it from   https://nodejs.org"
command -v node >/dev/null 2>&1 || die "Node.js isn't installed (or isn't on your PATH).
$INSTALL_HELP"
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
  || die "Agentville needs Node 22.13 or newer; you have $NODE_VERSION.
$INSTALL_HELP"
command -v npm >/dev/null 2>&1 || die "npm wasn't found next to Node $NODE_VERSION. Reinstall Node from https://nodejs.org."
echo "Node $NODE_VERSION, npm $(npm --version)"

# 2. Dependencies, only when package-lock.json changed since the last install.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "Installing dependencies (npm ci)…"
  npm ci --no-audit --no-fund
else
  say "Dependencies are up to date."
fi

# 3. The web app.
say "Building the web app…"
npm run --silent build

# 4. macOS: a double-click launcher.
if [ "$(uname -s)" = Darwin ]; then
  if [ "$LAUNCHER" = ask ]; then
    if [ -t 0 ]; then
      printf '\nCreate an Agentville launcher in %s? [Y/n] ' "$LAUNCHER_DIR"
      read -r answer || answer=n
      case "$answer" in [nN]*) LAUNCHER=no ;; *) LAUNCHER=yes ;; esac
    else
      LAUNCHER=no
      echo "(Not interactive: skipping the launcher. Run ./setup.sh --launcher to make one.)"
    fi
  fi
  if [ "$LAUNCHER" = yes ]; then
    if command -v swiftc >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
      say "Building the launcher…"
      mkdir -p "$LAUNCHER_DIR"
      tools/macos-launcher/build.sh "$LAUNCHER_DIR"
    else
      echo "Skipping the launcher: it needs the Xcode command line tools (xcode-select --install)."
    fi
  fi
elif [ "$LAUNCHER" = yes ]; then
  echo "The double-click launcher is macOS-only; skipping it."
fi

say "Done. Start Agentville with:"
echo "  npm start"
echo "then open http://127.0.0.1:${AGENTVILLE_PORT:-5275}/"
