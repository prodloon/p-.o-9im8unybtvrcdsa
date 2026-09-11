//! Daisy Cluster — Tauri shell (Phase 5)
//! =====================================
//! Desktop host that:
//!   1. spawns the Node orchestrator (`node backend/index.js --serve`) as a
//!      child process,
//!   2. tails `database/telemetry.json` every second and forwards each
//!      snapshot to the webview over the native IPC channel
//!      `telemetry://metrics` (no HTTP, no polling in the UI),
//!   3. kills the backend cleanly when the window closes.
//!
//! The backend is located relative to the crate dir so this works both from
//! `cargo tauri dev` and from a bundled .app.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::Manager;

struct BackendHandle(Mutex<Option<Child>>);

fn project_root() -> PathBuf {
    // src-tauri/ lives at <root>/src-tauri → root is one level up.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn spawn_backend() -> Option<Child> {
    let root = project_root();
    let script = root.join("backend").join("index.js");
    if !script.exists() {
        eprintln!("[shell] backend/index.js not found at {:?}", script);
        return None;
    }
    // Prefer the exact node the user has; fall back to PATH lookup.
    for candidate in ["/usr/local/bin/node", "node"] {
        let mut cmd = Command::new(candidate);
        cmd.arg("--serve").current_dir(&root).stdout(Stdio::null()).stderr(Stdio::null());
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
        .manage(BackendHandle(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // 1. Spawn the orchestrator.
            let child = spawn_backend();
            *app.state::<BackendHandle>().0.lock().unwrap() = child;

            // 2. Telemetry emit loop (native IPC, 1 Hz).
            thread::spawn(move || {
                let root = project_root();
                loop {
                    if let Some(snapshot) = read_telemetry(&root) {
                        use tauri::Emitter;
                        let _ = handle.emit("telemetry://metrics", snapshot);
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
