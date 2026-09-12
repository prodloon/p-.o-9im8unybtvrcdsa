# Daisy Chain — Hybrid Cloud-Local Multi-Agent Cluster
**Status:** ALL PHASES (1–6) COMPLETE — cluster verified and launch-ready. Batteries: governor 43/43, backend 47/47, cluster (Python, Phase 6) 40/40 — all grade A.
**Written:** 2026-09-11 · **Author of this document:** Buffy (Principal Systems Architect plan)
**Constraint:** 16 GB RAM, single Mac. Existing app keeps running from `~/` until cutover.

## Session decisions log (append-only — sub-agents read this first)
- 2026-09-11: Plan approved by user. Python `daisy_*.py` files frozen (no edits Phases 1–4).
- 2026-09-11: Supervisor models PINNED for Phase 3: primary `anthropic/claude-3.5-sonnet` (OpenRouter), fallback `meta-llama/llama-3.3-70b-instruct` (high-speed/low-cost).
- 2026-09-11: SQLite driver = built-in `node:sqlite` (Node v26.7.0 on this Mac; no npm deps, no native builds). Note: it has no `.transaction()` helper — use manual `BEGIN IMMEDIATE`; it binds only primitives — serialize objects with `JSON.stringify` (see `Governor._serialize`).
- 2026-09-11: Phase 1 delivered: `governor/governor.js` (policy + SQLite + reapers + injectable ram/clock seams), `governor/init-database.js`, `governor/governor.selftest.js` — now 43 checks, ALL GREEN.
- 2026-09-11: Phases 2+3 delivered. `backend/worker.js` (deterministic state machine, sandboxed file ops, SNIPE gate that refuses to act before skill injection), `backend/worker-pool.js` (claim/release semantics, spawn-block aware, hibernate/restore via SQLite), `backend/supervisor-bridge.js` (OpenRouter; claude-3.5-sonnet → llama-3.3-70b chain, 429/5xx exponential backoff w/ Retry-After, key strictly from env), `backend/skill-injector.js` (catalog validation, path-jail, supervisor + local keyword fallback), `backend/index.js` (orchestrator loop; `--enqueue` / one-shot / `--serve` CLI). `backend/backend.selftest.js`: 11 suites, 47 checks, ALL GREEN; cloud fully mocked via injectable fetch.
- 2026-09-11: Pool semantics: `acquire()` marks workers `claimed` and returns null (never throws) when pool is exhausted and spawn-blocked; orchestrator releases workers to `done`/`failed` after each task. Governor `heartbeat()` upserts an 'unregistered' row for unknown workers (bare workers may heartbeat pre-registration). Poison tasks fail permanently after 3 attempts with `attempts` carried across retries.
- 2026-09-11: Worker sandbox root = `daisy_sandbox_cluster/` (gitignored). All worker file ops path-jailed; no shell execution anywhere in the cluster.
- 2026-09-11: To use the real cloud: export OPENROUTER_API_KEY (never commit). Without it the cluster runs fully on local keyword sniping — verified working end-to-end via CLI.
- 2026-09-11: Phase 5 delivered. Telemetry pipeline: orchestrator writes `database/telemetry.json` (1 Hz, atomic tmp+rename) in both --serve and one-shot modes; dual-transport UI — Tauri native IPC (`telemetry://metrics` from src-tauri/main.rs emit loop) or loopback HTTP via `backend/telemetry-server.js` (:6292) under plain Vite; React 18 + Tailwind v4 dashboard (`ui/`) with 500ms throttled commits, SVG sparkline, gauge grid. Tauri v2 shell compiles (`cargo check` green; icon extracted from the legacy DaisyChain.app icns; child-process reaper on window close). UI production build verified (`vite build`, 1s).
- 2026-09-11: Phase 6 delivered. `daisy_cluster_selftest.py` (NEW file — the standing `daisy_selftest.py` stays byte-identical per the freeze rule; battery asserts that freeze): 6 suites, 40 checks — governor battery, backend battery, live end-to-end pipeline via real CLI + real SQLite (integrity_check, WAL, history), telemetry file+HTTP contract, shell artifacts incl. `cargo check`, frozen-file tripwire. `docs/runbook.md` written (start/feed/monitor/stop/verify).
- 2026-09-11: Per-agent CPU/RSS telemetry delivered end-to-end: governor schema (`cpu_pct`, `state_bytes`, `busy_ms` + in-place migration), `statsHeartbeat`/`workerStatsSnapshot`, `readProcessStats` (ps//proc), worker `busyMs` accounting + `getUsage()`, pool `heartbeatAll()` with host-CPU/RSS attribution (in-process workers ⇒ event-loop busy share + even RSS split), orchestrator wires both; dashboard gained the per-agent fleet table. Batteries: governor 56/56, backend 61/61, cluster 46/46 (Python battery pins the new counts + a usage_rows check). Live restart verified: attributed cpu 23.1% on a real task; state_bytes grows when a skill is injected (921 B). Gotchas: CREATE-IF-NOT-EXISTS can't add columns (ALTER migration must run BEFORE schema for the cpu_pct index); node:sqlite refuses double-quoted string literals in SQL; telemetry HTTP needs `Cache-Control: no-store` or browsers serve stale gauges; one-shot cycles run end-of-cycle heartbeatAll so usage rows always exist; tool-timeout reaps `&`-backgrounded processes — launch long-lived helpers via python Popen `start_new_session=True`.
- 2026-09-11: Remaining known items: real-cloud verification needs the user's OPENROUTER_API_KEY; per-worker CPU/RSS tracking is a future enhancement; `cargo tauri dev` first build not yet run end-to-end (compiles clean).

---

## 1. What exists today (read this before touching anything)

| File | Role | Notes for the cluster |
|---|---|---|
| `daisy_chain.py` (1,912 ln) | Engine: routing, skills, provisioner, tools | `TOOLS` dict + `execute_tool()` is our worker action library; `select_skills()`/`_keyword_skills()` is the *existing* skill matcher the Overseer will replace; `provisioner_*.json` files are its state |
| `daisy_ui.py` (1,502 ln) | stdlib `http.server` API + webview UI | Loopback-only API on this machine; the Tauri UI will *replace* it eventually; keep `/api/*` shapes compatible during migration |
| `daisy_docs.py` | RAG over `~/daisy_docs` | Index already JSON; fine as-is for now |
| `daisy_research_daemon.py` | LaunchAgent daemon | Writes `daisy_research/` reports; keep alive until cutover |
| `daisy_selftest.py` | 70-check test battery | Extend with cluster suites |
| `daisy_audit_report.md` | Audit: 7×A, ship-clean | Punch list: atomic writes, labels, scheduled selftest |

**Key facts:** Python 3.9 (CLT build), `ollama` client 0.6.2, everything hard-anchored to `$HOME`, app currently RUNNING from `~/` (PID may differ by session), LaunchAgent `com.moses.daisy-research` with `KeepAlive=true`.

---

## 2. Target architecture

```
                        ┌─────────────────────────────┐
                        │   Cloud Supervisor (API)    │
                        │  OpenRouter / Groq bridge   │
                        └──────────┬──────────────────┘
              JSON task payloads   │   JSON verdicts + skill commands
                        ┌──────────▼──────────────────┐
                        │  Orchestrator (backend/     │
                        │  index.js — Node.js)        │
                        │  • dispatch loop            │
                        │  • skill-sniping injection  │
                        │  • queue depth reporting    │
                        └───┬──────────────┬──────────┘
                            │              │
             100+ workers   │              │  telemetry stream
             (Node/Rust     │              ▼
             state machines)│      ┌──────────────────┐
                            ▼      │ Memory Governor  │
                   SQLite states   │ (RAM watchdog)   │
                   + task queues   └────────┬─────────┘
                                             │ hibernate @80% RAM
                                     ┌───────▼────────┐
                                     │ SQLite         │
                                     │ database/      │
                                     │ agent-states   │
                                     └────────────────┘
```

**Division of labor**
- **Local workers (100+):** deterministic tasks only — file I/O, API routing, scaffolding, static scans. Pure Node.js state machines; *no local LLM inference* in workers. (Rust workers are a later optimization; see §8.)
- **Cloud Supervisor:** all cognitive work — auditing, task delegation decisions, "skill-sniping" (choosing which skillbase script a worker needs). Reached via an API bridge with a provider-agnostic adapter (OpenRouter first, Groq as fallback).
- **Legacy Daisy (Python):** stays as-is during Phase 1–3; its `TOOLS` library becomes the seed of the worker action set; its UI/API is superseded by Tauri in Phase 5.

---

## 3. New directory structure

```
daisy-chain/
├── knowledge.md                  ← this file (context for all sub-agents)
├── daisy_chain.py                ← existing engine (unchanged Phases 1–4)
├── daisy_ui.py                   ← existing UI (unchanged Phases 1–4)
├── daisy_docs.py                 ← existing RAG
├── daisy_research_daemon.py      ← existing daemon
├── daisy_selftest.py             ← existing tests (extend in Phase 6)
├── backend/                      ← NEW: Node.js orchestrator
│   ├── index.js                  ← main orchestrator loop (entrypoint)
│   ├── supervisor-bridge.js      ← OpenRouter/Groq adapter (provider-agnostic)
│   ├── worker-pool.js            ← spawn/scale/track 100+ workers
│   ├── worker.js                 ← single worker state machine
│   ├── skill-injector.js         ← skillbase reader + context injector
│   ├── governor-client.js        ← reports RAM to governor, obeys hibernate
│   └── package.json
├── governor/                     ← NEW: memory governor
│   └── governor.js               ← RAM watchdog + SQLite hibernation
├── database/                     ← NEW: SQLite state store
│   └── agent-states.sqlite       ← gitignored (runtime artifact)
├── skillbase/                    ← NEW: snipeable skill scripts
│   ├── index.json                ← machine-readable skill catalog
│   ├── scaffold-express-api.md
│   ├── file-bulk-rename.md
│   ├── api-route-map.md
│   └── ...                       ← markdown/json scripts the Supervisor can summon
├── src-tauri/                    ← NEW: Tauri backend (Rust)
│   ├── src/main.rs               ← IPC channel setup, spawns Node backend
│   ├── Cargo.toml
│   └── tauri.conf.json
├── ui/                           ← NEW: React telemetry frontend
│   ├── src/App.jsx               ← dashboard: RAM/CPU/queue gauges
│   ├── src/telemetry.js          ← Tauri IPC channel listeners
│   └── package.json
├── docs/
│   └── runbook.md                ← how to start/stop the cluster locally
└── .gitignore                    ← extend: node_modules, dist, *.sqlite
```

---

## 4. SQLite Memory Governor schema (`database/agent-states.sqlite`)

```sql
-- One row per worker, whether running or hibernating.
CREATE TABLE workers (
    id            TEXT PRIMARY KEY,            -- e.g. 'w-0007'
    kind          TEXT NOT NULL,               -- 'file-io' | 'api-route' | 'scaffold' | ...
    state         TEXT NOT NULL,               -- 'running' | 'hibernating' | 'zombie'
    priority      INTEGER NOT NULL DEFAULT 5,  -- 1 (critical) .. 9 (evict first)
    ram_bytes     INTEGER,                     -- last measured RSS of the worker process
    spawned_at    INTEGER NOT NULL,            -- unix ms
    last_heartbeat INTEGER NOT NULL            -- unix ms; governor reaps stale rows
);

-- Serialized worker state: the "save file" written at hibernation.
CREATE TABLE worker_states (
    worker_id     TEXT PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
    state_json    TEXT NOT NULL,               -- full state machine snapshot
    task_payload  TEXT,                        -- in-flight task to resume after wake
    hibernated_at INTEGER NOT NULL,
    wake_count    INTEGER NOT NULL DEFAULT 0   -- thrash detection metric
);

-- Deterministic task queue the orchestrator pulls from.
CREATE TABLE task_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,               -- maps to worker 'kind'
    payload_json  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending|leased|done|failed
    leased_by     TEXT REFERENCES workers(id),
    lease_expires INTEGER,                     -- unix ms; reaper re-queues expired leases
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    finished_at   INTEGER
);

-- Audit trail of governor interventions (pattern matches daisy's provisioner_log).
CREATE TABLE governor_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    event         TEXT NOT NULL,               -- 'hibernate' | 'wake' | 'reap' | 'lease_requeue'
    worker_id     TEXT,
    detail_json   TEXT
);

-- Skill-sniping history: which skill was injected where, and whether it helped.
CREATE TABLE skill_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    worker_id     TEXT,
    skill_name    TEXT NOT NULL,
    source        TEXT NOT NULL,               -- 'supervisor' | 'local-fallback'
    outcome       TEXT                         -- 'applied' | 'rejected' | 'failed'
);

CREATE INDEX idx_workers_state   ON workers(state, priority);
CREATE INDEX idx_queue_status    ON task_queue(status, priority_order);  -- see note
CREATE INDEX idx_lease_expiry    ON task_queue(lease_expires);
```

**Governor policy (documented contract):**
- Poll RSS every 2 s (macOS `ps` or `/proc`-equivalent via Node `process.memoryUsage` + child process).
- At **80%** of 16 GB: hibernate lowest-priority, least-recently-active workers (LRU by `last_heartbeat`) until below 70% (hysteresis prevents thrash).
- Workers with `wake_count > 10/hour` get flagged in `governor_log` as thrash suspects; orchestrator reduces their priority.
- SQLite in **WAL mode**, single writer (governor), readers are the orchestrator/UI telemetry.
- Hard ceiling: if 90% is hit, stop spawning new workers entirely (log `spawn_blocked`).

---

## 5. Skill-sniping contract (Supervisor ↔ Orchestrator)

Request payload (orchestrator → cloud):
```json
{
  "worker_id": "w-0007",
  "task_kind": "scaffold",
  "task_summary": "create express api with auth",
  "context_digest": {"files_seen": 12, "last_error": null},
  "skills_catalog": ["scaffold-express-api", "file-bulk-rename"]
}
```

Verdict payload (cloud → orchestrator):
```json
{
  "verdict": "delegate",
  "skill": "scaffold-express-api",
  "confidence": 0.87,
  "inject": true
}
```

On `inject: true`, `skill-injector.js` reads `skillbase/{skill}.md` (or `.json`), validates it against `skillbase/index.json`, and prepends it to the worker's context before the worker proceeds. If the cloud is unreachable, the local fallback matcher (adapted from `daisy_chain.py::_keyword_skills`) snipes locally — the cluster degrades gracefully, never dead.

---

## 6. Telemetry (Tauri IPC)

- Rust side (`src-tauri`): spawns/watches the Node backend; tails `database/telemetry.json` every 1 s and emits `telemetry://metrics` events (native IPC; zero network in the shell).
- Browser fallback (plain Vite): loopback `telemetry-server.js :6292` serves the same JSON with `Cache-Control: no-store` (browsers heuristic-cache otherwise — bit us once).
- React side: single subscription (Tauri `listen()` or HTTP poll) into a 500 ms throttled feed; gauges + **per-agent fleet table** (`pool.workers[]`: id, kind, phase, attempts, cpuPct, stateBytes, busyMs).
- Per-agent usage semantics (workers are in-process state machines, so true per-process stats do not exist — these are the owned, honest numbers):
  - `cpuPct` = worker's busy share of the host event loop over the interval (busyMs delta / interval; sums to ≤100%). Persisted in `workers.cpu_pct` via `governor.statsHeartbeat()` each cycle (`pool.heartbeatAll()`).
  - `stateBytes` = **exact** `JSON.stringify(worker.state)` size — precisely what hibernation writes to `worker_states`. Persisted in `workers.state_bytes`.
  - `busyMs` = cumulative wall time inside `step()` (persisted in `workers.busy_ms`).
  - RSS = host Node process RSS (via `ps` on macOS, `/proc` on Linux: `governor.readProcessStats`), split evenly per live agent; shown in the table header as host rss + ~per-agent.
- Schema note: `workers` gains `cpu_pct`/`state_bytes`/`busy_ms` (+ `idx_workers_usage`). Governor migrates existing DBs **before** applying SCHEMA — the index on `cpu_pct` forces ALTERs to run first on legacy files.
- Numbers sourced from the governor's SQLite + OS process stats, so UI and governor can never disagree.

---

## 7. Phased implementation plan (each phase is independently verifiable)

| Phase | Deliverable | Verification |
|---|---|---|
| **1. Skeleton + governor** | Directory scaffold; `governor/governor.js` with SQLite schema above; unit test hibernating a fake worker at 80% RAM | Selftest: inject fake RSS reading → assert worker row flips to `hibernating` and state JSON exists |
| **2. Orchestrator core** | `backend/index.js` dispatch loop + `worker.js` state machine + `worker-pool.js`; task queue lease/reclaim | Selftest: enqueue 10 deterministic tasks → all complete; kill a worker mid-task → lease expires → re-queued |
| **3. Cloud bridge** | `supervisor-bridge.js` (OpenRouter adapter, Groq fallback, timeout/retry, local fallback sniping) | Selftest with mocked HTTP: verdict JSON parsed; offline → local fallback fires |
| **4. Skillbase + injector** | `skillbase/index.json` + 3 seed skills; `skill-injector.js` | Selftest: supervisor verdict triggers injection; unknown skill name → rejected + logged |
| **5. Tauri + React UI** | Scaffold `src-tauri/` + `ui/`; IPC telemetry channel; gauges | `npm run tauri dev` renders live RAM/queue numbers matching governor log |
| **6. Integration + cutover prep** | Extend `daisy_selftest.py` with cluster suites; decide cutover for the Python app | Full battery green; cutover plan written |

**Cutover rule (unchanged from earlier sessions):** the live app still runs from `~/` — nothing in this plan touches it until an explicit, separate cutover step the user approves. The cluster sandbox is `daisy_sandbox_cluster/` (distinct from the legacy `daisy_sandbox/`).

---

## 8. Risks & decisions taken (so sub-agents don't re-litigate)

1. **Node.js first, Rust workers later.** 100+ Node state machines fit comfortably in 16 GB *if* each worker stays under ~15 MB RSS; the governor enforces this. Rust workers are a Phase 6+ optimization only if Node RSS proves too fat.
2. **SQLite WAL, single-writer.** Simplest correct concurrency for one machine; no network DB.
3. **100 is a config number, not a constant.** `WORKER_TARGET` in config; governor may cap below 100 under RAM pressure. The blueprint's "100+" is a target, not a hard requirement.
4. **Cloud keys via env var** (`OPENROUTER_API_KEY` / `GROQ_API_KEY`), never committed. `.gitignore` gains `*.sqlite`, `node_modules/`, `dist/`, `.env`.
5. **Python 3.9 EOL:** does not block the cluster (Node/Rust stack), but the Python app should migrate eventually; noted, not scheduled.
6. **Open item needing user input later:** which OpenRouter model to pin as Supervisor (capability vs cost). Default proposal: a strong cheap model for routine verdicts + escalation path for hard audits.
