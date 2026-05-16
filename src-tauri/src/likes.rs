/// Writes the likes JSON snapshot to `{app_data_dir}/likes.json`.
#[tauri::command]
pub async fn likes_write(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = crate::app_paths::likes_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, json)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

/// Returns the absolute path where the likes file is written.
#[tauri::command]
pub async fn likes_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(crate::app_paths::likes_path(&app)?.display().to_string())
}
