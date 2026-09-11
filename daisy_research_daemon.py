"""
Daisy Research Daemon — continuous competitive intelligence.

Runs on a schedule (macOS LaunchAgent, every 4h). For each tracked competitor
it fetches the latest releases via the GitHub API (rate-limit aware, cached),
extracts feature signals from release notes, diffs them against what the daisy
chain already has, and writes:

  ~/daisy_research/report.json          machine-readable findings
  ~/daisy_research/report.md            human-readable brief
  ~/daisy_research/suggestions.json     concrete improvement suggestions

It NEVER modifies daisy_chain.py or daisy_ui.py — reports only. The app's
Provisioner panel / approval queue stays the single place anything gets executed.

Run once:   ~/daisy_env/bin/python ~/daisy_research_daemon.py --once
Run forever: (managed by LaunchAgent) ~/daisy_env/bin/python ~/daisy_research_daemon.py
"""

import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
OUT_DIR = os.path.join(HOME, "daisy_research")
LOG_FILE = os.path.join(HOME, "provisioner_log.json")   # shared audit trail
STATE_FILE = os.path.join(OUT_DIR, "state.json")        # seen releases
MATRIX_FILE = os.path.join(HOME, "daisy_feature_matrix.json")  # shared feature matrix
RUN_INTERVAL = 4 * 3600
GH_TTL = 900  # respect the 60/hr unauthenticated budget: cache 15 min

# ------------------------------------------------------------- tracked rivals
COMPETITORS = [
    # repo, human name, what it is
    ("open-webui/open-webui", "Open WebUI",
     "self-hosted chat UI with RAG, tools, MCP support, multi-user"),
    ("Mintplex-Labs/anything-llm", "AnythingLLM",
     "desktop RAG + no-code agent builder + workspaces"),
    ("janhq/jan", "Jan",
     "privacy-first local LLM desktop app"),
    ("ollama/ollama", "Ollama",
     "the runtime underneath — new models + engine features land here first"),
]

# Feature matrix: keyword signals in release notes -> feature name -> does daisy have it?
FEATURES = [
    # (feature, keywords, daisy_has_it)
    ("RAG / document chat", ["rag", "document", "knowledge", "embed", "vector", "citation"], False),
    ("Tool / function calling", ["tool call", "function call", "mcp", "tool use", "tools"], False),
    ("Voice input/output", ["voice", "speech", "audio", "whisper", "tts", "stt"], False),
    ("Multi-model comparison", ["compare models", "multi-model", "model comparison"], False),
    ("Persistent multi-session memory", ["memory", "long-term memory", "recall"], True),  # daisy has session memory
    ("Agent workflows / pipelines", ["agent", "workflow", "pipeline", "orchestrat"], True),  # daisy's chain
    ("Code execution sandbox", ["code execution", "sandbox", "interpreter", "jupyter"], False),
    ("Image / vision input", ["vision", "image input", "multimodal", "screenshot"], False),
    ("Prompt library / presets", ["prompt library", "presets", "templates", "characters"], False),
    ("Export / sharing", ["export", "share", "pdf", "markdown export"], True),  # daisy exports workload log
]


def http_json(url, timeout=15):
    req = urllib.request.Request(url, headers={
        "User-Agent": "daisy-research-daemon/1.0",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))


_cache = {}
def gh_json(url):
    """Cached GitHub GET — the unauthenticated budget is 60/hr per IP."""
    now = time.time()
    hit = _cache.get(url)
    if hit and now - hit[0] < GH_TTL:
        return hit[1], False
    data = http_json(url)
    _cache[url] = (now, data)
    return data, True


def log(action, detail):
    """Append to the shared provisioner audit log (best-effort)."""
    entry = {"timestamp": datetime.now(timezone.utc).isoformat(),
             "action": action, "detail": detail}
    try:
        try:
            with open(LOG_FILE) as f:
                data = json.load(f)
        except Exception:
            data = []
        if isinstance(data, list):
            data.append(entry)
            data = data[-200:]
            with open(LOG_FILE, "w") as f:
                json.dump(data, f, indent=2)
    except Exception:
        pass
    print(f"[{action}] {detail if isinstance(detail, str) else json.dumps(detail)[:200]}")


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {"seen": {}}


def save_state(state):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def fetch_latest_release(repo):
    data, _ = gh_json(f"https://api.github.com/repos/{repo}/releases/latest")
    return {
        "tag": (data.get("tag_name") or "").lstrip("v"),
        "name": data.get("name") or "",
        "date": (data.get("published_at") or "")[:10],
        "notes": data.get("body") or "",
        "url": data.get("html_url") or "",
    }


def extract_features(text):
    """Which known features does this release text signal? Keyword matching,
    deliberately conservative (lowercase, phrase-level)."""
    t = (text or "").lower()
    return [feat for feat, kws, _ in FEATURES
            if any(kw in t for kw in kws)]


# --- Shared feature matrix (~/daisy_feature_matrix.json) ---------------------
# Both the daemon and the user maintain this file. The daemon reads 'status'
# to decide what counts as a gap and stamps 'competitor_evidence' whenever a
# tracked rival signals the feature in a release. The user edits 'status' any
# time — flips are picked up on the next cycle, no restart needed.
VALID_STATUSES = ("built", "planned", "backlog", "not_planned")


def load_matrix():
    try:
        with open(MATRIX_FILE) as f:
            m = json.load(f)
        if isinstance(m, dict) and isinstance(m.get("features"), dict):
            return m
    except Exception as e:
        log("matrix_read_failed", str(e)[:120])
    return None


def save_matrix(matrix):
    meta = matrix.setdefault("_meta", {})
    meta["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    meta["updated_by"] = "daemon"
    with open(MATRIX_FILE, "w") as f:
        json.dump(matrix, f, indent=2)


def feature_statuses():
    """Feature name -> status, honoring the user's matrix edits.
    Falls back to the built-in FEATURES defaults if the file is missing/broken;
    matrix rows the user added beyond FEATURES are included too."""
    fallback = {feat: ("built" if has else "backlog") for feat, _kws, has in FEATURES}
    m = load_matrix()
    if not m:
        return fallback
    out = dict(fallback)
    for feat, row in m["features"].items():
        if isinstance(row, dict) and row.get("status") in VALID_STATUSES:
            out[feat] = row["status"]
        elif feat not in out:
            out[feat] = "backlog"
    return out


def _stamp_evidence(competitor, feats, rel):
    """Record in the matrix that `competitor` at version rel['tag'] signals
    these features. Only writes when something is genuinely new."""
    m = load_matrix()
    if not m:
        return
    changed = False
    for feat in feats:
        row = m["features"].setdefault(
            feat, {"status": "backlog", "notes": "", "competitor_evidence": {}})
        ev = row.setdefault("competitor_evidence", {})
        if ev.get(competitor, {}).get("version") != rel["tag"]:
            ev[competitor] = {"version": rel["tag"], "date": rel["date"]}
            changed = True
    if changed:
        save_matrix(m)


def competitor_pass(state):
    findings, new_releases = [], []
    for repo, name, blurb in COMPETITORS:
        try:
            rel = fetch_latest_release(repo)
        except Exception as e:
            findings.append({"repo": repo, "status": "fetch_failed", "error": str(e)[:120]})
            continue
        seen_tag = state["seen"].get(repo)
        is_new = bool(rel["tag"]) and rel["tag"] != seen_tag
        if is_new:
            new_releases.append((repo, name, rel))
            state["seen"][repo] = rel["tag"]
        feats = extract_features(rel["notes"] + " " + rel["name"])
        _stamp_evidence(name, feats, rel)
        findings.append({
            "repo": repo, "name": name, "blurb": blurb,
            "status": "new_release" if is_new else "unchanged",
            "latest": rel["tag"], "date": rel["date"], "url": rel["url"],
            "features_signalled": feats,
        })
    return findings, new_releases


def gap_analysis(competitor_findings):
    """Matrix-aware gap analysis.
    gaps = features rivals signal where daisy's status is 'backlog'
           (or the feature is unknown to the matrix)
    planned = rivals signal it and the user has committed ('planned') —
              reported as in-progress, not nagged about
    'built' and 'not_planned' rows never appear in either list."""
    statuses = feature_statuses()
    gaps, planned = {}, {}
    for f in competitor_findings:
        for feat in f.get("features_signalled", []):
            st = statuses.get(feat, "backlog")
            if st == "backlog":
                gaps.setdefault(feat, []).append(f.get("name", f.get("repo")))
            elif st == "planned":
                planned.setdefault(feat, []).append(f.get("name", f.get("repo")))
    mk = lambda feat, who: {
        "feature": feat, "seen_in": who,
        "action": f"research how {', '.join(sorted(set(who)))} implement '{feat}' and evaluate it for the daisy chain"}
    suggestions = [mk(feat, who)
                   for feat, who in sorted(gaps.items(), key=lambda kv: -len(kv[1]))]
    planned_list = [{"feature": feat, "seen_in": sorted(set(who))}
                    for feat, who in sorted(planned.items(), key=lambda kv: -len(kv[1]))]
    return suggestions, planned_list


def self_update_pass():
    """Watch the components daisy itself runs on."""
    out = []
    try:
        with urllib.request.urlopen("http://localhost:11434/api/version", timeout=5) as r:
            installed = json.loads(r.read()).get("version")
        rel, _ = gh_json("https://api.github.com/repos/ollama/ollama/releases/latest")
        latest = (rel.get("tag_name") or "").lstrip("v")
        if installed and latest and latest != installed:
            out.append({"component": "ollama", "installed": installed,
                        "latest": latest, "action": "review release notes, then update"})
    except Exception as e:
        out.append({"component": "ollama", "status": "check_failed", "error": str(e)[:120]})
    # pywebview (the window layer)
    try:
        with urllib.request.urlopen("https://pypi.org/pypi/pywebview/json", timeout=10) as r:
            pypi_latest = json.loads(r.read())["info"]["version"]
        out.append({"component": "pywebview", "installed": "4.0.2 (pinned)",
                    "latest": pypi_latest,
                    "note": "pinned because newest needs a compiler your machine lacks — only move with care"})
    except Exception as e:
        out.append({"component": "pywebview", "status": "check_failed", "error": str(e)[:120]})
    return out


def write_report(findings, suggestions, updates, new_releases, planned=None):
    os.makedirs(OUT_DIR, exist_ok=True)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    matrix = load_matrix()
    matrix_view = [
        {"feature": feat, "status": (row or {}).get("status", "backlog"),
         "notes": (row or {}).get("notes", "")}
        for feat, row in ((matrix or {}).get("features") or {}).items()
    ]
    report = {
        "generated": now,
        "competitors_tracked": len(COMPETITORS),
        "new_releases_this_run": [{"repo": r, "tag": rel["tag"]} for r, _n, rel in new_releases],
        "findings": findings,
        "self_updates": updates,
        "suggestions": suggestions,
        "planned": planned or [],
        "feature_matrix": matrix_view,
    }
    with open(os.path.join(OUT_DIR, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    with open(os.path.join(OUT_DIR, "suggestions.json"), "w") as f:
        json.dump(suggestions, f, indent=2)

    lines = [f"# Daisy competitive research — {now}", ""]
    if new_releases:
        lines.append("## New releases since last run")
        for repo, name, rel in new_releases:
            lines.append(f"- **{name}** `{rel['tag']}` ({rel['date']}) — {rel['url']}")
        lines.append("")
    lines.append("## Competitive snapshot")
    for f in findings:
        if f.get("status") == "fetch_failed":
            lines.append(f"- {f['repo']}: ⚠️ {f['error']}")
            continue
        feats = ", ".join(f["features_signalled"]) or "no feature signals in notes"
        lines.append(f"- **{f['name']}** `{f['latest']}` ({f['date']}): {feats}"
                     + (" — 🆕 new since last run" if f["status"] == "new_release" else ""))
    lines.append("")
    lines.append("## Feature gaps (they have it, daisy doesn't)")
    if suggestions:
        for s in suggestions:
            lines.append(f"- **{s['feature']}** — seen in: {', '.join(sorted(set(s['seen_in'])))}")
    else:
        lines.append("- none this run")
    lines.append("")
    if planned:
        lines.append("## In progress (planned — already committed)")
        for p in planned:
            lines.append(f"- **{p['feature']}** — also in: {', '.join(p['seen_in'])}")
        lines.append("")
    lines.append("## Self-update status")
    for u in updates:
        if u.get("status") == "check_failed":
            lines.append(f"- {u['component']}: ⚠️ {u['error']}")
        else:
            extra = f" — {u['note']}" if u.get("note") else ""
            lines.append(f"- {u['component']}: installed {u.get('installed')} / latest {u.get('latest')}{extra}")
    lines.append("")
    lines.append("_Reports only — nothing in the app was modified. Suggestions are advisory._")
    with open(os.path.join(OUT_DIR, "report.md"), "w") as f:
        f.write("\n".join(lines))
    return report


def run_once():
    state = load_state()
    findings, new_releases = competitor_pass(state)
    save_state(state)
    suggestions, planned = gap_analysis(findings)
    updates = self_update_pass()
    report = write_report(findings, suggestions, updates, new_releases, planned)
    log("research_run", {"new_releases": len(new_releases),
                         "gaps": len(suggestions),
                         "planned_in_progress": len(planned),
                         "self_updates_flagged": sum(1 for u in updates if u.get("action"))})
    return report


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    if "--once" in sys.argv:
        run_once()
        return
    log("research_daemon_started", "continuous competitive research online")
    backoff = 900  # retry 15 min after a rate-limit, not a full 4h cycle
    while True:
        try:
            run_once()
            backoff = 900
            time.sleep(RUN_INTERVAL)
        except Exception as e:
            rate_limited = "403" in str(e) or "rate limit" in str(e).lower()
            wait = backoff if rate_limited else RUN_INTERVAL
            log("research_run_retry", f"{str(e)[:120]} — retrying in {wait//60} min")
            time.sleep(wait)
            backoff = min(backoff * 2, 3600)


if __name__ == "__main__":
    main()
