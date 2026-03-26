use tauri::State;

use crate::cache_settings::UserCacheSettings;
use crate::torrent_image::TorrentImageState;
use crate::torrent_stream::TorrentStreamState;

/// Returns persisted cache limits for the settings UI.
#[tauri::command]
pub async fn get_user_cache_settings(
    state: State<'_, TorrentStreamState>,
) -> Result<UserCacheSettings, String> {
    Ok(state.user_cache_settings().await)
}

/// Validates, saves to disk, and applies cache limits for eviction.
#[tauri::command]
pub async fn set_user_cache_settings(
    state: State<'_, TorrentStreamState>,
    settings: UserCacheSettings,
) -> Result<(), String> {
    state.apply_user_cache_settings(settings).await
}

/// Drops active streams, removes all streaming torrents and their files, and resets the folder.
#[tauri::command]
pub async fn purge_streaming_cache(state: State<'_, TorrentStreamState>) -> Result<(), String> {
    state.purge_streaming_cache_disk().await
}

/// Clears the separate librqbit session used for cover art from torrents.
#[tauri::command]
pub async fn purge_cover_torrent_cache(state: State<'_, TorrentImageState>) -> Result<(), String> {
    state.purge_all_data().await
}
