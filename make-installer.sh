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
#   5. app-mode verification: launch the installed app and prove the emit
#      loop reads Application Support telemetry (fails the build on a
#      wrong-path regression); skip headless with NO_APP_VERIFY=1
#
# Usage:
#   ./make-installer.sh            # full build + install + verify
#   ./make-installer.sh --skip     # skip cargo build; restage + reinstall only
#   NO_APP_VERIFY=1 ./make-installer.sh   # skip stage 5 (headless/CI)
#   DAISY_VERIFY_ONLY='<bundle>' ./make-installer.sh   # run stage 5 against an existing bundle, nothing rebuilt
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src-tauri/target/release"
APP_NAME="Daisy Cluster.app"
BUNDLED="$SRC/bundle/macos/$APP_NAME"
INSTALLED="/Applications/$APP_NAME"
NODE_BIN=/usr/local/bin/node

cd "$ROOT/src-tauri"

VERIFY_ONLY="${DAISY_VERIFY_ONLY:-}"
if [ -z "$VERIFY_ONLY" ]; then

if [ "${1:-}" != "--skip" ]; then
  echo "▶ 1/5 tauri build (release; takes minutes)…"
  npx --prefix "$ROOT/ui" tauri build 2>&1 | tail -4
else
  echo "▶ 1/5 skipped (--skip)"
fi

echo "▶ 2/5 staging runtime payload into Contents/Resources/appdata…"
mkdir -p "$BUNDLED/Contents/Resources/appdata"
cd "$ROOT"
rsync -a \
  --exclude '.git*' --exclude 'node_modules' --exclude 'daisy_env' \
  --exclude 'ui' --exclude 'src-tauri' --exclude 'logs' --exclude '.run' \
  --exclude 'daisy_sandbox*' --exclude 'database' --exclude 'docs' \
  --exclude '.env' --exclude '.DS_Store' \
  ./ "$BUNDLED/Contents/Resources/appdata/"

echo "▶ 3/5 swapping in the freshly built binary + ad-hoc sign…"
cp "$SRC/daisy-cluster" "$BUNDLED/Contents/MacOS/daisy-cluster"
codesign --force -s - "$BUNDLED" 2>/dev/null || true

echo "▶ 4/5 installing to ${INSTALLED}…" # brace the var: bash parses $INSTALLED… (ellipsis) as one name under set -u
[ -d "$INSTALLED" ] && rm -rf "$INSTALLED"
ditto "$BUNDLED" "$INSTALLED"

# Post-install sanity: bundle shape
for p in "Contents/MacOS/daisy-cluster" "Contents/Resources/appdata/backend/index.js" \
         "Contents/Resources/appdata/skillbase/index.json" "Contents/Resources/icon.icns"; do
  [ -e "$INSTALLED/$p" ] || { echo "✗ missing $p in bundle"; exit 1; }
done

else
  # Verify-only mode: stage 5 against an existing bundle (no rebuild).
  INSTALLED="$VERIFY_ONLY"
  [ -d "$INSTALLED" ] || { echo "✗ verify-only: no bundle at $INSTALLED"; exit 1; }
  echo "▶ verify-only: stages 1–4 skipped — verifying $INSTALLED"
fi

# ────────────────────────────────────────────────────────────────────────────
# Stage 5: app-mode verification — prove the installed app actually works.
# A wrong telemetry path once shipped invisible: the emit loop read the
# bundle's (installer-excluded) database/ while the backend wrote to
# Application Support, so the dashboard never got telemetry://metrics — and
# every pre-flight grep looked fine. So verify BEHAVIOR, by launching the
# installed app and demanding its one-time proof line:
#   [shell] telemetry emit loop live: <path>   ← only prints on first real read
# Path regression → no line → build FAILS instead of hiding.
# Skippable headless: NO_APP_VERIFY=1 ./make-installer.sh
# ────────────────────────────────────────────────────────────────────────────
if [ "${NO_APP_VERIFY:-0}" = "1" ]; then
  echo "▶ 5/5 app verification skipped (NO_APP_VERIFY=1)"
else
  echo "▶ 5/5 app-mode verification (launch installed app, demand emit-loop proof)…"
  APP_DATA="$HOME/Library/Application Support/DaisyCluster"
  TEL="$APP_DATA/database/telemetry.json"
  GUI=""; BE=""

  # The app must be closed — a single-instance open would no-op and prove nothing.
  if pgrep -f "Daisy [C]luster.app/Contents/MacOS" >/dev/null; then
    echo "  app is running — quitting it first"
    osascript -e 'tell application "Daisy Cluster" to quit' >/dev/null 2>&1 || true
    sleep 3
  fi

  # launchctl submit runs fully detached AND captures stdout — plain `open`
  # gives neither, and a harness-watched direct exec dies silently.
  launchctl remove daisy-installer-verify 2>/dev/null || true
  rm -f /tmp/daisy-verify-out.log /tmp/daisy-verify-err.log
  launchctl submit -l daisy-installer-verify \
    -o /tmp/daisy-verify-out.log -e /tmp/daisy-verify-err.log -- "$INSTALLED/Contents/MacOS/daisy-cluster"
  sleep 4
  # set -e/pipefail-safe probes: pgrep exits 1 on no-match, so every probe
  # carries `|| true` and targets THIS bundle's binary path (verify-only may
  # run against a copy that isn't literally "Daisy Cluster.app").
  GUI=$(pgrep -f "$INSTALLED/Contents/MacOS" 2>/dev/null | head -1 || true)

  # Wait up to 25s for the proof line naming the Application Support path.
  WANT="$APP_DATA/database/telemetry.json"
  for i in $(seq 1 25); do
    if grep -q "telemetry emit loop live" /tmp/daisy-verify-out.log 2>/dev/null; then break; fi
    sleep 1
  done
  # Proof-line parse lives in scripts/freeze_drill.py (unit-tested).
  GOT=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[2]); from freeze_drill import emit_loop_path; p = emit_loop_path(sys.argv[1]); print(p if p else "")' /tmp/daisy-verify-out.log "$ROOT/scripts" 2>/dev/null || true)

  # The backend process (child of this GUI) — needed for the reap check.
  BE=""
  for p in $(pgrep -f "index[.]js --serve" 2>/dev/null || true); do
    if [ "$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')" = "$GUI" ]; then BE=$p; fi
  done

  FAIL=""
  if [ -z "$GUI" ]; then
    echo "  ✗ app GUI never launched (see /tmp/daisy-verify-err.log)"; FAIL=1
  fi
  if [ ! -e "$WANT" ]; then
    echo "  ✗ telemetry file missing at $WANT (backend never wrote it)"; FAIL=1
  elif [ -z "$GOT" ]; then
    echo "  ✗ no emit-loop proof line — emit loop never read the data dir"; FAIL=1
  elif [ "$GOT" != "$WANT" ]; then
    echo "  ✗ WRONG PATH: emit loop reads $GOT, backend writes $WANT"; FAIL=1
  fi
  if [ -z "$BE" ]; then
    echo "  ✗ no backend process spawned by the shell"; FAIL=1
  fi

  # Freshness: the proof line proves the SHELL's path, but a wrong-path
  # BACKEND leaves a stale leftover at $WANT that the shell happily re-emits
  # (stale files lie — same lesson as the watcher's boot false-alarm).
  # Demand a fresh write via scripts/freeze_drill.py — the shared, unit-tested
  # harness (also used by freeze drills); exit code IS the verdict.
  if ! python3 "$ROOT/scripts/freeze_drill.py" fresh --file "$WANT" --max-age 12 --timeout 15; then
    FAIL=1
  fi

  # Cleanup regardless of verdict. Graceful AppleScript quit works only for
  # the registered app name; verify-only copies get launchctl remove (SIGKILL
  # path). Either way the backend must die: via the shell's exit-kill, or —
  # if the GUI was killed hard — via the backend's own 5s orphan-guard.
  if [ "$INSTALLED" = "/Applications/Daisy Cluster.app" ]; then
    osascript -e 'tell application "Daisy Cluster" to quit' >/dev/null 2>&1 || true
  fi
  launchctl remove daisy-installer-verify 2>/dev/null || true
  REAPED=""
  for i in $(seq 1 12); do
    if ! kill -0 "${BE:-0}" 2>/dev/null; then REAPED=1; break; fi
    sleep 1
  done
  if [ -n "$BE" ] && [ -z "$REAPED" ]; then
    echo "  ✗ backend pid $BE survived app quit (orphan)"; FAIL=1
    kill "$BE" 2>/dev/null || true
  fi

  if [ -n "$FAIL" ]; then
    echo "✗ APP VERIFICATION FAILED — see /tmp/daisy-verify-out.log"; exit 1
  fi
  echo "  ✔ emit loop reads $WANT (fresh write confirmed); backend reaped on quit"
fi
echo "✔ installed: $INSTALLED ($(du -sh "$INSTALLED" | cut -f1))"
echo "  runtime data: ~/Library/Application Support/DaisyCluster/"
echo "  secrets:      put OPENROUTER_API_KEY in ~/Library/Application Support/DaisyCluster/.env"
echo "  launch:       open '/Applications/Daisy Cluster.app'"
