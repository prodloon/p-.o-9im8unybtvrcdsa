#!/usr/bin/env bash
# cmd_doctor - cluster self-diagnosis
cmd_doctor() {
  echo "Daisy Chain diagnostics - $(date '+%H:%M:%S')"
  echo "----------------------------------------------------------------"
  echo ""

  # Self-sufficient node resolution: clusterctl sets NODE_BIN, cluster.sh
  # does not (it uses plain `node`) — under `set -u` an unbound NODE_BIN
  # killed every DB probe below. Resolve once, silently.
  NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || echo node)}"

  # 1. DB integrity
  echo "- DB INTEGRITY -"
  local db_path="$ROOT/database/agent-states.sqlite"
  if [ -f "$db_path" ]; then
    local integrity rc=0
    integrity=$("$NODE_BIN" -e "
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(process.argv[1], { open: true });
  const row = db.prepare('PRAGMA integrity_check').get();
  db.close();
  process.stdout.write(row && row.integrity_check === 'ok' ? 'ok' : 'FAIL:' + (row ? row.integrity_check : 'norow'));
  process.exit(row && row.integrity_check === 'ok' ? 0 : 1);
} catch (e) {
  process.stdout.write('ERROR:' + (e.code || e.message || String(e)));
  process.exit(2);
}
" "$db_path" 2>/dev/null) || rc=$?
    case "$rc:$integrity" in
      0:ok)  ok "SQLite integrity_check: $integrity" ;;
      *:ok)  ok "SQLite integrity_check: $integrity (exit=$rc)" ;;
      *)     warn "SQLite integrity_check: $integrity (exit=$rc)" ;;
    esac
  else
    warn "SQLite database missing: $db_path - run start to initialize"
  fi

  if [ -f "$db_path" ]; then
    local wal journal tables
    wal=$("$NODE_BIN" -e "
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(process.argv[1], { open: true });
  const j = db.prepare('PRAGMA journal_mode').get();
  const t = db.prepare(\"SELECT COUNT(*) n FROM sqlite_master WHERE type='table'\").get();
  db.close();
  process.stdout.write((j && j.journal_mode || 'unknown') + '|' + (t && t.n != null ? t.n : -1));
  process.exit(0);
} catch (e) {
  process.stdout.write('ERROR:' + (e.message || String(e)));
  process.exit(2);
}
" "$db_path" 2>/dev/null) || wal="ERROR:$?"
    IFS='|' read -r journal tables <<< "$wal" || true
    if [ "$journal" = "wal" ]; then
      ok "WAL journal mode: $journal"
    else
      warn "WAL journal mode: $journal (expected wal)"
    fi
    if [ "$tables" -gt 0 ] 2>/dev/null; then
      ok "schema tables present: $tables"
    else
      warn "schema tables present: $tables"
    fi
  fi
  echo ""

  # 2. Live model-pin probes
  echo "- LIVE MODEL-PIN PROBES -"
  local ollama_up=0 ollama_model="" ollama_ps=""
  # NOTE: Ollama has NO /health endpoint — /api/tags is the canonical
  # liveness probe (matches cluster.sh ollama_healthy()); /health 404s and
  # made a healthy server report as down.
  if curl -sf -m 4 "$OLLAMA_BASE/api/tags" >/dev/null 2>&1; then
    ok "Ollama health: up @ $OLLAMA_BASE"
    ollama_up=1
  else
    warn "Ollama health: down/unreachable @ $OLLAMA_BASE"
  fi
  if [ "$ollama_up" = "1" ]; then
    ollama_model=$("$NODE_BIN" -e "
const http = require('http');
const u = new URL(process.argv[1]);
const model = process.argv[2];
http.get(u, { timeout: 8000 }, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const b = JSON.parse(d);
      // GOTCHA: the pinned model is fully qualified ("qwen2.5:7b"); comparing
      // name.split(':')[0] against it can never match ("qwen2.5" !== "qwen2.5:7b").
      // Match exact tag or a quant-suffixed variant ("qwen2.5:7b:Q4_K_M").
      const found = Array.isArray(b.models) && b.models.some(m => (m.name||'') === model || (m.name||'').startsWith(model + ':'));
      process.stdout.write(found ? 'present' : 'missing');
      process.exit(0);
    } catch(e) { process.stdout.write('error'); process.exit(2); }
  });
}).on('error', e => { process.stdout.write('error'); process.exit(2); });
" "$OLLAMA_BASE/api/tags" "$TIER2_MODEL" 2>/dev/null) || ollama_model="error"
    case "$ollama_model" in
      present) ok "Tier-2 model present: $TIER2_MODEL" ;;
      missing) warn "Tier-2 model missing: $TIER2_MODEL" ;;
      *)       warn "Tier-2 model probe: $ollama_model" ;;
    esac
    ollama_ps=$("$NODE_BIN" -e "
const http = require('http');
const u = new URL(process.argv[1]);
const expected = process.argv[2];
http.get(u, { timeout: 8000 }, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const b = JSON.parse(d);
      const models = Array.isArray(b.models) ? b.models : [];
      const hit = models.find(m => ((m.name||'')+(m.model||'')).includes(expected));
      if (hit) {
        const ka = hit.keep_alive != null ? String(hit.keep_alive) : 'unknown';
        const gb = hit.size_mb != null ? (hit.size_mb/1024).toFixed(1) : '?';
        process.stdout.write('resident|' + (hit.name||hit.model||'?') + '|' + ka + '|' + gb + 'GB');
      } else process.stdout.write('not-loaded|' + expected);
      process.exit(0);
    } catch(e) { process.stdout.write('error'); process.exit(2); }
  });
}).on('error', e => { process.stdout.write('error'); process.exit(2); });
" "$OLLAMA_BASE/api/ps" "$TIER2_MODEL" 2>/dev/null) || ollama_ps="error"
    case "$ollama_ps" in
      resident\|*)
        # probe emits: resident|name|keep_alive|sizeGB
        local rname="" rka="" rsize="" _type=""
        IFS='|' read -r _type rname rka rsize <<< "$ollama_ps"
        if [ "$rka" = "-1" ] || [ "$rka" = "0" ]; then
          ok "Tier-2 residency: $rname resident ($rsize GB, keep_alive=$rka -> weights pinned)"
        else
          ok "Tier-2 residency: $rname loaded ($rsize GB, keep_alive=$rka)"
        fi ;;
      not-loaded) warn "Tier-2 residency: $TIER2_MODEL not loaded in Ollama" ;;
      *)          warn "Tier-2 residency probe: $ollama_ps" ;;
    esac
  fi
  ok "Tier-3 model pinned: $TIER3_MODEL (verify in backend/supervisor-bridge.js POLICY.TIER3_MODEL)"
  echo ""

  # 3. Key presence
  echo "- KEY PRESENCE -"
  local key_ok=1
  if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY:-}" != "" ]; then
    ok "OPENROUTER_API_KEY: present in environment (length ${#OPENROUTER_API_KEY})"
  else
    warn "OPENROUTER_API_KEY: not in environment"
    key_ok=0
  fi
  if [ -f "$ENVFILE" ]; then
    if grep -q '^OPENROUTER_API_KEY=' "$ENVFILE" 2>/dev/null; then
      ok "OPENROUTER_API_KEY: present in $ENVFILE (gitignored)"
    else
      warn "OPENROUTER_API_KEY: not found in $ENVFILE"
      key_ok=0
    fi
  else
    warn ".env file missing: $ENVFILE"
    key_ok=0
  fi
  local app_env="$HOME/Library/Application Support/DaisyCluster/.env"
  if [ -f "$app_env" ]; then
    if grep -q '^OPENROUTER_API_KEY=' "$app_env" 2>/dev/null; then
      ok "App-bundle OPENROUTER_API_KEY: present in $app_env"
    else
      warn "App-bundle OPENROUTER_API_KEY: not found in $app_env"
    fi
  else
    echo "    App-bundle .env: not present (app may not have run yet)"
  fi
  [ "$key_ok" = "0" ] && warn "Tier-3 will fail clean without a key - cascade degrades to Tiers 1-2"
  echo ""

  # 4. Recent heal history
  echo "- HEAL HISTORY / SUPERVISOR STATE -"
  local sup_pid=$(pgrep -f "scripts/cluster.sh supervise" 2>/dev/null | head -1 || true)
  if [ -n "$sup_pid" ] && kill -0 "$sup_pid" 2>/dev/null; then
    ok "Supervisor agent running: pid $sup_pid"
  else
    warn "Supervisor agent: not running (install with: scripts/cluster.sh install-agent)"
  fi
  if [ -f "$PAUSE_FILE" ]; then
    local pm=$(stat -f %m "$PAUSE_FILE" 2>/dev/null || stat -c %Y "$PAUSE_FILE" 2>/dev/null || echo 0)
    local pa=$(( $(date +%s) - pm ))
    if [ "$pa" -lt 600 ]; then
      warn "Supervisor paused: manual stop active (resumes in $((600-pa))s; age ${pa}s)"
    else
      ok "Supervisor pause: expired (${pa}s) - should auto-resume"
    fi
  else
    ok "Supervisor pause: not paused"
  fi
  # Crash-loop guard state: consecutive-failure counter + halt marker.
  local failstreak=0
  [ -f "$FAIL_FILE" ] && failstreak=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
  if [ -f "${HALT_FILE:-/nonexistent}" ]; then
    fail "Supervisor HALTED: crash-loop guard tripped (healing stopped) - resume with: scripts/cluster.sh restart or clear-halt"
  elif [ "$failstreak" -gt 0 ] 2>/dev/null; then
    warn "Boot-failure streak: $failstreak/${MAX_CONSECUTIVE_FAILED_BOOTS:-5} consecutive - guard halts healing at the limit"
  else
    ok "Crash-loop guard: armed (halts healing after ${MAX_CONSECUTIVE_FAILED_BOOTS:-5} consecutive failed boots), streak 0"
  fi
  if [ -f "$AGENT_PLIST" ]; then
    if launchctl print "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1; then
      ok "LaunchAgent loaded: $AGENT_LABEL"
    else
      warn "LaunchAgent plist present but not loaded: $AGENT_PLIST"
    fi
  else
    warn "LaunchAgent plist missing: $AGENT_PLIST"
  fi
  if [ -f "$APP_AGENT_PLIST" ]; then
    if launchctl print "gui/$(id -u)/$APP_AGENT_LABEL" >/dev/null 2>&1; then
      ok "App autostart agent loaded: $APP_AGENT_LABEL"
    else
      warn "App autostart plist present but not loaded: $APP_AGENT_PLIST"
    fi
  fi
  if [ -d "$ROOT/logs" ] && [ -f "$ROOT/logs/launchd-agent.log" ]; then
    local hc=$(grep -c "healing" "$ROOT/logs/launchd-agent.log" 2>/dev/null || echo 0)
    if [ "$hc" -gt 0 ] 2>/dev/null; then
      ok "Heal events in launchd log: $hc"
      local lh=$(grep "healing" "$ROOT/logs/launchd-agent.log" 2>/dev/null | tail -1 || true)
      [ -n "$lh" ] && echo "      $lh"
    else
      echo "      No heal events recorded yet"
    fi
    local ll=$(wc -l < "$ROOT/logs/launchd-agent.log" 2>/dev/null || echo 0)
    echo "    launchd-agent.log: $ll lines"
  else
    warn "logs directory or launchd-agent.log missing"
  fi
  echo ""

  # 5. Service reachability
  echo "- SERVICE REACHABILITY -"
  if [ -f "$ROOT/database/telemetry.json" ]; then
    local ta=$(( $(date +%s) - $(stat -f %m "$ROOT/database/telemetry.json" 2>/dev/null || stat -c %Y "$ROOT/database/telemetry.json" 2>/dev/null || echo 0) ))
    if [ "$ta" -lt 10 ]; then
      ok "Telemetry file fresh: ${ta}s ago"
    else
      warn "Telemetry file stale: ${ta}s ago (orchestrator may be down)"
    fi
  else
    warn "Telemetry file missing: $ROOT/database/telemetry.json"
  fi
  local tp="${DAISY_TELEMETRY_PORT:-6292}"
  if curl -sf -m 3 "http://127.0.0.1:$tp/api/telemetry" >/dev/null 2>&1; then
    ok "Telemetry HTTP endpoint: up on port $tp"
  else
    warn "Telemetry HTTP endpoint: unreachable on port $tp"
  fi
  echo ""
  echo "----------------------------------------------------------------"
  local ec=0
  [ "$key_ok" = "0" ] && ec=1
  [ "$ollama_up" = "0" ] && ec=1
  echo "Done. Exit code: $ec"
  return $ec
}
