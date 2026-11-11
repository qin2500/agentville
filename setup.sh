#!/usr/bin/env bash
# One-command setup for Agentville. Safe to run again at any time.
#
#   ./setup.sh    check Node, install dependencies and build the web app
#
# Then: npm run app:build -- --install   (builds the desktop app into ~/Applications)
set -euo pipefail
cd "$(dirname "$0")"

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

say "Done. Build and install the desktop app with:"
echo "  npm run app:build -- --install"
echo "(or run it from this folder without building: npm run app)"
