mod vozduxan_ffi;
mod vozduxan_stream;
mod cache_commands;
mod cache_settings;
mod cover_art;
mod discord_presence;
mod nerd_stats;
mod rutracker;
mod soulseek;
mod torrent_image;
mod torrent_stream;

use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Listener, Manager, RunEvent,
};

/// In-process LRU cache for MusicBrainz + Cover Art Archive results.
/// Avoids repeat HTTP round-trips for the same artist/album.
type CoverArtCache = Mutex<LruCache<String, Option<String>>>;

use vozduxan_stream::VozduxanStreamState;
use torrent_stream::{apply_app_debug_from_disk, TorrentStreamState};

use discord_presence::DiscordPresenceState;

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
/// Results are cached in a 200-entry LRU (including None for negative caching).
#[tauri::command]
async fn fetch_album_cover(
    state: tauri::State<'_, rutracker::RutrackerState>,
    cache: tauri::State<'_, CoverArtCache>,
    ts: tauri::State<'_, torrent_stream::TorrentStreamState>,
    artist: String,
    album: String,
) -> Result<Option<String>, String> {
    let key = format!(
        "{}|{}",
        artist.trim().to_lowercase(),
        album.trim().to_lowercase()
    );

    // Fast path: cache hit (includes negative entries)
    {
        let mut c = cache.lock().unwrap();
        if let Some(cached) = c.get(&key) {
            ts.debug_log().push(
                "cover",
                format!("musicbrainz cover: cache hit — artist={artist:?} album={album:?} found={}", cached.is_some()),
                None,
            );
            return Ok(cached.clone());
        }
    }

    ts.debug_log().push(
        "cover",
        format!("musicbrainz cover: fetching — artist={artist:?} album={album:?}"),
        None,
    );

    let client = state.http_client()?;
    let result = cover_art::fetch_album_cover(&client, &artist, &album).await;

    ts.debug_log().push(
        "cover",
        format!(
            "musicbrainz cover: {} — artist={artist:?} album={album:?}",
            if result.is_some() { "OK" } else { "not found (no MusicBrainz match or CoverArtArchive returned nothing)" },
        ),
        None,
    );

    cache.lock().unwrap().put(key, result.clone());
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    raise_nofile_limit();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .setup(|app| {
            app.manage(rutracker::RutrackerState::new(app.handle()));
            app.manage(soulseek::SoulSeekState::new());
            app.manage(Mutex::new(LruCache::<String, Option<String>>::new(
                NonZeroUsize::new(200).unwrap(),
            )));
            // TorrentStreamState owns the shared debug log; VozduxanStreamState borrows it.
            let ts = torrent_stream::TorrentStreamState::new(app.handle().clone());
            // Sync: frontend must see correct `get_app_debug_enabled` on first invoke (spawn was too late).
            apply_app_debug_from_disk(app.handle(), &ts);
            let vozduxan_debug = ts.debug_log();
            let image_debug = ts.debug_log();
            app.manage(VozduxanStreamState::new(app.handle(), vozduxan_debug));
            app.manage(ts);

            // Cancel export while `torrent_export_files` is awaiting — a second `invoke` can be
            // queued behind the long command; `emit` + this listener sets the flag immediately.
            let export_cancel_app = app.handle().clone();
            let export_cancel_for_listener = export_cancel_app.clone();
            export_cancel_app.listen_any("torrent-export-cancel-request", move |_event| {
                if let Some(ts) = export_cancel_for_listener.try_state::<TorrentStreamState>() {
                    ts.export_cancel_trigger();
                }
            });

            app.manage(torrent_image::TorrentImageState::new(app.handle(), image_debug));
            app.manage(DiscordPresenceState::new());

            // System tray
            let open_item = MenuItem::with_id(app, "open", "Открыть нигде", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &separator, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .tooltip("нигде")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            let startup = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(ts) = startup.try_state::<TorrentStreamState>() {
                    let _ = ts.load_cache_settings_from_disk().await;
                    ts.reclaim_stream_cache_best_effort().await;
                }
            });
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
            rutracker::rutracker_download_torrent_file_b64,
            rutracker::rutracker_pick_mirror,
            rutracker::rutracker_get_http_proxy,
            rutracker::rutracker_set_http_proxy,
            rutracker::rutracker_probe_http_proxy,
            // ── Streaming: now backed by vozduxan (C++ + libtorrent) ──
            vozduxan_stream::torrent_prepare_stream,
            vozduxan_stream::torrent_magnet_list_files,
            vozduxan_stream::torrent_prefetch_next_track,
            vozduxan_stream::torrent_prepare_cancel,
            vozduxan_stream::torrent_dispose_preview,
            vozduxan_stream::torrent_release_stream,
            vozduxan_stream::vozduxan_notify_position,
            vozduxan_stream::vozduxan_stream_stats,
            // ── Export: full-download to user library (librqbit) ─────────
            torrent_stream::export::torrent_export_files,
            torrent_stream::export::torrent_export_cancel,
            torrent_image::torrent_fetch_image,
            fetch_album_cover,
            nerd_stats::get_nerd_diagnostics,
            cache_commands::get_user_cache_settings,
            cache_commands::set_user_cache_settings,
            cache_commands::purge_streaming_cache,
            cache_commands::purge_cover_torrent_cache,
            torrent_stream::debug_api::get_app_debug_enabled,
            torrent_stream::debug_api::set_app_debug_enabled,
            torrent_stream::debug_api::get_app_debug_log,
            torrent_stream::debug_api::clear_app_debug_log,
            torrent_stream::debug_api::app_debug_push,
            discord_presence::discord_presence_sync,
            discord_presence::discord_presence_clear,
            // ── SoulSeek ───────────────────────────────────────────────────────
            soulseek::soulseek_login,
            soulseek::soulseek_logout,
            soulseek::soulseek_status,
            soulseek::soulseek_search,
            soulseek::soulseek_prepare_stream,
            soulseek::soulseek_cover_preview,
            soulseek::soulseek_release_stream,
            soulseek::soulseek_save_credentials,
            soulseek::soulseek_load_credentials,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(dp) = app_handle.try_state::<DiscordPresenceState>() {
                discord_presence::discord_presence_shutdown(&dp);
            }
            let h = app_handle.clone();
            tauri::async_runtime::block_on(async move {
                if let Some(ts) = h.try_state::<TorrentStreamState>() {
                    ts.purge_torrent_data_on_exit().await;
                }
            });
            kill_vite_dev_server();
        }
    });
}
