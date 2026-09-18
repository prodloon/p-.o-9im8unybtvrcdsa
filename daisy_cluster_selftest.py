#!/usr/bin/env python
"""
Daisy Cluster self-test — Phase 6 battery.

Runs the full Node.js cluster test stack (governor + backend batteries),
verifies the live orchestration pipeline end-to-end via the real CLI,
checks the Tauri/React shell artifacts, and asserts the frozen legacy
daisy_*.py files were not modified by the cluster work.

Usage:  ~/daisy_env/bin/python daisy_cluster_selftest.py
        (or any python3 — the cluster itself is Node.js; Python is the harness)

Exit code 0 = all suites green. Same suite/grade style as daisy_selftest.py.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
import freeze_drill as fdh

ROOT = os.path.dirname(os.path.abspath(__file__))


def _resolve_node():
    """Portable node resolution — /usr/local/bin alone is wrong on Apple
    Silicon Homebrew (/opt/homebrew/bin) and misses nvm/asdf/official
    installs. Checked PATH first so this works on any customer's Mac."""
    found = shutil.which("node")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/node", "/usr/local/bin/node"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "/usr/local/bin/node"  # last resort; run_node()'s caller reports the failure


NODE = _resolve_node()

FROZEN_FILES = ["daisy_chain.py", "daisy_ui.py", "daisy_docs.py",
                "daisy_research_daemon.py", "daisy_selftest.py"]

# Baseline sizes from the initial commit (frozen files must stay untouched;
# sizes are a cheap tripwire — content is verified by git status below).
# daisy_ui.py: 70986 → 71629 after the Round-2 escJs() injection fix
# (CHANGES.md #5); baseline updated to the post-fix size.
FROZEN_SIZES = {
    "daisy_chain.py": 81730,
    "daisy_ui.py": 71629,
    "daisy_docs.py": 8298,
    "daisy_research_daemon.py": 15393,
    "daisy_selftest.py": 18447,
}

RESULTS = []


def check(suite, name, ok, detail=""):
    RESULTS.append((suite, name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  [{suite}] {name}" + (f" — {detail}" if detail else ""))


def run_node(script, timeout=None):
    args = [NODE, script]
    # DAISY_SELFTEST_FAST=1 → pass --fast to the backend battery: skips the
    # real local-Ollama triage leg so CI doesn't stall minutes per consult.
    if os.environ.get("DAISY_SELFTEST_FAST") == "1" and script.endswith("backend.selftest.js"):
        args.append("--fast")
    if timeout is None:
        # Full-mode backend battery runs the live-Ollama triage leg (~6–7 min);
        # the previous flat 180s ceiling made full mode self-time-out.
        timeout = 900 if script.endswith("backend.selftest.js") else 180
    proc = subprocess.run(args, cwd=ROOT, capture_output=True,
                          text=True, timeout=timeout)
    return proc.returncode, proc.stdout, proc.stderr


def http_json(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


# ---------------------------------------------------------------------------
def suite_governor_battery():
    print("== SUITE 1: GOVERNOR BATTERY (node) ==")
    code, out, _err = run_node("governor/governor.selftest.js")
    check("governor", "battery exits 0", code == 0)
    check("governor", "56/56 checks pass", "56 passed, 0 failed" in out)
    check("governor", "covers per-worker usage suite", "per-worker usage" in out)


def suite_backend_battery():
    print("== SUITE 2: BACKEND BATTERY (node) ==")
    code, out, _err = run_node("backend/backend.selftest.js")
    check("backend", "battery exits 0", code == 0)
    check("backend", "192/192 checks pass", "192 passed, 0 failed" in out)  # count unchanged; seed-skill assertion broadened
    check("backend", "covers SNIPE gate",
          any("SNIPE" in line for line in out.splitlines()))
    check("backend", "covers permanent model mappings",
          "permanent mappings enforced" in out and "rejected (permanent pin)" in out)
    check("backend", "covers confidence-score escalation",
          "confidence-score dynamic escalation" in out)


def suite_skill_executor():
    print("== SUITE 2c: SKILL EXECUTOR (SNIPE plans + executes, not just consumes) ==")
    code, out, _err = run_node("backend/skill-executor.selftest.js")
    check("executor", "skill-executor suite exits 0", code == 0)
    check("executor", "49/49 checks pass", "49 passed, 0 failed" in out)
    check("executor", "freeform AGENT turns work with no trigger words",
          "freeform AGENT — chat without trigger words" in out)
    check("executor", "tier-1 scaffold lands real project files",
          "real project scaffolded in the sandbox" in out)
    check("executor", "plan jail rejects traversal/deletes/oversize",
          "delete_file not allowed" in out and ".. traversal rejected" in out)
    check("executor", "end-to-end orchestrator cycle produces artifacts",
          "end-to-end — orchestrator cycle lands real project files" in out)


def suite_drill_failsafe():
    print("== SUITE 2d: IDLE-DRILL FAILSAFE (anti-rogue watchdog, mechanical grading) ==")
    code, out, _err = run_node("backend/drill-runner.selftest.js")
    check("drill", "drill failsafe suite exits 0", code == 0)
    check("drill", "50/50 checks pass", "50 passed, 0 failed" in out)
    check("drill", "three puzzle shapes, unique every draw",
          "every drill id is unique (different outcome every time)" in out)
    check("drill", "mechanical grading: exact answer passes, wrong fails",
          "exact correct answer PASSES" in out and "missing answer file FAILS" in out)
    check("drill", "idle threshold triggers exactly once per window",
          "idle past threshold → ENQUEUE" in out)
    check("drill", "E2E: idle cluster drills itself and grades PASS",
          "grade recorded a PASS" in out)
    check("drill", "rogue op is jailed + circuit breaker pauses failsafe",
          "rogue op is jailed" in out and "circuit breaker engaged" in out)


def suite_stale_telemetry_guard():
    print("== SUITE 2b: STALE-TELEMETRY GUARD (hung tier-2 survival) ==")
    code, out, _err = run_node("backend/stale-telemetry.selftest.js")
    check("backend", "stale-telemetry suite exits 0", code == 0)
    check("backend", "tier-2 timeout defaults to 30s", "tier-2 timeout defaults to 30s" in out)
    check("backend", "launchers export the 30s timeout",
          "clusterctl spawn exports" in out and "LaunchAgent plist exports" in out)
    check("backend", "tick survives a hung consult",
          "5 cycles completed while a consult hangs forever" in out)
    check("backend", "telemetry written despite the hang",
          "telemetry written every cycle despite the hang" in out)


def suite_live_pipeline():
    """End-to-end through the REAL CLI against the REAL database file."""
    print("== SUITE 3: LIVE PIPELINE (real CLI, real sqlite) ==")
    db = os.path.join(ROOT, "database", "agent-states.sqlite")

    def cli(*args):
        return subprocess.run([NODE, "backend/index.js", *args],
                              cwd=ROOT, capture_output=True, text=True, timeout=60)

    # enqueue a deterministic task
    r = cli("--enqueue", json.dumps({
        "kind": "file-io",
        "payload": {"action": "write_file",
                    "params": {"path": "phase6_live.txt", "content": "live"}}}))
    check("live", "enqueue succeeds", r.returncode == 0, r.stderr[:100])

    # run a cycle
    r = cli()
    check("live", "cycle exits 0", r.returncode == 0, r.stderr[:100])

    # A resident --serve orchestrator may drain the queue before the one-shot
    # cycle gets it — that IS the cluster working. Assert the task's FINAL
    # state in the DB (poll briefly), regardless of who completed it.
    status = None
    for _ in range(10):
        probe = subprocess.run([NODE, "-e", f"""
            const {{DatabaseSync}} = require('node:sqlite');
            const db = new DatabaseSync({json.dumps(db)});
            const rows = db.prepare('SELECT status FROM task_queue ORDER BY id DESC LIMIT 1').all();
            console.log(rows.length ? rows[0].status : 'none');
            db.close();
        """], capture_output=True, text=True, timeout=30)
        status = probe.stdout.strip().splitlines()[-1] if probe.stdout.strip() else "none"
        if status == "done":
            break
        time.sleep(1)
    check("live", "task completed (by one-shot or resident orchestrator)", status == "done", f"final status={status}")

    # artifact actually written to the sandbox
    artifact = os.path.join(ROOT, "daisy_sandbox_cluster", "phase6_live.txt")
    check("live", "sandbox artifact written",
          os.path.exists(artifact) and open(artifact).read() == "live")

    # sqlite integrity + WAL + real data
    check("live", "sqlite database exists", os.path.exists(db))
    integ = subprocess.run([NODE, "-e", f"""
        const {{DatabaseSync}} = require('node:sqlite');
        const db = new DatabaseSync({json.dumps(db)});
        console.log(JSON.stringify({{
          integrity: db.prepare('PRAGMA integrity_check').get(),
          wal: db.prepare('PRAGMA journal_mode').get(),
          workers: db.prepare('SELECT COUNT(*) n FROM workers').get().n,
          tasks: db.prepare('SELECT COUNT(*) n FROM task_queue').get().n,
          skills: db.prepare('SELECT COUNT(*) n FROM skill_events').get().n,
          usage_rows: db.prepare('SELECT COUNT(*) n FROM workers WHERE cpu_pct IS NOT NULL AND state_bytes IS NOT NULL').get().n,
        }}));
        db.close();
    """], capture_output=True, text=True, timeout=30)
    try:
        info = json.loads(integ.stdout.strip().splitlines()[-1])
        check("live", "integrity_check ok", info["integrity"]["integrity_check"] == "ok")
        check("live", "WAL mode active", info["wal"]["journal_mode"] == "wal")
        check("live", "workers tracked", info["workers"] >= 1)
        check("live", "task history recorded", info["tasks"] >= 1)
        # Per-agent usage columns (added with the dashboard fleet table):
        check("live", "worker usage columns populated", info["usage_rows"] >= 1,
              f"rows with cpu/state data: {info.get('usage_rows')}")
    except (ValueError, KeyError):
        check("live", "sqlite introspection", False, integ.stdout[:120] + integ.stderr[:120])


def suite_telemetry():
    """telemetry.json contract + loopback HTTP server."""
    print("== SUITE 4: TELEMETRY (file + HTTP transport) ==")
    tele_path = os.path.join(ROOT, "database", "telemetry.json")
    # produce fresh telemetry via the CLI cycle we just ran
    check("telemetry", "telemetry.json exists", os.path.exists(tele_path))
    if os.path.exists(tele_path):
        try:
            tele = json.load(open(tele_path))
            for key in ("ts", "cycle", "ramPct", "spawnBlocked", "pool", "queue"):
                check("telemetry", f"key '{key}' present", key in tele)
            check("telemetry", "ramPct sane", isinstance(tele.get("ramPct"), (int, float))
                  and 0 <= tele["ramPct"] <= 100)
            # Cost rollup (dashboard cost lines source):
            costs = tele.get("costs") or {}
            check("telemetry", "costs rollup present with totals", 
                  {"unitT3Usd", "perTier", "totals", "method"} <= set(costs)
                  and {"spentUsd", "avoidedUsd", "consults", "savingsPct"} <= set(costs.get("totals", {})))
            check("telemetry", "cost unit is the measured T3 price", 
                  abs(costs.get("unitT3Usd", -1) - 0.001) < 5e-4)
            check("telemetry", "pool snapshot shape",
                  {"size", "targetSize", "spawnBlocked", "byPhase", "workers"} <= set(tele.get("pool", {})))
            # Per-agent usage rows (the dashboard's fleet table source):
            workers = tele.get("pool", {}).get("workers")
            check("telemetry", "pool.workers is a list", isinstance(workers, list))
            if isinstance(workers, list) and workers:
                first = workers[0]
                need = {"id", "kind", "phase", "attempts", "cpuPct", "stateBytes", "busyMs"}
                check("telemetry", "agent rows carry usage fields", need <= set(first))
                check("telemetry", "stateBytes sane", isinstance(first.get("stateBytes"), int) and first["stateBytes"] > 0)
                check("telemetry", "hostStats present", "hostStats" in tele and
                      isinstance(tele["hostStats"].get("rssBytes"), int))
        except ValueError:
            check("telemetry", "telemetry.json parses", False)
    else:
        for key in ("ts", "cycle", "ramPct", "spawnBlocked", "pool", "queue"):
            check("telemetry", f"key '{key}' present", False, "file missing")

    # HTTP fallback transport on a private port
    srv = subprocess.Popen([NODE, "backend/telemetry-server.js", "--port", "6399"],
                           cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # A cold first launch (native-module load, fs-extra cache) can exceed a
    # flat 0.8s — retry the probe instead of flaking.
    data = None
    err = None
    try:
        for _ in range(10):
            time.sleep(0.8)
            try:
                data = http_json("http://127.0.0.1:6399/api/telemetry")
                break
            except Exception as probe_exc:  # noqa: BLE001
                err = str(probe_exc)
                if srv.poll() is not None:
                    break  # server died — report failure below, not retry noise
        check("telemetry", "HTTP transport serves JSON", isinstance(data, dict),
              "" if isinstance(data, dict) else (err or "server not reachable after retries"))
    except Exception as exc:  # noqa: BLE001
        check("telemetry", "HTTP transport serves JSON", False, str(exc))
    finally:
        srv.terminate()


def suite_shell_artifacts():
    """Tauri/React artifacts exist and the Rust crate compiles (cargo check)."""
    print("== SUITE 5: SHELL ARTIFACTS (tauri + react) ==")
    fast = os.environ.get("DAISY_SELFTEST_FAST") == "1"
    for rel in ("src-tauri/src/main.rs", "src-tauri/Cargo.toml",
                "src-tauri/tauri.conf.json", "src-tauri/icons/icon.png",
                "ui/src/App.jsx", "ui/src/telemetry.js",
                "ui/dist/index.html"):
        check("shell", f"{rel} exists", os.path.exists(os.path.join(ROOT, rel)))
    check("shell", "ui production build present",
          os.path.exists(os.path.join(ROOT, "ui", "dist", "assets")))

    cargo_cmd = ["cargo", "check"]
    if fast:
        # --fast CI mode: pin the cargo target dir to a persistent path so a
        # CI cache (or a warm checkout) carries the compiled dependency tree
        # between runs. The FIRST run still builds everything (~1-2 min); every
        # run after that is a no-op rebuild finishing in seconds. Checks are
        # identical — nothing about Suite 5 is skipped in fast mode.
        cargo_cmd += ["--target-dir",
                      os.environ.get("CARGO_TARGET_DIR") or os.path.join(ROOT, ".ci-cargo-target")]
        print("  [fast] cargo check uses persistent target dir (warm CI cache)")
    cargo = subprocess.run(cargo_cmd, cwd=os.path.join(ROOT, "src-tauri"),
                           capture_output=True, text=True, timeout=600)
    check("shell", "cargo check passes", cargo.returncode == 0,
          cargo.stderr.strip().splitlines()[-1] if cargo.returncode else "")

    # Updater event lifecycle: the shell must emit update-available BEFORE
    # update-ready (the UI's banner-supersede logic depends on this order),
    # with the exact event names App.jsx subscribes to, and messages built
    # through the extracted pure helpers (so format changes stay consistent
    # between code and battery). Static assertions on the source keep this
    # honest without spawning a webview.
    main_rs = open(os.path.join(ROOT, "src-tauri", "src", "main.rs")).read()
    app_jsx = open(os.path.join(ROOT, "ui", "src", "App.jsx")).read()
    telemetry_js = open(os.path.join(ROOT, "ui", "src", "telemetry.js")).read()

    check("shell", "updater emits both lifecycle events",
          "UPDATE_EVENT_AVAILABLE" in main_rs and "UPDATE_EVENT_READY" in main_rs)
    check("shell", "update-available fires before update-ready",
          0 < main_rs.find("UPDATE_EVENT_AVAILABLE") < main_rs.find("UPDATE_EVENT_READY")
          and main_rs.find("UPDATE_EVENT_READY", main_rs.find("download_and_install")) > -1)
    check("shell", "available event fires before download_and_install",
          main_rs.find("UPDATE_EVENT_AVAILABLE") < main_rs.find("download_and_install"))
    check("shell", "update messages built via pure helpers",
          "fn update_available_msg(" in main_rs and "fn update_ready_msg(" in main_rs
          and 'format!("Daisy Cluster {current} → {new}' in main_rs.replace("'" , "'"))
    check("shell", "UI subscribes to both update events",
          "subscribeUpdateAvailable" in telemetry_js and "subscribeUpdateReady" in telemetry_js
          and "'shell://update-available'" in telemetry_js and "'shell://update-ready'" in telemetry_js)
    check("shell", "UI renders both update banners",
          "showAvail &&" in app_jsx and "updateReady && (" in app_jsx)
    check("shell", "available banner is dismissible per-session",
          "setAvailDismissed(updateAvailable)" in app_jsx
          and "availDismissed" in app_jsx and "setAvailDismissed(null)" in app_jsx)
    check("shell", "ready banner is NOT dismissible (relaunch is the exit)",
          "updateReady && (" in app_jsx
          and app_jsx.count("setUpdateReady(null)") == 1
          and ".catch(() => setUpdateReady(null))" in app_jsx)


def suite_control_script():
    """clusterctl.sh — the single control surface (start/stop/status/logs)."""
    print("== SUITE 7: CONTROL SCRIPT (clusterctl.sh) ==")
    ctl = os.path.join(ROOT, "clusterctl.sh")
    check("ctl", "script exists + executable", os.path.exists(ctl) and os.access(ctl, os.X_OK))

    syntax = subprocess.run(["bash", "-n", ctl], capture_output=True, text=True, timeout=30)
    check("ctl", "bash syntax clean", syntax.returncode == 0, syntax.stderr[:120])

    # Retry-once: the orchestrator's HTTP probe can transiently fail mid-cycle
    # (pid alive, probe timed out) — a real blip seen on this machine, not a
    # code fault. One retry after a short settle makes CI deterministic.
    status = subprocess.run([ctl, "status"], capture_output=True, text=True, timeout=60)
    status_retried = False
    if status.returncode not in (0, 1):
        time.sleep(3)
        status = subprocess.run([ctl, "status"], capture_output=True, text=True, timeout=60)
        status_retried = True
    check("ctl", "status runs and prints the service table",
          status.returncode in (0, 1) and "SERVICE" in status.stdout,
          status.stderr[:120])
    check("ctl", "status shows the two-runtime split (repo stack vs installed app)",
          "REPO STACK" in status.stdout and "INSTALLED APP" in status.stdout,
          status.stdout[:200])
    check("ctl", "status exits 0 when the stack is up", status.returncode == 0,
          "stack down during battery" + (" (retried once, still failing)" if status_retried else ""))
    if status.returncode == 0:
        check("ctl", "status reports at least one service up", "✓ up" in status.stdout)
        check("ctl", "status live line parses telemetry", "live: cycle" in status.stdout)

    help_r = subprocess.run([ctl, "logs", "all", "1"], capture_output=True, text=True, timeout=30)
    check("ctl", "logs command is graceful", help_r.returncode == 0)

    # LaunchAgents (login autostart + self-heal) — artifacts must be valid
    # whenever present; the agents themselves may legitimately be uninstalled.
    cluster_sh = os.path.join(ROOT, "scripts", "cluster.sh")
    agent_label = "com.daisy.cluster"
    app_agent_label = "com.daisy.cluster.app"
    plist = os.path.expanduser(f"~/Library/LaunchAgents/{agent_label}.plist")
    if os.path.exists(plist):
        lint = subprocess.run(["plutil", "-lint", plist], capture_output=True, text=True, timeout=30)
        check("ctl", "agent plist lints clean", lint.returncode == 0, lint.stderr[:120])
        loaded = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{agent_label}"],
                                capture_output=True, text=True, timeout=30)
        check("ctl", "agent is loaded with the cluster plist", loaded.returncode == 0)
    app_plist = os.path.expanduser(f"~/Library/LaunchAgents/{app_agent_label}.plist")
    if os.path.exists(app_plist):
        lint = subprocess.run(["plutil", "-lint", app_plist], capture_output=True, text=True, timeout=30)
        check("ctl", "app-agent plist lints clean", lint.returncode == 0, lint.stderr[:120])
        with open(app_plist) as f:
            content = f.read()
        check("ctl", "app-agent is RunAtLoad open (no KeepAlive — app stays user-closable)",
              "RunAtLoad" in content and "KeepAlive" not in content and "/usr/bin/open" in content)
    sup = subprocess.run(["bash", "-n", cluster_sh], capture_output=True, text=True, timeout=30)
    check("ctl", "cluster.sh (supervisor) syntax clean",
          os.path.exists(cluster_sh) and sup.returncode == 0, sup.stderr[:120])


def suite_frozen_files():
    """The legacy daisy_*.py files must be untouched by all cluster work."""
    print("== SUITE 8: FROZEN LEGACY FILES ==")
    for name in FROZEN_FILES:
        path = os.path.join(ROOT, name)
        ok = os.path.exists(path) and os.path.getsize(path) == FROZEN_SIZES.get(name)
        check("frozen", f"{name} byte-size unchanged", ok)
    # Frozen = "byte-size unchanged" (the legacy files may receive reviewed,
    # committed security fixes — e.g. the escJs injection fix — but any change
    # must be deliberate, size-tracked here). The old git-clean check failed
    # the suite for 10s after every committed fix until the pin was refreshed.
    git_status = subprocess.run(["git", "status", "--porcelain", "--", *FROZEN_FILES],
                                cwd=ROOT, capture_output=True, text=True)
    check("frozen", "git reports no modifications", git_status.stdout.strip() == "",
          git_status.stdout.strip()[:100])


# ---------------------------------------------------------------------------
def suite_drill_harness():
    """S19: scripts/freeze_drill.py — the shared staleness/freshness harness
    used by app freeze drills AND installer stage-5 verification. Hermetic:
    all state lives in a temp dir, no live cluster needed."""
    S = "drill"
    check(S, "frozen module imports cleanly", True)  # import at top proves it

    NOW = 1_000_000_000.0  # fixed wall clock (s) for boundary math
    T0 = 1_000_000_000.0
    check(S, "badge_state: fresh ts → live (≤5s)",
          fdh.badge_state((T0 - 4.2) * 1000, now_ms=T0 * 1000) == "live")
    check(S, "badge_state: exact boundary is live (age == 5000ms)",
          fdh.badge_state((T0 - 5.0) * 1000, now_ms=T0 * 1000) == "live")
    check(S, "badge_state: past boundary → stale",
          fdh.badge_state((T0 - 5.001) * 1000, now_ms=T0 * 1000) == "stale")
    check(S, "badge_state: missing ts → unknown (not live)",
          fdh.badge_state(None) == "unknown")

    tmp = os.path.join(tempfile.mkdtemp(prefix="s19-"), "telemetry.json")
    check(S, "file_age/is_fresh: missing file is not fresh",
          fdh.file_age_s(tmp) is None and fdh.is_fresh(tmp) is False)
    with open(tmp, "w") as f:
        json.dump({"ts": 1}, f)
    os.utime(tmp, (NOW - 30, NOW - 30))
    check(S, "is_fresh: 30s-old file fails a 12s bound",
          fdh.is_fresh(tmp, max_age_s=12, now=NOW) is False)
    check(S, "wait_for_fresh: times out on a stale leftover (exit-1 shape)",
          fdh.wait_for_fresh(tmp, max_age_s=12, timeout_s=1.5, poll_s=0.2) is False)
    os.utime(tmp, (NOW, NOW))
    check(S, "is_fresh: just-written file passes",
          fdh.is_fresh(tmp, max_age_s=12, now=NOW) is True)
    check(S, "payload_ts: parses json ts, rejects junk",
          fdh.payload_ts(tmp) == 1 and fdh.payload_ts(tmp + ".nope") is None)

    log = os.path.join(tempfile.mkdtemp(prefix="s19-log-"), "shell.log")
    with open(log, "w") as f:
        f.write('[shell] backend spawned (/usr/local/bin/node 123)\n'
                '[shell] telemetry emit loop live: '
                '"/Users/x/Library/Application Support/DaisyCluster/'
                'database/telemetry.json"\n')
    got = fdh.emit_loop_path(log)
    check(S, "emit_loop_path: extracts the real Application Support path",
          got == "/Users/x/Library/Application Support/DaisyCluster/"
          "database/telemetry.json", got)
    check(S, "emit_loop_path: absent line → None (build must fail closed)",
          fdh.emit_loop_path(log + ".empty") is None)

    # CLI end-to-end: `fresh` exit codes are the installer's verdict.
    # (The CLI compares against the REAL clock, so staleness here comes from
    # os.utime to a past epoch — the fixed NOW constant is only for the pure
    # functions above, which take `now` as a parameter.)
    def _run_fresh():
        return subprocess.run(
            [sys.executable, os.path.join(ROOT, "scripts", "freeze_drill.py"),
             "fresh", "--file", tmp, "--max-age", "12", "--timeout", "0.5",
             "--interval", "0.1"], capture_output=True, text=True)

    os.utime(tmp, (NOW - 3600, NOW - 3600))  # an hour before year-2001 → very stale
    stale_run = _run_fresh()
    check(S, "CLI fresh: stale file exits 1 with the installer's verdict line",
          stale_run.returncode == 1 and "not being written" in stale_run.stderr,
          stale_run.stderr.strip()[:70])
    os.utime(tmp)  # touch → mtime = real now → fresh
    check(S, "CLI fresh: fresh file exits 0", _run_fresh().returncode == 0)


# ---------------------------------------------------------------------------
def main():
    print("🌼 Daisy Cluster self-test battery (Phase 6)")
    print("=" * 60)
    suite_governor_battery()
    suite_backend_battery()
    suite_stale_telemetry_guard()
    suite_skill_executor()
    suite_drill_failsafe()
    suite_live_pipeline()
    suite_telemetry()
    suite_shell_artifacts()
    suite_control_script()
    suite_frozen_files()
    suite_drill_harness()

    print("\n" + "=" * 60)
    suites = {}
    for s, n, ok, _d in RESULTS:
        suites.setdefault(s, [0, 0])
        suites[s][0] += 1
        suites[s][1] += (1 if ok else 0)
    fails = []
    print(f"{'SUITE':<12}{'PASS':>6}{'TOTAL':>7}  GRADE")
    for s, (total, passed) in suites.items():
        pct = passed / total if total else 0
        grade = ("A" if pct == 1 else "B" if pct >= .9 else "C" if pct >= .75
                 else "D" if pct >= .5 else "F")
        print(f"{s:<12}{passed:>6}{total:>7}  {grade}")
        fails += [(s, n, d) for su, n, ok, d in RESULTS if su == s and not ok]
    passed_sum = sum(t for _, t in suites.values())
    total_sum = sum(p for p, _ in suites.values())
    print(f"\nTOTAL: {passed_sum}/{total_sum} checks passed")
    if fails:
        print("\nFAILURES:")
        for s, n, d in fails:
            print(f"  [{s}] {n}" + (f" — {d}" if d else ""))
        sys.exit(1)
    print("ALL GREEN — cluster verified and launch-ready.")


if __name__ == "__main__":
    main()
