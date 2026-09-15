"""
Daisy UI — native desktop window for the Daisy Chain.

Runs the daisy_chain engine inside an embedded HTTP API and shows a polished
native macOS window (pywebview / WKWebView — no browser, no localhost URL bar).

Launch:  ~/daisy_env/bin/python ~/daisy_ui.py
"""

import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
from contextlib import redirect_stdout, redirect_stderr
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import daisy_chain as dc
import daisy_docs

os.chdir(os.path.expanduser("~"))  # engine files (provisioner_*.json etc.) live in home

PORT = 6274
MAX_BODY_BYTES = 1_000_000    # hard cap on any request body (DoS guard)
MAX_PROMPT_CHARS = 20_000     # a task prompt is text for a small-context model, not a file dump
_state_lock = threading.Lock()
_state = {"busy": False, "last_error": None, "provisioner_running": False}

# --------------------------------------------------------------- chat memory
# Session conversation memory: each completed task appends (user, assistant)
# turns here, and the next task's worker sees them as context so follow-up
# questions like "now make it shorter" work. In-memory only (cleared on app
# restart); 'New chat' clears it explicitly. Capped to protect the models'
# small context windows.
_conversation = []          # [{"role": "user"|"assistant", "content": str}]
MEMORY_MAX_CHARS = 4000     # ~1000 tokens of context, safe for the 7-8B workers
MEMORY_MAX_TURNS = 8        # hard cap on remembered exchange pairs
MEMORY_MAX_MSG_CHARS = 1500 # per-message clamp: even one oversized pair fits the cap
_memory_generation = 0      # bumped on every reset; in-flight tasks must match to store

# --------------------------------------------------------------- research panel
# The competitive-research daemon runs as its own LaunchAgent and writes its
# findings to ~/daisy_research; this layer only reads those files and can ask
# the daemon for an extra cycle. It never modifies them.
RESEARCH_DIR = os.path.join(os.path.expanduser("~"), "daisy_research")
RESEARCH_SPIN = {"running": False}
MATRIX_FILE = os.path.join(os.path.expanduser("~"), "daisy_feature_matrix.json")
DOCS_SPIN = {"running": False}
_capture_lock = threading.Lock()   # _capture's stdout swap is process-global


def _remember(prompt, answer, gen=None):
    """Store a completed exchange, trimming oldest turns to stay in budget.

    gen: the memory generation the task started under. If a reset happened
    while the task was in flight (generation moved on), the exchange is stale
    and dropped instead of landing in the freshly-cleared store.
    """
    with _state_lock:
        if gen is not None and gen != _memory_generation:
            return  # reset happened mid-task: do not resurrect anything
        # Clamp per message so a single huge prompt/answer can never exceed the cap:
        # one pair is at most 2 * MEMORY_MAX_MSG_CHARS < MEMORY_MAX_CHARS.
        _conversation.append({"role": "user", "content": prompt[:MEMORY_MAX_MSG_CHARS]})
        _conversation.append({"role": "assistant", "content": answer[:MEMORY_MAX_MSG_CHARS]})
        while len(_conversation) > MEMORY_MAX_TURNS * 2 or \
                sum(len(m["content"]) for m in _conversation) > MEMORY_MAX_CHARS:
            if len(_conversation) <= 2:
                break
            _conversation.pop(0)
            _conversation.pop(0)


def _memory_messages():
    """Snapshot of remembered turns (oldest first) for the worker's context."""
    with _state_lock:
        return [dict(m) for m in _conversation]


def _reset_memory():
    """Clear the store and bump the generation so in-flight tasks don't store after."""
    global _memory_generation
    with _state_lock:
        cleared = len(_conversation) // 2
        _conversation.clear()
        _memory_generation += 1
    return cleared


def _build_worker_messages(route, skills, prompt):
    """System (skills) + memory + new prompt, ready for ollama.chat."""
    messages = []
    system_msg = dc.build_skill_system_message(skills)
    if system_msg:
        messages.append({"role": "system", "content": system_msg})
    messages.extend(_memory_messages())
    messages.append({"role": "user", "content": prompt})
    return messages


_ANSI_RE = None

def _strip_ansi(text):
    import re
    return re.compile(r"\x1b\[[0-9;]*m").sub("", text)

def _capture(fn, *args, **kwargs):
    """Run a daisy_chain function and return its printed output (ANSI stripped).
    Unlike earlier versions this does NOT swallow exceptions silently — callers
    decide how to present failures, so a broken panel says so instead of
    rendering a plausible-looking 'no data' screen.

    The stdout/stderr redirection is serialized with a lock: redirect_stdout
    swaps the process-global sys.stdout, so two concurrent captures could
    otherwise deliver output into each other's buffers (found by the
    self-test stress suite)."""
    buf = io.StringIO()
    with _capture_lock:
        with redirect_stdout(buf), redirect_stderr(buf):
            fn(*args, **kwargs)
    return _strip_ansi(buf.getvalue())


# ---------------------------------------------------------------- task engine

def run_task(prompt):
    """Full chain: gatekeeper -> broker -> worker(+tools) -> export. Runs in a thread."""
    with _state_lock:
        _state["busy"] = True
        _state["last_error"] = None
        gen = _memory_generation  # reset after this point invalidates the exchange
    try:
        start = time.perf_counter()
        route = dc.filter_and_route(prompt)
        if route not in dc.VALID_ROUTES:
            route = "general"
        skills = dc.select_skills(prompt)
        model = dc.AGENT_POOL.get(route, dc.AGENT_POOL["general"])
        answer, tool_events = dc.run_worker_with_tools(
            model, _build_worker_messages(route, skills, prompt))
        elapsed = round(time.perf_counter() - start, 1)
        try:
            dc.export_workload(prompt, route, model, answer, skills, tools=tool_events)
        except Exception:
            pass
        _remember(prompt, answer, gen)
        result = {"ok": True, "prompt": prompt, "route": route, "model": model,
                  "skills": skills, "answer": answer, "seconds": elapsed,
                  "tools": tool_events}
    except Exception as e:
        result = {"ok": False, "prompt": prompt, "error": str(e)}
    finally:
        with _state_lock:
            _state["busy"] = False
    return result


def run_task_stream(prompt):
    """Generator yielding events for token-by-token rendering (SSE payloads).

    Same pipeline as run_task, but the worker model is consumed as a stream
    and every chunk is yielded the moment it arrives from Ollama.
    """
    with _state_lock:
        if _state["busy"]:
            yield {"event": "error", "error": "a task is already running"}
            return
        _state["busy"] = True
        _state["last_error"] = None
        gen = _memory_generation  # reset after this point invalidates the exchange
    try:
        start = time.perf_counter()
        route = dc.filter_and_route(prompt)
        if route not in dc.VALID_ROUTES:
            route = "general"
        skills = dc.select_skills(prompt)
        model = dc.AGENT_POOL.get(route, dc.AGENT_POOL["general"])
        yield {"event": "meta", "route": route, "model": model, "skills": skills,
               "tools_available": dc.TOOLS_ENABLED and len(dc.TOOLS) or 0}

        messages = _build_worker_messages(route, skills, prompt)

        parts, tool_events = [], []

        def _on_token(tok):
            parts.append(tok)
            yield_queue.append({"event": "token", "token": tok})

        def _on_tool(name, args):
            brief = ", ".join(f"{k}={str(v)[:40]}" for k, v in list(args.items())[:3])
            yield_queue.append({"event": "tool", "tool": name, "args": brief})

        # The tool loop is a plain generator over chat chunks internally; bridge
        # its callbacks into this generator's event stream via a queue drained
        # between chunks.
        yield_queue = []

        def _worker():
            try:
                ans, evs = dc.run_worker_with_tools(model, messages,
                                                    on_token=_on_token,
                                                    on_tool=_on_tool)
                yield_queue.append(("__done__", ans, evs))
            except Exception as e:
                yield_queue.append(("__error__", str(e)))

        wthread = threading.Thread(target=_worker, daemon=True)
        wthread.start()
        answer, err = None, None
        while True:
            if yield_queue:
                item = yield_queue.pop(0)
                if isinstance(item, tuple):
                    if item[0] == "__done__":
                        answer, tool_events = item[1], item[2]
                    else:
                        err = item[1]
                    break
                yield item
            elif wthread.is_alive():
                time.sleep(0.05)
            else:
                break
        if err is not None:
            raise RuntimeError(err)
        if answer is None:
            answer = "".join(parts)
        elapsed = round(time.perf_counter() - start, 1)
        try:
            dc.export_workload(prompt, route, model, answer, skills, tools=tool_events)
        except Exception:
            pass
        _remember(prompt, answer, gen)
        yield {"event": "done", "route": route, "model": model,
               "skills": skills, "seconds": elapsed, "tools": tool_events}
    except Exception as e:
        yield {"event": "error", "error": str(e)}
    finally:
        with _state_lock:
            _state["busy"] = False


def provisioner_cycle_async():
    def work():
        with _state_lock:
            _state["provisioner_running"] = True
        try:
            dc._provisioner_silent = True
            dc.alert_release(dc.check_ollama_releases())
            try:
                dc.alert_pypi(dc.check_pypi_package_releases("ollama"))
            except Exception:
                pass
            dc.run_provisioner_cycle()
        except Exception as e:
            dc._provisioner_log("ui_cycle_crash", str(e))
        finally:
            dc._provisioner_silent = False
            with _state_lock:
                _state["provisioner_running"] = False
    threading.Thread(target=work, daemon=True).start()


# ---------------------------------------------------------------- release cache
# GitHub's unauthenticated API allows 60 requests/hour per IP. The status poll
# used to hit it every 4s (~900/hr) which instantly exhausted the budget and
# broke the Releases panel. Cache both release checks for 15 minutes; multiple
# polls share one upstream call.
_RELEASE_CACHE = {}          # key -> (fetched_at, value)
_RELEASE_CACHE_TTL = 900

def _cached(key, fn):
    now = time.time()
    hit = _RELEASE_CACHE.get(key)
    if hit and now - hit[0] < _RELEASE_CACHE_TTL:
        return hit[1]
    try:
        val = fn()
    except Exception:
        if hit:            # serve stale rather than nothing during outages
            return hit[1]
        raise
    _RELEASE_CACHE[key] = (now, val)
    return val

def _local_ollama_version():
    """Read the version straight from Ollama's local API (no GitHub involved)."""
    try:
        with urllib.request.urlopen("http://localhost:11434/api/version", timeout=4) as r:
            return json.loads(r.read().decode()).get("version")
    except Exception:
        return None


# ---------------------------------------------------------------- api helpers

def api_status():
    pending = len(dc._load_pending())
    with _state_lock:
        busy, prov, err = _state["busy"], _state["provisioner_running"], _state["last_error"]
        research_running = RESEARCH_SPIN["running"]
        docs_indexing = DOCS_SPIN["running"]
    ollama_ver = _local_ollama_version()
    try:
        rel = _cached("gh_releases", dc.check_ollama_releases) or {}
        update = rel.get("update_available", False)
        latest = rel.get("latest")
        pre = rel.get("prerelease") if rel.get("prerelease_newer") else None
    except Exception:
        latest = update = pre = None
    try:
        pypi = _cached("pypi_ollama", lambda: dc.check_pypi_package_releases("ollama") or {})
    except Exception:
        pypi = {}
    try:
        ok = dc.check_ollama(silent=True)
    except Exception:
        ok = False
    return {"ok": ok, "ollama_version": ollama_ver, "ollama_latest": latest,
            "ollama_update": update, "prerelease": pre,
            "pypi_installed": pypi.get("installed"), "pypi_latest": pypi.get("latest"),
            "pypi_update": pypi.get("update_available", False),
            "busy": busy, "provisioner_running": prov, "pending": pending,
            "research_running": research_running,
            "docs_indexing": docs_indexing,
            "auto_install": dc.AUTO_INSTALL, "error": err,
            "cycle_seconds": dc._pref("cycle_seconds")}


def api_history():
    data = _load_exports()
    by_route, by_model, by_skill = {}, {}, {}
    for e in data:
        r = e.get("assigned_category", "unknown")
        by_route[r] = by_route.get(r, 0) + 1
        m = e.get("executed_by_model", "unknown")
        by_model[m] = by_model.get(m, 0) + 1
        for s in (e.get("skills_applied") or []):
            by_skill[s] = by_skill.get(s, 0) + 1
    return {"total": len(data), "by_route": by_route, "by_model": by_model,
            "by_skill": by_skill, "entries": list(reversed(data[-50:]))}


def _load_exports():
    try:
        with open("agent_workload_exports.json") as f:
            data = json.load(f)
    except Exception:
        return []
    return data if isinstance(data, list) else []


def api_delete_history(body):
    """Delete one logged task by index (index into the full export list)."""
    idx = (body or {}).get("index")
    data = _load_exports()
    if not isinstance(idx, int) or idx < 0 or idx >= len(data):
        return {"ok": False, "error": f"invalid index (0..{len(data)-1})"}
    removed = data.pop(idx)
    try:
        with open("agent_workload_exports.json", "w") as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    dc._provisioner_log("history_deleted", {"index": idx,
                        "task": (removed.get("input_prompt") or "")[:60]})
    return {"ok": True, "remaining": len(data)}


def api_prefs():
    keys = ["channel", "cycle_seconds", "sandbox_max_disk_mb",
            "repo_reaudit_hours", "repos_per_cycle", "pending_max"]
    return {k: dc._pref(k) for k in keys}


def api_set_prefs(body):
    ints = {"cycle_seconds", "sandbox_max_disk_mb", "repo_reaudit_hours",
            "repos_per_cycle", "pending_max"}
    prefs = dc._load_prefs()
    changed = {}
    for k, v in (body or {}).items():
        if k == "channel":
            if v in ("stable", "all"):
                prefs["channel"] = v
                changed[k] = v
        elif k in ints:
            try:
                v = int(v)
                if v > 0:
                    prefs[k] = v
                    changed[k] = v
            except (TypeError, ValueError):
                pass
    if not changed:
        # Invalid input must fail loudly, not save-and-smile. (Found by the
        # self-test battery: junk values were silently ignored but reported ok.)
        return {"ok": False, "error": "no valid settings in request — "
                "numeric prefs must be positive integers, channel is 'stable' or 'all'",
                "changed": {}}
    dc._save_prefs(prefs)
    dc._provisioner_log("prefs_changed", changed)
    return {"ok": True, "changed": changed, "prefs": api_prefs()}


def api_provisioner_log():
    try:
        with open(dc.PROVISIONER_LOG_FILE) as f:
            entries = json.load(f)
    except Exception:
        entries = []
    if not isinstance(entries, list):
        entries = []
    return {"entries": list(reversed(entries[-100:]))}


def api_reports():
    try:
        with open(dc.PROVISIONER_REPORTS_FILE) as f:
            reports = json.load(f)
    except Exception:
        reports = []
    if not isinstance(reports, list):
        reports = []
    return {"reports": list(reversed(reports[-20:]))}


def api_pending():
    items = dc._load_pending()
    return {"items": items}


def _execute_candidate_bounded(cand, timeout=180):
    """Run execute_candidate with a hard wall-clock cap.

    model pulls / pip installs normally finish in minutes at worst, but a
    network stall must never hang the Approve HTTP call forever — the UI
    would spin with no way out. On timeout the attempt is failed loudly; the
    suggestion stays parked for another try."""
    outcome = {}
    def work():
        try:
            outcome["result"] = dc.execute_candidate(cand)
        except Exception as e:
            outcome["result"] = (False, str(e))
    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        return False, f"execution exceeded {timeout}s (likely a network stall) — still parked, try again"
    return outcome.get("result", (False, "no result"))


def api_approve(body):
    """Approve (execute) or dismiss a parked suggestion by name."""
    name = (body or {}).get("name", "")
    action = (body or {}).get("action", "approve")
    items = dc._load_pending()
    target = next((i for i in items if i.get("candidate", {}).get("name") == name), None)
    if not target:
        return {"ok": False, "error": "not found in pending queue"}
    cand = target.get("candidate", {})
    if action == "dismiss":
        items.remove(target)
        dc._save_pending(items)
        dc._provisioner_log("ui_dismissed", {"candidate": cand})
        return {"ok": True, "action": "dismissed"}
    # approve: re-vet then execute (bounded so the UI can never hang)
    safe, reasons = dc.run_safety_checklist(cand)
    if not safe:
        items.remove(target)
        dc._save_pending(items)
        return {"ok": False, "error": "failed safety re-check: " + "; ".join(reasons)}
    ok, msg = _execute_candidate_bounded(cand)
    if ok or "exceeded" not in str(msg):
        items.remove(target)
        dc._save_pending(items)
    dc._provisioner_log("approved_execute" if ok else "execute_failed",
                        {"candidate": cand, "message": msg})
    return {"ok": ok, "message": msg}


def api_repos():
    return {"repos": dc._sandbox_jobs(), "sandbox_mb": round(dc._sandbox_disk_mb(), 1),
            "sandbox_root": dc.SANDBOX_ROOT}


def api_add_repo(body):
    repo = (body or {}).get("repo", "").strip()
    ok, msg = dc.add_repo_job(repo)
    return {"ok": ok, "message": msg}


def api_du():
    try:
        text = _capture(dc.handle_du)
        return {"text": text.strip()}
    except Exception as e:
        return {"text": "", "error": f"disk-usage scan failed: {e}"}


def api_cleanup():
    """Non-interactive cleanup: sandbox, pending queue, log trims."""
    freed = {}
    if os.path.isdir(dc.SANDBOX_ROOT):
        size = dc._sandbox_disk_mb()
        shutil.rmtree(dc.SANDBOX_ROOT, ignore_errors=True)
        freed["sandbox_mb"] = round(size, 1)
    pend = dc._load_pending()
    if pend:
        freed["pending_cleared"] = len(pend)
        dc._save_pending([])
    for fname in (dc.PROVISIONER_LOG_FILE,):
        try:
            with open(fname) as f:
                data = json.load(f)
            if isinstance(data, list) and len(data) > 100:
                keep = data[-100:]
                with open(fname, "w") as f:
                    json.dump(keep, f, indent=2)
                freed["log_trimmed"] = len(data) - len(keep)
        except Exception:
            pass
    dc._provisioner_log("ui_cleanup", freed)
    return {"ok": True, "freed": freed}


def api_releases():
    try:
        text = _cached("gh_history", lambda: _capture(dc.show_release_history, 10))
        return {"text": text.strip()}
    except Exception as e:
        msg = str(e)
        if "403" in msg or "rate limit" in msg.lower():
            return {"text": "", "error": "GitHub API rate limit reached (60/hr without auth). "
                    "Cached data will appear within 15 minutes; the limit resets hourly."}
        return {"text": "", "error": f"could not fetch releases: {msg}"}


def api_whatsnew(version):
    try:
        text = _cached("gh_notes_" + version, lambda: _capture(dc.show_release_notes, version))
        return {"text": text.strip()}
    except Exception as e:
        msg = str(e)
        if "403" in msg or "rate limit" in msg.lower():
            return {"text": "", "error": "GitHub API rate limit reached — try again in a few minutes."}
        return {"text": "", "error": f"could not fetch release notes: {msg}"}


def api_memory():
    """Small preview of what the worker currently remembers."""
    with _state_lock:
        turns = len(_conversation) // 2
        first = _conversation[0]["content"] if _conversation else None
    return {"turns": turns,
            "chars": sum(len(m["content"]) for m in _conversation),
            "oldest": (first[:80] + "…") if first and len(first) > 80 else first}


def api_models():
    try:
        r = dc.ollama.list()
        raw = getattr(r, "models", None) or (r.get("models") if isinstance(r, dict) else []) or []
        models = []
        for m in raw:
            n = getattr(m, "model", None) or (m.get("model") or m.get("name") if isinstance(m, dict) else None)
            if not n:
                continue
            size = getattr(m, "size", None) or (m.get("size") if isinstance(m, dict) else None)
            models.append({"name": n, "size_gb": round(size / 1e9, 1) if size else None})
        models.sort(key=lambda x: x["name"])
        return {"models": models}
    except Exception as e:
        return {"models": [], "error": str(e)}


def api_delete_model(body):
    """Delete an installed Ollama model by name (reclaims disk)."""
    name = (body or {}).get("name", "").strip()
    if not name:
        return {"ok": False, "error": "no model name given"}
    protected = set(dc.AGENT_POOL.values())
    if name in protected:
        return {"ok": False, "error": f"'{name}' is used by the daisy chain — remove it from the agent pool first"}
    try:
        dc.ollama.delete(name)
        dc._provisioner_log("ui_model_deleted", {"model": name})
        return {"ok": True, "message": f"deleted {name}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def api_research():
    """Serve the competitive-research daemon's latest outputs.
    The daemon (daisy_research_daemon.py, LaunchAgent com.moses.daisy-research)
    writes report.json / suggestions.json / report.md to ~/daisy_research every
    cycle; this panel renders them read-only."""
    def _read(fname):
        path = os.path.join(RESEARCH_DIR, fname)
        if not os.path.isfile(path):
            return None
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return None

    report = _read("report.json")
    suggestions = _read("suggestions.json") or []
    md = ""
    md_path = os.path.join(RESEARCH_DIR, "report.md")
    if os.path.isfile(md_path):
        try:
            with open(md_path) as f:
                md = f.read()
        except Exception:
            md = ""
    if report is None and not md:
        return {"ok": False,
                "error": "no research report yet — the daemon writes one after its first cycle, or press 'Run cycle now'"}
    gaps = {}
    for s in suggestions:
        if isinstance(s, dict) and s.get("feature"):
            gaps[s["feature"]] = s.get("seen_in", [])
    # The shared feature matrix is read straight from disk — it is the source
    # of truth and can be newer than the last daemon report.
    matrix = None
    try:
        with open(MATRIX_FILE) as f:
            matrix = json.load(f)
    except Exception:
        matrix = None
    return {"ok": True, "report": report, "gaps": gaps, "markdown": md,
            "matrix": matrix}


def api_docs():
    """Document-index status + the indexed file list for the Documents panel."""
    try:
        stats = daisy_docs.index_stats()
    except Exception as e:
        return {"ok": False, "error": f"could not read the docs index: {e}"}
    files = []
    idx = daisy_docs._load_index()
    for rel, info in sorted(idx.get("files", {}).items()):
        files.append({"name": rel, "chunks": len(info.get("chunks", []))})
    return {"ok": True, "stats": stats, "files": files,
            "docs_dir": daisy_docs.DOCS_DIR}


def api_docs_reindex():
    """Re-index ~/daisy_docs in the background (embedding takes a moment)."""
    with _state_lock:
        if DOCS_SPIN["running"]:
            return {"ok": False, "error": "an indexing run is already in progress"}
        DOCS_SPIN["running"] = True

    def work():
        try:
            res = daisy_docs.index_docs()
            dc._provisioner_log("ui_docs_indexed",
                                {"indexed": res["indexed"], "skipped": res["skipped"],
                                 "chunks": res["chunks"]})
        except Exception as e:
            dc._provisioner_log("ui_docs_index_failed", str(e)[:200])
        finally:
            with _state_lock:
                DOCS_SPIN["running"] = False

    threading.Thread(target=work, daemon=True).start()
    return {"ok": True, "message": "indexing started"}


def api_research_run():
    """Trigger one daemon cycle in the background (same script, --once flag)."""
    with _state_lock:
        if RESEARCH_SPIN["running"]:
            return {"ok": False, "error": "a research cycle is already running"}
        RESEARCH_SPIN["running"] = True

    def work():
        try:
            subprocess.run(
                [sys.executable,
                 os.path.join(os.path.expanduser("~"), "daisy_research_daemon.py"), "--once"],
                capture_output=True, text=True, timeout=180)
            dc._provisioner_log("ui_research_run", "manual cycle from Research panel")
        except Exception as e:
            dc._provisioner_log("ui_research_run_failed", str(e)[:200])
        finally:
            with _state_lock:
                RESEARCH_SPIN["running"] = False

    threading.Thread(target=work, daemon=True).start()
    return {"ok": True, "message": "research cycle started"}


# ---------------------------------------------------------------- http server

ROUTES = {
    "/api/status": ("GET", lambda: api_status()),
    "/api/history": ("GET", lambda: api_history()),
    "/api/prefs": ("GET", lambda: api_prefs()),
    "/api/provisioner/log": ("GET", lambda: api_provisioner_log()),
    "/api/reports": ("GET", lambda: api_reports()),
    "/api/pending": ("GET", lambda: api_pending()),
    "/api/repos": ("GET", lambda: api_repos()),
    "/api/du": ("GET", lambda: api_du()),
    "/api/releases": ("GET", lambda: api_releases()),
    "/api/models": ("GET", lambda: api_models()),
    "/api/memory": ("GET", lambda: api_memory()),
    "/api/research": ("GET", lambda: api_research()),
    "/api/docs": ("GET", lambda: api_docs()),
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj, content_type="application/json"):
        payload = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        if n > MAX_BODY_BYTES:
            return None  # oversize: caller must reject with 413
        try:
            return json.loads(self.rfile.read(n).decode())
        except Exception:
            return {}

    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/" or path == "/index.html":
            self._send(200, INDEX_HTML.encode(), "text/html")
            return
        if path.startswith("/api/whatsnew/"):
            v = urllib.parse.unquote(path.split("/api/whatsnew/", 1)[1])
            self._send(200, api_whatsnew(v))
            return
        route = ROUTES.get(path)
        if route and route[0] == "GET":
            try:
                self._send(200, route[1]())
            except Exception as e:
                self._send(500, {"error": str(e)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        body = self._body()
        if body is None:
            self._send(413, {"error": "request body too large"})
            return
        try:
            if path == "/api/task":
                with _state_lock:
                    busy = _state["busy"]
                if busy:
                    self._send(409, {"error": "a task is already running"})
                    return
                prompt = (body.get("prompt") or "").strip()
                if not prompt:
                    self._send(400, {"error": "empty prompt"})
                    return
                if len(prompt) > MAX_PROMPT_CHARS:
                    self._send(413, {"error": f"prompt too long (max {MAX_PROMPT_CHARS} characters)"})
                    return
                self._send(200, run_task(prompt))
            elif path == "/api/task/stream":
                with _state_lock:
                    busy = _state["busy"]
                if busy:
                    self._send(409, {"error": "a task is already running"})
                    return
                prompt = (body.get("prompt") or "").strip()
                if not prompt:
                    self._send(400, {"error": "empty prompt"})
                    return
                if len(prompt) > MAX_PROMPT_CHARS:
                    self._send(413, {"error": f"prompt too long (max {MAX_PROMPT_CHARS} characters)"})
                    return
                # Server-Sent Events: each generator yield becomes a data line,
                # flushed immediately so the window renders tokens as they land.
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    for ev in run_task_stream(prompt):
                        self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            elif path == "/api/provisioner/run":
                if _state["provisioner_running"]:
                    self._send(409, {"error": "a cycle is already running"})
                    return
                provisioner_cycle_async()
                self._send(200, {"ok": True})
            elif path == "/api/memory/reset":
                cleared = _reset_memory()
                dc._provisioner_log("ui_memory_reset", {"turns_cleared": cleared})
                self._send(200, {"ok": True, "cleared": cleared})
            elif path == "/api/approve":
                self._send(200, api_approve(body))
            elif path == "/api/repos":
                self._send(200, api_add_repo(body))
            elif path == "/api/cleanup":
                self._send(200, api_cleanup())
            elif path == "/api/prefs":
                self._send(200, api_set_prefs(body))
            elif path == "/api/history/delete":
                self._send(200, api_delete_history(body))
            elif path == "/api/models/delete":
                self._send(200, api_delete_model(body))
            elif path == "/api/research/run":
                self._send(200, api_research_run())
            elif path == "/api/docs/reindex":
                self._send(200, api_docs_reindex())
            else:
                self._send(404, {"error": "not found"})
        except Exception as e:
            self._send(500, {"error": str(e)})


# ---------------------------------------------------------------- the UI

INDEX_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Daisy Chain</title>
<style>
  :root{
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2330; --line:#2a3140;
    --text:#e6edf3; --dim:#8b96a5; --accent:#7c9cff; --accent2:#9d7cff;
    --green:#3fb950; --red:#f85149; --yellow:#d29922; --orange:#e8823a;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;height:100vh;display:flex;overflow:hidden}
  nav{width:190px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:14px 10px;flex-shrink:0}
  .logo{font-size:17px;font-weight:700;padding:6px 10px 16px;letter-spacing:.3px}
  .logo span{color:var(--accent)}
  .navbtn{display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:9px;color:var(--dim);cursor:pointer;border:none;background:none;font-size:13.5px;width:100%;text-align:left;font-family:inherit}
  .navbtn:hover{background:var(--panel2);color:var(--text)}
  .navbtn.active{background:linear-gradient(90deg,#7c9cff22,#9d7cff11);color:var(--text)}
  .navbtn .badge{margin-left:auto;background:var(--orange);color:#fff;font-size:10.5px;border-radius:9px;padding:1px 7px;font-weight:600}
  .spacer{flex:1}
  .ver{font-size:11px;color:var(--dim);padding:8px 12px}
  .ver b{color:var(--green)}
  .ver.warn b{color:var(--red)}
  main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0}
  .view{display:none;flex:1;overflow-y:auto;padding:26px 30px;min-height:0}
  .view.active{display:block}
  .view.active.chat{display:flex}
  h2{font-size:16px;margin-bottom:14px;font-weight:650}
  h2 small{color:var(--dim);font-weight:400;font-size:12.5px;margin-left:8px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
  .row{display:flex;gap:14px;flex-wrap:wrap}
  .row .card{flex:1;min-width:200px}
  .stat{font-size:26px;font-weight:700}
  .stat small{font-size:12px;color:var(--dim);font-weight:400;display:block}
  button{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
  button:hover{filter:brightness(1.12)}
  button:disabled{opacity:.45;cursor:default}
  button.ghost{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
  button.danger{background:var(--red)}
  button.mini{padding:5px 11px;font-size:12px}
  input,select{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 12px;font-size:13.5px;font-family:inherit;outline:none}
  input:focus{border-color:var(--accent)}
  pre{background:#0a0e14;border:1px solid var(--line);border-radius:10px;padding:14px;font:12px/1.55 "SF Mono",Menlo,monospace;white-space:pre-wrap;word-break:break-word;color:#c9d5e3;overflow-x:auto}
  .tag{display:inline-block;background:var(--panel2);border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:2px 9px;font-size:11.5px;margin:2px 4px 2px 0}
  .tag.route{color:var(--accent);border-color:#7c9cff44}
  .tag.skill{color:var(--orange);border-color:#e8823a44}
  .tag.ok{color:var(--green)} .tag.bad{color:var(--red)} .tag.warn{color:var(--yellow)}
  .tag.tool{color:var(--accent2);border-color:#9d7cff44}
  .tag.toolb{color:var(--accent2);border-color:#9d7cff44}
  .chat{display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0}
  #msgs{flex:1;min-height:0;overflow-y:auto;padding:20px 30px;display:flex;flex-direction:column;gap:12px}
  .msg{max-width:78%;border-radius:14px;padding:11px 15px;white-space:pre-wrap;word-break:break-word}
  .msg.user{align-self:flex-end;background:linear-gradient(135deg,#7c9cff,#9d7cff);color:#fff;border-bottom-right-radius:4px}
  .msg.bot{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:4px}
  .msg .meta{font-size:11px;color:var(--dim);margin-top:7px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .msg.bot .meta{border-top:1px solid var(--line);padding-top:6px}
  .composer{display:flex;gap:10px;padding:14px 30px 18px;background:var(--panel);border-top:1px solid var(--line)}
  .composer input{flex:1;font-size:14.5px;padding:11px 16px}
  .spin{display:inline-block;width:13px;height:13px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px}
  .gaprow{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}
  .gaprow:last-child{border-bottom:none}
  .gapname{font-weight:600;min-width:170px}
  .gapwho{color:var(--dim);font-size:12.5px;flex:1}
  .comprow{padding:8px 0;border-bottom:1px solid var(--line)}
  .comprow:last-child{border-bottom:none}
  .updrow{padding:6px 0;font-size:13.5px}
  .dimtxt{color:var(--dim);font-size:12.5px}
  .relink{color:var(--accent);text-decoration:none;font-size:12.5px}
  .mrowx{display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--line)}
  .mrowx:last-child{border-bottom:none}
  .mrowmain{flex:1;font-size:13.5px}
  .mrowmain .dimtxt{margin-top:2px}
  .tag.st-built{color:var(--green);border-color:#3fb95044}
  .tag.st-planned{color:var(--accent);border-color:#7c9cff44}
  .tag.st-backlog{color:var(--yellow);border-color:#d2992244}
  .tag.st-notplanned{color:var(--dim)}
  @keyframes sp{to{transform:rotate(360deg)}}
  .caret{display:inline-block;width:7px;height:14px;background:var(--accent);margin-left:2px;vertical-align:-2px;animation:blink 1s steps(1) infinite}
  @keyframes blink{50%{opacity:0}}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--dim);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;padding:6px 8px;border-bottom:1px solid var(--line)}
  td{padding:8px;border-bottom:1px solid #212836;vertical-align:top}
  .pending-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #212836}
  .pending-item:last-child{border-bottom:none}
  .pending-item .why{font-size:12px;color:var(--dim)}
  .toast{position:fixed;bottom:22px;right:22px;background:var(--panel2);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;padding:12px 18px;font-size:13px;box-shadow:0 8px 30px #0009;opacity:0;transform:translateY(10px);transition:.25s;max-width:380px;z-index:9}
  .toast.show{opacity:1;transform:none}
  .toast.err{border-left-color:var(--red)}
  .empty{color:var(--dim);text-align:center;padding:34px 0;font-size:13px}
  .kv{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #212836;font-size:13px}
  .kv:last-child{border:none}
  .kv b{font-weight:600}
  .modal-bg{position:fixed;inset:0;background:#000a;display:none;align-items:center;justify-content:center;z-index:99}
  .modal-bg.show{display:flex}
  .modal{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;max-width:420px;width:90%}
  .modal p{margin-bottom:16px;font-size:14px}
  .modal .mrow{display:flex;gap:10px;justify-content:flex-end}
</style>
</head>
<body>
<nav>
  <div class="logo">🌀 Daisy<span>Chain</span></div>
  <button class="navbtn active" data-v="chat">💬 Chat</button>
  <button class="navbtn" data-v="history">🗂 History</button>
  <button class="navbtn" data-v="provisioner">🛠 Provisioner <span class="badge" id="pendingBadge" style="display:none"></span></button>
  <button class="navbtn" data-v="research">🔭 Research <span class="badge" id="researchBadge" style="display:none"></span></button>
  <button class="navbtn" data-v="releases">🏷 Releases</button>
  <button class="navbtn" data-v="system">💾 System</button>
  <button class="navbtn" data-v="settings">⚙️ Settings</button>
  <button class="navbtn" data-v="documents">📄 Documents</button>
  <div class="spacer"></div>
  <div class="ver" id="verline">connecting…</div>
</nav>
<main>
  <!-- CHAT -->
  <div class="view active chat" id="v-chat">
    <div id="msgs" aria-live="polite" aria-label="Chat transcript"><div class="empty">Type a task below — the Gatekeeper routes it, the Skill Broker attaches skills, and the right agent answers.</div></div>
    <div class="composer">
      <button class="ghost" id="newChatBtn" title="Clear conversation memory">New chat</button>
      <input id="taskInput" aria-label="Task for the AI network" placeholder="Enter a task for your local AI network…" autofocus>
      <button id="sendBtn">Send</button>
      <button class="ghost" id="stopBtn" title="Cancel the running task">Stop</button>
    </div>
  </div>
  <!-- HISTORY -->
  <div class="view" id="v-history">
    <h2>History <small id="histStats"></small></h2>
    <div class="card" style="display:flex;gap:10px"><input id="histSearch" placeholder="Search tasks, agents, models…" style="flex:1" oninput="renderHist()"></div>
    <div class="row" id="histCards"></div>
    <div class="card"><table id="histTable"><thead><tr><th>When</th><th>Task</th><th>Agent</th><th>Skills</th><th>Model</th><th></th></tr></thead><tbody></tbody></table></div>
  </div>
  <!-- PROVISIONER -->
  <div class="view" id="v-provisioner">
    <h2>Autonomous Provisioner <small id="provMode"></small></h2>
    <div class="card" style="display:flex;gap:10px;align-items:center">
      <button id="runCycleBtn">Run research cycle now</button>
      <span id="provSpin" style="display:none" class="spin"></span>
      <span id="provStatus" style="color:var(--dim);font-size:13px"></span>
    </div>
    <div class="row">
      <div class="card" style="flex:1"><h2>Parked suggestions <small id="pendingCount"></small></h2><div id="pendingList"></div></div>
    </div>
    <div class="card"><h2>Recent log</h2><pre id="provLog" style="max-height:300px;overflow-y:auto"></pre></div>
    <div class="card"><h2>Repo audit queue <small id="sandboxInfo"></small></h2>
      <div style="display:flex;gap:10px;margin-bottom:10px">
        <input id="repoInput" placeholder="owner/name — e.g. pallets/click" style="flex:1">
        <button id="addRepoBtn">Queue audit</button>
      </div>
      <div id="repoList"></div>
    </div>
    <div class="card"><h2>Sandbox audit reports</h2><pre id="reports" style="max-height:260px;overflow-y:auto">none yet</pre></div>
  </div>
  <!-- RESEARCH -->
  <div class="view" id="v-research">
    <h2>Competitive research <small id="resMeta"></small></h2>
    <div class="card" style="display:flex;gap:10px;align-items:center">
      <button id="resRunBtn">Run cycle now</button>
      <span id="resSpin" style="display:none" class="spin"></span>
      <span id="resStatus" style="color:var(--dim);font-size:13px">watches Open WebUI · AnythingLLM · Jan · Ollama every 4h (LaunchAgent)</span>
    </div>
    <div id="resError" style="display:none" class="card"><span class="tag bad">no report</span> <span id="resErrorMsg" style="color:var(--dim)"></span></div>
    <div class="card">
      <h2>Feature matrix <small id="matrixMeta"></small></h2>
      <div class="dimtxt" style="margin-bottom:8px">Shared file <b>~/daisy_feature_matrix.json</b> — you and the daemon both maintain it. Edit <b>status</b> in the file; the next cycle and this panel pick it up automatically.</div>
      <div id="matrixList"></div>
    </div>
    <div class="row">
      <div class="card" style="flex:1"><h2>Feature gaps — they have it, Daisy doesn't</h2><div id="gapList"></div></div>
      <div class="card" style="flex:1"><h2>Competitive snapshot</h2><div id="compList"></div></div>
    </div>
    <div class="card"><h2>Self-update status</h2><div id="selfUpd"></div></div>
    <div class="card"><h2>New releases this cycle</h2><div id="newRel"></div></div>
    <div class="card"><h2>Full report</h2><pre id="resMd" style="max-height:340px;overflow-y:auto"></pre></div>
  </div>
  <!-- RELEASES -->
  <div class="view" id="v-releases">
    <h2>Ollama releases</h2>
    <div class="card" style="display:flex;gap:10px">
      <input id="wnInput" placeholder="whatsnew 0.33.3" style="flex:1">
      <button id="wnBtn">Show changelog</button>
    </div>
    <pre id="releasesText">loading…</pre>
    <pre id="wnText" style="display:none"></pre>
  </div>
  <!-- SYSTEM -->
  <div class="view" id="v-system">
    <h2>System</h2>
    <div class="row">
      <div class="card"><h2>Installed models</h2><div id="modelList"></div></div>
      <div class="card" style="flex:2"><h2>Disk usage</h2><pre id="duText">…</pre></div>
    </div>
    <div class="card"><h2>Maintenance</h2>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="danger" id="cleanupBtn">🧹 Cleanup (sandbox + parked + log trims)</button>
        <span id="cleanupMsg" style="color:var(--dim);font-size:13px"></span>
      </div>
    </div>
  </div>
  <!-- DOCUMENTS -->
  <div class="view" id="v-documents">
    <h2>Documents <small id="docStats"></small></h2>
    <div class="card" style="display:flex;gap:10px;align-items:center">
      <button id="docIndexBtn">Index folder now</button>
      <span id="docSpin" style="display:none" class="spin"></span>
      <span id="docStatus" style="color:var(--dim);font-size:13px"></span>
    </div>
    <div class="card">
      <div class="dimtxt" style="margin-bottom:8px">Drop text files (md, txt, code, csv…) into <b>~/daisy_docs</b> — they become searchable by every agent through the <span class="tag tool">🔧 search_documents</span> tool. Ask things like “What year does the Bluebird funding run out?” in Chat.</div>
      <div id="docFileList"></div>
    </div>
  </div>
  <!-- SETTINGS -->
  <div class="view" id="v-settings">
    <h2>Settings <small>saved to provisioner_prefs.json — survives restarts</small></h2>
    <div class="card" id="prefList"></div>
    <div class="card"><h2>Skill library</h2><div id="skillList"></div></div>
    <div class="card"><h2>Conversation memory <small id="memInfo"></small></h2>
      <pre id="memPreview" style="max-height:200px;overflow-y:auto">empty</pre>
      <div style="margin-top:10px"><button class="ghost" onclick="newChat()">Clear memory</button></div>
    </div>
  </div>
</main>
<div class="toast" id="toast"></div>
<div class="modal-bg" id="modalBg"><div class="modal"><p id="modalMsg"></p><div class="mrow"><button class="ghost" id="modalNo">Cancel</button><button class="danger" id="modalYes">Confirm</button></div></div></div>

<script>
const $=q=>document.querySelector(q);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// escJs: safe to interpolate into a single-quoted JS string literal that
// itself sits inside an HTML attribute (e.g. onclick="fn('${escJs(x)}')").
// NOTE: HTML-entity-escaping alone (esc()) is NOT enough here — the browser
// decodes HTML entities in the attribute value BEFORE compiling it as the
// handler's JS source, so an apostrophe encoded as &#39; still comes back
// as a literal ' by the time it's parsed as JS and breaks out of the
// string. Must backslash-escape for the JS-string context first, then
// HTML-escape the result for the attribute context.
const escJs=s=>esc(String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"));
let polling=null;

function toast(msg,err){const t=$('#toast');t.textContent=msg;t.className='toast show'+(err?' err':'');clearTimeout(t._t);t._t=setTimeout(()=>t.className='toast',3200);}
async function get(p){const r=await fetch(p);return r.json();}
async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});return r.json().catch(()=>({error:'bad response'}));}

document.querySelectorAll('.navbtn').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.navbtn').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');$('#v-'+b.dataset.v).classList.add('active');
  const v=b.dataset.v;
  if(v==='history')loadHistory(); if(v==='provisioner')loadProvisioner();
  if(v==='releases')loadReleases(); if(v==='system')loadSystem(); if(v==='settings')loadSettings();
  if(v==='research')loadResearch(); if(v==='documents')loadDocuments();
});

// ---- chat
let abortStream=null;
async function sendTask(){
  if(abortStream)return;              // a task is already in flight — Enter can't double-send
  const inp=$('#taskInput'),prompt=inp.value.trim();
  if(!prompt)return; inp.value='';$('#sendBtn').disabled=true;
  const msgs=$('#msgs');const q=document.querySelector('.empty');if(q)q.remove();
  msgs.insertAdjacentHTML('beforeend',`<div class="msg user">${esc(prompt)}</div>
    <div class="msg bot" id="live"><div class="streamtext"><span class="spin"></span> Gatekeeper → Skill Broker → Agent…</div></div>`);
  msgs.scrollTop=msgs.scrollHeight;
  const live=$('#live');
  let ctrl=new AbortController();abortStream=ctrl;
  try{
    const res=await fetch('/api/task/stream',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt}),signal:ctrl.signal});
    if(!res.ok){
      const err=await res.json().catch(()=>({error:'HTTP '+res.status}));
      live.innerHTML=`<div class="streamtext"><span class="tag bad">error</span> ${esc(err.error||('HTTP '+res.status))}</div>`;
    }else{
    const reader=res.body.getReader();
    const dec=new TextDecoder();let buf='',text='',metaTags=null,toolLog=[];
    while(true){
      const{done,value}=await reader.read();if(done)break;
      buf+=dec.decode(value,{stream:true});
      let idx;
      while((idx=buf.indexOf('\n\n'))>=0){
        const line=buf.slice(0,idx).trim();buf=buf.slice(idx+2);
        if(!line.startsWith('data:'))continue;
        let ev;try{ev=JSON.parse(line.slice(5));}catch(e){continue;}
        if(ev.event==='token'){
          text+=ev.token;
          live.innerHTML=`<div class="streamtext">${esc(text)}<span class="caret"></span></div>`;
          msgs.scrollTop=msgs.scrollHeight;
        }else if(ev.event==='tool'){
          toolLog.push(ev);
          live.innerHTML=`<div class="streamtext"><span class="tag tool">🔧 ${esc(ev.tool)}(${esc(ev.args||'')})</span></div><div class="streamtext">${esc(text)||'<span class="spin"></span>'}<span class="caret"></span></div>`;
          msgs.scrollTop=msgs.scrollHeight;
        }else if(ev.event==='meta'){
          const sk=(ev.skills||[]).map(s=>`<span class="tag skill">${esc(s)}</span>`).join('');
          const tl=ev.tools_available?`<span class="tag toolb">🔧 ${ev.tools_available} tools</span>`:'';
          metaTags=`<span class="tag route">${esc(ev.route)} · ${esc(ev.model)}</span>${sk}${tl}`;
        }else if(ev.event==='done'){
          const toolTags=(ev.tools||[]).map(t=>`<span class="tag ${t.ok?'tool':'bad'}">🔧 ${esc(t.tool)}</span>`).join('');
          live.innerHTML=`<div class="streamtext">${esc(text)}</div><div class="meta">${metaTags||''}${toolTags}<span>${ev.seconds}s</span></div>`;
        }else if(ev.event==='error'){
          live.innerHTML=`<div class="streamtext"><span class="tag bad">error</span> ${esc(ev.error||'failed')}\nIs the Ollama app running?</div>`;
        }
      }
    }
    }
  }catch(e){
    if(e.name==='AbortError'){
      live.innerHTML=`<div class="streamtext"><span class="tag warn">stopped</span> — task cancelled</div>`;
    }else{
      live.innerHTML=`<div class="streamtext"><span class="tag bad">error</span> ${esc(String(e))}</div>`;
    }
  }
  abortStream=null;$('#sendBtn').disabled=false;inp.focus();
}
$('#sendBtn').onclick=sendTask;
$('#taskInput').addEventListener('keydown',e=>{if(e.key==='Enter')sendTask();});
$('#stopBtn').onclick=()=>{if(abortStream)abortStream.abort();};

// ---- status poll
async function pollStatus(){
  try{
    const s=await get('/api/status');
    let line=`Ollama <b>${esc(s.ollama_version||'not running')}</b>`;
    if(s.ollama_update)line+=` · <span style="color:var(--red)">update available: ${esc(s.ollama_latest)}</span>`;
    else if(s.ollama_version&&s.ollama_latest)line+=` <span style="color:var(--green)">✓</span>`;
    if(s.prerelease)line+=` · 🧪 ${esc(s.prerelease)}`;
    const v=$('#verline');v.innerHTML=line;v.className='ver'+(s.ollama_update?' warn':'');
    const badge=$('#pendingBadge');
    if(s.pending>0){badge.style.display='';badge.textContent=s.pending;}else badge.style.display='none';
    $('#provStatus').textContent=s.provisioner_running?'cycle running…':'';
    $('#provSpin').style.display=s.provisioner_running?'':'none';
    $('#runCycleBtn').disabled=s.provisioner_running;
    const rb=$('#resRunBtn');
    if(s.research_running){rb.disabled=true;$('#resSpin').style.display='';$('#resStatus').textContent='research cycle running…';}
    else if(!rb.disabled||$('#resSpin').style.display!=='none'){rb.disabled=false;$('#resSpin').style.display='none';$('#resStatus').textContent='watches Open WebUI · AnythingLLM · Jan · Ollama every 4h (LaunchAgent)';}
  }catch(e){$('#verline').textContent='engine unreachable';}
}
pollStatus();polling=setInterval(pollStatus,4000);

// ---- history
let histAll=[];
async function loadHistory(){
  const h=await get('/api/history');
  histAll=h.entries||[];
  $('#histStats').textContent=h.total?`${h.total} tasks all-time`:'empty';
  $('#histCards').innerHTML=Object.entries(h.by_route).map(([r,c])=>
    `<div class="card"><div class="stat">${c}<small>${esc(r)} agent</small></div></div>`).join('')
    ||'<div class="empty">No tasks yet.</div>';
  renderHist();
}
function renderHist(){
  const q=($('#histSearch')&&$('#histSearch').value.trim().toLowerCase())||'';
  const rows=histAll.filter(e=>!q||((e.input_prompt||'')+(e.assigned_category||'')+(e.executed_by_model||'')).toLowerCase().includes(q));
  $('#histTable tbody').innerHTML=rows.map(e=>`<tr>
    <td style="color:var(--dim)">${esc((e.timestamp||'').slice(0,16).replace('T',' '))}</td>
    <td>${esc((e.input_prompt||'').slice(0,80))}</td>
    <td><span class="tag route">${esc(e.assigned_category||'?')}</span></td>
    <td>${(e.skills_applied||[]).map(s=>`<span class="tag skill">${esc(s)}</span>`).join('')||'—'}</td>
    <td style="color:var(--dim)">${esc(e.executed_by_model||'')}</td>
    <td><button class="mini ghost" onclick="delHist('${(e._idx??histAll.indexOf(e))}')">✕</button></td></tr>`).join('')
    ||'<tr><td colspan="6" class="empty">nothing logged yet</td></tr>';
}
async function delHist(i){
  if(!await askConfirm('Delete this logged task from history?'))return;
  const r=await post('/api/history/delete',{index:Number(i)});
  toast(r.ok?'Deleted':(r.error||'failed'),!r.ok);loadHistory();
}
window.delHist=delHist;

// ---- provisioner
async function loadProvisioner(){
  const[p,log,reps,models]=await Promise.all([get('/api/pending'),get('/api/provisioner/log'),get('/api/reports'),get('/api/repos')]);
  $('#pendingCount').textContent=p.items.length?`${p.items.length} waiting`:'none';
  $('#pendingList').innerHTML=p.items.map(i=>{const c=i.candidate||{};return `
    <div class="pending-item"><div style="flex:1">
      <b>${esc(c.kind||'?')}</b> · ${esc(c.name||'?')} <span class="why">— ${esc(c.reason||'')}</span></div>
      <button class="mini" onclick="decide('${escJs(c.name)}','approve')">Approve</button>
      <button class="mini ghost" onclick="decide('${escJs(c.name)}','dismiss')">Dismiss</button>
    </div>`}).join('')||'<div class="empty">Nothing parked — the provisioner proposes things on its cycles.</div>';
  $('#provLog').textContent=log.entries.map(e=>{
    const t=(e.timestamp||'').slice(11,19);const d=typeof e.detail==='object'?JSON.stringify(e.detail):e.detail;
    return `${t}  ${e.action.padEnd(18)} ${d||''}`}).join('\n')||'no entries yet';
  $('#reports').textContent=reps.reports.length?reps.reports.map(r=>
    `${r.repo}: ${r.verdict||''} — ${(r.findings||[]).length} findings (top: ${(r.findings||[]).slice(0,3).map(f=>`${f.file}:${f.line} ${f.pattern}`).join(' | ')})`
    ).join('\n\n'):'no audits yet';
  $('#sandboxInfo').textContent=`${(models.repos||[]).length} repos · ${models.sandbox_mb} MB in sandbox`;
  $('#repoList').innerHTML=(models.repos||[]).map(r=>`<span class="tag">${esc(r)}</span>`).join('')||'<span class="empty">queue empty</span>';
}
$('#runCycleBtn').onclick=async()=>{
  const r=await post('/api/provisioner/run');
  if(r.ok)toast('Research cycle started in background');
  else toast(r.error||'failed',true);
  setTimeout(loadProvisioner,1500);
};
async function decide(name,action){
  const r=await post('/api/approve',{name,action});
  if(r.ok)toast(action==='approve'?('Executed: '+(r.message||name)):('Dismissed '+name));
  else toast(r.error||'failed',true);
  loadProvisioner();pollStatus();
}
$('#addRepoBtn').onclick=async()=>{
  const v=$('#repoInput').value.trim();if(!v)return;
  const r=await post('/api/repos',{repo:v});
  toast(r.message||r.error||'done',!r.ok);$('#repoInput').value='';loadProvisioner();
};

// ---- releases
async function loadReleases(){
  const r=await get('/api/releases');
  const el=$('#releasesText');
  el.textContent=r.text||r.error||'unavailable';
  if((r.text||'').includes('rate limit'))el.insertAdjacentHTML('afterend','<div class="empty">GitHub rate-limited this connection — it clears within the hour, or the status bar shows the essentials meanwhile.</div>');
}
$('#wnBtn').onclick=async()=>{
  const v=$('#wnInput').value.trim();if(!v)return;
  const r=await get('/api/whatsnew/'+encodeURIComponent(v));
  const t=$('#wnText');t.style.display='';t.textContent=r.text||'not found';
};

// ---- system
// ---- research
gapCache={};
async function loadResearch(){
  const r=await get('/api/research');
  const show=el=>{$(el).style.display='';};
  if(!r.ok){
    $('#resError').style.display='';$('#resErrorMsg').textContent=r.error||'unknown';
    ['#gapList','#compList','#selfUpd','#newRel','#resMd'].forEach(s=>$(s).innerHTML='');
    $('#resMeta').textContent='';hideResearchBadge();return;
  }
  $('#resError').style.display='none';
  const rep=r.report||{};
  $('#resMeta').textContent='generated '+(rep.generated||'unknown')+' · '+(rep.competitors_tracked||0)+' competitors tracked';
  // gaps, ranked by how many rivals ship the feature
  const gaps=Object.entries(r.gaps||{}).sort((a,b)=>b[1].length-a[1].length);
  gapCache={};
  $('#gapList').innerHTML=gaps.length?gaps.map(([f,who])=>{
    gapCache[f]=who;
    return `<div class="gaprow"><div class="gapname">${esc(f)}</div><div class="gapwho">in ${esc(who.join(', '))}</div><button class="ghost" onclick="researchTask('${escJs(f)}')">Explore</button></div>`;
  }).join(''):'<div class="empty">No gaps detected in the latest cycle 🎉</div>';
  const nGaps=gaps.length;
  const badge=$('#researchBadge');
  if(nGaps>0){badge.style.display='';badge.textContent=nGaps;}else badge.style.display='none';
  // competitor snapshot
  const fs=rep.findings||[];
  $('#compList').innerHTML=fs.length?fs.map(f=>{
    if(f.status==='fetch_failed')return `<div class="comprow"><b>${esc(f.repo)}</b> <span class="tag bad">fetch failed</span><div class="dimtxt">${esc(f.error||'')}</div></div>`;
    const feats=(f.features_signalled||[]).map(x=>`<span class="tag">${esc(x)}</span>`).join('');
    const isNew=f.status==='new_release'?` <span class="tag ok">NEW</span>`:'';
    const link=f.url?` <a class="relink" href="#" onclick="openRelease('${escJs(f.url)}');return false">release ↗</a>`:'';
    return `<div class="comprow"><b>${esc(f.name||f.repo)}</b> <span style="color:var(--dim)">${esc(f.latest||'?')}</span>${isNew}${link}<div class="dimtxt">${esc(f.blurb||'')}</div><div style="margin-top:4px">${feats||'<span class="dimtxt">no feature signals</span>'}</div></div>`;
  }).join(''):'<div class="empty">no data</div>';
  // self-update status
  const up=rep.self_updates||[];
  $('#selfUpd').innerHTML=up.length?up.map(u=>{
    if(u.status==='check_failed')return `<div class="updrow"><b>${esc(u.component)}</b> <span class="tag bad">check failed</span> <span class="dimtxt">${esc(u.error||'')}</span></div>`;
    const needs=u.action?' <span class="tag warn">'+esc(u.action)+'</span>':'';
    const note=u.note?` <span class="dimtxt">— ${esc(u.note)}</span>`:'';
    return `<div class="updrow"><b>${esc(u.component)}</b> installed <b>${esc(u.installed||'?')}</b> · latest <b>${esc(u.latest||'?')}</b>${needs}${note}</div>`;
  }).join(''):'<div class="empty">all components current</div>';
  // new releases this cycle
  const nr=rep.new_releases_this_run||[];
  $('#newRel').innerHTML=nr.length?nr.map(x=>`<div class="updrow">🆕 <b>${esc(x[1]||x[0])}</b> — ${esc((x[2]&&x[2].tag)||'')}</div>`).join(''):'<div class="dimtxt">nothing new since the previous cycle</div>';
  $('#resMd').textContent=r.markdown||'';
  // shared feature matrix (read live from disk, so it can be newer than the report)
  const mx=r.matrix;
  const mList=$('#matrixList');
  if(mx&&mx.features){
    const order={built:0,planned:1,backlog:2,not_planned:3};
    const rows=Object.entries(mx.features).sort((a,b)=>(order[a[1].status]??9)-(order[b[1].status]??9));
    const meta=mx._meta||{};
    $('#matrixMeta').textContent=`last touched ${meta.updated||'?'} by ${meta.updated_by||'?'}`;
    mList.innerHTML=rows.map(([f,row])=>{
      const st=row.status||'backlog';
      const evs=Object.entries(row.competitor_evidence||{});
      const ev=evs.length?`<div class="dimtxt">also in: ${evs.map(([c,e])=>esc(c)+' '+esc(e.version||'')).join(' · ')}</div>`:'';
      const notes=row.notes?`<div class="dimtxt">${esc(row.notes)}</div>`:'';
      return `<div class="mrowx"><span class="tag st-${st.replace('_','')}">${esc(st)}</span><div class="mrowmain"><b>${esc(f)}</b>${notes}${ev}</div></div>`;
    }).join('');
  }else{
    mList.innerHTML='<div class="dimtxt">matrix file missing or unreadable — the daemon falls back to built-in defaults</div>';
  }
}
async function researchTask(feature){
  const who=(gapCache[feature]||[]).join(', ')||'competitors';
  document.querySelector('[data-v="chat"]').click();
  const inp=$('#taskInput');
  inp.value=`Research how ${who} implement "${feature}" and propose how the daisy chain could adopt it`;
  inp.focus();
}
async function openRelease(url){
  // pywebview window has no address bar — hand the URL to the default browser
  try{window.pywebview.api.open_external(url);}catch(e){window.open(url,'_blank');}
}
function hideResearchBadge(){const b=$('#researchBadge');b.style.display='none';}
$('#resRunBtn').onclick=async()=>{
  const r=await post('/api/research/run');
  if(!r.ok){toast(r.error||'failed',true);return;}
  toast('Research cycle started — report will refresh when it lands');
  $('#resRunBtn').disabled=true;$('#resSpin').style.display='';
  let tries=0;
  const t=setInterval(async()=>{
    tries++;
    const s=await get('/api/status').catch(()=>null);
    if(s&&!s.research_running){clearInterval(t);$('#resRunBtn').disabled=false;$('#resSpin').style.display='none';loadResearch();}
    else if(tries>120){clearInterval(t);$('#resRunBtn').disabled=false;$('#resSpin').style.display='none';}
  },2000);
};

// ---- documents (RAG)
async function loadDocuments(){
  const r=await get('/api/docs');
  if(!r.ok){$('#docStats').textContent='';$('#docFileList').innerHTML=`<span class="tag bad">error</span> ${esc(r.error||'')}`;return;}
  const s=r.stats;
  $('#docStats').textContent=s.files+' file(s) · '+s.chunks+' chunks indexed '+(s.built_at?('· '+s.built_at):'· never indexed');
  $('#docFileList').innerHTML=r.files.length
    ?r.files.map(f=>`<div class="updrow">📄 <b>${esc(f.name)}</b> <span class="dimtxt">— ${f.chunks} chunk${f.chunks==1?'':'s'}</span></div>`).join('')
    :`<div class="dimtxt">nothing indexed yet — put files in ${esc(r.docs_dir)} and press “Index folder now”</div>`;
}
$('#docIndexBtn').onclick=async()=>{
  const r=await post('/api/docs/reindex');
  if(!r.ok){toast(r.error||'failed',true);return;}
  toast('Indexing your documents…');
  $('#docIndexBtn').disabled=true;$('#docSpin').style.display='';
  let tries=0;
  const t=setInterval(async()=>{
    tries++;
    const s=await get('/api/status').catch(()=>null);
    if(s&&!s.docs_indexing){clearInterval(t);$('#docIndexBtn').disabled=false;$('#docSpin').style.display='none';toast('Documents indexed ✓');loadDocuments();}
    else if(tries>150){clearInterval(t);$('#docIndexBtn').disabled=false;$('#docSpin').style.display='none';}
  },2000);
};

async function loadSystem(){
  const[m,d]=await Promise.all([get('/api/models'),get('/api/du')]);
  $('#modelList').innerHTML=(m.models||[]).map(x=>`<div class="kv">
      <div><b>${esc(x.name)}</b>${x.size_gb?`<div style="color:var(--dim);font-size:12px">${x.size_gb} GB</div>`:''}</div>
      <button class="mini ghost" title="Delete model and free disk" onclick="delModel('${escJs(x.name)}','${escJs(x.size_gb||'')}')">✕</button>
    </div>`).join('')||'<span class="empty">none</span>';
  $('#duText').textContent=d.text||d.error||'unavailable';
}
async function delModel(name,gb){
  if(!await askConfirm(`Delete model "${name}"${gb?` (${gb} GB)`:''}? This frees disk space and cannot be undone.`))return;
  const r=await post('/api/models/delete',{name});
  toast(r.ok?(r.message||'deleted'):(r.error||'failed'),!r.ok);
  loadSystem();
}
window.delModel=delModel;
let confirmRes=null;
function askConfirm(msg){return new Promise(res=>{confirmRes=res;$('#modalMsg').textContent=msg;$('#modalBg').classList.add('show');});}
$('#modalYes').onclick=()=>{$('#modalBg').classList.remove('show');confirmRes&&confirmRes(true);};
$('#modalNo').onclick=()=>{$('#modalBg').classList.remove('show');confirmRes&&confirmRes(false);};

$('#cleanupBtn').onclick=async()=>{
  if(!await askConfirm('Delete sandbox clones, clear parked suggestions, and trim logs? This cannot be undone.'))return;
  const r=await post('/api/cleanup');
  const f=r.freed||{};
  $('#cleanupMsg').textContent='done — '+Object.entries(f).map(([k,v])=>k+': '+v).join(', ');
  loadSystem();
};

// ---- settings
async function loadSettings(){
  const p=await get('/api/prefs');
  const rows=[
    ['channel','Update channel','select',['stable','all'],'stable only vs include pre-releases'],
    ['cycle_seconds','Research interval (s)','num',null,'seconds between provisioner cycles'],
    ['sandbox_max_disk_mb','Sandbox cap (MB)','num',null,'max disk for repo clones'],
    ['repo_reaudit_hours','Re-audit cadence (h)','num',null,'hours between repo audits'],
    ['repos_per_cycle','Repo audits / cycle','num',null,'pacing cap per cycle'],
    ['pending_max','Pending cap','num',null,'max parked suggestions'],
  ];
  $('#prefList').innerHTML=rows.map(([k,label,type,opts,hint])=>`
    <div class="kv"><div><b>${label}</b><div style="color:var(--dim);font-size:12px">${hint}</div></div>
    ${type==='select'?`<select id="pf-${k}" style="width:140px">${opts.map(o=>`<option ${p[k]===o?'selected':''}>${o}</option>`).join('')}</select>`
      :`<input id="pf-${k}" type="number" value="${p[k]}" style="width:120px">`}
    <button class="mini ghost" onclick="savePref('${k}')">Save</button></div>`).join('');
  const s=await get('/api/status');
  $('#provMode').textContent=`auto-install: ${s.auto_install?'ON':'OFF (dry-run)'} · cycle: ${s.cycle_seconds}s`;
  const skRes=await get('/api/skills').catch(()=>({skills:[]}));
  $('#skillList').innerHTML=(skRes.skills||[]).map(([n,d])=>`<div class="kv"><b>${esc(n)}</b><span style="color:var(--dim);font-size:12.5px;text-align:right;max-width:70%">${esc(d)}</span></div>`).join('');
  const mem=await get('/api/memory').catch(()=>null);
  if(mem){
    $('#memInfo').textContent=mem.turns?`${mem.turns} exchange${mem.turns>1?'s':''}, ${mem.chars} chars`:'empty';
    $('#memPreview').textContent=mem.oldest?`oldest: ${mem.oldest}`:'empty';
  }
}
async function savePref(k){
  const el=$('#pf-'+k);const v=el.value;
  const num=Number(v);
  if(k!=='channel'&&(!Number.isFinite(num)||num<=0)){toast(k+' must be a positive number',true);return;}
  const r=await post('/api/prefs',{[k]:v});
  const n=Object.keys(r.changed||{}).length;
  toast(r.ok&&n?'Saved ✓':(r.ok?'no change':(r.error||'rejected — invalid value')),r.ok&&n?false:true);
  loadSettings();
}
window.savePref=savePref;

// ---- memory
async function pollMemory(){
  try{
    const m=await get('/api/memory');
    const inp=$('#taskInput');
    inp.placeholder=m.turns?`Ask a follow-up — I remember ${m.turns} exchange${m.turns>1?'s':''}…`:'Enter a task for your local AI network…';
  }catch(e){}
}
pollMemory();setInterval(pollMemory,8000);
async function newChat(){
  const r=await post('/api/memory/reset');
  if(r.ok){toast(r.cleared?`Cleared ${r.cleared} exchange${r.cleared>1?'s':''} — fresh start`:'Memory was already empty');
    $('#msgs').innerHTML='<div class="empty">Type a task below — the Gatekeeper routes it, the Skill Broker attaches skills, and the right agent answers.</div>';
  } else toast(r.error||'reset failed',true);
  pollMemory();
}
window.newChat=newChat;
$('#newChatBtn').onclick=newChat;
</script>
</body>
</html>
"""

# skills endpoint helper (served via GET /api/skills)

def _monkeypatch_routes():
    ROUTES["/api/skills"] = ("GET", lambda: {"skills": list(dc.SKILLS.items())})

_monkeypatch_routes()


def main():
    if not dc.check_ollama(silent=True):
        print("⚠️  Ollama server not reachable — start the Ollama app first. Retrying in the UI anyway.")
    # request_queue_size must be set before bind/listen (it is the listen
    # backlog), hence the subclass. Default is 5 — the 4s status poll plus
    # bursty panel loads occasionally got connections reset under load
    # (found by the self-test stress suite). Bursts now queue instead.
    class _Server(ThreadingHTTPServer):
        request_queue_size = 64

    server = _Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    # background provisioner, silent to stdout (UI polls the log file instead)
    def prov():
        dc._provisioner_silent = True
        try:
            dc.provisioner_loop()
        except Exception:
            pass
    threading.Thread(target=prov, name="provisioner", daemon=True).start()

    print(f"🌀 Daisy UI ready — native window opening (internal port {PORT})")
    import webview

    class _Api:
        """Bridge for JS: open release links in the real browser (the window
        itself has no address bar or tab UI)."""
        def open_external(self, url):
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                return
            subprocess.Popen(["open", url])

    webview.create_window("🌀 Daisy Chain", f"http://127.0.0.1:{PORT}/",
                          width=1180, height=780, min_size=(900, 600), js_api=_Api())
    webview.start()


if __name__ == "__main__":
    main()
