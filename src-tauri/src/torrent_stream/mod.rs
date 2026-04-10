pub mod debug_api;
mod debug_log;
pub mod export;
mod state;
mod stream_cache;
mod types;

pub use debug_api::apply_app_debug_from_disk;
pub use stream_cache::{directory_size_bytes, purge_session_torrents};
pub use state::TorrentStreamState;

/// Subfolder name for the blizorukost streaming cache (used by nerd_stats).
pub fn torrent_streams_dir_label() -> &'static str {
    if cfg!(debug_assertions) {
        "bliz_streams_dev"
    } else {
        "bliz_streams"
    }
}

use base64::Engine;
use serde_json::json;
use types::{PrefetchNextResponse, StreamReady};

// ─────────────────────────────────────────────────────────────────────────
//  Tauri commands
// ─────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn torrent_prepare_stream(
    state: tauri::State<'_, TorrentStreamState>,
    magnet: String,
    file_idx: usize,
    torrent_file_b64: Option<String>,
) -> Result<StreamReady, String> {
    let torrent_file: Option<Vec<u8>> = match torrent_file_b64.as_deref() {
        None | Some("") => None,
        Some(s) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|e| format!("Неверный base64 торрент-файла: {e}"))?,
        ),
    };
    state.inner.debug_log.push(
        "ipc",
        "torrent_prepare_stream enter",
        Some(json!({
            "fileIdx": file_idx,
            "magnetLen": magnet.len(),
            "magnet": &magnet,
            "torrentFileLen": torrent_file.as_ref().map(|b| b.len()),
        })),
    );
    let result = state
        .prepare(magnet.clone(), file_idx, torrent_file, true)
        .await;
    if let Ok(ref ready) = result {
        state.inner.debug_log.push(
            "ipc",
            "torrent_prepare_stream ok",
            Some(json!({
                "fileIdx": file_idx,
                "urlPreview": ready.url.chars().take(120).collect::<String>(),
            })),
        );
    } else if let Err(ref err) = result {
        eprintln!(
            "[torrent_prepare_stream] file_idx={file_idx} magnet_len={} err={err}",
            magnet.len()
        );
    }
    result
}

#[tauri::command]
pub async fn torrent_dispose_preview(
    state: tauri::State<'_, TorrentStreamState>,
) -> Result<(), String> {
    state.dispose().await;
    Ok(())
}

#[tauri::command]
pub async fn torrent_release_stream(
    state: tauri::State<'_, TorrentStreamState>,
    token: String,
) -> Result<(), String> {
    state.release_stream_token(&token).await;
    Ok(())
}

#[tauri::command]
pub async fn torrent_prepare_cancel(
    state: tauri::State<'_, TorrentStreamState>,
) -> Result<(), String> {
    state.prepare_cancel_trigger();
    Ok(())
}

/// Warms the next track while the current one plays.
#[tauri::command]
pub async fn torrent_prefetch_next_track(
    state: tauri::State<'_, TorrentStreamState>,
    current_magnet: String,
    current_file_idx: usize,
    next_magnet: String,
    next_file_idx: usize,
    next_torrent_file_b64: Option<String>,
) -> Result<PrefetchNextResponse, String> {
    let next_torrent_file: Option<Vec<u8>> = match next_torrent_file_b64.as_deref() {
        None | Some("") => None,
        Some(s) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|e| format!("Неверный base64 торрент-файла: {e}"))?,
        ),
    };
    state
        .prefetch_next_track(
            current_magnet,
            current_file_idx,
            next_magnet,
            next_file_idx,
            next_torrent_file,
        )
        .await
}

/// Returns the list of files inside a torrent (metadata resolved via DHT/trackers).
#[tauri::command]
pub async fn torrent_magnet_list_files(
    state: tauri::State<'_, TorrentStreamState>,
    magnet: String,
) -> Result<Vec<crate::rutracker::TorrentFile>, String> {
    state.magnet_resolve_files(magnet).await
}

/// Update playback position so blizorukost can slide the priority window.
/// Call from frontend `<audio> timeupdate` handler.
#[tauri::command]
pub async fn torrent_notify_position(
    state: tauri::State<'_, TorrentStreamState>,
    token: String,
    byte_offset: i64,
) -> Result<(), String> {
    state.notify_position(&token, byte_offset).await;
    Ok(())
}
