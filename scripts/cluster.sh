#!/usr/bin/env bash
#
# scripts/cluster.sh — boot sequence + supervisor for the local orchestration
# cluster.
# =============================================================================
#   scripts/cluster.sh start    governor/DB preflight → Ollama checks →
#                               orchestrator + telemetry up (idempotent)
#   scripts/cluster.sh stop     clean termination; while a LaunchAgent is
#                               loaded this PAUSES the supervisor for 10 min
#                               (launchd would otherwise re-boot the stack)
#   scripts/cluster.sh status   services + cascade pins + Ollama health
#   scripts/cluster.sh restart  stop, then start
#   scripts/cluster.sh supervise    boot once, then heal: every 15 s restore
#                               any dead core service (this is what the
#                               LaunchAgent runs; exit ≠ 0 only if boot fails)
#   scripts/cluster.sh install-agent [--unload-first]   write + load the
#                               LaunchAgent (login autostart + self-heal)
#   scripts/cluster.sh uninstall-agent [--keep-running] remove the agent
#   scripts/cluster.sh agent-status         loaded/running + last heal action
#   scripts/cluster.sh task '<json>'   enqueue work through the running stack
#   scripts/cluster.sh logs [svc]      orchestrator|telemetry|ollama|all
#
# Exit codes: 0 = all green, 1 = partial/degraded, 2 = failed to boot.
#
# Boot order follows knowledge.md §5.5 (3-Tier COST LAW):
#   Tier 1 needs the skillbase + WAL database (governor preflight).
#   Tier 2 needs local Ollama serving qwen2.5:7b on localhost:11434.
#   Tier 3 needs OPENROUTER_API_KEY (from gitignored .env — clusterctl loads it).
#
# The PINNED model mappings live in backend/supervisor-bridge.js and are not
# configurable here by design; this script only *verifies* the environment
# can honor them.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTL="$ROOT/clusterctl.sh"
ENVFILE="$ROOT/.env"
OLLAMA_BASE="http://localhost:11434"            # PINNED tier-2 host (§5.5)
TIER2_MODEL="qwen2.5:7b"                        # PINNED tier-2 model (§5.5)
TIER3_MODEL="~anthropic/claude-sonnet-latest"   # PINNED tier-3 model (§5.5)
AGENT_LABEL="com.daisy.cluster"                 # LaunchAgent identifier
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
SUPERVISOR_INTERVAL=15                           # heal-check cadence (s)
PAUSE_FILE="$ROOT/.run/supervisor.paused"
WARM_TIER2="${DAISY_WARM_TIER2:-1}"             # default ON: pre-load qwen weights at boot (removes the ~20s cold start on first consult)
# Residency policy — MUST match bridge POLICY.OLLAMA_KEEP_ALIVE. GOTCHA:
# Ollama parses keep_alive as a Go duration; the STRING "-1" is rejected
# (400). Numeric -1 = resident forever, '5m' = release after 5 min.
case "${DAISY_OLLAMA_KEEP_ALIVE:-}" in
  '')       KEEP_ALIVE_JSON=-1 ;;
  '-1'|'0') KEEP_ALIVE_JSON="${DAISY_OLLAMA_KEEP_ALIVE}" ;;
  *)        KEEP_ALIVE_JSON="\"${DAISY_OLLAMA_KEEP_ALIVE}\"" ;; # duration string → quoted
esac
OLLAMA_PIDFILE="$ROOT/.run/ollama.pid"

# API key into env for checks (never printed) — clusterctl does the same for spawns.
if [ -f "$ENVFILE" ]; then
  set -a; . "$ENVFILE"; set +a
fi

log()  { printf '\033[36m[cluster]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  ⚠\033[0m %s\n' "$*"; }
fail() { printf '\033[31m  ✗\033[0m %s\n' "$*"; }

# --- preflight: WAL database + schema present (Tier-1 persistence) ----------
db_preflight() {
  log "preflight: governor database"
  mkdir -p "$ROOT/database" "$ROOT/.run" "$ROOT/logs"
  if node "$ROOT/governor/init-database.js" >/dev/null 2>&1; then
    ok "database ready (WAL, schema applied)"
  else
    fail "governor database preflight failed"; return 1
  fi
  # WAL journal mode is set by the governor; verify it stuck.
  local mode
  mode=$(node -e "
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync('$ROOT/database/agent-states.sqlite', { readOnly: true });
    console.log(d.prepare('PRAGMA journal_mode').get().journal_mode || d.prepare('PRAGMA journal_mode').get().mode);
  " 2>/dev/null || echo unknown)
  if [ "$mode" = "wal" ]; then ok "journal_mode=wal"; else warn "journal_mode=$mode (expected wal)"; fi
}

# --- tier-2 checks: Ollama reachable, pinned model pulled, optional warm -----
ollama_pid() { [ -f "$OLLAMA_PIDFILE" ] && cat "$OLLAMA_PIDFILE" 2>/dev/null || true; }

ollama_healthy() {
  curl -sf -m 3 "$OLLAMA_BASE/api/tags" >/dev/null 2>&1
}

model_pulled() {
  curl -sf -m 5 "$OLLAMA_BASE/api/tags" 2>/dev/null | grep -q "\"name\":\"$TIER2_MODEL\"\\|\"name\":\"$TIER2_MODEL:"
}

tier2_preflight() {
  log "tier 2: Ollama ($TIER2_MODEL @ $OLLAMA_BASE)"
  if ollama_healthy; then
    ok "server reachable"
  else
    if command -v ollama >/dev/null 2>&1; then
      warn "server down — starting 'ollama serve' (we own it; stop will clean up)"
      mkdir -p "$ROOT/logs"
      # macOS has no setsid; spawn detached the proven way (survives tool timeouts).
      local pid
      pid=$(python3 - "$ROOT/logs/ollama.log" <<'PY'
import subprocess, sys
logf = open(sys.argv[1], "ab", buffering=0)
p = subprocess.Popen(["ollama", "serve"], stdout=logf, stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, start_new_session=True)
print(p.pid)
PY
)
      echo "$pid" > "$OLLAMA_PIDFILE"
      local i
      for i in $(seq 1 20); do
        if ollama_healthy; then break; fi
        sleep 0.5
      done
      if ollama_healthy; then ok "server started (pid $pid)"; else fail "ollama did not come up — see logs/ollama.log"; return 1; fi
    else
      fail "ollama not installed and server down — tier 2 will be skipped by the cascade (tasks fall through to tier 3)"
      return 0   # degraded, not fatal: the cascade handles a missing tier 2
    fi
  fi

  if model_pulled; then
    ok "model '$TIER2_MODEL' present"
  else
    warn "model '$TIER2_MODEL' missing — pulling (one-time, ~4 GB)"
    if ollama pull "$TIER2_MODEL" >/dev/null 2>&1; then
      ok "model pulled"
    else
      warn "pull failed — tier 2 will be skipped by the cascade"
      return 0
    fi
  fi

  if [ "$WARM_TIER2" = "1" ]; then
    log "tier 2: warming weights (keep_alive=$(echo $KEEP_ALIVE_JSON | tr -d '\\"'); disable with DAISY_WARM_TIER2=0)"
    # Warm call pins residency the same way every tier-2 consult does.
    curl -sf -m 300 "$OLLAMA_BASE/api/chat" -d "{\"model\":\"$TIER2_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"stream\":false,\"keep_alive\":$KEEP_ALIVE_JSON,\"options\":{\"num_predict\":1}}" >/dev/null 2>&1 \
      && ok "weights resident — first consult will be fast" \
      || warn "warmup call failed (continuing; first consult pays the cold start)"
  else
    warn "warmup disabled (DAISY_WARM_TIER2=0) — first tier-2 consult pays the cold start"
  fi
}

# --- tier-3 check: key present (never printed) ------------------------------
tier3_preflight() {
  log "tier 3: OpenRouter ($TIER3_MODEL)"
  if [ "${OPENROUTER_API_KEY:-}" != "" ]; then
    ok "OPENROUTER_API_KEY loaded"
  else
    warn "no OPENROUTER_API_KEY in env/.env — tier 3 will fail clean; cascade degrades to tiers 1-2"
  fi
}

# --- supervisor pause (a manual stop must not be undone by the healer) ------
supervisor_pid() { pgrep -f "bash .*scripts/cluster[.]sh supervise" 2>/dev/null | head -1; }
pause_supervisor() { mkdir -p "$(dirname "$PAUSE_FILE")"; date +%s > "$PAUSE_FILE"; }
clear_pause() { rm -f "$PAUSE_FILE"; }
paused_at() { [ -f "$PAUSE_FILE" ] && cat "$PAUSE_FILE" 2>/dev/null || echo 0; }

# --- LaunchAgent entry point: boot once, then heal forever ------------------
core_ok() {
  # Orchestrator liveness = telemetry.json fresh (<10s); telemetry server =
  # its real HTTP endpoint. A failed probe heals via cmd_start, which is
  # idempotent AND re-runs the tier-2 preflight (so an Ollama we started
  # gets resurrected too).
  local tel="$ROOT/database/telemetry.json"
  [ -f "$tel" ] || return 1
  local mt
  mt=$(node -e "console.log(Math.round(require('fs').statSync(process.argv[1]).mtimeMs/1000))" "$tel" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - mt )) -lt 10 ] || return 1
  curl -sf -m 3 "http://127.0.0.1:6292/api/telemetry" >/dev/null 2>&1
}

cmd_supervise() {
  trap 'log "supervisor: TERM from launchd — leaving services as-is"' TERM
  log "supervisor: booting stack (login/reload)"
  # db_preflight failure exits 2 from cmd_start — also a nonzero exit for
  # launchd to retry with ThrottleInterval backoff. Same net effect.
  if ! cmd_start; then
    log "supervisor: boot FAILED — exiting 1 so launchd retries"
    exit 1
  fi
  clear_pause
  log "supervisor: watching every ${SUPERVISOR_INTERVAL}s (heal = idempotent boot)"
  while true; do
    if [ -f "$PAUSE_FILE" ]; then
      # Paused via a manual `cluster.sh stop`. Auto-resume after 10 min so a
      # paused supervisor can't silently become "agent installed but dead".
      local age=$(( $(date +%s) - $(paused_at) ))
      if [ "$age" -ge 600 ]; then
        log "supervisor: pause expired (${age}s) — resuming"
        clear_pause
      else
        sleep "$SUPERVISOR_INTERVAL"
        continue
      fi
    fi
    if ! core_ok; then
      log "supervisor: core service down — healing (idempotent boot)"
      cmd_start >/dev/null 2>&1 || log "supervisor: heal attempt failed (retrying next tick)"
    fi
    sleep "$SUPERVISOR_INTERVAL"
  done
}

# --- LaunchAgent management -------------------------------------------------
write_agent_plist() {
  cat > "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/scripts/cluster.sh</string>
    <string>supervise</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DAISY_WARM_TIER2</key><string>${WARM_TIER2}</string>
  </dict>
  <key>StandardOutPath</key><string>${ROOT}/logs/launchd-agent.log</string>
  <key>StandardErrorPath</key><string>${ROOT}/logs/launchd-agent.log</string>
</dict>
</plist>
PLIST
}

cmd_install_agent() {
  local unload_first=0
  [ "${1:-}" = "--unload-first" ] && unload_first=1
  mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
  if launchctl print "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1; then
    if [ "$unload_first" = "1" ]; then
      log "agent already loaded — unloading first (--unload-first)"
      cmd_uninstall_agent --keep-running >/dev/null 2>&1 || true
    else
      log "agent already loaded — nothing to do (use --unload-first to reload)"
      cmd_agent_status
      return 0
    fi
  fi
  log "writing $AGENT_PLIST"
  write_agent_plist
  if ! plutil -lint "$AGENT_PLIST" >/dev/null; then fail "generated plist failed lint"; exit 2; fi
  ok "plist lint passed"
  log "loading agent (bootstrap gui/$(id -u))"
  if ! launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" 2>/dev/null; then
    fail "bootstrap failed (see $ROOT/logs/launchd-agent.log)"
    exit 2
  fi
  sleep 3
  cmd_agent_status
  log "login autostart + self-heal ACTIVE — note: 'cluster.sh stop' now PAUSES the healer for 10 min"
}

cmd_uninstall_agent() {
  local keep=0
  [ "${1:-}" = "--keep-running" ] && keep=1
  if launchctl print "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1; then
    log "booting out agent"
    launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
    ok "agent unloaded (launchd TERMed the supervisor; services keep running)"
  else
    log "agent not loaded"
  fi
  if [ -f "$AGENT_PLIST" ]; then rm -f "$AGENT_PLIST"; ok "plist removed (no autostart at next login)"; fi
  clear_pause
  if [ "$keep" = "1" ]; then
    ok "services left running (--keep-running)"
  else
    cmd_stop
  fi
}

cmd_agent_status() {
  if launchctl print "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1; then
    local pid
    pid=$(launchctl print "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*pid = //p' | head -1)
    ok "LaunchAgent $AGENT_LABEL: LOADED (supervisor pid ${pid:-starting})"
    if [ -f "$PAUSE_FILE" ]; then
      warn "supervisor PAUSED (manual stop) — auto-resumes 10 min after pause, or run 'restart'"
    fi
  else
    warn "LaunchAgent $AGENT_LABEL: not loaded (install with 'install-agent')"
  fi
}

cmd_start() {
  log "booting Daisy cluster (boot order: T1 persistence → T2 ollama → T3 key → orchestrator)"
  db_preflight || exit 2
  tier2_preflight || true      # degraded-ok, never fatal
  tier3_preflight
  log "starting services (clusterctl)"
  "$CTL" start --no-ui         # headless by default; pass --shell via args if you want the desktop shell
  clear_pause # explicit start/restart = intent to run → the healer must watch again
  log "boot complete — pins: T1 skillbase · T2 $TIER2_MODEL · T3 $TIER3_MODEL"
}

cmd_stop() {
  if [ -n "$(supervisor_pid)" ]; then
    pause_supervisor
    log "LaunchAgent supervisor detected — PAUSING it for 10 min"
    warn "(without the pause, the healer would re-boot this stack in ~15s; 'uninstall-agent' stops permanently)"
  fi
  log "stopping Daisy cluster"
  "$CTL" stop || true
  local opid
  opid="$(ollama_pid)"
  if [ -n "$opid" ] && kill -0 "$opid" 2>/dev/null; then
    # Only kill Ollama if WE started it this boot session.
    log "stopping ollama (pid $opid, started by this script)"
    kill "$opid" 2>/dev/null || true
    sleep 1
    kill -9 "$opid" 2>/dev/null || true
    rm -f "$OLLAMA_PIDFILE"
    ok "ollama stopped"
  else
    rm -f "$OLLAMA_PIDFILE"
    ok "ollama untouched (not started by this script or already down)"
  fi
  log "stop complete"
}

cmd_status() {
  "$CTL" status || true
  # Cascade pin + tier-2 health summary (machine-readable companion to status).
  local ollama="down" model="missing" residency="not loaded"
  ollama_healthy && ollama="up"
  model_pulled && model="present"
  if ollama_healthy && curl -sf -m 5 "$OLLAMA_BASE/api/ps" 2>/dev/null | grep -q "\"name\":\"$TIER2_MODEL"; then
    residency="resident (keep_alive=$(echo $KEEP_ALIVE_JSON | tr -d '\\"'))"
  fi
  printf '  cascade          T1 skillbase($0) · T2 %s@%s [%s, model %s, %s] · T3 %s\n' \
    "$TIER2_MODEL" "$OLLAMA_BASE" "$ollama" "$model" "$residency" "$TIER3_MODEL"
  if [ -f "$AGENT_PLIST" ] || launchctl print "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1; then
    cmd_agent_status
  fi
}

cmd_logs() {
  local svc="${1:-all}"
  case "$svc" in
    ollama) [ -f "$ROOT/logs/ollama.log" ] && tail -n 40 "$ROOT/logs/ollama.log" || echo "(no ollama log yet)" ;;
    *) "$CTL" logs "$svc" ;;
  esac
}

case "${1:-status}" in
  start)          shift || true; cmd_start "$@" ;;
  stop)           cmd_stop ;;
  restart)        cmd_stop; sleep 1; cmd_start ;;
  status)         cmd_status ;; # status already reports the agent line
  supervise)      cmd_supervise ;;
  install-agent)  shift || true; cmd_install_agent "${1:-}" ;;
  uninstall-agent) shift || true; cmd_uninstall_agent "${1:-}" ;;
  agent-status)   cmd_agent_status ;;
  task)           shift; "$CTL" task "$@" ;;
  logs)           shift || true; cmd_logs "${1:-all}" ;;
  *) echo "usage: scripts/cluster.sh {start|stop|restart|status|supervise|install-agent|uninstall-agent|agent-status|task '<json>'|logs [svc]}"; exit 2 ;;
esac
