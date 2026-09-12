# LaunchAgent Audit — 2026-09-12

Machine-wide audit of auto-start and resurrection behavior. Method: every
plist in `~/Library/LaunchAgents`, `/Library/LaunchAgents`, and
`/Library/LaunchDaemons` parsed (`RunAtLoad` / `KeepAlive` / schedules),
cross-referenced against `launchctl list`, `launchctl print-disabled`, and
`launchctl print` for session-submitted services. Crontab checked (empty).
Apple-owned system agents (408 Agents / 394 Daemons in /System) out of scope.

## 1. The resurrection club — login autostart + `KeepAlive=true`

launchd restarts these instantly on any exit; nothing they spawn can be
killed permanently. All user-domain (start at login for user 501):

| Label | Runs | State at audit |
|---|---|---|
| `ai.hermes.gateway` | `~/.hermes` venv → `hermes_cli` | running, last exit -9 (SIGKILLed and resurrected — live proof) |
| `ai.openclaw.gateway` | node via `~/.openclaw/service-env` wrapper | running |
| `com.ai-holdco-agent` | python `~/ai-holdco-agent/main.py` | running |
| `com.gh-radar` | `/usr/local/bin/gh-radar daemon` | running |
| `com.jarvis.mission-control.server` | node `JARVIS-Mission-Control-OpenClaw/server/index.js` | running, last exit -9 |
| `com.moses.daisy-research` | `~/daisy_env/bin/python ~/daisy_research_daemon.py` | running |
| `com.daisy.cluster` | `~/daisy-chain/scripts/cluster.sh supervise` (now carries the crash-loop guard: halts healing after 5 consecutive failed boots) | running |

Boot-domain counterpart: `/Library/LaunchDaemons/com.paceap.eden.licensed.plist`
(PACE anti-piracy, root) — `KeepAlive=true` but never loaded; inert.

## 2. Login autostart WITHOUT resurrection (user-closable)

- `com.daisy.cluster.app` — opens the installed Daisy app at login
  (RunAtLoad only, no KeepAlive, by design)
- `io.sideloadly.daemon` — Sideloadly helper (loaded, last exit 78)
- `com.avast.userinit` — Avast init (exit 0)
- `com.enigmasoft.spyhunter` — SpyHunter (not loaded)

## 3. Time-based autostarts

- `com.workflow.watchdog` — every 300 s, node `workflow-pro/autoimprove/watchdog.mjs`
- `com.workflow.autoimprove` — daily 02:15 (last exit 1)
- `com.oracle.java.Java-Updater` — Mondays 17:03
- `com.google.GoogleUpdater.wake` — hourly (not loaded)

## 4. Session anomalies (loaded, no plist in any standard dir)

- `frogr-preview-a4d8de71` — **manually submitted** by `launchctl` (node
  `~/Desktop/frogr/.freebuff/preview-server.mjs`) with **inferred keepalive**:
  resurrects within the session, dies at logout. Dev-preview server someone
  left running.
- `com.avast.Antivirus` — plist lives inside the app bundle; running.
- `com.freebuff.desktop.ShipIt`, `com.microsoft.VSCode.ShipIt` — updater stubs.

## 5. Disabled-override ghosts

MacKeeper (`MacKeeperAgent`, `MacKeeper-Info`, `MacKeeper-Reminder`) and
`com.ollama.ollama` are "enabled" in the disabled-overrides DB but have **no
plists on disk** — remnants of removed apps, harmless but stale.

## 6. Cleanup actions taken (2026-09-12)

- ❌ `com.giulia.serve-all` — REMOVED (booted out + plist deleted). It pointed
  at `/tmp/serve-all.js`, which no longer existed: failed at every login
  (exit 1) forever.
- ❌ `com.valvesoftware.steamclean` — REMOVED (plist deleted). Stale Steam
  WatchPaths agent, never loaded.
- ⏸️ `/Library/LaunchDaemons/com.paceap.eden.licensed.plist` — removal prompt
  timed out (root-owned, needs admin). It is inert (never loaded). When
  desired, run with admin rights:
  `sudo rm /Library/LaunchDaemons/com.paceap.eden.licensed.plist`

## 7. Kill switch — `suspend-agents`

`~/bin/suspend-agents` (symlinked to `/usr/local/bin/suspend-agents`):

```
suspend-agents            # boot out all 7 resurrection-club agents + session-submitted extras
suspend-agents restore    # bootstrap back exactly what was loaded pre-suspend
suspend-agents status     # per-agent: plist / loaded / pending-restore record
```

- Records in `~/.config/suspend-agents/`; `restore` only touches recorded
  agents, so anything manually unloaded stays unloaded.
- Waits out slow node teardowns before declaring a suspend complete
  (race found in live testing: `ai.openclaw.gateway` lingers seconds after
  bootout, which made a fast `restore` drop its record).
- Session-submitted services (e.g. `frogr-preview-*`) are killed on suspend
  but cannot be restored (no plist) — relaunch them manually.
- Logout/login re-bootstraps every plist still on disk — that is the escape
  hatch if `restore` is ever lost.

Live-validated 2026-09-12: suspend → 0/8 present in launchd after 8 s and
process table clean; restore → 7/7 back, `status` exit 0, no leftover records.

## 8. Beyond launchd: Login Items, BTM store, app-bundle helpers (same day)

### 8.1 Classic Login Items (System Events)

Only two: **Macs Fan Control**, **Turbo Boost Switcher**. Both utilities,
both expected.

### 8.2 Background Task Management store (`sfltool dumpbtm`, 69 records)

BTM tracks more than launchd plists — these did not appear in the plist
audit. Notable records and dispositions (`[enabled/disabled, allowed/
disallowed, …]`):

| Record | Identifier | Disposition | Meaning |
|---|---|---|---|
| Daisy Cluster | `com.daisy.cluster.app` | enabled, **allowed** | the app's login autostart, user-approved |
| Ollama (login item) | `com.electron.ollama` | **disabled** | user turned Ollama autostart off (cluster.sh starts it itself) |
| Squirrel (Ollama updater) | `com.ollama.ollama` | enabled, **disallowed** | BTM blocks it — resolves the audit's "ollama ghost" |
| Docker login item | `Docker` | **disabled** | off |
| Docker helper | `com.docker.vmnetd` | enabled, **disallowed** | BTM blocks the privileged helper |
| licenseDaemon | `com.paceap.eden.licensed` | enabled, **disallowed** | PACE daemon blocked by BTM (triple-dead: not loaded + blocked + orphaned plist) |
| Software Activation | `com.paceap.eden.licensed.agent` | enabled, **disallowed** | PACE agent blocked by BTM |
| iLok License Manager | `com.paceap.eden.iLokLicenseManager` | **disabled** | off |
| SpyHunter opener | (EnigmaSoft) | enabled, **disallowed** | BTM blocks it |
| Sideloadly daemon | `io.sideloadly.daemon` | enabled, **disallowed** | BTM blocks it (explains last-exit 78) |
| VirtualBox | (daemon + item) | daemon **disallowed**, item disabled | both inert |
| Stars updater | `com.starstechnologies.updaterhelper` | enabled, **disallowed** | BTM blocks it |

**Blocked-by-BTM list (disk plists that macOS refuses to run):** Ollama's
Squirrel updater, `com.docker.vmnetd`, both PACE items, SpyHunter, Sideloadly,
VirtualBox, `com.starstechnologies.updaterhelper`. These cannot resurrect
regardless of their plist contents.

### 8.3 App-bundle helper agents (SMAppService vector)

Exactly one across /Applications: `Ollama.app/Contents/Library/LaunchAgents/
com.ollama.ollama.plist` — the Squirrel auto-updater (RunAtLoad, no
KeepAlive). Registered in BTM but **disallowed** (above), so it does not run.
No PrivilegedHelperTools, no loginhelper plists.

### 8.4 Net autostart picture after the deeper audit

Every auto-start vector on the machine is now accounted for: 7 launchd
resurrecting agents (§1), 4 plain login autostarts (§2), 4 scheduled (§3),
2 classic Login Items (§8.1), 1 BTM-allowed app login item (Daisy Cluster,
§8.2) — and a pile of blocked/disabled leftovers that cannot run. Nothing
auto-starts from vectors outside this list.
