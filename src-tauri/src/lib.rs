mod rutracker;
mod torrent_stream;

use tauri::{Manager, RunEvent};

/// Vite from `beforeDevCommand` is a sibling of this process under `tauri dev`, not the same
/// process group, so `kill(-pgrp)` never reaches it. Free the dev port when the event loop exits.
fn kill_vite_dev_server() {
    if !cfg!(debug_assertions) {
        return;
    }
    #[cfg(all(unix, not(target_os = "ios")))]
    {
        // TERM first so Vite/npm can exit cleanly; SIGKILL only if the port is still bound.
        let _ = std::process::Command::new("sh")
            .arg("-c")
            .arg(
                "lsof -ti:5173 | xargs kill 2>/dev/null; \
                 sleep 0.4; \
                 lsof -ti:5173 | xargs kill -9 2>/dev/null; \
                 true",
            )
            .status();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            // RutrackerState needs the AppHandle to locate the app data dir.
            app.manage(rutracker::RutrackerState::new(app.handle()));
            app.manage(torrent_stream::TorrentStreamState::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rutracker::rutracker_login,
            rutracker::rutracker_logout,
            rutracker::rutracker_restore_session,
            rutracker::rutracker_status,
            rutracker::rutracker_search,
            rutracker::rutracker_get_cover,
            rutracker::rutracker_get_torrent_details,
            torrent_stream::torrent_prepare_stream,
            torrent_stream::torrent_dispose_preview,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            kill_vite_dev_server();
        }
    });
}
