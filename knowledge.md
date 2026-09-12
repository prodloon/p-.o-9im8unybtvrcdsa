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
- 2026-09-11: FIRST LIVE CLOUD RUN (user key, stored in gitignored `.env`; never logged). Result: pipeline works end-to-end supervisor-driven (cloud=2, local=0; both tasks done with `via supervisor` skill_events), **but the pinned primary `anthropic/claude-3.5-sonnet` is RETIRED on OpenRouter — HTTP 404 "No endpoints found"**. Every verdict silently served from the llama-3.3-70b fallback (chain worked as designed, masking a dead primary). Live claude verdicts obtained by overriding the chain to `anthropic/claude-sonnet-5`: 4/4 primary hits, ~2.1–2.4s, sensible routing (3 delegates to matching skills; 1 delegate-inject:false on a trivial task). OPEN DECISION for the user: re-pin primary (claude-sonnet-5 is the same-tier successor at $2/M prompt — cheaper than 3.5-sonnet era) or keep llama as primary. Until re-pinned, production effectively runs llama-3.3-70b only.
- 2026-09-11: `clusterctl.sh` — single control surface (start [--shell] [--no-ui] / stop / status / restart / logs / task). Adoption by discovery (pgrep command shapes + port fallback), not pidfile-dependence — it adopted the hand-started stack on first run. Shell-mode mutual exclusion: the Tauri shell owns its backend; headless start refuses next to it; stop kills the shell LAST. Children spawn via python `Popen(start_new_session=True)` (macOS has NO setsid binary — nohup+& children get reaped by tool-timeout process groups; this is the only reliable detach on this box). Orchestrator health = telemetry.json mtime <10s (NOT the telemetry-server URL, which is a different process). status exit code is machine-readable (0 all green / 1 partial-down). logs/ and .run/ are gitignored. Battery gains SUITE 7 (control script) — run it with the stack up for full coverage.
- 2026-09-11: RELEASE .app shipped. `make-installer.sh` = reproducible pipeline (tauri build → stage appdata payload → swap hardened binary → ad-hoc sign → ditto to /Applications; `--skip` re-stages without rebuilding). Installed layout: code in `Contents/Resources/appdata/` (NO secrets/node_modules/state), runtime data in `~/Library/Application Support/DaisyCluster/{database,sandbox}` via new `DAISY_DATA_DIR`/`DAISY_SANDBOX_DIR` env overrides (governor DB path, telemetry file, sandbox root all honor them; defaults unchanged), secrets in `<appdata>/.env` loaded by the shell. Rust hardening: root discovery probes the BUNDLE first (compile-time CARGO_MANIFEST_DIR is baked in and exists on the build machine — first release launch ran the repo backend because dev-tree won; fixed by ordering), single-instance plugin, `.env` fills gaps only (real exports win). clusterctl now EXCLUDES the installed app's processes (shell+orchestrator cross-matched by command shape; status shows the installed app informationally). Dashboard demoted to non-gating in status (viewer, not core). Battery 53/53 with BOTH stacks coexisting. DMG at src-tauri/target/release/bundle/dmg/.
- 2026-09-11: Remaining known items: real-cloud verification needs the user's OPENROUTER_API_KEY; per-worker CPU/RSS tracking is a future enhancement; `cargo tauri dev` first build not yet run end-to-end (compiles clean).
- 2026-09-11: 3-TIER MODEL CASCADE shipped (see §5.5 COST LAW — binding). User directives: Tier 3 = `anthropic/claude-sonnet-latest` — bare slug rejected HTTP 400 by OpenRouter; the live alias is the tilde form `~anthropic/claude-sonnet-latest` (HTTP 200, real verdicts served). Tier 2 = local Ollama `qwen2.5:7b` (already pulled on this box; ~17 s warm, cold start can exceed 120 s — T2 timeout sized accordingly). Gatekeeper `SupervisorBridge.routeTask()` intercepts ALL consults: T1 skillbase templates ($0) → T2 Ollama triage ($0) → T3 OpenRouter chain with backoff; `getVerdict()` only reachable via T3. Orchestrator counts per tier (`stats.tiers`, `telemetry.json → cascade{tiers,lastTier,models}`, `skill_events.source` = winning tier); dashboard gains the "Supervisor pipeline" panel. Backend battery 64/64 incl. the T1→T2→T3 escalation proof (S9) and the all-tiers-decline ⇒ no force-feed check (S7).
- 2026-09-11: PERMANENT MODEL MAPPINGS enforced (user directive; §5.5 rule 2 updated). T3 is now EXCLUSIVE (`~anthropic/claude-sonnet-latest` only — `FALLBACK_MODEL` removed from the chain; retries exhaust → clean failure → cascade degrades, no llama rescue). T2 pinned to `qwen2.5:7b` @ `http://localhost:11434`. Model/URL env overrides (`DAISY_TIER2_MODEL`, `DAISY_OLLAMA_URL`, `DAISY_TIER3_MODEL`) removed — attempts to override via constructor opts THROW, so a dead pin can never drift in silently again. `scripts/cluster.sh` added: boot sequence (governor DB/WAL preflight → Ollama up+model+optional warmup via `DAISY_WARM_TIER2=1` → tier-3 key check → `clusterctl start`), clean stop (kills Ollama only if it started it; never touches a user-run server), status with cascade-pin summary. Backend battery 69/69 (S6 rewritten: permanence throws + exclusive-T3 retry-exhaustion semantics).
- 2026-09-11: TIER-2 RESIDENCY shipped (user directive: pre-warm at boot + keep_alive pin). Bridge sends `keep_alive` on EVERY consult (default numeric -1 = forever); `scripts/cluster.sh` warms at boot by default (`DAISY_WARM_TIER2=0` to disable) and `status` reports real residency from `/api/ps`. Live-verified: `/api/ps` shows qwen2.5:7b resident with `expires_at` ≈ 2318; warm ping 0.635s (was 120s+ cold). REAL GOTCHA found live: Ollama 0.33.3 rejects the STRING "-1" as keep_alive (Go duration parse, HTTP 400) — numeric -1 is the correct forever sentinel; the string form would have 400'd every pinned consult and silently escalated the whole cascade to T3 (caught because the warm-up stopped being silent). Honest latency report: residency removes the cold start, but CPU-bound generation (1–2.3 tok/s under orchestrator load; verdicts need only ~25–44 tokens) keeps consults at 17s uncontended / up to ~55s contended — near the 60s task lease. Backend battery 78/78 (S6 pins numeric keep_alive on the tier-2 body).
- 2026-09-12: APP LOGIN-AUTOSTART shipped (`com.daisy.cluster.app`, RunAtLoad-only `/usr/bin/open '/Applications/Daisy Cluster.app'` — deliberately NO KeepAlive: a GUI app must stay user-closable and `open` exits instantly, so KeepAlive would spawn-loop; the app's single-instance guard makes double-launch harmless). Verbs: `install-app-agent [--unload-first]` / `uninstall-app-agent` (never quits a running app) / `agent-status` covers both agents; clusterctl status shows an `app-autostart` line. REAL BUG found while testing: `osascript ... quit` bypasses the shell's `WindowEvent::Destroyed` reaper → the app's backend ORPHANED (two bundle backends fighting one queue). Fixed with TWO layers: (1) Rust `RunEvent::Exit` handler also kills the backend (needed `.build(...).run(closure)` refactor + a `;` to drop the lock temporary before `state` — E0597), (2) Node orphan guard in `serve()`: every 5 s, if `process.ppid() === 1` (launchd reparented us = parent died) → exit. Defense in depth: the Node guard is shell-agnostic (covers kill -9, crash, ANY death). Installed app rebuilt to pick up the Rust fix. Battery 62/62 (app-agent plist pins: RunAtLoad + `/usr/bin/open` + NO KeepAlive).
- 2026-09-12: TWO-RUNTIME STATUS shipped. `clusterctl status` now prints two labeled sections — REPO STACK (~/daisy-chain; services + supervisor-agent line incl. PAUSED state, live glance now tags `data database/`) and INSTALLED APP (app-shell / app-backend with its Application Support data dir / app-telemetry FRESH-vs-staleness from the app's own telemetry.json). New helper `app_backend_pid()` (bash-3.2-safe multi-line form — the one-line `$(... | while ... case ...)` pipeline inside `$( )` broke `bash -n` on macOS's bash 3.2 with a bogus `syntax error near unexpected token ';;'`; app_backend_pid is excluded from orch_pid discovery as before). The exit code still gates ONLY on repo core services. Runbook §7.1 documents coexistence: who manages what, data/key/queue separation, tasks are not portable across runtimes, version drift expected (app updates only via make-installer.sh full rebuild). Battery pins the two-runtime status shape.
- 2026-09-12: LOGIN AUTOSTART + SELF-HEAL shipped via LaunchAgent `com.daisy.cluster` (`~/Library/LaunchAgents/`, RunAtLoad+KeepAlive → `scripts/cluster.sh supervise`). KEY DESIGN: the agent does NOT run `start` (it spawns detached children and exits — KeepAlive would spin); `supervise` boots once then health-checks every 15 s, healing by re-running the idempotent boot (orchestrator = telemetry.json freshness <10 s; telemetry = its HTTP endpoint; heal also resurrects an Ollama the agent started). Supervisor itself is launchd-protected (kill it → ThrottleInterval 30 s respawn, proven). PAUSE SEMANTICS: a manual `cluster.sh stop` while the agent is loaded writes `.run/supervisor.paused` → healer sleeps; auto-resumes after 10 min (no silently-dead agents), and explicit `start`/`restart` clear the pause. Healer covers the CORE only — vite/dashboard is a non-gating viewer and is not resurrected. Install verbs: `install-agent [--unload-first]` (plutil-lint + `launchctl bootstrap gui/$(id -u)`) / `uninstall-agent [--keep-running]` (bootout TERMs the supervisor; services keep running) / `agent-status`; status shows the agent line. ALL heal modes verified live: kill -9 orchestrator → healed in one tick; kill supervisor → respawned by launchd; kill both core services → one tick heals both; `stop` while loaded → stayed down, pause honored. Cluster battery 59/59 (SUITE 7 gained plist-lint + agent-loaded checks, run only when the plist exists). Gotcha for future plist editing: under `set -u`, reference SCRIPT variables (WARM_TIER2), never env vars that may be unset, inside the plist heredoc.
- 2026-09-12: COST ROLLUP shipped (dashboard + `telemetry.json → costs`). $ avoided = below-frontier consults (T1+T2+fallback from `skill_events`) × the measured T3 consult price — **$0.000972, live-calibrated** (one real pinned-model consult measured 286 prompt + 40 completion tokens; OpenRouter's own `usage.cost` matched the $2/$10-per-Mtok rate card to the digit — rate card constants in bridge POLICY). `Orchestrator.costRollup()` reads the audit trail, so numbers survive restarts and always agree with the DB; T3 spend counts only SUCCESSFUL supervisor consults (declined routes can't be distinguished in `skill_events` — under-count, stated in `method`). S15 pins the math (unit = 0.000972 exactly; keyless run spends $0); Python telemetry suite pins the block shape + unit price. Live: 12 consults all-time → $0.0039 spent / $0.0078 avoided / 66.7% savings, rendering in the dashboard panel. NOTE the installed app is now one release behind again (cost panel is binary-baked) — rerun `make-installer.sh` when convenient.
- 2026-09-12: INSTALLED APP REFRESHED to the pins/gate/residency release (full rebuild — the cascade dashboard panel is baked into the Tauri binary, so `--skip` restaging alone would ship a stale UI). Two installer bugs found & fixed: (1) Tauri v2 runs `beforeBuildCommand`/`beforeDevCommand` with CWD = PROJECT ROOT, not `src-tauri/` — `npm run build --prefix ../ui` escaped to `$HOME/ui` (npm ENOENT); hooks now use `--prefix ui`. (2) `set -u` parses `$INSTALLED…` (trailing Unicode ellipsis) as one variable name → "unbound variable" mid-install; brace it `${INSTALLED}…`. Build-tool gotchas for future sessions: run long builds DETACHED (`Popen(start_new_session=True)` → poll the log) — the 10-min tool cap kills in-process builds; build ≈8 min cold-ish. Verified in /Applications: no `FALLBACK_MODEL`, permanence checks present, `beginTask` in pool, `keep_alive` in bridge+cluster.sh, binary 22:11; live: two same-worker tasks each produced their own `tier1-template` consult (gate fix proven in the bundle). App data/key in Application Support survive reinstalls (installer never touches that dir). Note: the app's backend does not run cluster.sh's warm-up — after a REBOOT its first-ever T2 consult pays the cold start (T2 is optional mid-tier; T1/T3 unaffected).
- 2026-09-11: SNIPE-GATE LEAK fixed (found while live-verifying the pins: a repeated task completed with NO cascade event). Root cause: `WorkerPool.acquire()` reused released workers WITHOUT resetting per-task state, so `state.injectedSkill` from a previous task satisfied the SNIPE gate — the whole cascade was silently bypassed on worker reuse, and an unmatched task could inherit a WRONG skill with zero supervisor consult. Fix: `Worker.beginTask()` clears `injectedSkill/skillSource/skillContent/lastError`; `acquire()` calls it on EVERY handout (reuse, spawn, and steal paths). Regression suite S14 pins the leak shut (backend 76/76). Rule of thumb: skill grants are single-task scope — never let worker state survive an acquire.
- 2026-09-12: CRASH-LOOP GUARD shipped for the supervisor (incident: a headless backend with the broken `process.ppid()` *call* TypeError-crashed ~5 s after spawn; the healer re-booted it every 15 s — 35 heal events in one night, by design unbounded). Guard design: `scripts/cluster.sh supervise` counts consecutive failed boots AND failed heals in one persisted streak (`.run/supervisor.bootfailures`, survives supervisor restarts); at `DAISY_MAX_BOOT_FAILURES` (default 5) it alerts (`ALERT:` log line + macOS notification, `DAISY_ALERT=0` silences the notify for tests), writes `.run/supervisor.halted` and exits — a RELAUNCHED supervisor sees the marker and idles instead of booting (launchd KeepAlive would otherwise respawn straight back into the boot storm; idling is the stable halted state). Resume: `restart` (fix-then-reboot) or new `clear-halt` verb (re-arm in place, fresh budget — deliberate: both clear the counter). TWO latent bugs fixed en route, both made any guard useless: `cmd_start` `exit 2` on db-preflight failure killed the SUPERVISOR process (launchd relaunched it, failure uncounted) — now `return 2`; and heals were judged by boot exit code, which can be 0 with a broken stack — now the heal must survive a post-boot `core_ok` re-probe, and `cmd_start --heal` skips guard-state resets (a heal resetting the streak it is judged on would make the guard never fire). Guard state (halt + streak) surfaces in `status`, `doctor` (red HALTED line / "guard: armed, streak N"), and telemetry (`backend/index.js → supervisor {loaded,halted,streak,maxFailures}` read directly from the `.run` files — backend only observes; dashboard "Supervisor guard" panel). Full sandboxed simulation proved all phases (blocked `DAISY_DATA_DIR` under a file path = deterministic db failure without touching the real stack): 5→halt with visible countdown, relaunch idles (0 boot attempts), clear-halt resumes, real boot lifts a stale streak. Resiliency drill: SIGKILL live orchestrator → healed ~35 s, streak never left 0. Batteries: backend 87/87 (S16 orphan-guard suite); Python battery's pinned backend count refreshed 84→87 (stale pin false-alarmed) — cluster 62/62 ALL GREEN.
- 2026-09-12: MACHINE AUDIT + OPS TOOLING (full report: `docs/launchagent-audit-2026-09-12.md`). Audit of every plist in the three launchd dirs + `sfltool dumpbtm` (works WITHOUT root on this box; 69 records) + Login Items + app-bundle `Contents/Library/LaunchAgents`: 7 self-resurrecting user agents (RunAtLoad+KeepAlive — hermes, openclaw, ai-holdco, gh-radar, jarvis, daisy-research, com.daisy.cluster; the daisy supervisor was never unique, just the one managing a stack). BTM resolves the override ghosts (Ollama's bundled agent = its Squirrel UPDATER — RunAtLoad, no KeepAlive, BTM-disallowed) and shows 7 helpers macOS actively BLOCKS (ollama updater, docker vmnetd, both PACE items, SpyHunter, Sideloadly, VirtualBox, Stars updater) — they cannot resurrect regardless of plist. Purged (owner app ABSENT): giulia serve-all (target `/tmp/serve-all.js` long gone — failed every login), steamclean, sideloadly daemon (explains last-exit 78), vboxwebsrv, spyhunter, paceap daemon+agent (elevated deletes; triple-dead). KEPT with reasons: PokerStars' stars updater (app INSTALLED — never delete an updater for present software), Docker helpers, Ollama in-bundle updater. TOOLS on PATH: `~/bin/suspend-agents` (suspend/restore/status; bootout records who was loaded — restore bootstraps exactly those; waits out slow node teardowns — openclaw lingers seconds post-bootout and a fast restore dropped its record; frogr-style session-submitted services die on suspend but are unrestorable) and `~/bin/launchagent-drift-check` (snapshots all plist dirs+keys, loaded labels, disabled overrides, bundle agents, Login Items AND daisy guard state; diffs vs `~/.config/launchagent-baseline.json`; exit 1 = drift). Weekly LaunchAgent `com.moses.la-drift` (Sundays 10:00, --notify, log `~/Library/Logs/launchagent-drift.log`) — first run caught a REAL flip (FolderActionsDispatcher disabled→enabled) and validation caught planted decoy + halt markers. Installer REFRESHED (full rebuild) so /Applications carries the guard-telemetry backend + new dashboard panel; verified live: bundle backend spawns and survives the ppid-guard tick, quit reaps the backend (no orphan), codesign strict-OK. GOTCHA re-learned: `strings <binary> | grep <panel-name>` is a FALSE negative for tauri dashboards (assets embedded compressed) — verify by behavior, not plaintext.

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

## 5.5 3-Tier Model Cascading Pipeline — COST LAW (binding for all sub-agents)

**The law:** every supervisor consult descends the cascade in strict cost order — never pay cloud tokens for a decision a cheaper tier can make. Implemented in `SupervisorBridge.routeTask()` (the interception gatekeeper; `consultSupervisor()` in `backend/index.js` routes through it — nothing calls `getVerdict()` except Tier 3 internally).

| Tier | Handles | Engine | Cost |
|---|---|---|---|
| **1 — Local skill-sniping** | Routine formatting, pattern matching, rule checks, obvious skill matches | `skillbase/` trigger templates via `routeTier1()` (trigger match on the task summary) | $0 |
| **2 — Ultra-cheap triage** | Mid-level data triage, text processing when no template matched | Local **Ollama `qwen2.5:7b`** at `http://127.0.0.1:11434` | $0, local GPU |
| **3 — Frontier brain** | Exclusively high-complexity architecture, deep reasoning, everything T1/T2 declined | OpenRouter chain: `~anthropic/claude-sonnet-latest` → `meta-llama/llama-3.3-70b-instruct` (429/5xx exponential backoff, Retry-After honored) | cloud tokens |

Rules every sub-agent must respect:
1. **Order is fixed: T1 → T2 → T3.** A new feature that "just calls the cloud" violates this law — route through `routeTask()`.
2. **Mappings are PERMANENT (user directive, 2026-09-11):** T1 = `skillbase/` regex + markdown + JSON trigger templates ($0) · T2 = Ollama **`qwen2.5:7b`** at **`http://localhost:11434`** ($0) · T3 = OpenRouter **`~anthropic/claude-sonnet-latest`** — **exclusive frontier brain; the llama-3.3-70b cloud fallback is removed**. Pins live as constants in `POLICY` (`backend/supervisor-bridge.js`) and are NOT env-overridable: `tier3Model`/`fallbackModel`/tier2-mapping overrides throw at construction. **Residency:** every tier-2 consult (and the boot warm-up in `scripts/cluster.sh`) sends `keep_alive` to pin qwen weights in RAM — default numeric `-1` (resident forever; verified `expires_at` ≈ year 2318). GOTCHA (Ollama 0.33.3): `keep_alive` is parsed as a Go duration — the STRING "-1" is REJECTED (400 `time: missing unit`); only numeric `-1`/`0` or duration strings (`'5m'`) are legal. `DAISY_OLLAMA_KEEP_ALIVE` (`-1`\|`0`\|`5m`) and `DAISY_OLLAMA_TIMEOUT_MS` stay tunable (performance, not mapping). **Measured on this 16 GB box:** cold start 120s+ → warm ping 0.6s with residency; but consults still cost 17s (uncontended) to ~55s (when the resident orchestrator's 2s tick loop contends for CPU) because generation runs at 1–2.3 tok/s on CPU — a ~55s consult nearly exhausts the 60s task lease, so keep the tick load light during T2-heavy cycles or lower `DAISY_OLLAMA_KEEP_ALIVE` to trade RAM back. Boot-order verification lives in `scripts/cluster.sh`.
3. **Model-string law:** bare `anthropic/...` slugs are rejected by OpenRouter (400); the live alias form is **tilde-prefixed** (`~anthropic/claude-sonnet-latest`, verified HTTP 200). NEVER pin a model slug without live-probing the OpenRouter catalog first — the 3.5-sonnet pin rotted silently for a session while the fallback masked it.
4. **Telemetry contract:** `routeTask()` → `{source, model, verdict, attempts?, latencyMs}`, `source ∈ tier1-template | tier2-local | supervisor | cloud-unavailable`. Orchestrator counts per-source into `stats.tiers` → `telemetry.json → cascade{tiers, lastTier, models}` → dashboard "Supervisor pipeline" panel. `skill_events.source` records the winning tier (`tier1-template`/`tier2-local`/`supervisor`/`local-fallback`).
5. **Failure semantics:** if all tiers decline (offline + unmatched task), nothing is force-fed — the task burns its attempts and fails permanently via the poison guard. No skill injection without a verdict.

---

## 6. Telemetry (Tauri IPC)

- Rust side (`src-tauri`): spawns/watches the Node backend; tails `database/telemetry.json` every 1 s and emits `telemetry://metrics` events (native IPC; zero network in the shell).
- Browser fallback (plain Vite): loopback `telemetry-server.js :6292` serves the same JSON with `Cache-Control: no-store` (browsers heuristic-cache otherwise — bit us once).
- React side: single subscription (Tauri `listen()` or HTTP poll) into a 500 ms throttled feed; gauges + **per-agent fleet table** (`pool.workers[]`: id, kind, phase, attempts, cpuPct, stateBytes, busyMs) + **Supervisor pipeline panel** (`cascade`: per-tier consult counts, model pins, last route + latency).
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
- 2026-09-12: SUPERVISOR LOG TIMESTAMPS + real event times on the dashboard strip. `cluster.sh log()` now writes `[cluster YYYY-MM-DD HH:MM:SS]` prefixes; the strip's parser was extracted to `backend/supervisor-log-parser.js` (pure — S17 suite, 9 checks: newest-first/limit, kind precedence INCLUDING the trap that a HALTED line is written via `alert()` so contains "ALERT:" and HALTED must win, era tally, ANSI-strip order, `[cluster`-substring decoy behavior, garbage inputs). Events carry `ts` (unix ms, parsed from the log's LOCAL wall time via ISO-with-offset — never assume UTC); legacy pre-timestamping lines keep `ts:null` and render `—:—` with tooltip, never "now". Footnote is era-aware (log-age while pure-timestamped / era explanation while mixed). Rollout subtlety: launchd supervisor keeps OLD bash code in memory until killed — restart the agent (`kill -9` → KeepAlive respawn) before trusting new log formats. Live-proven with a real kill→heal drill (heal stamped 12:32:57, next tick; the FIRST heal's spawn failed the core_ok re-probe → "heal attempt failed (1/5 consecutive)" — the failed-heals counter path ran for real, then the good boot lifted the streak). Backend battery 87→96; python pin + runbook §6 refreshed. Committed 808c768. DRIFT ALARM watches the timestamp era too (`daisyLog` in `~/bin/launchagent-drift-check`): flags a reverted `cluster.sh` writer (lost `date '+%Y-%m-%d %H:%M:%S'` in log()) and a legacy-format writer still ACTIVE (newest tagged log line pre-timestamping) — deliberately ABSOLUTE checks so `--update-baseline` cannot silence them; `DAISY_ROOT` env enables sandboxed testing and redirects the baseline to a separate `-sandbox.json` (shared-path baseline pollution caught live and structurally fixed); failed diff subprocess now exits 2 UNVERIFIED instead of reading as "no drift" (a corrupted `elif` during the edit briefly made every run green — caught because the tests ASSERTED content, not exit codes). Installer REFRESHED same day (full tauri rebuild) so /Applications carries the timestamped strip + 96-check backend: bundle verified (parser staged, index wired, S17 present, codesign strict-OK, binary = fresh build modulo re-sign) and smoke-tested live (backend survived ppid-guard tick on launch, reaped on quit — no orphan). Dashboard also gained the STALE indicator (the heal drill's silent-freeze gap): a 1s heartbeat re-evaluates `Date.now() − sample.ts` even when no samples arrive, so the header badge is three-state — live (fresh ≤5s) / `stale — orchestrator unreachable · data Ns old` (amber: telemetry-server still answers with the orchestrator's frozen snapshot; supervisor should heal within a tick) / offline (never had a sample). Proven live via SIGSTOP/SIGCONT of the orchestrator (stale at 17s age, back to live after resume) — during a REAL outage the badge says stale with a climbing age instead of lying "live". Installer refreshed again (full rebuild) so /Applications carries the stale-indicator dashboard; smoke test green both halves (survived guard tick on launch, reaped on quit).
6. **Open item needing user input later:** which OpenRouter model to pin as Supervisor (capability vs cost). Default proposal: a strong cheap model for routine verdicts + escalation path for hard audits.
