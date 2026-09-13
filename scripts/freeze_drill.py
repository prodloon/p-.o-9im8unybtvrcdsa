#!/usr/bin/env python3
"""
freeze_drill.py — one tested harness for staleness/freshness verdicts
=====================================================================
Two consumers, one core (they drifted toward two ad-hoc copies once;
this file exists so they never drift again):

  1. Freeze drills (operator-driven, e.g. the app-mode stale-badge drill):
       python3 scripts/freeze_drill.py sample --file <telemetry.json> \
            [--stale-ms 5000] [--duration 25] [--interval 1.0]
     Prints an ISO-timestamped transcript of badge states computed from the
     file's payload `ts` — the same transition function the dashboard badge
     runs (age ≤ stale_ms → live, else stale; missing ts → unknown).
     SIGINT/SIGTERM stops sampling cleanly.

  2. Installer stage-5 verification (make-installer.sh):
       python3 scripts/freeze_drill.py fresh --file <telemetry.json> \
            --max-age 12 --timeout 15
     Exits 0 iff the file exists AND gets a write younger than --max-age
     within --timeout. A proof line alone can be satisfied by a stale
     leftover, so freshness is the real regression signal.

Shared core (importable, unit-tested in daisy_cluster_selftest.py):
  badge_state / file_age_s / is_fresh / wait_for_fresh / emit_loop_path
Stdlib only; no dependency on a live cluster — tests run hermetic.
"""
import argparse
import datetime
import json
import os
import signal
import sys
import time

DEFAULT_STALE_MS = 5000   # dashboard badge threshold (STALE_MS in App.jsx)
DEFAULT_MAX_AGE_S = 12    # installer freshness bound (backend writes ~1-3s)


# ────────────────────────────── shared core ──────────────────────────────

def badge_state(ts_ms, now_ms=None, stale_ms=DEFAULT_STALE_MS):
    """The dashboard badge's transition function, from a payload ts (ms)."""
    if ts_ms is None:
        return "unknown"
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    return "live" if (now_ms - ts_ms) <= stale_ms else "stale"


def file_age_s(path, now=None):
    """Age of a file's mtime in seconds; None if the file doesn't exist."""
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return None
    now = time.time() if now is None else now
    return max(0.0, now - mtime)


def is_fresh(path, max_age_s=DEFAULT_MAX_AGE_S, now=None):
    """True iff the file exists and was written within max_age_s."""
    age = file_age_s(path, now=now)
    return age is not None and age <= max_age_s


def wait_for_fresh(path, max_age_s=DEFAULT_MAX_AGE_S,
                   timeout_s=15.0, poll_s=1.0):
    """Poll until the file is fresh; True on success, False on timeout."""
    deadline = time.monotonic() + timeout_s
    while True:
        if is_fresh(path, max_age_s=max_age_s):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(poll_s)


def emit_loop_path(shell_log_path):
    """Extract the path from the Rust shell's one-time emit-loop proof line:
    '[shell] telemetry emit loop live: "<path>"'. None if absent."""
    try:
        with open(shell_log_path, "r", errors="replace") as f:
            for line in f:
                if "telemetry emit loop live:" in line:
                    return (
                        line.split("telemetry emit loop live:", 1)[1]
                        .strip()
                        .strip('"')
                    )
    except OSError:
        pass
    return None


def payload_ts(path):
    """Payload `ts` (unix ms) from a telemetry JSON file; None if unreadable."""
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    ts = data.get("ts")
    return ts if isinstance(ts, (int, float)) else None


# ─────────────────────────────── subcommands ──────────────────────────────

def cmd_sample(args):
    """1Hz (or --interval) transcript of badge states — the freeze drill."""
    stop = {"flag": False}

    def _stop(_sig, _frm):
        stop["flag"] = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    deadline = time.monotonic() + args.duration if args.duration else None
    while not stop["flag"]:
        if deadline is not None and time.monotonic() >= deadline:
            break
        ts = payload_ts(args.file)
        now_ms = time.time() * 1000
        state = badge_state(ts, now_ms=now_ms, stale_ms=args.stale_ms)
        age = None if ts is None else (now_ms - ts) / 1000.0
        stamp = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
        age_s = "n/a" if age is None else f"{age:5.1f}s"
        print(f"{stamp}  state={state:<7} ts_age={age_s}", flush=True)
        time.sleep(args.interval)
    return 0


def cmd_fresh(args):
    """Installer verdict: exit 0 iff the file gets a fresh write in time."""
    if wait_for_fresh(args.file, max_age_s=args.max_age,
                      timeout_s=args.timeout, poll_s=args.interval):
        return 0
    print(f"✗ telemetry at {args.file} is not being written "
          f"(stale leftover?) — backend writes elsewhere", file=sys.stderr)
    return 1


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sample", help="badge-state transcript (freeze drill)")
    s.add_argument("--file", required=True, help="telemetry.json to sample")
    s.add_argument("--stale-ms", type=int, default=DEFAULT_STALE_MS)
    s.add_argument("--duration", type=float, default=None,
                   help="seconds to run (default: until Ctrl-C)")
    s.add_argument("--interval", type=float, default=1.0)
    s.set_defaults(fn=cmd_sample)

    f = sub.add_parser("fresh", help="wait-for-fresh verdict (installer)")
    f.add_argument("--file", required=True, help="telemetry.json to check")
    f.add_argument("--max-age", type=float, default=DEFAULT_MAX_AGE_S)
    f.add_argument("--timeout", type=float, default=15.0)
    f.add_argument("--interval", type=float, default=1.0)
    f.set_defaults(fn=cmd_fresh)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
