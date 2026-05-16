use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::Manager;

use crate::app_paths;
use crate::torrent_stream::{directory_size_bytes, TorrentStreamState};

const DEFER_WRITES_MB: u32 = 32;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NerdDiagnostics {
    pub resident_memory_bytes: Option<u64>,
    pub app_data_path: String,
    pub stream_cache_bytes: u64,
    pub cover_torrent_cache_bytes: u64,
    pub total_app_data_bytes: u64,
    pub stream_cache_limit_bytes: u64,
    pub stream_cache_ttl_secs: u64,
    pub defer_writes_mb: u32,
    pub streaming_torrent_count: u32,
    pub stream_cache_dir_label: String,
    pub cover_cache_dir_label: String,
}

/// Returns RSS, disk cache sizes, and fixed policy values for the advanced settings UI.
#[tauri::command]
pub async fn get_nerd_diagnostics(
    app: tauri::AppHandle,
    state: tauri::State<'_, TorrentStreamState>,
) -> Result<NerdDiagnostics, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Не удалось получить app_data_dir: {e}"))?;

    let app_data_path = app_data_dir.to_string_lossy().into_owned();

    let stream_dir = app_paths::bt_torrent_dir(&app)
        .map_err(|e| format!("bt_torrent_dir: {e}"))?;
    let cover_dir = app_paths::bt_covers_dir(&app)
        .map_err(|e| format!("bt_covers_dir: {e}"))?;

    let stream_cache_dir_label = stream_dir
        .strip_prefix(&app_data_dir)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| stream_dir.display().to_string());
    let cover_cache_dir_label = cover_dir
        .strip_prefix(&app_data_dir)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| cover_dir.display().to_string());

    let stream_cache_bytes = directory_size_bytes(&stream_dir);
    let cover_torrent_cache_bytes = directory_size_bytes(&cover_dir);
    let total_app_data_bytes = directory_size_bytes(&app_data_dir);

    let resident_memory_bytes = current_process_resident_memory();

    let streaming_torrent_count = state.streaming_torrent_count().await;

    let (limit_bytes, ttl_secs) = state.stream_cache_policy_limits().await;

    Ok(NerdDiagnostics {
        resident_memory_bytes,
        app_data_path,
        stream_cache_bytes,
        cover_torrent_cache_bytes,
        total_app_data_bytes,
        stream_cache_limit_bytes: limit_bytes,
        stream_cache_ttl_secs: ttl_secs,
        defer_writes_mb: DEFER_WRITES_MB,
        streaming_torrent_count,
        stream_cache_dir_label,
        cover_cache_dir_label,
    })
}

fn current_process_resident_memory() -> Option<u64> {
    let pid = Pid::from_u32(std::process::id());
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        false,
        ProcessRefreshKind::new().with_memory(),
    );
    sys.process(pid).map(|p| p.memory())
}
