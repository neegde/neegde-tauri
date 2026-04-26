mod vozduxan_ffi;
mod vozduxan_stream;
mod cache_commands;
mod cache_settings;
mod cover_art;
mod deezer;
mod discord_presence;
mod nerd_stats;
mod resolver;
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
        let _ = rlimit::increase_nofile_limit(65_536);
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

/// Dev helper: dump raw wire data from RuTracker + SoulSeek for a single
/// query. Writes everything into a fresh subdirectory under the app data
/// dir and returns that path so the user can open it manually to inspect
/// exactly what the backends give us before any parsing. Contents:
///
///   rt_listing_raw.html        — tracker.php?nm=... full HTML response
///   rt_topic_<id>.html         — viewtopic.php post body for the top hit
///   rt_<id>.torrent            — raw .torrent bytes for the top hit
///   slsk_raw_results.json      — SlskFileResult[] from a live peer search
#[tauri::command]
async fn dev_dump_raw_search(
    app: tauri::AppHandle,
    rt_state: tauri::State<'_, rutracker::RutrackerState>,
    slsk_state: tauri::State<'_, soulseek::SoulSeekState>,
    query: String,
    mirror: String,
) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let slug: String = query
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .take(40)
        .collect();
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = base_dir.join("dev_dumps").join(format!("{ts}_{slug}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;

    // ── RuTracker ────────────────────────────────────────────────────────────
    // Prefer the mirror we actually logged into — cookies are host-scoped,
    // so hitting a different mirror returns a guest-view HTML.
    let client = rt_state.http_client()?;
    let base = rutracker::auth_base_for_dev(&rt_state, &mirror);

    // 1) Raw listing HTML
    let listing_url = format!("{}/forum/tracker.php", base);
    let listing = client
        .get(&listing_url)
        .query(&[("nm", query.as_str())])
        .send()
        .await
        .map_err(|e| format!("rt listing: {e}"))?;
    let listing_bytes = listing.bytes().await.map_err(|e| format!("rt listing body: {e}"))?;
    std::fs::write(dir.join("rt_listing_raw.html"), &listing_bytes)
        .map_err(|e| format!("write listing: {e}"))?;

    // 2) Parse listing just enough to pick a top topic id, then fetch its raw page + .torrent.
    let results = rutracker::search::search_music(&client, &base, &query)
        .await
        .unwrap_or_default();
    if let Some(top) = results.first() {
        let topic_url = format!("{}/forum/viewtopic.php?t={}", base, top.id);
        if let Ok(resp) = client.get(&topic_url).send().await {
            if let Ok(bytes) = resp.bytes().await {
                let _ = std::fs::write(dir.join(format!("rt_topic_{}.html", top.id)), &bytes);
            }
        }
        let dl_url = format!("{}/forum/dl.php?t={}", base, top.id);
        if let Ok(resp) = client.get(&dl_url).send().await {
            if let Ok(bytes) = resp.bytes().await {
                let _ = std::fs::write(dir.join(format!("rt_{}.torrent", top.id)), &bytes);
            }
        }
        // Run the same parse pipeline the UI uses — lets us eyeball what was
        // actually extracted (artist / year / genre / tracklist) next to the
        // raw HTML we just saved.
        if let Ok(details) = rutracker::topic::get_torrent_details(&client, &base, &top.id).await {
            let json = serde_json::to_string_pretty(&details)
                .unwrap_or_else(|e| format!("{{\"error\":\"serialize: {e}\"}}"));
            let _ = std::fs::write(dir.join(format!("rt_topic_{}_parsed.json", top.id)), json);
        }
    }

    // ── SoulSeek ─────────────────────────────────────────────────────────────
    // Go through the session directly so we get SlskFileResult[] with ALL
    // fields stamped by the wire parser (slots_free / avg_speed / queue_length
    // / bitrate / duration) — closer to "raw" than what the UI-facing
    // SlskSearchResultRow exposes.
    if let Ok(session) = slsk_state.get_session() {
        let request_id = 1_000_000u64 + ts; // deterministic-ish id, avoids clash with real searches
        let results = session.search(query.clone(), None, request_id).await;
        let json = serde_json::to_string_pretty(&results)
            .unwrap_or_else(|e| format!("{{\"error\":\"serialize: {e}\"}}"));
        let _ = std::fs::write(dir.join("slsk_raw_results.json"), json);
    }

    Ok(dir.to_string_lossy().into_owned())
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

    let mut builder = tauri::Builder::default();
    #[cfg(not(mobile))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }

    let app = builder
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
            app.manage(resolver::ResolverState::new());

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
            rutracker::rutracker_login_via_webview,
            rutracker::rutracker_logout,
            rutracker::rutracker_restore_session,
            rutracker::rutracker_status,
            rutracker::rutracker_search,
            rutracker::rutracker_get_cover,
            rutracker::rutracker_get_torrent_details,
            rutracker::rutracker_topic_has_playable_audio,
            rutracker::rutracker_download_torrent_file_b64,
            rutracker::rutracker_pick_mirror,
            rutracker::rutracker_check_connectivity,
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
            dev_dump_raw_search,
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
            // ── Query intent resolver ──────────────────────────────────────
            resolver::resolve_query,
            deezer::deezer_search,
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
            soulseek::soulseek_clear_saved_credentials,
            soulseek::soulseek_export_file,
            soulseek::soulseek_export_cancel,
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
