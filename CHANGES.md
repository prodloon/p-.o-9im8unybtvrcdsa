# Round 8 — 2026-09-15

## Updater signing keypair generated; updater artifacts re-enabled

- **Keypair:** `~/.tauri-daisy-keys/daisy-updater.key(.pub)` via
  `cargo tauri signer generate` (empty password — the file is the secret).
- **Pubkey embedded:** `plugins.updater.pubkey` in `tauri.conf.json` now
  holds the real base64 minisign public key (was empty, which made update
  checks silent no-ops on dev builds).
- **`createUpdaterArtifacts: true`** in the bundle config — release builds
  now emit `*.app.tar.gz` + `.sig` for the updater feed.
- **CI made resilient:** the installer job disables the flag at build time
  when the `TAURI_SIGNING_PRIVATE_KEY` secret is absent, so CI stays green
  before the secret is added; with the secret set, artifacts sign
  automatically. Setup steps documented in `DISTRIBUTION.md`
  (maintainer section).
- React 19 + Vite 8 PR (#13) merged with a fix for the
  `telemetry.js`-derived subscription API; superseded dependabot PRs
  closed; main is green.

## Tree merge: workspace Rounds 4–7 folded into the supervised checkout

The two diverged trees are now one. `~/daisy-chain` (the git checkout CI
runs from) received every Round 4–7 change, and the workspace distribution
tree received the checkout's T2 canary, burn projections, S22/S23 suites,
and key-health work. Verified in both directions:

- **Backend battery: 189/189** (was 141 workspace-only / 185
  checkout-only). The merged file keeps workspace `--fast` mode AND the
  checkout's S22 t2-canary + S23 secret-scanner suites.
- **Cluster battery: 76/76, all A** in the checkout and in the workspace
copy after the sync.
- **CI is now one workflow.** The repo's own `selftest.yml` proved better
  than our ci.yml (it pins node via symlink instead of env vars); the
  duplicate `ci.yml` was deleted and the portability fixes kept.
- **S23 caught its first real catch during the merge:** the workspace's
  literal zeroed OpenRouter key tripped the self-scan. The S20 fixture now
  fragment-assembles its synthetic key (checkout HEAD's approach).
- **Frozen suite semantics clarified:** the byte-size pin is the
  invariant; committed reviewed fixes to legacy files (the escJs injection
  fix changed `daisy_ui.py`) are legitimate — the old git-clean check
  failed for 10s after every committed fix until the pin was refreshed.
- **Dependabot** now covers npm (ui/), cargo (src-tauri/), and GitHub
  Actions; npm prod-dep audit is clean (0 vulnerabilities).
- **Tauri updater + process plugins** wired (config, deps, plugin
  registration compile clean); the release feed points at the repo's
  latest-release `latest.json`. Gated on the Developer ID pubkey until
  signing goes live — an empty pubkey means the check silently skips,
  so dev builds are unaffected.

# Round 7 — 2026-09-15

## CI workflow, ctl de-flake, DMG notarization, Node-missing UX

Four release-readiness items from the Round 6.5 checklist, all verified.
Plus a fifth same-day addition: a **release job** (below).

0. **Full-mode certification run:** after all Round 7 changes, the full
   battery (live Ollama) was re-run end to end — **76/76, all A, 5m45s**,
   confirming `--fast`, the ctl de-flake, DMG notarization, the Node-missing
   check, and the workflows changed nothing in full mode. The run surfaced a
   real bug, now fixed: `run_node()`'s flat 180s subprocess timeout predated
   full-mode runtimes and killed the backend battery at 3 minutes every time
   full mode ran via the cluster harness. Timeout is now per-script (backend
   battery 900s, everything else 180s); fast mode is unaffected.

5. **Release workflow job** (`release` in ci.yml): on a pushed `v*` tag,
   after `fast-battery` passes (never ship what the battery just failed),
   a macOS runner provisions the Developer ID cert into a temporary
   keychain (with the partition-list step that suppresses the headless GUI
   prompt), builds the notary keychain profile from App Store Connect API
   secrets, then runs `./make-installer.sh` unchanged — the script already
   owns build → hardened-runtime sign → notarize (.app + .dmg) → staple →
   spctl/stapler gates. Headless accommodations: `NO_APP_VERIFY=1` (stage 5
   launches the installed app — impossible on a runner; the battery already
   proved the build) and `DAISY_ALLOW_EXTRA_BUNDLES=1` (belt-and-braces on
   a clean /Applications). The stapled DMG is attached to the GitHub
   release via softprops/action-gh-release. Requires six repo secrets
   (documented in the workflow): APPLE_CERT_P12_BASE64,
   APPLE_CERT_PASSWORD, KEYCHAIN_PASSWORD, APPLE_KEY_ID, APPLE_ISSUER_ID,
   APPLE_API_KEY_P8_BASE64, plus a `release` environment for approvals.
   YAML parse-verified; the job cannot run end-to-end until the secrets
   and a GitHub remote exist.
6. **Distribution README** (`DISTRIBUTION.md`, ships in the bundle and the
   hardened zip): recipient-facing coverage of prerequisites (Node
   required, Ollama + model pin and OpenRouter key optional), first-launch
   Gatekeeper behavior (notarized + stapled → clean open, with guidance to
   re-download rather than override if a warning ever appears), the
   single data location (`~/Library/Application Support/DaisyCluster/`
   with `.env`/`database`/`sandbox` layout, upgrade/backup/uninstall
   implications), dashboard chip meanings, a troubleshooting table, and a
   privacy/network-behavior statement consistent with the Round 6 review.

1. **GitHub Actions workflow** (`.github/workflows/ci.yml`): the full
   8-suite fast battery on every push/PR. macOS runner (ctl suite needs
   launchctl/plutil), Node 22, stable Rust, `actions/cache` on
   `.ci-cargo-target` keyed by `Cargo.lock` — after the first run, cargo
   check is a no-op rebuild and the whole battery lands well under a
   minute. The stack starts headless (`clusterctl.sh start --no-ui`) so
   Suites 3/6/7 exercise the real orchestrator and ctl status on a clean
   runner; the workflow stops the stack and uploads logs on failure.
   Full mode stays a local pre-release step.
2. **ctl status de-flaked**: `suite_control_script` retries `clusterctl
   status` once (3s settle) when it exits above the expected (0, 1) range —
   the transient pid-alive/probe-failed blip seen twice on this machine can
   no longer fail CI. Failure detail now notes when a retry happened.
3. **DMG notarization in Stage 6**: when signing is enabled, the newest
   `.dmg` from `src-tauri/target/release/bundle/dmg/` is submitted to
   notarytool directly (notary accepts dmg natively), stapled, and
   `stapler validate` gates the build. A missing DMG warns but does not
   fail (tauri build can be run with bundle targets that skip dmg).
   Recipients now see "verified by Apple" on the disk image itself, not
   just the app inside it.
4. **Node-missing first-run UX**: without Node the backend could previously
   die silently behind a dead dashboard. Now `spawn_backend() == None`
   triggers (a) a native stop-dialog via osascript (no new dependencies —
   no tauri-plugin-dialog added) naming the fix (`brew install node` or
   nodejs.org), and (b) a `shell://no-node` event rendered as a persistent
   red banner in `App.jsx` via a new `subscribeShellAlert()` in
   `telemetry.js`. `cargo check` clean; UI production build clean
   (`npm run build`, 990ms); fast battery 76/76 in 20s after all four
   changes.

---

# Round 6 — 2026-09-15

## Shell security review (src-tauri + ui) — the last unreviewed surface

Same bar as Rounds 1–3. Good news: **no injection-class bugs, no
over-privileged IPC, nothing urgent.** The shell is the most conservative
part of the codebase.

### Verified clean

- **IPC surface is minimal by construction.** The UI never calls `invoke()`
  — there are ZERO custom Tauri commands. Data flows one way: the Rust
  emit loop broadcasts `telemetry://metrics` every second; the webview only
  listens. Nothing the webview renders can ask the Rust host to DO anything.
- **Capabilities are locked down**: `capabilities/default.json` grants only
  `core:default` to the `main` window. No `fs`, `shell`, `opener`, `http`,
  or `asset` protocol exposure. The compiled `gen/schemas/capabilities.json`
  matches — the dangerous plugins simply aren't in the dependency tree.
- **No XSS sinks in the React app**: no `innerHTML`,
  `dangerouslySetInnerHTML`, `eval`, `document.write`, `window.open`, or
  dynamic `href` anywhere in `App.jsx`/`telemetry.js`. All telemetry fields
  (including supervisor-event text, which comes from parsing an on-disk log)
  render as React text nodes — auto-escaped. The sparkline builds SVG
  polyline points from numbers only. Even a hostile telemetry.json can't
  script the webview.
- **No remote content**: `frontendDist` is the local build; `devUrl` is
  loopback and dev-only; no `dangerousRemoteDomainIpcAccess`, no navigation
  overrides, no custom protocol handlers.
- **Spawn hygiene**: the backend child spawns via `Command::new(node)` with
  a fixed script path and no shell — argv-array semantics, no injection
  surface. Kill paths are double-covered (`WindowEvent::Destroyed` AND
  `RunEvent::Exit` for Cmd-Q/AppleScript quit), and the backend's own
  5s orphan guard backs both up.
- **Secrets stay out of the bundle**: `.env` is loaded from Application
  Support (user-editable, not distributable) and only fills gaps — real
  environment exports always win. Matches the installer's exclusion rules.
- **Data-dir resolution is regression-proofed**: app mode redirects to
  `~/Library/Application Support/DaisyCluster`; the one-time emit-loop
  proof line (the wrong-path bug from Round 1's audit) is still asserted
  by make-installer.sh Stage 5.
- **Single-instance plugin** registered first — a second launch focuses the
  existing window instead of spawning a rival backend.

### Noted, not urgent — ALL THREE NOW FIXED (same day)

1. **`"csp": null` in tauri.conf.json.** The UI is fully local and only
   talks to loopback, so the practical exposure is low — but CSP is
   defense-in-depth against a future dependency (a compromised npm package
   in the UI bundle would face no content restrictions). ~~Recommended:~~
   **APPLIED**: `"csp": "default-src 'self'; style-src 'self'
   'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost
   http://127.0.0.1:6292"` (the 6292 clause keeps the Vite-mode loopback
   polling working; `style-src 'unsafe-inline'` covers Tailwind's inline
   styles). `cargo check` re-verifies the config parses (Tauri embeds it at
   compile time) and Suite 5 is 9/9 after the change.
2. **`notify_outage` AppleScript escaping is partial** — it escaped `"` but
   not `\\`. **FIXED**: backslash is now escaped first (`msg.replace('\\',
   "\\\\")` then the quote escape), so an AppleScript string-injection
   vector cannot exist even if external text is ever fed into the message.
3. **Parity nit**: `main.rs` node lookup tried `/usr/local/bin/node` then
   `node` on PATH — it lacked the `/opt/homebrew/bin/node` explicit fallback
   the shell scripts got in Round 1's portability pass. **FIXED**: candidate
   list is now `/usr/local/bin/node`, `/opt/homebrew/bin/node`, `node`.

### Verdict

The GUI was safe to ship before; with all three notes applied it is now at
the same hardening bar as the rest of the codebase.

### Re-review after the three fixes (same day)

Full second pass over the post-fix source — no regressions, no new
findings. Confirmed live on the current tree:

- **CSP is set and parses** (`cargo check` embeds/validates tauri.conf.json
  at compile time). Policy: `default-src 'self'; style-src 'self'
  'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost
  http://127.0.0.1:6292` — `default-src 'self'` blocks script injection
  from a future compromised dependency; the two loopback clauses preserve
  the Vite-mode polling path only.
- **AppleScript escaping order verified**: backslash first, then quote —
  `msg.replace('\\', "\\\\").replace('"', "\\\"")`. Correct order (escaping
  the quote first would bake new backslashes that the second pass would
  then mangle).
- **Sinks re-scanned across `ui/src/` and `src-tauri/src/`**: zero hits for
  `invoke`, `innerHTML`, `dangerouslySetInnerHTML`, `eval(`,
  `window.open`, `document.write`, dynamic `href`, or
  `dangerousRemote*`. Still zero custom Tauri commands — `invoke_handler`
  never appears in `main.rs`; the webview's only IPC is the one-way
  `listen('telemetry://metrics')`.
- **Capabilities unchanged**: `core:default` only, `main` window only.
  Dependency tree unchanged (tauri + single-instance + serde) — no
  `tauri-plugin-shell`/`fs`/`http`/`opener` anywhere.

No changes required from the re-review; this entry documents that the
fixes landed clean.

---

# Round 5 — 2026-09-15

## New: `--fast` mode for the backend selftest

The full backend battery took ~6–9 minutes on machines with local Ollama
running, because suites that build a *default* keyless bridge get the
production Tier-2 leg — and one unmatched task summary in S14 then triggers
a REAL qwen2.5:7b inference (S16's real-timer sleeps add the rest).

`node backend/backend.selftest.js --fast` (or `DAISY_SELFTEST_FAST=1` for
the cluster harness, which forwards the flag to the backend battery):
- **Same 141 checks, same outcomes.** Only the five keyless default bridges
  (S10, S12c, S14, S15, S20d) change: their Tier-2 (Ollama) leg is disabled,
  so no suite ever makes a real local-LLM call. Those suites only exercise
  Tier-1/offline-fallback paths anyway, which are unaffected.
- The full Tier-2 *logic* coverage (request shape, residency keep_alive,
  confidence escalation, escalation-failure degradation) was always mocked
  and stays in S6/S21 in both modes.
- Full mode (no flag) is byte-for-byte unchanged and was re-verified:
  141/141 in 6m11s.

Measured on this machine: full mode 6m11s → fast mode **11.5s**; the whole
cluster battery (Suites 1–4, 6–8) drops from minutes to **17s**.

CI guidance: run `--fast` on every push; run full mode (with Ollama up) on
release candidates or when touching `supervisor-bridge.js` itself.

## Fast mode covers the whole battery, including cargo check

Follow-up to `--fast`: the cluster harness's Suite 5 now honors
`DAISY_SELFTEST_FAST=1` too, so the ENTIRE 8-suite battery (76 checks,
`cargo check` included) runs green in CI:

- In fast mode Suite 5 runs `cargo check` with a **persistent target dir**
  (`.ci-cargo-target` in the tree, overridable via the standard
  `CARGO_TARGET_DIR` env var). The first run builds the full dependency tree
  (~2 min); every run after that is a no-op rebuild in seconds. In CI, cache
  that one directory between runs. **Nothing is skipped** — same 9 checks,
  same outcomes; only the rebuild work is avoided. Full mode still uses the
  default per-checkout `target/` and behaves exactly as before.
- Measured on this machine (cold `rm -rf .ci-cargo-target` first):
  cold fast run 2m19s (one-time dep build), warm fast run **18.8s, 76/76,
  all suites grade A**. Full mode remains ~7 min (Suite 5's default-target
  cargo check + S14's live-Ollama triage leg); full mode Suite 5 re-verified
  9/9 after the change.
- Caveat carried over from `--fast`: the ctl suite's `status` check once
  flaked on a transient orchestrator HTTP-probe blip mid-battery
  (environmental — re-run cleared it). If CI ever sees a single `[ctl]
  status` failure, re-run before investigating.

CI recipe: cache `daisy-chain/.ci-cargo-target` (or set `CARGO_TARGET_DIR`
to a cached path), export `DAISY_SELFTEST_FAST=1`, run
`python3 daisy_cluster_selftest.py`.

## Also in this round

- `.app` consolidation executed: `Daisy Cluster 2.app` (unsigned stripped
  duplicate) and `DaisyChain.app` (legacy bash launcher) were zipped to
  ~/Downloads with ditto, extraction-verified byte-identical, then removed
  from /Applications. Canonical `Daisy Cluster.app` untouched and its
  signature still verifies. Round 4's recommendation is now done.
- **Consolidation is COMPLETE and verified.** /Applications now contains
  exactly one Daisy bundle (`Daisy Cluster.app`). Post-deletion sweep for
  stale references came back clean: no LaunchAgent/Daemon, login item (BTM),
  default-handler registration, cron entry, or shell-rc reference points at
  either deleted path — the four Daisy agents all target the canonical app
  or the ~/daisy-chain checkout. Two legacy-era leftovers under the old
  launcher's name were removed: `~/Library/Caches/daisy-cluster` (deleted;
  disposable web cache) and `~/Library/WebKit/daisy-cluster` (quarantined
  to ~/Downloads/daisy/legacy-quarantine/ — may hold old localStorage).
- Discovery: the supervised checkout `~/daisy-chain` (git repo) contains the
  previously-missing Tauri/React shell source (`src-tauri/`, `ui/`). Suite 5
  and the GUI security review are now unblocked — pending integration.
- **Shell source integrated — Suite 5 runs for the first time, ALL GREEN.**
  `src-tauri/` and `ui/` were copied from the supervised checkout
  (`~/daisy-chain`) into the hardened tree, excluding `target/` (2.8G of
  Rust build artifacts), `node_modules/` (76M), and `ui/dist` was carried
  along as the verified production build. Full cluster battery (all 8
  suites, first complete run ever): **76/76 — grade A in every suite**,
  including `shell` 9/9 (tauri.conf, main.rs, Cargo.toml, icons, App.jsx,
  telemetry.js, ui/dist present; `cargo check` passes on the real crate).
  First battery run showed 73/74 with a transient `[ctl] status` failure
  (orchestrator HTTP probe blipped while the battery ran); clean re-run
  passed everything — environmental, not a regression.
- **Bundle-drift guard in `make-installer.sh`**: the build now FAILS if any
  Daisy `.app` other than `Daisy Cluster.app` exists in /Applications —
  the exact condition the Round-4 audit found (an unsigned duplicate + a
  legacy launcher). Case-insensitive match (`Daisy`, `daisy`, `DAISY`),
  skips the canonical name, checks run before any build/install work.
  Escape hatch for intentional setups: `DAISY_ALLOW_EXTRA_BUNDLES=1`.
  The glob logic was tested against 6 scenarios (clean, one extra, two
  extras, case variants, extra-without-canonical, non-Daisy apps ignored)
  — which caught a real bug in the first draft (an unquoted glob split
  matched the directory itself as a "bundle"); fixed and re-verified 6/6,
  plus a live run against the real /Applications (clean).

---

# Round 4 — 2026-09-15

## Fixed

7. **ReDoS hardening in `worker.js` `list_files`** — the item flagged at the
   end of Round 3, now fixed before any remote task ingestion exists.
   Node has no regex timeout, and workers run in-process, so a catastrophic
   backtracking pattern (e.g. `(a+)+$`) in a task payload would hang the
   entire orchestrator event loop. Added `assertPatternSafe()`: a 256-char
   length cap plus rejection of quantified groups containing a quantifier
   or alternation (the exponential-blowup shapes). Benign patterns
   (`^a+\\.txt$`, `^w[0-9]{2}$`) pass unchanged. Conservative by design —
   future legitimate needs should be explicit allowlist entries, reviewed.
   Five new selftest checks cover benign pass-through, both catastrophic
   shapes, and the length cap (backend suite 136 → 141 checks).

8. **Stale baselines in `daisy_cluster_selftest.py`** (found while
   re-running all suites on a second machine — this is exactly what the
   frozen tripwire is for, it just hadn't been updated after legitimate
   changes):
   - backend check grepped for the literal "136 passed" — now 141 after #7.
   - `FROZEN_SIZES['daisy_ui.py']` was 70986 (pre-Round-2); the `escJs()`
     injection fix (#5, Round 2) legitimately changed the file. Baseline
     updated to the post-fix 71629 with a comment pointing at CHANGES.md.

## New: distribution signing/notarization (Stage 6 in make-installer.sh)

Opt-in: behavior is byte-for-byte unchanged unless `DAISY_SIGN_IDENTITY`
is set. With it:
- Stage 3 signs with **Hardened Runtime** (`--options runtime`) + an
  `allow-jit` entitlement (WebKit needs it under Hardened Runtime) and
  fails the build on a bad signature (`codesign --verify --strict`).
- New Stage 6: ditto-zips the installed .app (ditto preserves signatures;
  `zip -r` can corrupt them), submits via `xcrun notarytool submit --wait`,
  staples the ticket, and gates on `spctl --assess`.

One-time prerequisites (in the script header): Apple Developer Program
membership, a Developer ID Application certificate, and
`xcrun notarytool store-credentials` for the keychain profile.

Ad-hoc signing (`codesign -s -`) remains the default for local dev — it is
Gatekeeper-clean only on the signing Mac.

## Verified on this machine (mosesrodriguez's Mac, cold runs)

- `governor/governor.selftest.js` — 56/56
- `backend/backend.selftest.js` — **141/141** (incl. the 5 new ReDoS checks)
- `daisy_cluster_selftest.py` Suites 1–4, 6–8 — **67/67** (Suite 5 shell
  artifacts still can't run: `src-tauri/` + `ui/` source still not in any
  archive — Tauri/React source remains the one unreviewed surface)
- `daisy_selftest.py` — 70/70
- `make-installer.sh` — `bash -n` clean

Note: the backend selftest takes ~8–9 minutes here because S14/S15/S21 do
REAL local-Ollama (qwen2.5:7b) triage and S16 sleeps on real timers. The
multi-minute silence is expected, not a hang — worth a `--fast` mode before
customer-facing CI, or at least a comment where the wait is longest.

## .app consolidation assessment (for your decision)

Verified in /Applications on this machine:
- **`Daisy Cluster.app`** (6.5M, v0.1.0, ad-hoc, com.moses.daisycluster,
  full appdata staged) — the only complete, canonical build. **Keep.**
- **`Daisy Cluster 2.app`** (5.8M, v0.1.0) — signed at all: **no signature
  whatsoever**, and `Contents/Resources/` contains ONLY `icon.icns` — no
  appdata payload, nothing runnable. Stripped duplicate. **Delete.**
- **`DaisyChain.app`** (220K, v1.0, ad-hoc, com.moses.daisychain) — its
  "binary" is a **bash shell script**, not the compiled app. Legacy
  launcher pointing outside the bundle, exactly as the Round-1 audit
  described. **Delete** (or archive it first if sentimental).

Both deletions are safe: neither bundle contains anything the canonical
build lacks. Left for you to run (I don't delete things in /Applications
without an explicit go-ahead):
```bash
rm -rf "/Applications/Daisy Cluster 2.app" "/Applications/DaisyChain.app"
```

---

# Security/reliability pass — 2026-09-14

## Fixed

1. **Leaked live API key** (`backend/backend.selftest.js`)
   A real OpenRouter key (the post-rotation one, per knowledge.md) was hardcoded
   in a test fixture and shipped inside the .app bundle. Replaced with a
   synthetic key; also tightened the assertion to actively check the middle
   of the key is never exposed by the fingerprint function.
   **Action needed from you: revoke `sk-or-v1-2b87…6361` on openrouter.ai now
   if you haven't already — it was sitting in a distributable file.**

2. **Silent bug in `readProcessStats` (Linux branch)** (`governor/governor.js`)
   Referenced an undefined `_ticks` variable, which threw and was swallowed
   by the surrounding try/catch — so the function always returned null RSS
   on Linux, invisibly. Fixed the variable reference. (Your shipped target
   is macOS, but this proves the test suite wasn't actually exercising this
   branch — worth knowing before you trust "all green" on unfamiliar ground.)

3. **Non-portable selftest assertion** (`governor/governor.selftest.js`)
   `S8` hard-asserted total system RAM is ~16 GiB — true only on the
   original dev machine. Any customer with an 8GB, 24GB, or 32GB Mac would
   fail this check on a totally healthy machine. Rewrote it to compare
   against `os.totalmem()` instead, so it verifies the *reader* is correct
   rather than assuming a specific RAM size.

4. **Hardcoded `/usr/local/bin/node`** (`clusterctl.sh`, `make-installer.sh`,
   `daisy_cluster_selftest.py`)
   This path is only correct for Intel Homebrew. Apple Silicon Homebrew
   installs to `/opt/homebrew/bin`; nvm, asdf, and the official installer
   land elsewhere again. Since Apple Silicon is now most new Macs, this
   would have broken the app for the majority of customers who don't
   happen to have Node symlinked into `/usr/local/bin`. All three now
   resolve via `PATH` first, then fall back to both Homebrew prefixes, and
   fail with a clear message instead of a cryptic "command not found" if
   node genuinely isn't installed.

## Independently verified (not just re-reading the audit doc)

Ran the actual test suites myself, cold, on a machine that isn't yours:
- `governor/governor.selftest.js` — 56/56 (was 54/56 before the fixes above)
- `backend/backend.selftest.js` — 136/136 (was 134/136)
- `daisy_cluster_selftest.py` Suites 1–4 (governor battery, backend battery,
  **live end-to-end pipeline** — real CLI, real SQLite, real task execution,
  telemetry, cost rollup) — all genuinely pass, including with no
  OPENROUTER_API_KEY and no Ollama installed (graceful degradation confirmed
  for real, not just asserted in a comment).

---

# Round 2 — 2026-09-14 (continued)

## Fixed

5. **Real script-injection bug in the webview UI** (`daisy_ui.py`) — the
   most serious thing found so far.

   Several buttons build their `onclick` handler by interpolating
   HTML-escaped text into a single-quoted JS string, e.g.
   `onclick="decide('${esc(c.name)}','approve')"`. HTML-entity escaping
   protects the HTML-attribute boundary, but the browser decodes those
   entities *before* compiling the attribute as JS — so an apostrophe in
   the value still reaches the JS parser as a real `'`, closing the string
   early. A crafted name like `x');fetch('/api/approve',{method:'POST'...});//`
   breaks out and runs arbitrary JS in the app's webview.

   The worst instances were the **package/repo install-approval buttons**
   (`decide(...)`, driven by `candidate.name` — sourced from GitHub/PyPI
   metadata your research daemon discovers, i.e. not fully trusted) and the
   model-delete button. Confirmed the blast radius: `api_approve()` re-runs
   the safety checklist and then actually executes the install — so this
   bug could have let a maliciously-named package or repo trigger its own
   installation, defeating the human-approval step the whole provisioner
   design depends on.

   The codebase already knew about this exact bug class and had patched it
   in exactly one place (`researchTask(...)`, via an ad-hoc
   `.replace(/'/g,"\\'")`) but missed it everywhere else. Fixed by adding
   one proper `escJs()` helper (backslash-escapes for the JS-string context,
   then HTML-escapes for the attribute context — order matters) and
   applying it consistently: the approve/dismiss buttons, the model-delete
   button, the release-link opener, and the research-explore button
   (replacing its ad-hoc fix with the shared helper).

6. Verified `api_set_prefs`'s "no silent success on junk input" fix and the
   loopback-only bind + `request_queue_size=64` claims by reading the
   actual code — both check out as described in the audit.

## Still not reviewed

`daisy_docs.py` (RAG), `daisy_research_daemon.py`, and the Node orchestrator
internals (`worker.js`, `worker-pool.js`, `skill-injector.js`,
`backend/index.js`) haven't had the same close pass yet — next in line.

---

# Round 3 — 2026-09-14 (continued)

Finished the remaining backend surface. Good news: no more injection-class
bugs. Two things worth your attention, one real (low severity today) and
one just confirmation.

## Reviewed, clean

- **`daisy_docs.py`** (local RAG) — fully local, no network, reads only
  from a fixed folder under `$HOME`. No issues.
- **`daisy_research_daemon.py`** — no subprocess/shell/eval anywhere; all
  network calls go to three fixed, hardcoded hosts (localhost Ollama,
  pypi.org, GitHub API). No issues.
- **`backend/worker.js`** — file-op path jailing (`_safePath`) uses the
  correct pattern (`resolved.startsWith(root + sep)`, not the common buggy
  `startsWith(root)` that lets sibling directories like `root-evil/`
  through). URL fetches are http(s)-only and size-capped.
- **`backend/skill-injector.js`** — skill files are path-jailed to
  `skillbase/`, and a skill's content only ever becomes *context text*
  handed to a worker — it can't set the action or parameters a worker
  executes. So even a malicious skill file can't reach `worker.js`'s file
  operations directly.
- **`backend/worker-pool.js`** — confirmed the SNIPE-gate leak fix from your
  changelog is actually in the code (`beginTask()` runs on every acquire
  path, not just some).
- **`backend/index.js`** — the one `execSync` call is a hardcoded, constant
  command string (no interpolation, no injection surface); `process.ppid`
  is correctly used as a property, matching the changelog's account of that
  bug being fixed.

## Noted, not urgent

- `worker.js`'s `list_files` action builds a `RegExp` directly from a
  `pattern` parameter in the task payload. If a crafted pattern (e.g.
  catastrophic backtracking like `(a+)+$`) ever reached this from an
  untrusted source, it would hang the event loop — and since workers run
  **in-process** (not subprocesses), that stalls the entire orchestrator,
  not just one task. Today there's no path for this: tasks are only
  enqueued locally by you via the CLI. Worth hardening (regex timeout or a
  pattern allowlist) *before* any feature that accepts tasks from outside
  your own machine — flagging now so it's not forgotten later.

## What's left before I'd call the backend market-ready

1. The Tauri/React source (still not in any archive you've sent — the
   actual GUI).
2. Consolidating the three `.app` builds.
3. Packaging: code signing / notarization for distribution outside your
   own Mac — I haven't looked at this at all yet, and it's required for
   any Mac app you distribute to other people without Gatekeeper blocking
   it on launch.

Want me to keep going on code signing/notarization requirements next, or
hold there until you send the Tauri/UI source?

## Found, not fixed — needs your input

- **Suite 5 (Tauri shell + React UI) can't run — the source isn't in this
  archive.** Only `src-tauri/` and `ui/` build *artifacts* exist as compiled
  binaries in the .app bundles; the `.rs` and `.jsx` source files aren't
  present anywhere in what you sent. That's the actual GUI your customers
  will use — I haven't been able to review it at all yet. If you have that
  source elsewhere, send it and I'll go through it next with the same bar.
- The three `.app` bundles in your zip are still unconsolidated (one full
  build, one stripped duplicate, one legacy launcher pointing outside the
  bundle). Worth deciding which is canonical before packaging for
  distribution.
