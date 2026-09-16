//! Daisy Cluster — Tauri shell (Phase 5, release-hardened)
//! =====================================================
//! Desktop host that:
//!   1. spawns the Node orchestrator (`node backend/index.js --serve`) as a
//!      child process, loading `.env` into its environment so the supervisor
//!      bridge gets `OPENROUTER_API_KEY` without any shell exports,
//!   2. tails `database/telemetry.json` every second and forwards each
//!      snapshot to the webview over the native IPC channel
//!      `telemetry://metrics` (no HTTP, no polling in the UI),
//!   3. kills the backend cleanly when the window closes.
//!
//! Root discovery (release vs dev):
//!   • repo dev:  src-tauri/ sits next to backend/ → CARGO_MANIFEST_DIR/..
//!   • installed: backend/ + skillbase/ + database/ are copied into
//!     DaisyCluster.app/Contents/Resources/appdata/ at bundle/install time.
//! `daisy_find_project_root()` probes for `backend/index.js` in both.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::Manager;

struct BackendHandle(Mutex<Option<Child>>);

/// Resolve the app data root at RUNTIME. Installed .app bundles win over the
/// compile-time dev path — CARGO_MANIFEST_DIR is baked in and exists on the
/// build machine, so it must only be a fallback, never the first probe.
fn daisy_find_project_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // 1. Installed .app: <…>.app/Contents/Resources/appdata/.
    if let Some(bundled) = exe
        .ancestors()
        .find(|p| p.join("Resources/appdata/backend/index.js").exists())
        .map(|p| p.join("Resources/appdata"))
    {
        return Some(bundled);
    }
    // 2. Dev tree (cargo dev / cargo run): src-tauri/ next to backend/.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent()?.to_path_buf();
    if dev.join("backend/index.js").exists() {
        return Some(dev);
    }
    None
}

/// Runtime root where TELEMETRY DATA lives. In app mode the bundle is
/// read-only, so the backend's data is redirected (DAISY_DATA_DIR) to
/// Application Support — the emit loop and outage watcher must read from
/// there too, never from the bundle. Dev mode reads the dev tree as before.
fn daisy_data_root(root: &PathBuf) -> PathBuf {
    if root.join("Contents").exists() || root.to_string_lossy().contains("Resources/appdata") {
        if let Some(home) = std::env::var_os("HOME") {
            let appdata = PathBuf::from(home).join("Library/Application Support/DaisyCluster");
            return appdata; // backend create_dir_all's database/ on spawn
        }
    }
    root.clone()
}

/// Load KEY=VALUE pairs from `<root>/.env` into the child environment map
/// (existing env entries win — explicit exports take precedence).
fn load_env_file(root: &PathBuf, envs: &mut Vec<(String, String)>) {
    let text = match fs::read_to_string(root.join(".env")) {
        Ok(t) => t,
        Err(_) => return,
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            if !k.is_empty() {
                envs.push((k.to_string(), v.trim().to_string()));
            }
        }
    }
}

fn spawn_backend() -> Option<Child> {
    let root = daisy_find_project_root().expect("daisy: no project root (dev tree or Resources/appdata)");
    let script = root.join("backend").join("index.js");
    if !script.exists() {
        eprintln!("[shell] backend/index.js not found at {:?}", script);
        return None;
    }

    let mut envs: Vec<(String, String)> = Vec::new();
    load_env_file(&root, &mut envs);

    // Installed-app mode: the bundle is read-only in /Applications, so the
    // orchestrator's data + sandbox live in Application Support instead.
    if root.join("Contents").exists() || root.to_string_lossy().contains("Resources/appdata") {
        if let Some(home) = std::env::var_os("HOME") {
            let appdata = PathBuf::from(home).join("Library/Application Support/DaisyCluster");
            let data = appdata.join("database");
            let sandbox = appdata.join("sandbox");
            let _ = fs::create_dir_all(&data);
            let _ = fs::create_dir_all(&sandbox);
            envs.push(("DAISY_DATA_DIR".into(), data.to_string_lossy().into_owned()));
            envs.push(("DAISY_SANDBOX_DIR".into(), sandbox.to_string_lossy().into_owned()));
            // Secrets live in a user-editable .env in Application Support,
            // never inside the (read-only, distributable) bundle.
            load_env_file(&appdata, &mut envs);
        }
    }

    // Apple Silicon Homebrew lives in /opt/homebrew — explicit fallback keeps
    // Rust and the shell scripts (portability pass) in agreement.
    for candidate in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "node"] {
        let mut cmd = Command::new(candidate);
        cmd.arg(&script)
            .arg("--serve")
            .current_dir(&root)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // .env fills gaps only — real environment exports always win.
        for (k, v) in &envs {
            if std::env::var(k).is_err() {
                cmd.env(k, v);
            }
        }
        match cmd.spawn() {
            Ok(child) => {
                println!("[shell] backend spawned ({} {})", candidate, child.id());
                return Some(child);
            }
            Err(_) => continue,
        }
    }
    eprintln!("[shell] could not spawn node — is Node on PATH?");
    None
}

/// First-run dependency check: without Node the backend can never spawn and
/// the app would sit silent on a dead dashboard. Best-effort native dialog
/// (never blocks or crashes the shell); the UI additionally renders a banner
/// fed by the `shell://no-node` event emitted from setup.
fn alert_no_node() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let script = format!(
        "display dialog \"{}\" with title \"Daisy Cluster\" buttons {{\"Quit\"}} default button \"Quit\" with icon stop",
        // Backslash FIRST, then quote — reversing the order corrupts the text.
        "Daisy Cluster could not find Node.js.\n\nInstall Node and relaunch (e.g. `brew install node`, or from https://nodejs.org). The orchestrator cannot start without it."
            .replace('\\', "\\\\")
            .replace('"', "\\\""),
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

fn read_telemetry(root: &PathBuf) -> Option<serde_json::Value> {
    let path = root.join("database").join("telemetry.json");
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Best-effort macOS notification for telemetry outages (app-mode twin of the
/// telemetry-server watcher's notifyOutage; DAISY_ALERT=0 silences upstream —
/// the println log line always fires). Must never block or crash the shell.
/// Update lifecycle event names, in the order the shell must emit them:
/// feed check finds a newer version → download+verify completes → staged.
/// The UI's banner logic (App.jsx) depends on this order — `update-ready`
/// supersedes `update-available` — so the battery asserts both the names
/// and their ordering (see suite_shell_artifacts).
const UPDATE_EVENT_AVAILABLE: &str = "shell://update-available";
const UPDATE_EVENT_READY: &str = "shell://update-ready";

/// Banner messages for the two update lifecycle events (pure — unit-checkable).
fn update_available_msg(current: &str, new: &str) -> String {
    format!("Daisy Cluster {current} → {new} — downloading in the background…")
}
fn update_ready_msg(new: &str) -> String {
    format!("Daisy Cluster {new} is ready — relaunch the app to install it.")
}

fn notify_outage(msg: &str, urgent: bool) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let sound = if urgent { " sound name \"Basso\"" } else { "" };
    let script = format!(
        "display notification \"{}\" with title \"Daisy telemetry\"{}",
        msg.replace('"', "\\\""),
        sound
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

fn main() {
    tauri::Builder::default()
        // Single-instance: a second launch focuses the existing window instead
        // of spawning a rival backend. Must be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        // Auto-update: check the release feed on launch (silent when
        // up-to-date). The check itself runs in setup() below; the plugin
        // registration wires the endpoint + embedded pubkey.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(BackendHandle(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // 1. Spawn the orchestrator. If Node is missing entirely, say so
            // loudly (dialog + in-app banner) instead of failing silently.
            let child = spawn_backend();
            if child.is_none() {
                use tauri::Emitter;
                alert_no_node();
                let _ = handle.emit(
                    "shell://no-node",
                    "Node.js not found — the orchestrator cannot start. Install Node (brew install node, or nodejs.org) and relaunch.",
                );
            }
            *app.state::<BackendHandle>().0.lock().unwrap() = child;

            // 1b. Updater: query the release feed on launch. On a newer
            // version, download + verify against the embedded pubkey, stage
            // the update, and tell the user (relaunch applies it). Silent no-op
            // when current, offline, or the feed is unreachable — an update
            // failure must never block the shell from running.
            {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_updater::UpdaterExt;
                    let updater = match handle.updater() {
                        Ok(u) => u,
                        Err(e) => {
                            println!("[shell] updater unavailable: {e}");
                            return;
                        }
                    };
                    match updater.check().await {
                        Ok(Some(update)) => {
                            println!(
                                "[shell] update available: {} → {} — downloading…",
                                update.current_version, update.version
                            );
                            // Tell the UI (and, if the window is closed/hidden,
                            // the user via Notification Center) that an update
                            // was found BEFORE the download completes — a large
                            // download shouldn't appear to come from nowhere.
                            {
                                use tauri::Emitter;
                                let _ = handle.emit(
                                    UPDATE_EVENT_AVAILABLE,
                                    update_available_msg(&update.current_version, &update.version),
                                );
                            }
                            notify_outage(
                                &format!(
                                    "Update {} → {} found — downloading",
                                    update.current_version, update.version
                                ),
                                false,
                            );
                            match update.download_and_install(|_, _| {}, || {}).await {
                                Ok(()) => {
                                    println!("[shell] update staged — takes effect on relaunch");
                                    use tauri::Emitter;
                                    let _ = handle.emit(
                                        UPDATE_EVENT_READY,
                                        update_ready_msg(&update.version),
                                    );
                                }
                                Err(e) => println!("[shell] update install failed: {e}"),
                            }
                        }
                        Ok(None) => println!(
                            "[shell] updater: current (v{}) — no update on feed",
                            handle.package_info().version
                        ),
                        Err(e) => println!("[shell] updater check failed (non-fatal): {e}"),
                    }
                });
            }

            // 2. Telemetry emit loop (native IPC, 1 Hz) + outage watcher.
            // In app mode the shell tails telemetry.json itself — there is no
            // telemetry-server process — so THIS loop is what notices a frozen
            // feed and pings, mirroring backend/telemetry-server.js's watcher
            // (same edges: alert on freeze incl. missing file, one recovery
            // ping with duration, silent on boot-time unknown→healthy,
            // edge-triggered so a sustained outage notifies once).
            thread::spawn(move || {
                let root = daisy_find_project_root();
                // Data lives in Application Support in app mode — reading the
                // bundle's (excluded) database/ meant the watcher alerted on a
                // path that never exists and the UI never got telemetry://metrics.
                let data_root = root.as_ref().map(daisy_data_root);
                let tel_path = data_root
                    .as_ref()
                    .map(|r| r.join("database").join("telemetry.json"));
                let mut announced_emit = false;
                let stale_secs: u64 = std::env::var("DAISY_STALE_NOTIFY_MS")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(|ms| (ms / 1000).max(1))
                    .unwrap_or(10);
                let silenced = std::env::var("DAISY_ALERT").ok().as_deref() == Some("0");
                let mut feed_state: u8 = 0; // 0 unknown · 1 healthy · 2 stale
                let mut stale_since: Option<std::time::Instant> = None;
                loop {
                    if let Some(tp) = &tel_path {
                        let age: Option<Option<u64>> = fs::metadata(tp)
                            .and_then(|m| m.modified())
                            .ok()
                            .map(|m| m.elapsed().ok().map(|d| d.as_secs()));
                        let next = match age {
                            Some(Some(a)) if a < stale_secs => 1u8,
                            _ => 2u8, // missing or frozen
                        };
                        if next != feed_state {
                            if next == 2 {
                                // APP-MODE BOOT RULE: the app starts after
                                // arbitrary gaps, so a stale or missing file at
                                // boot usually means "the app was closed" — not
                                // an outage. Only degradation observed LIVE (a
                                // transition FROM a seen-healthy state) may
                                // alert; boot-time unknown→stale stays silent.
                                if feed_state == 1 {
                                    // Backdate the freeze start by the observed
                                    // age: the freeze actually began ~age ago,
                                    // so the recovery ping reports an honest
                                    // outage length instead of alert→now.
                                    stale_since = Some(
                                        std::time::Instant::now()
                                            .checked_sub(std::time::Duration::from_secs(
                                                age.flatten().unwrap_or(stale_secs),
                                            ))
                                            .unwrap_or_else(std::time::Instant::now),
                                    );
                                    let why = match age {
                                        None => "telemetry file missing".to_string(),
                                        _ => format!(
                                            "orchestrator snapshot frozen {}s",
                                            age.flatten().unwrap_or(stale_secs)
                                        ),
                                    };
                                    println!("[shell] ALERT: {} — orchestrator down?", why);
                                    if !silenced {
                                        notify_outage(
                                            &format!(
                                                "{} — orchestrator down? supervisor should heal within a tick",
                                                why
                                            ),
                                            true,
                                        );
                                    }
                                }
                            } else if feed_state == 2 && stale_since.is_some() {
                                // recovery only from an ACTUAL outage —
                                // stale_since is set exactly when we alert, so a
                                // silent boot-time unknown→stale flip (missing
                                // file) can never produce a bogus "outage lasted
                                // ~0s" when the first snapshot lands.
                                let dur = stale_since
                                    .map(|s| s.elapsed().as_secs())
                                    .unwrap_or(0);
                                println!("[shell] orchestrator back — outage lasted ~{}s", dur);
                                if !silenced {
                                    notify_outage(
                                        &format!("orchestrator back — outage lasted ~{}s", dur),
                                        false,
                                    );
                                }
                                stale_since = None;
                            }
                            feed_state = next;
                        }
                    }
                    if let Some(r) = &data_root {
                        if let Some(snapshot) = read_telemetry(r) {
                            if !announced_emit {
                                // One-time proof line: the emit loop is actually
                                // reading the live data dir (was the silent bug).
                                println!(
                                    "[shell] telemetry emit loop live: {:?}",
                                    r.join("database").join("telemetry.json")
                                );
                                announced_emit = true;
                            }
                            use tauri::Emitter;
                            let _ = handle.emit("telemetry://metrics", snapshot);
                        }
                    }
                    thread::sleep(Duration::from_millis(1000));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 3. Kill the backend when the main window closes.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    // Scope all borrows (handle → state → guard) into a block
                    // that yields an owned child; kill after borrows end.
                    let taken = {
                        let handle = window.app_handle();
                        let state = handle.state::<BackendHandle>();
                        let mut guard = state.0.lock().unwrap();
                        let child = guard.take();
                        drop(guard); // explicit drop order keeps the borrow checker happy
                        child
                    };
                    if let Some(mut child) = taken {
                        let _ = child.kill();
                        println!("[shell] backend killed on window close");
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // WindowEvent::Destroyed does NOT fire on AppleScript quit / Cmd-Q
            // during shutdown / kill of the shell — catch the app-level exit
            // too, or the backend outlives the shell as a duplicate orchestrator.
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<BackendHandle>();
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        println!("[shell] backend killed on app exit");
                    }
                }; // semicolon: drop the lock temporary before `state` (E0597)
            }
        });
}
