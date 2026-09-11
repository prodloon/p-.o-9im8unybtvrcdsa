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
- **Audit trail:** `database/agent-states.sqlite`
  - `governor_log` — hibernations, reaps, spawn blocks, lease requeues
  - `skill_events` — every skill injection (source: supervisor / local-fallback)
  - `task_queue` — full task history with attempts and outcomes
- **Quick introspection:**
  ```bash
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('database/agent-states.sqlite');console.table(db.prepare('SELECT event,COUNT(*) n FROM governor_log GROUP BY event').all())"
  ```

## 5. Stopping

- Shell window: close it (child reaper kills the backend).
- Headless: Ctrl-C the `--serve` process. SQLite is crash-safe (WAL);
  mid-task leases expire after 60s + 10s grace and tasks auto-requeue.

## 6. Verification (run after any change)

```bash
node governor/governor.selftest.js     # 43 checks
node backend/backend.selftest.js       # 47 checks
~/daisy_env/bin/python daisy_cluster_selftest.py   # 40 checks, end-to-end
```

All three green = launch-ready. The Python battery also asserts the legacy
`daisy_*.py` files remain untouched.

## 7. Known constraints

- 16 GiB ceiling: hibernation ≥80%, spawn block ≥90% (policy in
  `governor/governor.js`; contract in `knowledge.md §4`).
- Workers are sandboxed to `daisy_sandbox_cluster/` — path escapes are
  refused; no shell execution anywhere in the cluster.
- `OPENROUTER_API_KEY` must never be committed; it is read from env only.
- Offline mode is fully functional via local keyword sniping — cloud loss
  degrades skill quality, never availability.
