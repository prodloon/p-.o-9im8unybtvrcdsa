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

    // Prefer the exact node the user has; fall back to PATH lookup.
    for candidate in ["/usr/local/bin/node", "node"] {
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

fn read_telemetry(root: &PathBuf) -> Option<serde_json::Value> {
    let path = root.join("database").join("telemetry.json");
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
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
        .manage(BackendHandle(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // 1. Spawn the orchestrator.
            let child = spawn_backend();
            *app.state::<BackendHandle>().0.lock().unwrap() = child;

            // 2. Telemetry emit loop (native IPC, 1 Hz).
            thread::spawn(move || {
                let root = daisy_find_project_root();
                loop {
                    if let Some(r) = &root {
                        if let Some(snapshot) = read_telemetry(r) {
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
