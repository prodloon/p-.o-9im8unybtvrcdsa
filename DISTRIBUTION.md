# Daisy Chain — Distribution Notes

Welcome. This document covers what you need before installing Daisy
Cluster, what to expect the first time macOS opens it, and where the app
keeps its data (so you always know what to back up — or delete).

---

## What Daisy Cluster is

A local-first multi-agent orchestrator with a desktop telemetry window:

- **Node orchestrator** (`backend/index.js --serve`) — task queue, worker
  pool, RAM governor, supervisor, 3-tier consult cascade
  (skill templates → local LLM → cloud frontier).
- **Tauri shell** (`Daisy Cluster.app`) — a native macOS window that
  spawns the orchestrator as its child, tails its telemetry at 1 Hz, and
  kills it cleanly on quit. The app owns its orchestrator; you never run
  anything by hand.

The app is ad-hoc signed in release candidates (rc1–rc3) — its seal is
integrity-checked at build time, but it carries **no Apple Developer ID
certificate**. Until proper signing lands, Gatekeeper will refuse the
first launch:

- macOS may report the app as **"damaged"** — that is the un-notarized
  ad-hoc signature, not actual corruption. Verify the download against
  the release's `SHA256SUMS.txt` first, then approve it once via
  **System Settings → Privacy & Security → Security → Open Anyway**
  (or `xattr -dr com.apple.quarantine` on the app before first launch).
- Once Developer ID signing + notarization is in place (Apple Developer
  Program enrollment is the outstanding prerequisite), this section
  reverts to: Gatekeeper treats the app as verified software from the
  first launch, no override needed.

---

## Prerequisites

### Node.js — required

The desktop app spawns `node` to run the orchestrator. Without Node, the
window opens but the backend cannot start: the app shows a red banner and
a macOS dialog naming this explicitly. Install either way:

```bash
brew install node          # Homebrew (Intel or Apple Silicon)
```

…or the official installer from <https://nodejs.org> (LTS is fine).

The app looks for Node at `/usr/local/bin/node`, `/opt/homebrew/bin/node`,
then your `PATH`. No specific Node version pin — any current Node 20+
works.

### Ollama — optional, saves money

If you want the **local-LLM tier** (tier 2) instead of paying the cloud
for every consult, install [Ollama](https://ollama.com) and pull the
pinned model:

```bash
ollama pull qwen2.5:7b
```

Without Ollama the cluster still works — consults just route to the cloud
tier (or decline, if no API key is configured either).

### OpenRouter API key — optional, enables the cloud tier

The tier-3 frontier model needs an OpenRouter key. See *Runtime data*
below for where to put it. Everything except cloud consults works without
a key, and the dashboard's `key` chip will read `missing` to say so.

---

## Installing

1. Download `Daisy Cluster.dmg` from the release page.
2. Open it and drag **Daisy Cluster** to `/Applications`.
3. Launch it once from Applications.

In the current release candidates, the first launch shows a Gatekeeper
prompt or a "damaged" warning — see the signing note above for the
one-time approval. This is expected while the app is ad-hoc signed and
not notarized. Once Developer ID notarization lands, the first launch
becomes clean: no "unidentified developer" warning, no right-click
override.

On first launch the app: creates its data directory, spawns the Node
orchestrator, and opens the telemetry dashboard. Quitting the window
(Cmd-Q included) kills the orchestrator it spawned. Launching a second
copy just focuses the first — the app is single-instance by design.

---

## Where your data lives

Everything the cluster writes lives in **one place**:

```
~/Library/Application Support/DaisyCluster/
├── .env            ← your secrets (OPENROUTER_API_KEY, ...). See below.
├── database/       ← agent states (sqlite), telemetry.json, task queue
└── sandbox/        ← the workers' file-activity sandbox
```

The app bundle in `/Applications` is **read-only and stateless** — all
state, including secrets, stays outside it. That means:

- **Upgrades are safe**: replace the app bundle; your data and keys are
  untouched.
- **Back up** `database/` if you care about agent history; the rest is
  regenerable.
- **Uninstall** = drag the app to Trash + delete the data directory above.

### Putting your API key in place

```bash
mkdir -p ~/Library/Application\ Support/DaisyCluster
printf 'OPENROUTER_API_KEY=sk-or-v1-…\n' \
  >> ~/Library/Application\ Support/DaisyCluster/.env
```

Then relaunch the app. The key is read at orchestrator start; the
dashboard's `key` chip turns green (`ok`) once the backend's health probe
sees a working key — it only ever displays a masked fingerprint, never the
key itself.

---

## The dashboard at a glance

- **Live / stale / offline** badge — is fresh telemetry flowing, has the
  orchestrator's snapshot frozen, or is nothing answering?
- **`key` chip** — OpenRouter key health (ok / missing / exhausted /
  invalid).
- **`t2` chip** — is the local Ollama model actually resident? `dead`
  means consults are silently costing cloud money.
- **RAM gauge + Governor panel** — hibernation policy engages at 80 %
  system RAM; spawn blocking at 90 %.
- **Supervisor panel** — automatic healer state; a sustained boot-failure
  streak halts healing on purpose (check `database/` and the orchestrator
  logs before clearing it).

If the orchestrator dies unexpectedly, the shell's outage watcher notices
within seconds and posts a macOS notification; it pings again on recovery
with how long the outage lasted.

---

## Giving the cluster work (task payload contract)

Tasks are JSON enqueued through `clusterctl.sh` (headless) or the app's queue. A task needs **three** fields to do something real:

```bash
./clusterctl.sh task '{
  "kind": "generic",
  "payload": {
    "summary": "Scaffold a small express api with a health endpoint",
    "action": "scaffold",              // required: what the worker does
    "params": { "name": "my-api", "kind": "node-api" },
    "needsSkill": true                 // optional: run the SNIPE skill consult first
  }
}'
```

- **`action`** (required) — one of the worker's deterministic actions:
  `list_files`, `read_file`, `write_file`, `append_file`, `delete_file`,
  `mkdir`, `file_stats`, `scaffold`, `http_get_json`, `SNIPE`.
  A summary with no action fails 3× and poisons (`unknown action ''`).
- **`params`** — the action's arguments (see the examples below; wrong
  params fail per-attempt, e.g. `http_get_json` refuses non-http(s) URLs).
- **`needsSkill: true`** — the SNIPE gate: the worker refuses to act until
  the supervisor cascade (T1 template → T2 Ollama → T3 cloud) injects a
  skill or declines. Omit it for pure mechanical tasks.
- **`summary`** — phrased to match a skill's trigger words, it routes at
  T1 (free). Triggers live in `skillbase/index.json`, e.g. scaffold / api /
  rest for the express scaffold, rename / bulk / batch for bulk renames,
  route / map / audit for route inventories.

Copy-paste examples:

```bash
# Scaffold a project (SNIPE cascade, T1 hit on 'scaffold'/'api')
./clusterctl.sh task '{"kind":"generic","payload":{"summary":"scaffold an express api","needsSkill":true,"action":"scaffold","params":{"name":"demo-api","kind":"node-api"}}}'

# List files in the sandbox
./clusterctl.sh task '{"kind":"generic","payload":{"summary":"list the files","action":"list_files","params":{"dir":"."}}}'

# Fetch JSON over HTTP
./clusterctl.sh task '{"kind":"generic","payload":{"summary":"fetch json over http","action":"http_get_json","params":{"url":"https://api.github.com/zen"}}}'
```

Watch it run: `./clusterctl.sh logs orchestrator 50` (look for
`task N → tier1-template`), or the dashboard's pipeline panel.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Red "Node.js not found" banner on launch | Install Node (`brew install node`), relaunch. |
| `key: missing` chip | No `.env` in the data dir — see above. |
| `key: invalid` | The key was revoked or mistyped; rotate it at OpenRouter and update `.env`. |
| `t2: unreachable` / `dead` | Ollama isn't running or the model isn't pulled (`ollama pull qwen2.5:7b`). |
| Dashboard says **offline** | The orchestrator isn't running; relaunch the app (it owns the orchestrator — don't start a second headless one). |
| Everything renders but numbers are frozen | Badge should read **stale**; the supervisor heals within one tick (~15 s). Sustained staleness = check `~/Library/Application Support/DaisyCluster/database/telemetry.json`. |

---

## Maintainer: updater signing key (TAURI_SIGNING_PRIVATE_KEY)

Auto-updates are signed with a minisign keypair generated by the Tauri CLI. The **public** key is embedded in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and ships with every build. The **private** key signs each release artifact and must never be committed.

One-time setup (done 2026-09-15 — these steps are here in case the key is ever rotated):

```bash
# 1. Generate the keypair (empty password is fine for CI-driven signing;
#    the key file itself is the secret):
cargo tauri signer generate -w daisy-updater.key --password ""

# 2. Paste the .pub file's base64 content into
#    src-tauri/tauri.conf.json → plugins.updater.pubkey

# 3. Store the PRIVATE key as GitHub repo secrets:
#    - TAURI_SIGNING_PRIVATE_KEY          = base64 of daisy-updater.key
#    - TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "" (or omit)
#      base64 < daisy-updater.key | gh secret set TAURI_SIGNING_PRIVATE_KEY
```

What happens automatically:

- **With the secret set:** `tauri build` produces `*.app.tar.gz` + `.sig` alongside the DMG; the release workflow attaches them and publishes `latest.json` — installed apps check the updater endpoint and self-update with signature verification.
- **Without the secret:** CI disables `createUpdaterArtifacts` before building, so builds and CI stay green; the updater simply has no new artifacts to serve.
- **Private repo caveat (current state):** the updater fetches the feed anonymously, and GitHub release assets in a **private** repo 404 for anonymous requests. While the repo is private, the self-update check fails non-fatally (`updater check failed`) on every install — detection, verification, and staging were all proven live against a public-feed simulation (rc3/rc4 work). Self-updates start working the moment the repo is made public, or if `latest.json` is hosted on a public URL (S3/R2/gist) and put in `plugins.updater.endpoints`.

If the private key is lost, releases already published remain installable, but no further signed updates can be issued — rotate by generating a new keypair and shipping one final "re-install" release with the new pubkey.

## Privacy / network behavior

- The app talks to **loopback only** for its own transport; the webview
  loads a local build with a strict CSP — no remote content, no tracking,
  no analytics.
- Outbound network happens only where you'd expect: OpenRouter cloud
  consults (if a key is configured) and the Ollama probe on localhost.
- Task execution is local-only today; workers' file writes stay in the
  sandbox directory.
