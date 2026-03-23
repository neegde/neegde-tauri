mod http;
mod state;
mod types;

pub(super) const PREBUFFER_BYTES: usize = 512 * 1024;
pub(super) const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
pub(super) const COPY_CHUNK_BYTES: usize = 64 * 1024;

pub use state::TorrentStreamState;
use types::StreamReady;

#[tauri::command]
pub async fn torrent_prepare_stream(
    state: tauri::State<'_, TorrentStreamState>,
    magnet: String,
    file_idx: usize,
) -> Result<StreamReady, String> {
    state.prepare(magnet, file_idx).await
}

#[tauri::command]
pub async fn torrent_dispose_preview(
    state: tauri::State<'_, TorrentStreamState>,
) -> Result<(), String> {
    state.dispose().await;
    Ok(())
}
