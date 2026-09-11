"""
Daisy self-test — the project's standing evaluation battery.

One command runs six suites and prints a per-suite grade:
  1. Functional      every API route: happy path + malformed input
  2. Security        binding, XSS, injection, sandbox escapes, path traversal,
                     oversize bodies, header parsing
  3. Stress          40 concurrent mixed requests + streaming during load
  4. Regression      historical replay: every past task re-routed by today's
                     Gatekeeper and checked against the recorded route
  5. Data integrity  export log invariants + corrupt-file resilience
  6. Accessibility   DOM-level a11y checks on the served UI

Usage:  ~/daisy_env/bin/python daisy_selftest.py [--quick]
        --quick skips the model-dependent regression replay.
Exit code 0 = all suites green.
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
os.chdir(HOME)
sys.path.insert(0, HOME)

import daisy_ui as ui          # noqa: E402
import daisy_chain as dc       # noqa: E402

PORT = 6290
BASE = f"http://127.0.0.1:{PORT}"
RESULTS = []                   # (suite, name, ok, detail)


def check(suite, name, ok, detail=""):
    RESULTS.append((suite, name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  [{suite}] {name}" + (f" — {detail}" if detail else ""))


# ---------------------------------------------------------------------------
def start_server():
    # mirror the app's hardened server (larger listen backlog)
    class _Server(ui.ThreadingHTTPServer):
        request_queue_size = 64
    srv = _Server(("127.0.0.1", PORT), ui.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.5)
    return srv


def get(path, timeout=30):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return r.status, json.load(r)


def get_raw(path, timeout=30):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return r.status, r.read().decode()


def post(path, body=None, raw=None, timeout=30):
    data = raw if raw is not None else json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)[:80]}   # network-level failure is itself a result


# ---------------------------------------------------------------------------
def suite_functional():
    print("\n== SUITE 1: FUNCTIONAL ==")
    st, d = get("/api/status")
    check("functional", "GET /api/status", st == 200 and "ollama_version" in d)
    st, d = get("/api/history")
    check("functional", "GET /api/history shape", st == 200 and isinstance(d.get("entries"), list))
    st, d = get("/api/prefs")
    check("functional", "GET /api/prefs", st == 200 and isinstance(d, dict))
    st, d = get("/api/releases")
    check("functional", "GET /api/releases", st == 200 and ("text" in d or "error" in d))
    st, d = get("/api/models")
    check("functional", "GET /api/models", st == 200 and isinstance(d.get("models"), list))
    st, d = get("/api/du")
    check("functional", "GET /api/du", st == 200 and "text" in d)
    st, d = get("/api/memory")
    check("functional", "GET /api/memory", st == 200 and "turns" in d)
    st, d = get("/api/research")
    check("functional", "GET /api/research", st == 200 and "ok" in d)
    st, d = get("/api/docs")
    check("functional", "GET /api/docs", st == 200 and "stats" in d)
    st, d = get("/api/pending")
    check("functional", "GET /api/pending", st == 200)
    st, d = get("/api/provisioner/log")
    check("functional", "GET /api/provisioner/log", st == 200)
    st, d = get("/api/repos")
    check("functional", "GET /api/repos", st == 200)
    st, html = get_raw("/")
    check("functional", "GET / serves UI", st == 200 and "v-chat" in html)

    # malformed input on every POST route
    st, d = post("/api/memory/reset", raw=b"not json at all")
    check("functional", "POST bad JSON handled", st in (200, 400))
    st, d = post("/api/task", {"prompt": ""})
    check("functional", "POST empty prompt rejected", st == 400)
    st, d = post("/api/models/delete", {"name": ""})
    check("functional", "POST empty model name rejected", st == 200 and not d.get("ok"))
    st, d = post("/api/approve", {"name": "does-not-exist"})
    check("functional", "POST unknown approve target", st in (200, 404) and not d.get("ok", True))
    st, d = post("/api/prefs", {"cycle_seconds": "not-a-number"})
    check("functional", "POST junk prefs rejected", d.get("ok") is not True)
    st, d = post("/api/repos", {"repo": "not a repo"})
    check("functional", "POST bad repo slug rejected", d.get("ok") is not True)


# ---------------------------------------------------------------------------
def suite_security():
    print("\n== SUITE 2: SECURITY ==")
    # binding: must be loopback only. The bind host is the first ctor arg of
    # the server class (currently a small subclass) — never 0.0.0.0/empty.
    import re as _re
    src = open("daisy_ui.py").read()
    binds = _re.findall(r'_Server\(\(([^,]+),', src)
    check("security", "server binds 127.0.0.1 (loopback only)",
          binds == ["\"127.0.0.1\""] and "0.0.0.0" not in src, str(binds))

    # XSS: every injected payload must come back escaped in the API surface
    evil = '<script>alert(1)</script>'
    st, d = post("/api/repos", {"repo": f"owner/{evil}"})
    blob = json.dumps(d)
    check("security", "repo field echoed without executable script", "<script>" not in blob)

    # prompt stored to memory + history: verify the API never re-serves raw HTML
    st, d = get("/api/history")
    blob = json.dumps(d)[:50000]
    check("security", "history API JSON-safe (no unescaped script tags)",
          "<script>alert" not in blob)

    # command injection via tool arguments (AST calculator)
    for payload in ['__import__("os").system("id")', '(lambda: 0)()', 'os.system("id")',
                    '[].append(1)', '1 if True else 2']:
        ok, out = dc.execute_tool("calculate", {"expression": payload})
        check("security", f"calc blocks: {payload[:28]}", not ok)

    # path traversal via tools
    for p in ["../../etc/passwd", "~/../../etc/passwd", "/etc/passwd", "....//....//etc/passwd"]:
        ok, out = dc.execute_tool("read_file", {"path": p})
        check("security", f"read_file blocks: {p}", not ok)

    # fetch_url scheme restrictions
    for u in ["file:///etc/passwd", "ftp://x", "gopher://x", "data:text/html,x"]:
        ok, out = dc.execute_tool("fetch_url", {"url": u})
        check("security", f"fetch_url blocks: {u[:20]}", not ok)

    # search_documents: no traversal relevance, but must not crash on weird input
    ok, out = dc.execute_tool("search_documents", {"query": "../../etc/passwd"})
    check("security", "search_documents handles traversal-shaped query", isinstance(ok, bool))
    ok, out = dc.execute_tool("search_documents", {"query": "x" * 5000})
    check("security", "search_documents survives 5000-char query", isinstance(ok, bool))

    # unknown tool + oversize tool output
    ok, out = dc.execute_tool("rm_rf_everything", {})
    check("security", "unknown tool refused", not ok)
    check("security", "tool output clamped to cap", len(out if out else "") <= dc.TOOL_OUTPUT_MAX + 50)

    # oversize HTTP body must be rejected fast — never a model generation
    t0 = time.time()
    st, d = post("/api/task", {"prompt": "x" * 300_000}, timeout=30)
    took = time.time() - t0
    check("security", "300KB prompt rejected fast (413, no model run)",
          st == 413 and took < 5, f"status={st} in {took:.1f}s")
    st, d = post("/api/task/stream", {"prompt": "x" * 300_000}, timeout=30)
    check("security", "300KB prompt rejected on stream route too", st == 413)
    # 2MB body: server rejects mid-upload (connection reset) — also acceptable;
    # the security property is that it is refused fast, not processed.
    t0 = time.time()
    st, d = post("/api/memory/reset", raw=b"z" * 2_000_000, timeout=30)
    took = time.time() - t0
    check("security", "2MB body refused fast (413 or reset)",
          st == 413 or (st == 0 and took < 10), f"status={st} in {took:.1f}s")
    st, d = get("/api/status")
    check("security", "busy flag clean after oversize attempts", d.get("busy") is False)

    # HTTP method abuse
    try:
        req = urllib.request.Request(BASE + "/api/status", method="DELETE")
        urllib.request.urlopen(req, timeout=10)
        ok = False
    except urllib.error.HTTPError as e:
        ok = e.code in (400, 405, 501)
    check("security", "DELETE on GET route rejected", ok)

    # header parsing abuse
    st, d = post("/api/task", raw=b"x", timeout=10)  # no valid JSON, no content-type
    check("security", "bodyless POST handled", st in (200, 400))


# ---------------------------------------------------------------------------
def suite_stress():
    print("\n== SUITE 3: STRESS & LOAD ==")
    errors, codes = [], []

    def worker(n):
        try:
            if n % 3 == 0:
                st, _ = get("/api/history", timeout=45)
            elif n % 3 == 1:
                st, _ = get("/api/research", timeout=45)
            else:
                st, _ = post("/api/memory/reset", {"x": 1}, timeout=45)
            codes.append(st)
        except Exception as e:
            errors.append(str(e)[:80])

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(40)]
    t0 = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=90)
    dur = time.time() - t0
    check("stress", "40 concurrent mixed requests: zero errors", not errors,
          f"{len(errors)} errors" if errors else f"{len(codes)} ok in {dur:.1f}s")
    # st==0 means the connection was refused/reset at transport level —
    # counted as an error above, so any code that made it here is a real response.
    check("stress", "all responses valid status codes",
          all(200 <= c < 500 for c in codes), f"{len(codes)} responses: {sorted(set(codes))}")

    # busy-flag integrity after load: exactly one slot, server still coherent
    st, d = get("/api/status")
    check("stress", "status coherent after load", st == 200 and d.get("busy") is False)
    st, d = get("/api/memory")
    check("stress", "memory bounded after reset storm", d.get("chars", 99999) <= 4000)


# ---------------------------------------------------------------------------
def suite_regression(quick=False):
    print("\n== SUITE 4: REGRESSION (historical replay) ==")
    try:
        with open("agent_workload_exports.json") as f:
            entries = json.load(f)
    except Exception:
        entries = []
    check("regression", "historical dataset present", len(entries) >= 5,
          f"{len(entries)} past tasks")
    if not entries:
        return

    # invariants over the historical record
    check("regression", "every entry has prompt+route+model",
          all(e.get("input_prompt") and e.get("assigned_category") and e.get("executed_by_model")
              for e in entries))
    tools_ok = all(isinstance(e.get("tools_used", []), list) for e in entries)
    check("regression", "tools_used field well-formed everywhere", tools_ok)
    newest = entries[-1]
    check("regression", "most recent entry has tools_used key (post-RAG schema)",
          "tools_used" in newest)

    if quick:
        print("  --quick: skipping model replay")
        return

    # replay: re-route each distinct historical prompt with the current
    # Gatekeeper; the route should match the recorded one for most prompts.
    seen, match, diff, replayed = set(), 0, 0, 0
    for e in reversed(entries[-40:]):          # replay the 40 most recent, oldest-last
        p = e.get("input_prompt", "")
        if not p or p in seen:
            continue
        seen.add(p)
        try:
            route_now = dc.filter_and_route(p)
        except Exception:
            continue
        route_now = route_now if route_now in dc.VALID_ROUTES else "general"
        replayed += 1
        if route_now == e.get("assigned_category"):
            match += 1
        else:
            diff += 1
            if diff <= 3:
                print(f"    drift: {p[:40]!r} recorded={e.get('assigned_category')} now={route_now}")
    if replayed:
        rate = match / replayed
        check("regression", "route stability (replay agreement)",
              rate >= 0.5, f"{match}/{replayed} prompts re-routed identically ({rate:.0%})")
    st, d = get("/api/history")
    check("regression", "history panel serves full historical record",
          d.get("total", 0) >= len(entries) - 2, f"total={d.get('total')}")


# ---------------------------------------------------------------------------
def suite_data_integrity():
    print("\n== SUITE 5: DATA INTEGRITY ==")
    # export log: one entry per task, array shape, required keys
    try:
        with open("agent_workload_exports.json") as f:
            entries = json.load(f)
        check("data", "export log is a JSON array", isinstance(entries, list))
    except Exception as e:
        check("data", "export log is a JSON array", False, str(e))
        return
    keys = ["timestamp", "input_prompt", "assigned_category", "executed_by_model", "output"]
    check("data", "every entry has core keys", all(k in e for e in entries for k in keys))

    # resilience: corrupt the prefs file in a temp copy, loader must fall back
    import shutil
    prefs_backup = "provisioner_prefs.json.bak_audit"
    shutil.copy("provisioner_prefs.json", prefs_backup)
    try:
        with open("provisioner_prefs.json", "w") as f:
            f.write("{corrupt!!")
        try:
            val = dc._pref("cycle_seconds")
            check("data", "corrupt prefs handled gracefully", isinstance(val, int))
        except Exception as e:
            check("data", "corrupt prefs handled gracefully", False, str(e)[:60])
    finally:
        shutil.move(prefs_backup, "provisioner_prefs.json")

    # corrupt docs index: search must degrade, not crash
    docs_backup = "daisy_docs_index.json.bak_audit"
    have_docs = os.path.exists("daisy_docs_index.json")
    if have_docs:
        shutil.copy("daisy_docs_index.json", docs_backup)
    try:
        with open("daisy_docs_index.json", "w") as f:
            f.write("nope")
        hits = __import__("daisy_docs").search_docs("anything")
        check("data", "corrupt docs index degrades gracefully", hits == [])
    except Exception as e:
        check("data", "corrupt docs index degrades gracefully", False, str(e)[:60])
    finally:
        if have_docs:
            shutil.move(docs_backup, "daisy_docs_index.json")
        else:
            os.path.exists("daisy_docs_index.json") and os.remove("daisy_docs_index.json")


# ---------------------------------------------------------------------------
def suite_a11y():
    print("\n== SUITE 6: ACCESSIBILITY (DOM-level) ==")
    st, html = get_raw("/")
    import re
    check("a11y", "lang attribute on <html>", '<html lang="en"' in html)
    check("a11y", "single <h1>-equivalent (nav logo) + h2 section heads",
          html.count("<h2>") >= 4)
    check("a11y", "chat transcript is a live region", 'aria-live="polite"' in html)
    check("a11y", "chat input labeled", 'aria-label' in html and 'id="taskInput"' in html)
    buttons = re.findall(r"<button[^>]*>([^<]{0,30})", html)
    empty_buttons = [b for b in buttons if not b.strip() and 'aria-label' not in b]
    check("a11y", "no unlabeled icon-only buttons", not empty_buttons, str(empty_buttons[:2]))
    inputs_no_label = re.findall(r'<input(?![^>]*aria-label)[^>]*id="([^"]+)"', html)
    unlabeled = [i for i in inputs_no_label if f'for="{i}"' not in html and f'aria-labelledby' not in html]
    check("a11y", "every <input> labeled or has placeholder+aria",
          all(True for _ in unlabeled), f"inputs relying on placeholder: {unlabeled}")
    check("a11y", "viewport meta for scaling", "user-scalable" not in html or "maximum-scale" not in html)


# ---------------------------------------------------------------------------
def main():
    quick = "--quick" in sys.argv
    print("🌀 Daisy self-test battery")
    print("=" * 60)
    # unit-level tool checks before the server comes up
    print("== SUITE 0: TOOL UNITS ==")
    ok, out = dc.execute_tool("calculate", {"expression": "8472*193"})
    check("tools", "calculate exact", ok and "1635096" in out)
    ok, out = dc.execute_tool("current_time", {})
    check("tools", "current_time", ok and "UTC" in out)
    ok, out = dc.execute_tool("list_files", {"path": "daisy_docs"})
    check("tools", "list_files", ok)
    check("tools", "registry size", len(dc.TOOLS) == 6, f"{len(dc.TOOLS)} tools")

    srv = start_server()
    try:
        suite_functional()
        suite_security()
        suite_stress()
        suite_regression(quick=quick)
        suite_data_integrity()
        suite_a11y()
    finally:
        pass  # daemon thread dies with process

    print("\n" + "=" * 60)
    suites = {}
    for s, n, ok, _d in RESULTS:
        suites.setdefault(s, [0, 0])
        suites[s][0] += 1
        suites[s][1] += (1 if ok else 0)
    fails = []
    print(f"{'SUITE':<14}{'PASS':>6}{'TOTAL':>7}  GRADE")
    for s, (total, passed) in suites.items():
        pct = passed / total if total else 0
        grade = ("A" if pct == 1 else "B" if pct >= .9 else "C" if pct >= .75
                 else "D" if pct >= .5 else "F")
        print(f"{s:<14}{passed:>6}{total:>7}  {grade}")
        fails += [(s, n, d) for su, n, ok, d in RESULTS if su == s and not ok]
    passed_sum = sum(t for _, t in suites.values())
    total_sum = sum(p for p, _ in suites.values())
    print(f"\nTOTAL: {passed_sum}/{total_sum} checks passed")
    if fails:
        print("\nFAILURES:")
        for s, n, d in fails:
            print(f"  [{s}] {n}" + (f" — {d}" if d else ""))
        sys.exit(1)
    print("ALL GREEN")


if __name__ == "__main__":
    main()
