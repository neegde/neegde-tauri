pub mod export;
pub mod debug_api;
mod debug_log;
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

pub(super) const PREBUFFER_BYTES: usize = 512 * 1024;
pub(super) const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
pub(super) const COPY_CHUNK_BYTES: usize = 64 * 1024;

pub use state::TorrentStreamState;
use serde_json::json;
use types::StreamReady;

#[tauri::command]
pub async fn torrent_prepare_stream(
    state: tauri::State<'_, TorrentStreamState>,
    magnet: String,
    file_idx: usize,
) -> Result<StreamReady, String> {
    state.inner.debug_log.push(
        "ipc",
        "torrent_prepare_stream enter",
        Some(json!({
            "fileIdx": file_idx,
            "magnetLen": magnet.len(),
            "magnet": &magnet,
        })),
    );
    let result = state.prepare(magnet.clone(), file_idx).await;
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
pub async fn torrent_prepare_cancel(
    state: tauri::State<'_, TorrentStreamState>,
) -> Result<(), String> {
    state.prepare_cancel_trigger();
    Ok(())
}
