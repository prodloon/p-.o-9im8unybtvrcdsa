#!/usr/bin/env bash
#
# scripts/cluster.sh — boot sequence for the local orchestration cluster.
# =============================================================================
#   scripts/cluster.sh start    governor/DB preflight → Ollama checks →
#                               orchestrator + telemetry up (idempotent)
#   scripts/cluster.sh stop     clean termination (orchestrator, telemetry,
#                               ollama-if-we-started-it, orphan sweep)
#   scripts/cluster.sh status   services + cascade pins + Ollama health
#   scripts/cluster.sh restart  stop, then start
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

cmd_start() {
  log "booting Daisy cluster (boot order: T1 persistence → T2 ollama → T3 key → orchestrator)"
  db_preflight || exit 2
  tier2_preflight || true      # degraded-ok, never fatal
  tier3_preflight
  log "starting services (clusterctl)"
  "$CTL" start --no-ui         # headless by default; pass --shell via args if you want the desktop shell
  log "boot complete — pins: T1 skillbase · T2 $TIER2_MODEL · T3 $TIER3_MODEL"
}

cmd_stop() {
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
}

cmd_logs() {
  local svc="${1:-all}"
  case "$svc" in
    ollama) [ -f "$ROOT/logs/ollama.log" ] && tail -n 40 "$ROOT/logs/ollama.log" || echo "(no ollama log yet)" ;;
    *) "$CTL" logs "$svc" ;;
  esac
}

case "${1:-status}" in
  start)   shift || true; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; sleep 1; cmd_start ;;
  status)  cmd_status ;;
  task)    shift; "$CTL" task "$@" ;;
  logs)    shift || true; cmd_logs "${1:-all}" ;;
  *) echo "usage: scripts/cluster.sh {start|stop|restart|status|task '<json>'|logs [svc]}"; exit 2 ;;
esac
