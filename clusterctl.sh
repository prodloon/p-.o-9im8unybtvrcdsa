#!/usr/bin/env bash
#
# clusterctl.sh — single control surface for the Daisy Chain cluster stack.
# ============================================================================
#   ./clusterctl.sh start [--shell] [--no-ui]   start the stack (idempotent)
#   ./clusterctl.sh stop                        stop everything (pidfiles + sweep)
#   ./clusterctl.sh restart [flags]             stop, then start
#   ./clusterctl.sh status                      per-service state + health
#   ./clusterctl.sh logs [orchestrator|shell|telemetry|vite|all] [n]
#   ./clusterctl.sh task '<json>'               enqueue one task
#
# Services:
#   orchestrator     node backend/index.js --serve     (queue + governor + telemetry.json)
#   telemetry-server loopback :6292                    (browser transport)
#   vite             ui dashboard :5183                (browser dashboard)
#   shell            Tauri desktop window              (OWNS its own orchestrator)
#
# Design notes:
#   • The Tauri shell spawns its OWN backend. Never run a headless orchestrator
#     next to the shell — start refuses, and stop always kills the shell last.
#   • Children are launched detached (setsid + nohup) so they survive this
#     script, terminals, and tool timeouts.
#   • OPENROUTER_API_KEY is loaded from .env (gitignored) if present. Never
#     printed, never exported outside this script's children.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PIDDIR="$ROOT/.run"
LOGDIR="$ROOT/logs"
ENVFILE="$ROOT/.env"
TELEMETRY_PORT="${DAISY_TELEMETRY_PORT:-6292}"
UI_PORT="${DAISY_UI_PORT:-5183}"
SHELL_BIN="$ROOT/src-tauri/target/debug/daisy-cluster"
# Node resolution: explicit override first (CI hands the setup-node binary),
# then PATH, then the two Homebrew prefixes. /usr/local/bin alone breaks on
# Apple Silicon machines and on GitHub's macOS runners.
NODE_BIN="${DAISY_NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || NODE_BIN="/opt/homebrew/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="/usr/local/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "clusterctl: node not found (checked \$DAISY_NODE_BIN, PATH, /opt/homebrew/bin, /usr/local/bin)." >&2
  echo "Install Node.js (https://nodejs.org) or make sure it's on your PATH, then retry." >&2
  exit 1
fi

mkdir -p "$PIDDIR" "$LOGDIR"
[ -f "$ENVFILE" ] && set -a && . "$ENVFILE" && set +a   # load key into env (silently)

c_green=$'\033[32m'; c_red=$'\033[31m'; c_amber=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
ok()   { printf "  %s✓%s %s\n" "$c_green" "$c_off" "$1"; }
bad()  { printf "  %s✗%s %s\n" "$c_red" "$c_off" "$1"; }
warn() { printf "  %s!%s %s\n" "$c_amber" "$c_off" "$1"; }
note() { printf "  %s%s%s\n" "$c_dim" "$1" "$c_off"; }

# --- service discovery (pgrep by command shape; ports as fallback) ----------
# NOTE: excludes the INSTALLED app's backend (Daisy Cluster.app/.../appdata)
# — clusterctl manages the repo stack only; the installed .app owns its own.
orch_pid() {
  local p cmd
  for p in $(pgrep -f "node .*backend/index[.]js --serve"); do
    cmd="$(ps -o command= -p "$p" 2>/dev/null)"
    case "$cmd" in *"Daisy Cluster.app"*) ;; *) echo "$p"; return ;; esac
  done
}
telemetry_pid(){ pgrep -f "backend/telemetry-server[.]js" | head -1; }
vite_pid()     { lsof -ti tcp:"$UI_PORT" 2>/dev/null | head -1; }
shell_pid()    {
  local p
  for p in $(pgrep -x "daisy-cluster"); do
    case "$(ps -o command= -p "$p" 2>/dev/null)" in *"Daisy Cluster.app"*) ;; *) echo "$p"; return ;; esac
  done
}
installed_shell_pid() { pgrep -x "daisy-cluster" | while read -r p; do case "$(ps -o command= -p "$p" 2>/dev/null)" in *"Daisy Cluster.app"*) echo "$p";; esac; done | head -1; }
app_backend_pid() {
  # The installed app's backend: --serve running from inside the bundle.
  local p
  for p in $(pgrep -f "backend/index[.]js --serve"); do
    case "$(ps -o command= -p "$p" 2>/dev/null)" in
      *"Daisy Cluster.app"*) echo "$p"; return ;;
    esac
  done
  return 1
}
alive()        { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

shell_is_up() { alive "$(shell_pid)"; }

cmd_dashboard() {
  # Standalone dashboard spawn (for the dashboard LaunchAgent, or manual
  # start when the orchestrator is already up). Uses the same python
  # spawner as cmd_start so the child survives terminal/tool timeouts.
  if [ -n "$(vite_pid)" ]; then
    ok "dashboard already up (pid $(vite_pid)) → http://localhost:$UI_PORT"
    return 0
  fi
  [ -d ui/node_modules ] || (cd ui && npm install --no-audit --no-fund --loglevel=error >>"$LOGDIR/vite.log" 2>&1)
  spawn vite "$PIDDIR/vite.pid" "$LOGDIR/vite.log" npm run dev --prefix ui
  if wait_http "http://localhost:$UI_PORT/" 25; then
    ok "dashboard up → http://localhost:$UI_PORT"
  else
    warn "dashboard slow or failed — check logs/vite.log"
    return 1
  fi
}

# True orchestrator health = its 1 Hz telemetry write loop is alive
# (telemetry.json modified within the last 10s), not a borrowed endpoint.
orch_healthy() {
  local age
  age=$("$NODE_BIN" -e "try{console.log(Math.floor(Date.now()-require('fs').statSync('$ROOT/database/telemetry.json').mtimeMs))}catch{console.log(9e9)}" 2>/dev/null)
  [ -n "$age" ] && [ "$age" -lt 10000 ]
}

# --- spawn helper: fully detached, logged, pidfile'd ------------------------
# macOS ships no setsid binary — use python's Popen(start_new_session=True)
# (the pattern proven to survive terminal exits and tool-timeout group kills).
PYBIN="${DAISY_PYTHON:-$HOME/daisy_env/bin/python}"
[ -x "$PYBIN" ] || PYBIN="/usr/bin/python3"
spawn() { # spawn <name> <pidfile> <logfile> <cmd...>
  local name="$1" pidfile="$2" logfile="$3"; shift 3
  local pid
  pid=$("$PYBIN" -c '
import os, subprocess, sys
log, cmd = sys.argv[1], sys.argv[2:]
out = open(log, "ab", buffering=0)
p = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL, start_new_session=True,
                     cwd=os.path.dirname(os.path.abspath(log)) + "/..")
print(p.pid)
' "$logfile" "$@")
  if [ -z "$pid" ]; then
    bad "failed to spawn $name (python spawner error)"
    return 1
  fi
  echo "$pid" > "$pidfile"
  note "spawned $name (pid $pid) → logs/$(basename "$logfile")"
}

wait_http() { # wait_http <url> <tries>
  local url="$1" tries="${2:-15}" i=0
  until curl -sf -o /dev/null -m 2 "$url" 2>/dev/null; do
    i=$((i+1)); [ "$i" -ge "$tries" ] && return 1
    sleep 1
  done
  return 0
}

# ============================================================================
cmd_start() {
  local mode="headless" ui="ui"
  for arg in "$@"; do
    case "$arg" in
      --shell) mode="shell" ;;
      --no-ui) ui="none" ;;
      *) warn "unknown flag $arg ignored" ;;
    esac
  done

  echo "▶ starting Daisy cluster ($mode)…"

  # --- shell mode: the desktop window owns the backend ---------------------
  if [ "$mode" = "shell" ]; then
    if shell_is_up; then
      ok "shell already running (pid $(shell_pid)) — it owns the orchestrator; nothing to do"
    else
      if [ ! -x "$SHELL_BIN" ]; then
        bad "shell binary missing ($SHELL_BIN) — build with: (cd src-tauri && cargo build)"
        exit 1
      fi
      spawn shell "$PIDDIR/shell.pid" "$LOGDIR/shell.log" "$SHELL_BIN"
      sleep 2
      if shell_is_up; then ok "shell up (pid $(shell_pid)) — window opened, backend spawned by shell"
      else bad "shell died immediately — see logs/shell.log"; exit 1; fi
    fi
  else
    # --- headless orchestrator (refuses next to the shell) -----------------
    if shell_is_up; then
      warn "desktop shell is running (pid $(shell_pid)) and already owns an orchestrator"
      note "use './clusterctl.sh restart --shell' or stop the shell before headless start"
    elif alive "$(orch_pid)"; then
      ok "orchestrator already running (pid $(orch_pid))"
    else
      [ -d ui/node_modules ] || (cd ui && npm install --no-audit --no-fund --loglevel=error >>"$LOGDIR/vite.log" 2>&1)
      spawn orchestrator "$PIDDIR/orchestrator.pid" "$LOGDIR/orchestrator.log" "$NODE_BIN" backend/index.js --serve
      sleep 1
      if alive "$(orch_pid)"; then ok "orchestrator up (pid $(orch_pid))"
      else bad "orchestrator died immediately — see logs/orchestrator.log"; exit 1; fi
    fi
  fi

  # --- telemetry server (always; cheap and useful) --------------------------
  if alive "$(telemetry_pid)"; then
    ok "telemetry-server already up (pid $(telemetry_pid))"
  else
    spawn telemetry "$PIDDIR/telemetry.pid" "$LOGDIR/telemetry.log" "$NODE_BIN" backend/telemetry-server.js --port "$TELEMETRY_PORT"
    if wait_http "http://127.0.0.1:$TELEMETRY_PORT/api/telemetry" 10; then
      ok "telemetry-server up on :$TELEMETRY_PORT"
    else
      bad "telemetry-server did not answer — see logs/telemetry.log"
    fi
  fi

  # --- vite dashboard (unless --no-ui) --------------------------------------
  if [ "$ui" = "none" ]; then
    note "dashboard skipped (--no-ui)"
  elif [ -n "$(vite_pid)" ]; then
    ok "dashboard already up (pid $(vite_pid)) → http://localhost:$UI_PORT"
  else
    spawn vite "$PIDDIR/vite.pid" "$LOGDIR/vite.log" npm run dev --prefix ui
    if wait_http "http://localhost:$UI_PORT/" 25; then
      ok "dashboard up → http://localhost:$UI_PORT"
    else
      warn "dashboard slow or failed — check logs/vite.log (orchestrator unaffected)"
    fi
  fi

  echo "✔ start complete — './clusterctl.sh status' for health"
}

# ============================================================================
stop_pid() { # stop_pid <pid> <label>
  local pid="$1" label="$2" i=0
  alive "$pid" || return 0
  kill "$pid" 2>/dev/null
  while alive "$pid" && [ "$i" -lt 5 ]; do sleep 1; i=$((i+1)); done
  if alive "$pid"; then kill -9 "$pid" 2>/dev/null; sleep 1; fi
  if alive "$pid"; then bad "$label (pid $pid) refused to die"; else ok "$label stopped"; fi
}

cmd_stop() {
  echo "■ stopping Daisy cluster…"
  stop_pid "$(orch_pid)"      "orchestrator"
  stop_pid "$(shell_pid)"     "shell (desktop window)"
  stop_pid "$(telemetry_pid)" "telemetry-server"
  stop_pid "$(vite_pid)"      "dashboard (vite)"
  # port sweep: catch orphans our patterns missed
  for port in "$TELEMETRY_PORT" "$UI_PORT"; do
    for pid in $(lsof -ti tcp:"$port" 2>/dev/null); do
      warn "orphan on :$port (pid $pid) — killing"; stop_pid "$pid" "orphan :$port"
    done
  done
  rm -f "$PIDDIR"/*.pid
  echo "✔ stop complete"
}

# ============================================================================
# doctor — lives in scripts/cluster_doctor.sh (single source of truth; it is
# also sourced by scripts/cluster.sh, so `cluster.sh doctor` and
# `clusterctl.sh doctor` run the SAME diagnostics). Loaded lazily below.
clusterctl_doctor() {
  if [ -f "$ROOT/scripts/cluster_doctor.sh" ]; then
    # The doctor fragment expects the same pinned-model vars cluster.sh
    # defines; provide them here (keep values in sync with cluster.sh §5.5).
    OLLAMA_BASE="${OLLAMA_BASE:-http://localhost:11434}"
    TIER2_MODEL="${TIER2_MODEL:-qwen2.5:7b}"
    TIER3_MODEL="${TIER3_MODEL:-~anthropic/claude-sonnet-latest}"
    ENVFILE="${ENVFILE:-$ROOT/.env}"
    PAUSE_FILE="$ROOT/.run/supervisor.paused"
    # Crash-loop guard state files (same contract as scripts/cluster.sh).
    HALT_FILE="$ROOT/.run/supervisor.halted"
    FAIL_FILE="$ROOT/.run/supervisor.bootfailures"
    MAX_CONSECUTIVE_FAILED_BOOTS="${DAISY_MAX_BOOT_FAILURES:-5}"
    AGENT_LABEL="com.daisy.cluster"
    AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
    APP_AGENT_LABEL="com.daisy.cluster.app"
    APP_AGENT_PLIST="$HOME/Library/LaunchAgents/$APP_AGENT_LABEL.plist"
    # shellcheck source=cluster_doctor.sh
    . "$ROOT/scripts/cluster_doctor.sh"
    cmd_doctor
  else
    warn "doctor script missing: $ROOT/scripts/cluster_doctor.sh"
    return 2
  fi
}

# ============================================================================
cmd_status() {
  local rc=0
  echo "Daisy cluster status — $(date '+%H:%M:%S')"
  echo "  ── REPO STACK — ~/daisy-chain (managed by clusterctl + launchd agent) ──"
  printf "  %-18s %-8s %s\n" "SERVICE" "PID" "HEALTH"

  local o="$(orch_pid)" t="$(telemetry_pid)" v="$(vite_pid)" s="$(shell_pid)"
  check() { # check <label> <pid> <probe-cmd>
    local label="$1" pid="$2"; shift 2
    if ! alive "$pid"; then printf "  %-18s %-8s %s✗ down%s\n" "$label" "-" "$c_red" "$c_off"; rc=1; return; fi
    if "$@" >/dev/null 2>&1; then printf "  %-18s %-8s %s✓ up%s\n" "$label" "$pid" "$c_green" "$c_off"
    else printf "  %-18s %-8s %s! pid alive, probe failed%s\n" "$label" "$pid" "$c_amber" "$c_off"; rc=1; fi
  }
  check orchestrator "$o" orch_healthy
  check telemetry-server "$t" curl -sf -m 2 "http://127.0.0.1:$TELEMETRY_PORT/api/telemetry"
  # Dashboard is a VIEWER, not core — it never gates the exit code (it may be
  # intentionally absent via --no-ui, or replaced by the installed app's window).
  if alive "$v"; then
    if curl -sf -m 2 "http://localhost:$UI_PORT/" >/dev/null 2>&1; then printf "  %-18s %-8s %s✓ up%s → http://localhost:%s\n" "dashboard-vite" "$v" "$c_green" "$c_off" "$UI_PORT"
    else printf "  %-18s %-8s %s! pid alive, probe failed%s\n" "dashboard-vite" "$v" "$c_amber" "$c_off"; fi
  else
    printf "  %-18s %-8s %s— not running (optional; ./clusterctl.sh start)%s\n" "dashboard-vite" "-" "$c_dim" "$c_off"
  fi
  if alive "$s"; then printf "  %-18s %-8s %s✓ up%s\n" "shell" "$s" "$c_green" "$c_off"
  else printf "  %-18s %-8s %s— not running%s\n" "shell" "-" "$c_dim" "$c_off"; fi

  # LaunchAgent supervisor (repo stack only — never manages the installed app).
  local sup="$(pgrep -f "scripts/cluster[.]sh supervise" 2>/dev/null | head -1)"
  if alive "$sup"; then
    local sup_note="✓ watching (heals core every 15s)"
    if [ -f "$ROOT/.run/supervisor.paused" ]; then
      sup_note="! PAUSED (manual stop; auto-resumes 10 min)"
    fi
    printf "  %-18s %-8s %s%s%s\n" "supervisor-agent" "$sup" "$c_green" "$sup_note" "$c_off"
  else
    printf "  %-18s %-8s %s— not running (install: scripts/cluster.sh install-agent)%s\n" "supervisor-agent" "-" "$c_dim" "$c_off"
  fi

  # live telemetry glance (repo stack)
  local tel
  tel=$(curl -sf -m 2 "http://127.0.0.1:$TELEMETRY_PORT/api/telemetry" 2>/dev/null) && \
    echo "$tel" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const t=JSON.parse(d);console.log('  live: cycle '+t.cycle+' · ram '+t.ramPct+'% · agents '+(t.pool?t.pool.size:'?')+' · queue pending '+(t.queue?t.queue.pending:'?')+' · burn '+((t.costs&&t.costs.burnProjection)?t.costs.burnProjection.dailyBurnUsd:'?')+'/day')}catch{}})" 2>/dev/null

  # ── INSTALLED APP — a second, fully independent runtime ─────────────────
  # Separate code (bundle payload), separate data (Application Support),
  # separate queue + key + cascade. clusterctl NEVER manages it.
  echo "  ── INSTALLED APP — /Applications/Daisy Cluster.app (independent) ──"
  local inst="$(installed_shell_pid)"
  local appdb="$HOME/Library/Application Support/DaisyCluster/database"
  if alive "$inst"; then
    printf "  %-18s %-8s %s✓ up%s\n" "app-shell" "$inst" "$c_green" "$c_off"
  else
    printf "  %-18s %-8s %s— not running (open the app to start it)%s\n" "app-shell" "-" "$c_dim" "$c_off"
  fi
  local aorch
  aorch=$(app_backend_pid)
  if alive "$aorch"; then
    printf "  %-18s %-8s %s✓ up%s · data 'Application Support/DaisyCluster'\n" "app-backend" "$aorch" "$c_green" "$c_off"
  elif alive "$inst"; then
    printf "  %-18s %-8s %s! shell up but backend missing%s\n" "app-backend" "-" "$c_amber" "$c_off"
  else
    printf "  %-18s %-8s %s—%s\n" "app-backend" "-" "$c_dim" "$c_off"
  fi
  # App login-autostart agent (managed by scripts/cluster.sh, informational).
  if [ -f "$HOME/Library/LaunchAgents/com.daisy.cluster.app.plist" ] || launchctl print "gui/$(id -u)/com.daisy.cluster.app" >/dev/null 2>&1; then
    if launchctl print "gui/$(id -u)/com.daisy.cluster.app" >/dev/null 2>&1; then
      printf "  %-18s %-8s %s✓ loaded%s · opens the app at login\n" "app-autostart" "-" "$c_green" "$c_off"
    else
      printf "  %-18s %-8s %s! plist present but not loaded%s\n" "app-autostart" "-" "$c_amber" "$c_off"
    fi
  fi
  # App telemetry freshness (its own file, its own clock) — informational.
  if [ -f "$appdb/telemetry.json" ]; then
    local age
    age=$("$NODE_BIN" -e "console.log(Math.max(0,Math.round((Date.now()-require('fs').statSync(process.argv[1]).mtimeMs)/1000)))" "$appdb/telemetry.json" 2>/dev/null || echo '?')
    if [ "$age" != '?' ] && [ "$age" -lt 10 ]; then
      printf "  %-18s %-8s %stelemetry FRESH (%ss ago)%s\n" "app-telemetry" "-" "$c_green" "$age" "$c_off"
    else
      printf "  %-18s %-8s %sstale/quiet (%ss)%s\n" "app-telemetry" "-" "$c_dim" "$age" "$c_off"
    fi
  else
    printf "  %-18s %-8s %s— (app never ran)%s\n" "app-telemetry" "-" "$c_dim" "$c_off"
  fi
  return $rc
}

# ============================================================================
cmd_logs() {
  local svc="${1:-all}" n="${2:-30}"
  show() { # show <file>
    if [ -f "$1" ]; then tail -n "$n" "$1"; else note "no $(basename "$1") yet"; fi
  }
  case "$svc" in
    orchestrator) show "$LOGDIR/orchestrator.log"; note "(shell-mode backend output is owned by the shell — see logs/shell.log)" ;;
    shell)        show "$LOGDIR/shell.log" ;;
    telemetry)    show "$LOGDIR/telemetry.log" ;;
    vite)         show "$LOGDIR/vite.log" ;;
    all)
      for f in orchestrator telemetry vite shell; do
        [ -f "$LOGDIR/$f.log" ] && { echo "──── logs/$f.log ────"; tail -n "$n" "$LOGDIR/$f.log"; }
      done
      [ -f "$LOGDIR/orchestrator.log" ] || [ -f "$LOGDIR/shell.log" ] || note "no logs yet" ;;
    *) warn "unknown service '$svc' (orchestrator|shell|telemetry|vite|all)"; exit 1 ;;
  esac
}

cmd_task() {
  [ -n "${1:-}" ] || { bad "usage: ./clusterctl.sh task '{\"kind\":...,\"payload\":{...}}'"; exit 1; }
  exec "$NODE_BIN" backend/index.js --enqueue "$1"
}

doctor_raw() { # doctor_raw — status-side probes (live, no header/foot)
  local o="$(orch_pid)" t="$(telemetry_pid)" v="$(vite_pid)" s="$(shell_pid)"
  local aorch="$(app_backend_pid 2>/dev/null)" inst="$(installed_shell_pid 2>/dev/null)"
  echo "REPO_PID_ORCH=$o"; echo "REPO_PID_TELEM=$t"; echo "REPO_PID_VITE=$v"; echo "REPO_PID_SHELL=$s"
  echo "APP_PID_SHELL=$inst"; echo "APP_PID_BACKEND=$aorch"
  local sup="$(pgrep -f "scripts/cluster[.]sh supervise" 2>/dev/null | head -1)"; echo "SUPERVISOR_PID=$sup"
  local supervoloaded=0; [ -n "$sup" ] && kill -0 "$sup" 2>/dev/null && supervoloaded=1; echo "SUPERVISOR_LOADED=$supervoloaded"
  if [ -f "$ROOT/.run/supervisor.paused" ]; then echo "SUPERVISOR_PAUSED=1"; else echo "SUPERVISOR_PAUSED=0"; fi
  echo "TELEFRESH=$(if [ -f "$ROOT/database/telemetry.json" ]; then "$NODE_BIN" -e "try{console.log(Math.floor(Date.now()-require('fs').statSync('$ROOT/database/telemetry.json').mtimeMs));process.exit(0)}catch{console.log(999999);process.exit(0)}" 2>/dev/null || echo 999999; else echo 999999; fi)"
  echo "TELEMHTTP=$(curl -sf -m 2 "http://127.0.0.1:$TELEMETRY_PORT/api/telemetry" >/dev/null 2>&1 && echo 1 || echo 0)"
  echo "APPTELEMFILE=$(test -f "$HOME/Library/Application Support/DaisyCluster/database/telemetry.json" && echo 1 || echo 0)"
  if [ "$(test -f "$HOME/Library/Application Support/DaisyCluster/database/telemetry.json" && echo 1 || echo 0)" = "1" ]; then
    echo "APPTELEMFRESH=$(python3 -c "import os,time;print(int(max(0,(time.time()-os.path.getmtime(os.path.expanduser('$HOME/Library/Application Support/DaisyCluster/database/telemetry.json'))))) if __name__=='__main__' else 0)" 2>/dev/null || echo '?')"
  else echo "APPTELEMFRESH=never"; fi
  echo "APPKEYFILE=$(test -f "$HOME/Library/Application Support/DaisyCluster/.env" && echo 1 || echo 0)"
  echo "OLLAMA_BASE=$OLLAMA_BASE"; echo "TIER2_MODEL=$TIER2_MODEL"; echo "TIER3_MODEL=$TIER3_MODEL"
  echo "OLLAMA_UP=$(curl -sf -m 3 "$OLLAMA_BASE/api/tags" >/dev/null 2>&1 && echo 1 || echo 0)"
  echo "OLLAMA_MODEL=$(curl -sf -m 8 "$OLLAMA_BASE/api/tags" 2>/dev/null | python3 -c "import sys,json;print(1 if any(any(m.get('name','').startswith('$TIER2_MODEL') for m in data.get('models',[])) for data in [json.load(sys.stdin)] if data) else 0)" 2>/dev/null || echo '?')"
  # App backend residency via /api/ps (the real keep_alive signal).
  echo "OLLAMA_RESIDENT=$(curl -sf -m 8 "$OLLAMA_BASE/api/ps" 2>/dev/null | python3 -c "import sys,json;print(1 if any(any((d.get('name','')=='$TIER2_MODEL' or d.get('name','').startswith('$TIER2_MODEL') or d.get('model','')=='$TIER2_MODEL') for d in data.get('models',[])) for data in [json.load(sys.stdin)] if data) else 0)" 2>/dev/null || echo '?')"
  echo "SPOKEN_TIER2=$(test -f "$ROOT/database/telemetry.json" && python3 -c "import json,os;try:print(next((e.get('meta',{}).get('tier2Spoken') or 0) for e in list(reversed(json.load(open('$ROOT/database/telemetry.json')).skill_events)) if e.get('kind') in ('tier2','tier2-rejected') and e.get('meta',{}).get('tier2Spoken')));except:print(0)" 2>/dev/null || echo '?')"
}

# --- Dashboard login autostart -----------------------------------------------
DASHBOARD_AGENT_LABEL="com.daisy.cluster.dashboard"
DASHBOARD_AGENT_PLIST="$HOME/Library/LaunchAgents/$DASHBOARD_AGENT_LABEL.plist"

write_dashboard_agent_plist() {
  cat > "$DASHBOARD_AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DASHBOARD_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${ROOT}/clusterctl.sh</string>
    <string>dashboard</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>${ROOT}/logs/dashboard-agent.log</string>
  <key>StandardErrorPath</key><string>${ROOT}/logs/dashboard-agent.log</string>
</dict>
</plist>
PLIST
}

cmd_install_dashboard_agent() {
  local unload_first=0
  [ "${1:-}" = "--unload-first" ] && unload_first=1
  mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"
  if launchctl print "gui/$(id -u)/$DASHBOARD_AGENT_LABEL" >/dev/null 2>&1; then
    if [ "$unload_first" = "1" ]; then
      log "dashboard agent already loaded — unloading first (--unload-first)"
      cmd_uninstall_dashboard_agent --keep-running >/dev/null 2>&1 || true
    else
      log "dashboard agent already loaded — nothing to do (use --unload-first to reload)"
      return 0
    fi
  fi
  log "writing $DASHBOARD_AGENT_PLIST"
  write_dashboard_agent_plist
  if ! plutil -lint "$DASHBOARD_AGENT_PLIST" >/dev/null; then fail "generated plist failed lint"; exit 2; fi
  ok "plist lint passed"
  log "loading dashboard agent (bootstrap gui/$(id -u)) — vite will spawn at login"
  if ! launchctl bootstrap "gui/$(id -u)" "$DASHBOARD_AGENT_PLIST" 2>/dev/null; then
    fail "bootstrap failed (see $ROOT/logs/dashboard-agent.log)"
    exit 2
  fi
  sleep 6
  cmd_status | grep -A1 "dashboard-agent" || true
  log "dashboard is login-autostart — close the browser tab any time; it re-opens at next login"
}

cmd_uninstall_dashboard_agent() {
  local keep=0
  [ "${1:-}" = "--keep-running" ] && keep=1
  if launchctl print "gui/$(id -u)/$DASHBOARD_AGENT_LABEL" >/dev/null 2>&1; then
    log "booting out dashboard agent (does NOT kill a running vite)"
    launchctl bootout "gui/$(id -u)/$DASHBOARD_AGENT_LABEL" 2>/dev/null || true
    ok "dashboard autostart removed"
  else
    log "dashboard agent not loaded"
  fi
  [ -f "$DASHBOARD_AGENT_PLIST" ] && rm -f "$DASHBOARD_AGENT_PLIST" && ok "dashboard plist removed"
  :
}

case "${1:-help}" in
  doctor)       clusterctl_doctor ;;
  start)        shift; cmd_start "$@" ;;
  stop)         cmd_stop ;;
  restart)      shift; cmd_stop; cmd_start "$@" ;;
  status)       cmd_status ;;
  logs)         shift; cmd_logs "$@" ;;
  task)         shift; cmd_task "$@" ;;
  dashboard)           cmd_dashboard ;;
  install-dashboard-agent)  shift; cmd_install_dashboard_agent "$@" ;;
  uninstall-dashboard-agent) shift; cmd_uninstall_dashboard_agent "$@" ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
