mod rutracker;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // RutrackerState needs the AppHandle to locate the app data dir.
            app.manage(rutracker::RutrackerState::new(app.handle()));
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
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Send SIGTERM to the entire process group so that the Tauri CLI
                // watcher and the Vite dev server (port 5173) also exit cleanly.
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(libc::getpgrp()), libc::SIGTERM);
                }
                std::process::exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
