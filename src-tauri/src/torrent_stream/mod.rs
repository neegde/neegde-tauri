pub mod debug_api;
mod debug_log;
pub mod export;
mod http;
mod state;
mod stream_cache;
mod types;

pub use debug_api::apply_app_debug_from_disk;

pub use stream_cache::{directory_size_bytes, purge_session_torrents};

/// Subfolder under app data for the streaming librqbit session (debug vs release).
pub fn torrent_streams_dir_label() -> &'static str {
    if cfg!(debug_assertions) {
        "torrent_streams_dev"
    } else {
        "torrent_streams"
    }
}

/// Minimum (initial) prebuffer target — fast start at any connection speed.
/// 32 KB is enough to unblock Web Audio on most connections; speed is sampled
/// at 25% (8 KB) so adaptive upsizing happens early on fast links.
pub(super) const PREBUFFER_BYTES: usize = 32 * 1024;
/// Maximum prebuffer when connection is fast (>2 MB/s measured during the first read).
pub(super) const PREBUFFER_ADAPTIVE_MAX: usize = 512 * 1024;
/// One `read` on the file stream — if the swarm sends nothing, bail out of this wait quickly.
pub(super) const PREBUFFER_READ_TIMEOUT_SECS: u64 = 8;
/// Hard cap for the whole prebuffer loop (many small reads).
pub(super) const PREBUFFER_MAX_WALL_SECS: u64 = 20;
pub(super) const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
pub(super) const COPY_CHUNK_BYTES: usize = 256 * 1024;

use base64::Engine;
use serde_json::json;
pub use state::TorrentStreamState;
use types::{PrefetchNextResponse, StreamReady};

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

/// Warms the next track while the current one plays: merges `only_files` for the same torrent,
/// or runs a silent `prepare` (no UI progress events) for another magnet.
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

/// Returns the list of files inside a torrent described by a magnet link (metadata via DHT/trackers).
#[tauri::command]
pub async fn torrent_magnet_list_files(
    state: tauri::State<'_, TorrentStreamState>,
    magnet: String,
) -> Result<Vec<crate::rutracker::TorrentFile>, String> {
    state.magnet_resolve_files(magnet).await
}
