use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;
use tauri::State;

use super::debug_log::DebugLine;
use super::state::TorrentStreamState;

const SETTINGS_FILE: &str = "app_debug.json";
const LEGACY_SETTINGS_FILE: &str = "streaming_debug.json";

#[derive(Default, Serialize, Deserialize)]
struct AppDebugFile {
    enabled: bool,
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join(SETTINGS_FILE))
}

fn legacy_settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join(LEGACY_SETTINGS_FILE))
}

fn load_enabled_from_disk(app: &AppHandle) -> bool {
    let Ok(path) = settings_path(app) else {
        return false;
    };
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(f) = serde_json::from_str::<AppDebugFile>(&raw) {
            return f.enabled;
        }
    }
    let Ok(legacy_path) = legacy_settings_path(app) else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(legacy_path) else {
        return false;
    };
    serde_json::from_str::<AppDebugFile>(&raw)
        .map(|f| f.enabled)
        .unwrap_or(false)
}

fn save_enabled_to_disk(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Не удалось создать каталог: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&AppDebugFile { enabled })
        .map_err(|e| format!("Сериализация: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Запись настроек отладки: {e}"))?;
    Ok(())
}

/// Returns whether application debug logging is enabled.
#[tauri::command]
pub async fn get_app_debug_enabled(state: State<'_, TorrentStreamState>) -> Result<bool, String> {
    Ok(state.inner.debug_log.is_enabled())
}

/// Enables or disables application debug logging and persists the choice.
#[tauri::command]
pub async fn set_app_debug_enabled(
    app: AppHandle,
    state: State<'_, TorrentStreamState>,
    enabled: bool,
) -> Result<(), String> {
    state.inner.debug_log.set_enabled(enabled);
    save_enabled_to_disk(&app, enabled)?;
    Ok(())
}

/// Returns all buffered debug lines (oldest first).
#[tauri::command]
pub async fn get_app_debug_log(state: State<'_, TorrentStreamState>) -> Result<Vec<DebugLine>, String> {
    Ok(state.inner.debug_log.snapshot())
}

/// Clears the in-memory buffer (toggle stays as-is).
#[tauri::command]
pub async fn clear_app_debug_log(state: State<'_, TorrentStreamState>) -> Result<(), String> {
    state.inner.debug_log.clear_buffer();
    Ok(())
}

/// Records one line from the frontend (UI instrumentation) when debug mode is on.
#[tauri::command]
pub async fn app_debug_push(
    state: State<'_, TorrentStreamState>,
    category: String,
    message: String,
    detail: Option<serde_json::Value>,
) -> Result<(), String> {
    state.inner.debug_log.push(category, message, detail);
    Ok(())
}

/// Loads `enabled` from disk into the runtime log (called from app setup).
pub fn apply_app_debug_from_disk(app: &AppHandle, state: &TorrentStreamState) {
    let enabled = load_enabled_from_disk(app);
    state.inner.debug_log.set_enabled(enabled);
}
