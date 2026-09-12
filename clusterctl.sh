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
NODE_BIN="/usr/local/bin/node"

mkdir -p "$PIDDIR" "$LOGDIR"
[ -f "$ENVFILE" ] && set -a && . "$ENVFILE" && set +a   # load key into env (silently)

c_green=$'\033[32m'; c_red=$'\033[31m'; c_amber=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
ok()   { printf "  %s✓%s %s\n" "$c_green" "$c_off" "$1"; }
bad()  { printf "  %s✗%s %s\n" "$c_red" "$c_off" "$1"; }
warn() { printf "  %s!%s %s\n" "$c_amber" "$c_off" "$1"; }
note() { printf "  %s%s%s\n" "$c_dim" "$1" "$c_off"; }

# --- service discovery (pgrep by command shape; ports as fallback) ----------
orch_pid()     { pgrep -f "node .*backend/index[.]js --serve" | head -1; }
telemetry_pid(){ pgrep -f "backend/telemetry-server[.]js" | head -1; }
vite_pid()     { lsof -ti tcp:"$UI_PORT" 2>/dev/null | head -1; }
shell_pid()    { pgrep -x "daisy-cluster" | head -1; }
alive()        { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

shell_is_up() { alive "$(shell_pid)"; }

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
cmd_status() {
  local rc=0
  echo "Daisy cluster status — $(date '+%H:%M:%S')"
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
  check dashboard-vite "$v" curl -sf -m 2 "http://localhost:$UI_PORT/"
  if alive "$s"; then printf "  %-18s %-8s %s✓ up%s\n" "shell" "$s" "$c_green" "$c_off"
  else printf "  %-18s %-8s %s— not running%s\n" "shell" "-" "$c_dim" "$c_off"; fi

  # live telemetry glance
  local tel
  tel=$(curl -sf -m 2 "http://127.0.0.1:$TELEMETRY_PORT/api/telemetry" 2>/dev/null) && \
    echo "$tel" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const t=JSON.parse(d);console.log('  live: cycle '+t.cycle+' · ram '+t.ramPct+'% · agents '+(t.pool?t.pool.size:'?')+' · queue pending '+(t.queue?t.queue.pending:'?'))}catch{}})" 2>/dev/null
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

case "${1:-help}" in
  start)   shift; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  restart) shift; cmd_stop; cmd_start "$@" ;;
  status)  cmd_status ;;
  logs)    shift; cmd_logs "$@" ;;
  task)    shift; cmd_task "$@" ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
