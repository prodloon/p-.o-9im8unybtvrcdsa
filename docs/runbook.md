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

**Preferred: let it run itself** (login autostart + self-heal):
```bash
cd ~/daisy-chain
./scripts/cluster.sh install-agent      # once — survives reboots, heals crashes
./scripts/cluster.sh install-app-agent  # once — opens the installed app at login
./scripts/cluster.sh uninstall-agent    # remove supervisor (stops services unless --keep-running)
./scripts/cluster.sh uninstall-app-agent # remove app autostart (never quits a running app)
```
Two agents, two jobs:
- `com.daisy.cluster` runs `scripts/cluster.sh supervise`: boot the repo
  stack at login, then a 15 s watchdog re-runs the (idempotent) boot when a
  core service dies. Consequences:
  - `./scripts/cluster.sh stop` **pauses the supervisor for 10 min**
    (otherwise the healer would re-boot the stack within seconds);
    `start`/`restart` clear the pause immediately.
  - The supervisor itself is launchd-protected: kill it, launchd respawns it.
  - **Crash-loop guard:** after 5 consecutive failed boots *or* heals
    (`DAISY_MAX_BOOT_FAILURES` in `.env` to change), the supervisor HALTS —
    macOS notification + `ALERT` line in `logs/launchd-agent.log` +
    `.run/supervisor.halted` — and stops healing instead of crash-looping
    forever. The streak counter lives in `.run/supervisor.bootfailures` and
    survives supervisor restarts; one healthy tick clears it. A relaunched
    supervisor sees the halt marker and idles (launchd would otherwise
    respawn it straight back into the boot storm). Resume with
    `./scripts/cluster.sh restart` (fix-then-reboot) or
    `./scripts/cluster.sh clear-halt` (re-arm as-is); `status` and `doctor`
    surface the halt and the live streak.
  - Healing covers orchestrator + telemetry (+ Ollama when the agent owns
    it) — the dashboard (vite) is a viewer and is not re-spawned.
- `com.daisy.cluster.app` is RunAtLoad-only `/usr/bin/open '/Applications/
  Daisy Cluster.app'` at login — deliberately **no KeepAlive** (a GUI app
  stays user-closable; `open` exits instantly, so KeepAlive would loop).
  The app's single-instance guard makes double-launch harmless.
- Logs: `logs/launchd-agent.log` (supervisor) — status shows both agent lines.

**One command — the whole stack** (manual control):
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

- **Cost rollup:** `telemetry.json → costs` (and the dashboard's
  Supervisor-pipeline panel) shows all-time $ spent at T3 vs $ avoided by
  handling consults at T1/T2/fallback. Computed from `skill_events` × the
  measured T3 consult price ($0.000972: 286 prompt + 40 completion tokens
  at the pinned $2/$10-per-Mtok rate card, live-calibrated). Modeled, not
  invoiced — `method` in the block states the basis.

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
`DAISY_OLLAMA_TIMEOUT_MS` (default 120 s), `DAISY_WARM_TIER2=0` (disable
the default boot warm-up), and `DAISY_OLLAMA_KEEP_ALIVE` (`-1` resident
forever · `0` free after each consult · `'5m'` duration) are tunable.
Residency GOTCHA: Ollama parses `keep_alive` as a Go duration — the
STRING `"-1"` is rejected (400); numeric `-1` is the forever sentinel.
Honest numbers on the 16 GB dev box: warm ping 0.6s with residency
(was 120s+ cold), but a consult still takes 17s (uncontended) to ~55s
(orchestrator tick load contending) — CPU generation is 1–2.3 tok/s.
The full
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
node backend/backend.selftest.js       # 101 checks (incl. S16 orphan-guard, S17 log-parser, S18 supervisor-root suites)
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
- **Login autostart:** `./scripts/cluster.sh install-app-agent` opens the
  app at every login (RunAtLoad only — close it freely; it returns next
  login). The shell kills its backend on window close AND on app exit, and
  the backend carries its own orphan guard (exits when reparented to pid 1),
  so no duplicate-orchestrator orphans survive any quit path.

The installed app and the repo stack are INDEPENDENT (separate data dirs,
separate queues). `clusterctl` manages the repo stack only and shows the
installed app's presence informationally.

### 7.1 Two runtimes — who owns what

Running `./clusterctl.sh status` shows **two labeled sections**. They are
separate worlds that happen to share one machine:

| | **REPO STACK** (`~/daisy-chain`) | **INSTALLED APP** (`/Applications`) |
|---|---|---|
| Managed by | `clusterctl` + the launchd supervisor | the app itself (open/close) |
| Code | the working tree | the bundle's `Resources/appdata/` payload |
| Data | `~/daisy-chain/database/` | `~/Library/Application Support/DaisyCluster/` |
| API key | `~/daisy-chain/.env` | `Application Support/DaisyCluster/.env` |
| Queue/DB | its own SQLite | its own SQLite |
| Self-heal | launchd agent (15 s watchdog) | none — close/reopen the app |
| Updated by | editing files + `clusterctl restart` | `./make-installer.sh` (full rebuild) |

Coexistence rules (all proven live):
- **Neither touches the other.** Discovery excludes the app's processes by
  command path; the supervisor only heals the repo stack; the app's backend
  is spawned by the app's shell, not by clusterctl.
- **Ports are shared by design** (telemetry :6292 is repo-only; the app's
  telemetry is a file the app's UI reads via IPC — no server). Nothing to
  reconcile.
- **Tasks are not portable.** Enqueuing via clusterctl goes to the repo
  queue only; the app has its own. Pick one runtime per use case.
- **Version drift is expected** — the app only updates when you run
  `make-installer.sh`. `status` surfaces app-side staleness via the
  `app-telemetry` freshness line; refresh with a full rebuild (the UI is
  baked into the binary, so `--skip` restaging alone can strand an old
  dashboard next to a new backend).

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
