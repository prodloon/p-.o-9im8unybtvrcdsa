# Daisy Chain Cluster — Runbook

Operations manual for the Hybrid Cloud-Local Multi-Agent Cluster.
Architecture and session history live in `knowledge.md`; this file is the
*how do I drive it* manual.

---

## 0. Prerequisites

| Requirement | Check | Notes |
|---|---|---|
| Node ≥ 26 (built-in `node:sqlite`) | `node --version` | v26.7.0 on this machine |
| Rust toolchain (shell only) | `cargo --version` | 1.97.1; only needed for the Tauri UI |
| Python 3.9 venv (harness only) | `~/daisy_env/bin/python --version` | runs the selftest batteries |
| OpenRouter API key (optional) | `echo $OPENROUTER_API_KEY` | without it, cluster runs on local sniping |

## 1. Starting the cluster

**One command — the whole stack** (preferred):
```bash
cd ~/daisy-chain
./clusterctl.sh start --shell   # desktop shell + dashboard + telemetry
./clusterctl.sh start           # headless orchestrator + telemetry + dashboard
./clusterctl.sh start --no-ui   # headless, no vite
```

Everything else is a wrapper around clusterctl now:

```bash
./clusterctl.sh status          # service table + health probes (exit 0 = all green)
./clusterctl.sh logs [svc] [n]  # orchestrator|shell|telemetry|vite|all
./clusterctl.sh task '<json>'   # enqueue one task
./clusterctl.sh restart [--shell]
./clusterctl.sh stop            # pidfiles + port sweep; kills shell last
```

Notes:
- `OPENROUTER_API_KEY` is loaded automatically from the gitignored `.env` —
  no exports needed.
- **Never run a headless orchestrator while the desktop shell is up** — the
  shell owns its own backend; `start` refuses and tells you.
- Children are spawned session-detached (python `start_new_session`) —
  they survive terminal closes.

---

### Legacy manual methods (still work; clusterctl adopts them)

**Headless (orchestrator only):**
```bash
cd ~/daisy-chain
export OPENROUTER_API_KEY=sk-or-...   # optional but recommended
node backend/index.js --serve         # loop: governor tick + queue drain + telemetry
```

**With telemetry in a browser (dev loop):**
```bash
node backend/telemetry-server.js &    # loopback :6292
cd ui && npm run dev                  # Vite dev server, open the printed URL
```

**Desktop shell (production feel):**
```bash
cd src-tauri && cargo tauri dev       # spawns backend + window with native IPC
# release build: cargo tauri build → bundled .app
```

The Rust shell spawns/kills the backend automatically; do not run
`--serve` manually when using the shell.

## 2. Feeding it work

```bash
# deterministic (no cloud consult):
node backend/index.js --enqueue '{"kind":"file-io","payload":{"action":"write_file","params":{"path":"notes/x.txt","content":"hi"}}}'

# cognitive (SNIPE gate → supervisor verdict or local snipe):
node backend/index.js --enqueue '{"kind":"scaffold","payload":{"action":"SNIPE","needsSkill":true,"summary":"scaffold an express api for invoices"}}'
```

Task kinds map to worker specialties; payloads are `{action, params}` from
the worker's deterministic action library (`backend/worker.js`).
`needsSkill:true` routes the task through skill-sniping.

## 3. One-shot mode (cron-friendly)

`node backend/index.js` (no flags) runs exactly one drain cycle, writes
`database/telemetry.json`, prints stats JSON, and exits. Good for
LaunchAgent/cron-driven operation without a resident process.

## 4. Monitoring

- **Live metrics:** `database/telemetry.json` (1 Hz, atomic rename) or
  `curl http://127.0.0.1:6292/api/telemetry` with the telemetry server up.
- **Per-agent table:** the dashboard's AGENTS panel renders `pool.workers[]`
  from telemetry — one row per agent: phase, attributed cpu %, exact state
  size, cumulative busy time, steps. Memory attribution: workers are
  in-process state machines, so `cpuPct` is the agent's share of the host
  event loop (busy delta / interval) and RSS is the host process split
  evenly per live agent. `stateBytes` is exactly what hibernation writes
  to `worker_states`.
- **Audit trail:** `database/agent-states.sqlite`
  - `governor_log` — hibernations, reaps, spawn blocks, lease requeues
  - `skill_events` — every skill injection (**source = winning cascade tier**:
    `tier1-template` / `tier2-local` / `supervisor` / `local-fallback`)
  - `task_queue` — full task history with attempts and outcomes
  - `workers.cpu_pct / state_bytes / busy_ms` — per-agent usage history

### 4.1 The 3-Tier cascade (what handled each task, and what it cost)

Every supervisor consult descends **T1 local templates ($0) → T2 Ollama
qwen2.5:7b ($0) → T3 OpenRouter `~anthropic/claude-sonnet-latest`** (full
retry/backoff chain). The orchestrator log prints the route per task
(`task 27 → tier2-local (qwen2.5:7b) in 22897ms`) and per-cycle tier totals;
`telemetry.json → cascade` carries live per-tier counts, the pinned model
strings, and the last route for the dashboard's **Supervisor pipeline** panel.

Live-routing cheat sheet (all three verified in production):

| You will see | Meaning | Cost |
|---|---|---|
| `→ tier1-template (skillbase-templates) in 1ms` | trigger match sniped locally | $0 |
| `→ tier2-local (qwen2.5:7b) in ~20-30s` | local LLM triaged it (cold start can push past 100s) | $0 |
| `→ supervisor (~anthropic/claude-sonnet-latest) in ~2-3s` | frontier brain consulted | tokens |
| `→ supervisor` + `no skill found` | T3 consulted and honestly declined (no skill fits) | tokens |
| `fallback=1` | everything above declined; keyword snipe caught it | $0 |

Tier-2/3 mappings are **PERMANENT** (knowledge.md §5.5): T2 =
`qwen2.5:7b` @ `http://localhost:11434`, T3 =
`~anthropic/claude-sonnet-latest` exclusively (no cloud fallback). Only
`DAISY_OLLAMA_TIMEOUT_MS` (default 120 s) and `DAISY_WARM_TIER2=1`
(pre-load Ollama weights at boot) are tunable. The full
contract lives in `knowledge.md` §5.5 — the COST LAW. Boot-order checks
(db/WAL → Ollama → key → orchestrator) are automated in `scripts/cluster.sh`.
- **Quick introspection:**
  ```bash
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('database/agent-states.sqlite');console.table(db.prepare('SELECT event,COUNT(*) n FROM governor_log GROUP BY event').all())"
  # heaviest agents by serialized state:
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('database/agent-states.sqlite');console.table(db.prepare('SELECT id,kind,state,cpu_pct,state_bytes,busy_ms FROM workers ORDER BY state_bytes DESC LIMIT 10').all())"
  ```

## 5. Stopping

- **`./clusterctl.sh stop`** — the one command (orchestrator → shell →
  telemetry → dashboard, then an orphan port sweep). SQLite is crash-safe
  (WAL); mid-task leases expire after 60s + 10s grace and tasks auto-requeue.
- Shell window: closing it also works (child reaper kills the backend),
  then `./clusterctl.sh stop` for the remaining helpers.
- Headless: Ctrl-C the `--serve` process equally works.

## 6. Verification (run after any change)

```bash
node governor/governor.selftest.js     # 56 checks
node backend/backend.selftest.js       # 61 checks
~/daisy_env/bin/python daisy_cluster_selftest.py   # end-to-end, incl. clusterctl
```

All three green = launch-ready. The Python battery also asserts the legacy
`daisy_*.py` files remain untouched.

## 7. Release app (installed .app)

The desktop shell ships as a normal macOS app:

```bash
./make-installer.sh               # tauri build + stage payload + install to /Applications
./make-installer.sh --skip        # restage payload + reinstall (no cargo rebuild)
open '/Applications/Daisy Cluster.app'
```

Layout:
- **Code:** the bundle carries `backend/`, `governor/`, `skillbase/` in
  `Contents/Resources/appdata/` (no secrets, no node_modules, no state).
- **State:** `~/Library/Application Support/DaisyCluster/{database,sandbox}/`
  (the shell sets `DAISY_DATA_DIR`/`DAISY_SANDBOX_DIR` automatically — the
  bundle is read-only in /Applications).
- **Secrets:** `~/Library/Application Support/DaisyCluster/.env` — put
  `OPENROUTER_API_KEY=…` there; the shell loads it at backend spawn.
- **A DMG** for sharing lands in `src-tauri/target/release/bundle/dmg/`.

The installed app and the repo stack are INDEPENDENT (separate data dirs,
separate queues). `clusterctl` manages the repo stack only and shows the
installed app's presence informationally.

Rebuild after backend/governor changes: `./make-installer.sh` (full) —
the payload is re-staged automatically.

## 8. Known constraints

- 16 GiB ceiling: hibernation ≥80%, spawn block ≥90% (policy in
  `governor/governor.js`; contract in `knowledge.md §4`).
- Workers are sandboxed to `daisy_sandbox_cluster/` — path escapes are
  refused; no shell execution anywhere in the cluster.
- `OPENROUTER_API_KEY` must never be committed; it is read from env only.
- Offline mode is fully functional via local keyword sniping — cloud loss
  degrades skill quality, never availability.
