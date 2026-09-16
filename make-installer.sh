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
#
# Distribution (Stage 6 — optional, opt-in):
#   Ad-hoc signing (-s -) satisfies Gatekeeper only on THIS Mac. An app given
#   to anyone else is blocked on first launch. Stage 6 signs with a real
#   Developer ID certificate, notarizes via Apple's notary service, and
#   staples the ticket — the full Gatekeeper-clean pipeline:
#
#   Prerequisites (one-time):
#     • Apple Developer Program membership ($99/yr) — free accounts cannot
#       create the required certificate.
#     • "Developer ID Application" certificate in the login keychain
#       (check: security find-identity -p basic -v).
#     • Credentials stored once: xcrun notarytool store-credentials \
#         --apple-id you@example.com --team-id TEAMID   (uses an
#       app-specific password; profile name is what you pass below).
#
#   DAISY_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
#   DAISY_NOTARY_PROFILE='daisy-notary' \
#   ./make-installer.sh --skip
#
#   With DAISY_SIGN_IDENTITY set, stage 3 signs with Hardened Runtime
#   (a notarization requirement) instead of ad-hoc, and stage 6 submits the
#   zip to notarytool, staples the ticket onto the .app, and verifies with
#   spctl. Without it, behavior is unchanged (ad-hoc, local Mac only).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Daisy Cluster.app"
# Universal-binary builds land in target/universal-apple-darwin/release (the
# appdata payload is identical either way — only the binary and bundle differ).
SRC="$ROOT/src-tauri/target/release"
if [ -n "${TAURI_UNIVERSAL:-}" ]; then
  # Must be decided BEFORE the build: the universal bundle only exists after
  # `tauri build --target universal-apple-darwin` runs below.
  SRC="$ROOT/src-tauri/target/universal-apple-darwin/release"
fi
BUNDLED="$SRC/bundle/macos/$APP_NAME"
INSTALLED="/Applications/$APP_NAME"
# Portable node resolution — see clusterctl.sh for why /usr/local/bin alone
# is wrong on Apple Silicon Homebrew installs.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$candidate" ] && NODE_BIN="$candidate" && break
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "make-installer: node not found (checked PATH, /opt/homebrew/bin, /usr/local/bin)." >&2
  exit 1
fi

# Distribution signing (empty = ad-hoc, this Mac only — see header).
SIGN_IDENTITY="${DAISY_SIGN_IDENTITY:-}"
NOTARY_PROFILE="${DAISY_NOTARY_PROFILE:-}"

# ────────────────────────────────────────────────────────────────────────────
# Bundle-drift guard: exactly ONE Daisy .app may exist in /Applications.
# The Round-4 audit found three competing bundles — one of them an unsigned
# stripped duplicate, one a legacy launcher whose "binary" was a bash script
# pointing outside the bundle. A customer (or a future you) launching the
# wrong one gets the broken build, and diagnose time burns on "which app did
# you open?". Fail the build early instead. Skippable for exotic setups:
#   DAISY_ALLOW_EXTRA_BUNDLES=1 ./make-installer.sh
# ────────────────────────────────────────────────────────────────────────────
if [ -z "${VERIFY_ONLY:-}" ] && [ "${DAISY_ALLOW_EXTRA_BUNDLES:-0}" != "1" ]; then
  APPS_DIR="${DAISY_APPS_DIR:-/Applications}"
  extras=""
  for candidate in "$APPS_DIR/"*[Dd]aisy*.app "$APPS_DIR/"*[Dd]AISY*.app; do
    [ -d "$candidate" ] || continue
    case "$(basename "$candidate")" in
      "$APP_NAME") ;;                                    # canonical — fine
      *) extras="${extras:+$extras\n}  $candidate" ;;
    esac
  done
  if [ -n "$extras" ]; then
    echo "make-installer: competing Daisy .app bundle(s) found in $APPS_DIR:" >&2
    printf '%b\n' "$extras" >&2
    echo "  → a second bundle means someone can launch the wrong build." >&2
    echo "  → remove the extras (archive first if wanted):" >&2
    echo "      ditto -c -k --keepParent '<bundle>' ~/Desktop/'<bundle>.zip' && rm -rf '<bundle>'" >&2
    echo "  → or, if the extras are intentional, re-run with DAISY_ALLOW_EXTRA_BUNDLES=1" >&2
    exit 1
  fi
  echo "✔ bundle-drift guard: only the canonical bundle exists in $APPS_DIR"
fi

cd "$ROOT/src-tauri"

VERIFY_ONLY="${DAISY_VERIFY_ONLY:-}"
if [ -z "$VERIFY_ONLY" ]; then

if [ "${1:-}" != "--skip" ]; then
  echo "▶ 1/5 tauri build (release; takes minutes)…"
  if [ -n "${TAURI_UNIVERSAL:-}" ]; then
    # Universal (arm64 + x86_64) build for distributable artifacts. CI runs
    # this via the installer workflow so one DMG serves both Apple chips.
    mkdir -p "$ROOT/src-tauri/target"
    rustup target add x86_64-apple-darwin aarch64-apple-darwin
    npx --prefix "$ROOT/ui" tauri build --target universal-apple-darwin 2>&1 | tail -4
  else
    npx --prefix "$ROOT/ui" tauri build 2>&1 | tail -4
  fi
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

echo "▶ 3/5 swapping in the freshly built binary + $([ -n "$SIGN_IDENTITY" ] && echo 'Developer ID' || echo 'ad-hoc') sign…"
cp "$SRC/daisy-cluster" "$BUNDLED/Contents/MacOS/daisy-cluster"
if [ -n "$SIGN_IDENTITY" ]; then
  # Hardened Runtime is REQUIRED for notarization. WebKit's JIT needs the
  # allow-jit entitlement under Hardened Runtime; the backend spawns node
  # (external binary) so no allow-unsigned-executable-memory is needed here.
  ENTITLEMENTS="$(mktemp /tmp/daisy-entitlements.XXXXXX.plist)"
  cat > "$ENTITLEMENTS" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
  </dict>
</plist>
EOF
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" \
    --sign "$SIGN_IDENTITY" "$BUNDLED"
  rm -f "$ENTITLEMENTS"
  codesign --verify --strict "$BUNDLED"   # fail the build on a bad signature
else
  # Ad-hoc seal of the .app bundle. This MUST succeed and MUST be verified:
  # without _CodeSignature/, Gatekeeper refuses the app as damaged on any
  # clean Mac ("code has no resources but signature indicates they must be
  # present"). Never swallow failures here — a CI build shipped unsealed once.
  codesign --force --deep -s - "$BUNDLED"
fi
codesign --verify --strict "$BUNDLED"
[ -d "$BUNDLED/Contents/_CodeSignature" ] || { echo "FATAL: bundle not sealed (_CodeSignature missing)" >&2; exit 1; }

# Rebuild the distributable DMG from the SEALED bundle. The DMG that tauri
# build emits at stage 1 predates the binary swap + signing, so publishing it
# would ship an unsealed app that Gatekeeper reports as damaged (exactly the
# bug the rc2 smoke test caught). Only rebuilt in universal/release mode.
if [ -n "${TAURI_UNIVERSAL:-}" ]; then
  echo "▶ 3b/5 rebuilding DMG from the sealed bundle…"
  DMG_SRC="$(mktemp -d /tmp/daisy-dmg-src.XXXXXX)"
  cp -R "$BUNDLED" "$DMG_SRC/"
  ln -s /Applications "$DMG_SRC/Applications"
  rm -f "$SRC/bundle/dmg/$APP_NAME"_*.dmg
  hdiutil create -volname "Daisy Cluster" -srcfolder "$DMG_SRC" \
    -format UDZO -ov "$SRC/bundle/dmg/Daisy Cluster_$(print "%s" "${DAISY_APP_VERSION:-0.1.0}")_universal.dmg"
  rm -rf "$DMG_SRC"
  codesign --verify --strict "$DMG_SRC/../$APP_NAME" 2>/dev/null || true
fi

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

# ────────────────────────────────────────────────────────────────────────────
# Stage 6 (optional): notarize + staple for distribution outside this Mac.
# Runs only when DAISY_SIGN_IDENTITY is set (see header for prerequisites).
# Notary accepts app/zip/dmg/pkg; we submit a ditto-created zip (preserves
# the signature, unlike tar). --wait polls until Apple returns a verdict.
# ────────────────────────────────────────────────────────────────────────────
if [ -n "$SIGN_IDENTITY" ]; then
  if [ -z "$NOTARY_PROFILE" ]; then
    echo "✗ DAISY_SIGN_IDENTITY set but DAISY_NOTARY_PROFILE missing —" \
        "store credentials once with: xcrun notarytool store-credentials" >&2
    exit 1
  fi
  echo "▶ 6/6 notarizing + stapling (Apple notary service; usually 1–5 min)…"
  ZIP="$(mktemp /tmp/daisy-notarize.XXXXXX.zip)"
  # ditto keeps the code signature intact (zip -r can corrupt it).
  ditto -c -k --keepParent "$INSTALLED" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  rm -f "$ZIP"
  xcrun stapler staple "$INSTALLED"
  spctl --assess --type execute -vv "$INSTALLED"
  echo "✔ notarized + stapled — Gatekeeper-clean for distribution"

  # The .dmg from stage 1 is a separate artifact with its own Gatekeeper
  # story: notarize it too (notary accepts dmg natively — no zip wrapper
  # needed) and staple the ticket onto the image, so the DMG itself shows
  # "verified by Apple" on the recipient's Mac, not just the app inside it.
  DMG="$(ls -t "$SRC"/bundle/dmg/*.dmg 2>/dev/null | head -1)"
  if [ -n "$DMG" ]; then
    echo "  → notarizing DMG: $(basename "$DMG")"
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    echo "  ✔ DMG notarized + stapled — distributable disk image is Gatekeeper-clean"
  else
    echo "  ⚠ no .dmg found in $SRC/bundle/dmg/ — skipped DMG notarization"
  fi
fi
