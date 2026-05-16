use tauri::Manager;
use std::io;

/// Writes the General List JSON snapshot to `{app_data_dir}/general-list.json`.
#[tauri::command]
pub async fn general_list_write(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create_dir_all {}: {e}", dir.display()))?;
    let path = dir.join("general-list.json");
    std::fs::write(&path, json)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

/// Returns the absolute path where the General List file is written.
#[tauri::command]
pub async fn general_list_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("general-list.json").display().to_string())
}

/// Deletes every file and sub-directory inside `app_data_dir`, leaving the
/// directory itself intact. Called by the factory-reset flow before relaunch.
#[tauri::command]
pub async fn factory_reset(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    if !dir.exists() {
        return Ok(());
    }
    let mut errors: Vec<String> = Vec::new();
    let rd = std::fs::read_dir(&dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => { errors.push(e.to_string()); continue; }
        };
        let path = entry.path();
        let result: io::Result<()> = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(e) = result {
            errors.push(format!("{}: {e}", path.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
