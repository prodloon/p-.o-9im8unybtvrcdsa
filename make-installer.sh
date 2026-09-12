#!/usr/bin/env bash
#
# make-installer.sh — build and install the release Daisy Cluster .app
# ============================================================================
# Reproduces the full release pipeline in one command:
#   1. tauri build              → release binary + .app + .dmg
#   2. stage backend/skillbase  → <.app>/Contents/Resources/appdata/
#     (NEVER copies .env or database/ — secrets and state stay out of the
#      bundle; runtime data lives in ~/Library/Application Support/DaisyCluster)
#   3. swap in the freshly built binary — `tauri build` bundles the binary
#      from its own intermediate step, which can lag a just-built main.rs
#   4. re-sign ad-hoc and install to /Applications with ditto
#
# Usage:
#   ./make-installer.sh            # full build + install
#   ./make-installer.sh --skip     # skip cargo build; restage + reinstall only
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src-tauri/target/release"
APP_NAME="Daisy Cluster.app"
BUNDLED="$SRC/bundle/macos/$APP_NAME"
INSTALLED="/Applications/$APP_NAME"
NODE_BIN=/usr/local/bin/node

cd "$ROOT/src-tauri"

if [ "${1:-}" != "--skip" ]; then
  echo "▶ 1/4 tauri build (release; takes minutes)…"
  npx --prefix "$ROOT/ui" tauri build 2>&1 | tail -4
else
  echo "▶ 1/4 skipped (--skip)"
fi

echo "▶ 2/4 staging runtime payload into Contents/Resources/appdata…"
mkdir -p "$BUNDLED/Contents/Resources/appdata"
cd "$ROOT"
rsync -a \
  --exclude '.git*' --exclude 'node_modules' --exclude 'daisy_env' \
  --exclude 'ui' --exclude 'src-tauri' --exclude 'logs' --exclude '.run' \
  --exclude 'daisy_sandbox*' --exclude 'database' --exclude 'docs' \
  --exclude '.env' --exclude '.DS_Store' \
  ./ "$BUNDLED/Contents/Resources/appdata/"

echo "▶ 3/4 swapping in the freshly built binary + ad-hoc sign…"
cp "$SRC/daisy-cluster" "$BUNDLED/Contents/MacOS/daisy-cluster"
codesign --force -s - "$BUNDLED" 2>/dev/null || true

echo "▶ 4/4 installing to $INSTALLED…"
[ -d "$INSTALLED" ] && rm -rf "$INSTALLED"
ditto "$BUNDLED" "$INSTALLED"

# Post-install sanity: bundle shape
for p in "Contents/MacOS/daisy-cluster" "Contents/Resources/appdata/backend/index.js" \
         "Contents/Resources/appdata/skillbase/index.json" "Contents/Resources/icon.icns"; do
  [ -e "$INSTALLED/$p" ] || { echo "✗ missing $p in bundle"; exit 1; }
done
echo "✔ installed: $INSTALLED ($(du -sh "$INSTALLED" | cut -f1))"
echo "  runtime data: ~/Library/Application Support/DaisyCluster/"
echo "  secrets:      put OPENROUTER_API_KEY in ~/Library/Application Support/DaisyCluster/.env"
echo "  launch:       open '/Applications/Daisy Cluster.app'"
