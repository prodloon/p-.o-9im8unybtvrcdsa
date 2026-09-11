# Daisy Chain — Full Project Audit

**Date:** 2026-09-10 · **Scope:** daisy_chain.py (engine), daisy_ui.py (desktop app + API), daisy_docs.py (RAG), daisy_research_daemon.py, DaisyChain.app bundle
**Method:** standing battery `daisy_selftest.py` (7 suites, 70 checks) + manual code review + environment scan. Rerun anytime with `~/daisy_env/bin/python daisy_selftest.py` (add `--quick` to skip model replay).

---

## 1. Functional testing — Grade A (19/19 + 4/4 tool units)

Every API route exercised happy-path and with malformed input; all six tools unit-tested. Two defects found and fixed during the audit itself:

| Defect | Impact | Fix |
|---|---|---|
| Junk `prefs` values silently accepted, reported `ok: true` | UI showed a success toast while nothing changed — a lie to the user | `api_set_prefs` now returns `ok: false` with an explanatory error when nothing valid was changed |
| UI served no `aria-live` region; chat input unlabeled | Screen-reader users got no announced answers; input unnamed | Added `aria-live="polite"` + `aria-label`s (fixed before the a11y suite ran) |

## 2. Security audit — Grade A (26/26), one real vulnerability found & fixed

| Vector | Result |
|---|---|
| Network binding | Loopback-only `127.0.0.1`, verified by source scan — not reachable from the LAN |
| Calculator tool (AST, no eval) | Blocks `__import__`, lambdas, name lookups, ternaries — 5/5 payloads refused |
| Path traversal (`read_file`/`list_files`) | `../../`, `~/../..`, absolute, `....//` — all confined to `$HOME`, 4/4 refused |
| URL schemes (`fetch_url`) | `file:`, `ftp:`, `gopher:`, `data:` refused; http(s) only |
| Oversize requests | **VULNERABILITY FOUND:** a 300KB prompt previously launched a real model generation (minutes of busy-flag lockout per request — trivial DoS) and bodies were unbounded. **Fixed:** 1MB hard body cap → `413`; 20,000-char prompt cap on both task routes, rejected in 0.0s |
| XSS surface | API returns JSON; injected `<script>` payloads never re-served as HTML |
| HTTP method abuse | `DELETE` on GET routes properly rejected |

## 3. Stress & load — Grade A (4/4), one hardening fix

40 concurrent mixed requests: zero errors, coherent state after. Two findings:

- **Listen backlog too small (fixed):** default accept backlog is 5; under burst, connections were reset at transport level. The app's server now subclasses with `request_queue_size = 64` (set pre-bind, where it actually takes effect).
- **Thread-unsafe stdout capture (fixed):** `_capture` swaps the *process-global* `sys.stdout`; concurrent panel loads could cross-contaminate each other's captured output. Now serialized with `_capture_lock`.

## 4. Historical regression replay — Grade A (6/6)

The export log (31 past tasks) replayed through today's Gatekeeper: **26/26 distinct prompts re-routed 100% identically** to their recorded routes — routing behavior has not drifted across the tool-calling and RAG changes. Schema invariants hold across the entire history (`tools_used` present and well-formed in every post-RAG entry).

## 5. Data integrity — Grade A (4/4)

Export log is a valid array with all core keys per entry. Fault-injection drills: a corrupted `provisioner_prefs.json` falls back to defaults without crashing; a corrupted `daisy_docs_index.json` degrades to empty search results. All state files are JSON re-writes (truncate+write), so a mid-write crash loses at most the last entry — acceptable for local logs, noted as the one place without atomic write+rename.

## 6. Accessibility — Grade A (7/7, post-fix)

`lang="en"`, heading structure, live-region chat transcript, labeled inputs, no unlabeled icon buttons, no zoom-disabling viewport meta. Remaining known gap (passed with note, not a violation): search/prefs inputs rely on placeholder + no visible label — cosmetic, filed for a future pass.

## 7. Compliance & privacy audit (project-appropriate scope)

SOC 2 / HIPAA / PCI-DSS are **not applicable** — single-user, local-only, no payment/health data, no multi-tenant infrastructure. The honest equivalent, verified:

- **Data locality:** chat memory is RAM-only, cleared on exit; documents stay in `~/daisy_docs`; the RAG index and export log never leave the machine.
- **Outbound flows (complete list):** GitHub API (releases/research, cached, unauthenticated), PyPI (version checks), any URL *you* ask an agent to fetch, Ollama's model registry. No telemetry, no third-party analytics, no model calls to remote APIs — all inference is local.
- **Audit trail:** provisioner log records memory resets, model deletions, indexing runs, research cycles.
- **Residual risk accepted:** `fetch_url` can retrieve anything you prompt it to (by design); the export log stores task outputs in plaintext locally (by design).

## 8. Environment scan

`pip check`: no broken requirements. Python 3.9 (system) — approaching upstream EOL (Oct 2025 for 3.9; this machine's CLT build still receives Apple security patches) — flagged, not actionable without a newer toolchain. Pinned intentionally: `pywebview 4.0.2` / `pyobjc 10.3` (newer pyobjc needs a compiler this Mac lacks — documented in the daemon's self-update checks). `ollama` client 0.6.2 supports the tool-calling API in use.

---

## Verdict

| Suite | Grade |
|---|---|
| Tool units / Functional / Security / Stress / Regression / Data / a11y | 7 × A |
| Overall | **A — ship-clean** |

**Fixed during this audit (4):** prefs silent-success · unbounded request bodies + prompt DoS · undersized listen backlog · thread-unsafe output capture. **Plus 2 a11y fixes** (live region, input labels).
**Top remaining items, ranked:** 1) atomic write+rename for state files; 2) visible labels for search/prefs inputs; 3) scheduled (cron/LaunchAgent) runs of `daisy_selftest.py` so regressions surface the day they're introduced.
