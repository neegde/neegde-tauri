mod cover_art;
mod rutracker;
mod torrent_image;
mod torrent_stream;

use tauri::{Manager, RunEvent};

/// librqbit opens every file in a torrent on disk at once; large discographies exceed the default
/// macOS soft `RLIMIT_NOFILE` (~256) → "Too many open files (os error 24)".
fn raise_nofile_limit() {
    #[cfg(unix)]
    {
        match rlimit::increase_nofile_limit(65_536) {
            Ok(n) => {
                #[cfg(debug_assertions)]
                eprintln!("[neegde] RLIMIT_NOFILE soft limit: {n}");
            }
            Err(e) => eprintln!("[neegde] could not raise RLIMIT_NOFILE: {e}"),
        }
    }
}

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

/// Fetch album cover art via MusicBrainz search + Cover Art Archive.
/// Does not require Rutracker auth — uses the shared reqwest client.
#[tauri::command]
async fn fetch_album_cover(
    state: tauri::State<'_, rutracker::RutrackerState>,
    artist: String,
    album: String,
) -> Result<Option<String>, String> {
    let client = state.client.clone();
    Ok(cover_art::fetch_album_cover(&client, &artist, &album).await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    raise_nofile_limit();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(rutracker::RutrackerState::new(app.handle()));
            app.manage(torrent_stream::TorrentStreamState::new(app.handle().clone()));
            app.manage(torrent_image::TorrentImageState::new(app.handle()));
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
            rutracker::rutracker_pick_mirror,
            torrent_stream::torrent_prepare_stream,
            torrent_stream::torrent_dispose_preview,
            torrent_stream::export::torrent_export_files,
            torrent_stream::export::torrent_export_cancel,
            torrent_image::torrent_fetch_image,
            fetch_album_cover,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            kill_vite_dev_server();
        }
    });
}
