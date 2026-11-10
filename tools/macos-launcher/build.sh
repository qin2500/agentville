#!/bin/bash
# Build "Agentville.app", a double-click launcher for this checkout. macOS only; needs Xcode command line tools.
# Usage: tools/macos-launcher/build.sh [destination folder, default ~/Desktop]
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEST="${1:-$HOME/Desktop}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Agentville.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# The icon is drawn by tools/icon/build.mjs (desktop/icons/icon.icns), shared with the desktop app.
cp "$REPO/desktop/icons/icon.icns" "$APP/Contents/Resources/Agentville.icns"

swiftc -O "$HERE/Launcher.swift" -o "$APP/Contents/MacOS/Agentville"
# The checkout's path goes in its own file, read verbatim by launch.sh: no quoting or sed escaping.
cp "$HERE/launch.sh" "$APP/Contents/Resources/launch.sh"
printf '%s' "$REPO" > "$APP/Contents/Resources/repo-path"
# The Node that built this, as a fallback for when Finder's minimal PATH doesn't find one.
if command -v node >/dev/null 2>&1; then printf '%s' "$(command -v node)" > "$APP/Contents/Resources/node-path"; fi
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key><string>Agentville</string>
	<key>CFBundleExecutable</key><string>Agentville</string>
	<key>CFBundleIconFile</key><string>Agentville</string>
	<key>CFBundleIdentifier</key><string>local.agentville.launcher</string>
	<key>CFBundleName</key><string>Agentville</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --deep --sign - "$APP"

rm -rf "$DEST/Agentville.app"
mv "$APP" "$DEST/"
echo "Built $DEST/Agentville.app (launches $REPO)"
