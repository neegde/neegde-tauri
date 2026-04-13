//! Копирование выбранных файлов из локальной сессии librqbit в папку пользователя.
//! Треки обрабатываются **по одному**: скачали → скопировали → следующий.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use librqbit::api::TorrentIdOrHash;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, Api, Magnet, ManagedTorrent, Session,
    TorrentStatsState,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::TorrentStreamState;

#[derive(Serialize)]
pub struct TorrentExportResult {
    pub copied: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgressPayload {
    pub phase: String,
    pub torrent_state: String,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub pct: f64,
    pub queue_labels: Vec<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_label: Option<String>,
    /// Текущий трек в пачке (1..N), если несколько файлов.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_label: Option<String>,
}

fn emit_progress(app: &AppHandle, p: ExportProgressPayload) {
    let _ = app.emit("torrent-export-progress", &p);
}

fn emit_cancelled(app: &AppHandle, queue_labels: &[String]) {
    emit_progress(
        app,
        ExportProgressPayload {
            phase: "cancelled".into(),
            torrent_state: "paused".into(),
            progress_bytes: 0,
            total_bytes: 0,
            pct: 0.0,
            queue_labels: queue_labels.to_vec(),
            message: "Скачивание остановлено".into(),
            copy_index: None,
            copy_total: None,
            copy_label: None,
            batch_index: None,
            batch_total: None,
            batch_label: None,
        },
    );
}

async fn pause_torrent(session: &Arc<Session>, handle: &Arc<ManagedTorrent>) {
    let _ = session.pause(handle).await;
}

fn unique_dest_path(dest_dir: &Path, base_name: &str) -> PathBuf {
    let dest = dest_dir.join(base_name);
    if !dest.exists() {
        return dest;
    }
    let path = Path::new(base_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for n in 1..10_000u32 {
        let candidate = dest_dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dest_dir.join(format!(
        "{stem}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

/// Polls export-cancel; completes when the user requested stop (for `select!` with init wait).
async fn export_cancel_detected(state: &TorrentStreamState) {
    while !state.export_cancel_triggered() {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Waits for librqbit metadata init or honors user cancel (otherwise stop would queue until init finished).
async fn wait_until_initialized_or_export_cancel(
    handle: &Arc<ManagedTorrent>,
    state: &TorrentStreamState,
) -> Result<(), String> {
    tokio::select! {
        r = handle.wait_until_initialized() => {
            r.map_err(|e| format!("Инициализация торрента: {e}"))
        }
        _ = export_cancel_detected(state) => Err("Скачивание остановлено".into()),
    }
}

fn sanitize_folder_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().chars() {
        let bad = matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        if bad || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let normalized = out.trim().trim_matches('.').trim();
    if normalized.is_empty() {
        "Альбом".to_string()
    } else {
        normalized.to_string()
    }
}

/// Добавить торрент в сессию или взять существующий и оставить только один файл в загрузке.
async fn ensure_torrent_with_single_file(
    session: &Arc<Session>,
    magnet: &str,
    file_idx: usize,
    state: &TorrentStreamState,
) -> Result<Arc<ManagedTorrent>, String> {
    if state.export_cancel_triggered() {
        return Err("Скачивание остановлено".into());
    }

    let m = Magnet::parse(magnet).map_err(|e| format!("Неверный magnet: {e}"))?;
    let info_hash = m.as_id20().ok_or_else(|| "В magnet нет BTIH".to_string())?;
    let id = TorrentIdOrHash::Hash(info_hash);

    if let Some(handle) = session.get(id) {
        if state.export_cancel_triggered() {
            return Err("Скачивание остановлено".into());
        }
        let only = HashSet::from([file_idx]);
        tokio::select! {
            r = session.update_only_files(&handle, &only) => {
                r.map_err(|e| format!("Не удалось обновить список файлов: {e}"))?;
            }
            _ = export_cancel_detected(state) => {
                return Err("Скачивание остановлено".into());
            }
        }
        return Ok(handle);
    }

    if state.export_cancel_triggered() {
        return Err("Скачивание остановлено".into());
    }

    let opts = AddTorrentOptions {
        only_files: Some(vec![file_idx]),
        overwrite: true,
        ..Default::default()
    };
    let added = tokio::select! {
        r = session.add_torrent(AddTorrent::from_url(magnet), Some(opts)) => {
            r.map_err(|e| format!("Не удалось добавить торрент: {e}"))?
        }
        _ = export_cancel_detected(state) => {
            return Err("Скачивание остановлено".into());
        }
    };

    let handle = match added {
        AddTorrentResponse::Added(_, h) => h,
        AddTorrentResponse::AlreadyManaged(_, h) => {
            if state.export_cancel_triggered() {
                return Err("Скачивание остановлено".into());
            }
            let only = HashSet::from([file_idx]);
            tokio::select! {
                r = session.update_only_files(&h, &only) => {
                    r.map_err(|e| format!("Не удалось обновить список файлов: {e}"))?;
                }
                _ = export_cancel_detected(state) => {
                    return Err("Скачивание остановлено".into());
                }
            }
            h
        }
        AddTorrentResponse::ListOnly(_) => {
            return Err("Не удалось открыть торрент (list_only)".into());
        }
    };

    if state.export_cancel_triggered() {
        let _ = session.pause(&handle).await;
        return Err("Скачивание остановлено".into());
    }

    match wait_until_initialized_or_export_cancel(&handle, state).await {
        Ok(()) => Ok(handle),
        Err(e) => {
            if e == "Скачивание остановлено" {
                let _ = session.pause(&handle).await;
            }
            Err(e)
        }
    }
}

async fn wait_until_selected_finished(
    app: &AppHandle,
    session: &Arc<Session>,
    handle: &Arc<ManagedTorrent>,
    ts: &TorrentStreamState,
    queue_labels: &[String],
    batch_index: usize,
    batch_total: usize,
    batch_label: &str,
) -> Result<(), String> {
    const MAX_WAIT: Duration = Duration::from_secs(7200);
    const TICK: Duration = Duration::from_millis(350);
    let started = Instant::now();

    let mut unpaused_once = false;

    loop {
        if ts.export_cancel_triggered() {
            pause_torrent(session, handle).await;
            emit_cancelled(app, queue_labels);
            return Err("Скачивание остановлено".into());
        }

        if started.elapsed() > MAX_WAIT {
            return Err("Превышено время ожидания загрузки (2 ч). Проверьте сидов и сеть.".into());
        }

        let s = handle.stats();

        let pct = if s.total_bytes > 0 {
            (s.progress_bytes.min(s.total_bytes) as f64 / s.total_bytes as f64) * 100.0
        } else {
            0.0
        };

        let msg = match s.state {
            TorrentStatsState::Initializing => "Получение метаданных торрента…",
            TorrentStatsState::Live => "Загрузка через BitTorrent…",
            TorrentStatsState::Paused => "Пауза — возобновляем загрузку…",
            TorrentStatsState::Error => "Ошибка торрента",
        };

        emit_progress(
            app,
            ExportProgressPayload {
                phase: "downloading".into(),
                torrent_state: format!("{}", s.state),
                progress_bytes: s.progress_bytes,
                total_bytes: s.total_bytes,
                pct,
                queue_labels: queue_labels.to_vec(),
                message: format!(
                    "{} — трек {} из {}: {}",
                    msg, batch_index, batch_total, batch_label
                ),
                copy_index: None,
                copy_total: None,
                copy_label: None,
                batch_index: Some(batch_index),
                batch_total: Some(batch_total),
                batch_label: Some(batch_label.to_string()),
            },
        );

        if matches!(s.state, TorrentStatsState::Error) {
            return Err(s
                .error
                .unwrap_or_else(|| "Неизвестная ошибка торрента".into()));
        }

        if s.finished {
            return Ok(());
        }

        if matches!(s.state, TorrentStatsState::Paused) && !unpaused_once {
            session
                .unpause(handle)
                .await
                .map_err(|e| format!("Не удалось возобновить загрузку: {e}"))?;
            unpaused_once = true;
        }

        tokio::time::sleep(TICK).await;
    }
}

#[tauri::command]
pub async fn torrent_export_files(
    app: AppHandle,
    state: State<'_, TorrentStreamState>,
    magnet: String,
    file_indices: Vec<usize>,
    dest_dir: String,
    file_names: Vec<String>,
    album_dir_name: Option<String>,
) -> Result<TorrentExportResult, String> {
    state.export_cancel_reset();

    if magnet.trim().is_empty() {
        return Err("Пустой magnet".into());
    }
    if file_indices.is_empty() {
        return Err("Не выбраны файлы".into());
    }

    let mut dest_root = PathBuf::from(&dest_dir);
    if !dest_root.is_dir() {
        return Err("Указанная папка недоступна".into());
    }
    if let Some(album_dir_name_raw) = album_dir_name {
        if !album_dir_name_raw.trim().is_empty() {
            let folder_name = sanitize_folder_name(&album_dir_name_raw);
            dest_root = dest_root.join(folder_name);
            tokio::fs::create_dir_all(&dest_root)
                .await
                .map_err(|e| format!("Не удалось создать каталог альбома: {e}"))?;
        }
    }

    let queue_labels: Vec<String> = file_indices
        .iter()
        .enumerate()
        .map(|(i, _)| {
            file_names
                .get(i)
                .filter(|s| !s.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("Файл {}", i + 1))
        })
        .collect();

    let batch_total = file_indices.len();
    let session = state.torrent_session().await?;

    let m = Magnet::parse(&magnet).map_err(|e| format!("Неверный magnet: {e}"))?;
    let info_hash = m.as_id20().ok_or_else(|| "В magnet нет BTIH".to_string())?;

    emit_progress(
        &app,
        ExportProgressPayload {
            phase: "preparing".into(),
            torrent_state: "…".into(),
            progress_bytes: 0,
            total_bytes: 0,
            pct: 0.0,
            queue_labels: queue_labels.clone(),
            message: "Подключение к торрент-сессии…".into(),
            copy_index: None,
            copy_total: None,
            copy_label: None,
            batch_index: None,
            batch_total: None,
            batch_label: None,
        },
    );

    if state.export_cancel_triggered() {
        emit_cancelled(&app, &queue_labels);
        return Err("Скачивание остановлено".into());
    }

    state.inner.stream_cache.begin_export(info_hash).await;

    let export_out = async {
        if state.export_cancel_triggered() {
            emit_cancelled(&app, &queue_labels);
            return Err("Скачивание остановлено".into());
        }

        let first_idx = file_indices[0];
        let handle = match ensure_torrent_with_single_file(&session, &magnet, first_idx, &state).await
        {
            Ok(h) => h,
            Err(e) => {
                if e == "Скачивание остановлено" {
                    emit_cancelled(&app, &queue_labels);
                }
                return Err(e);
            }
        };

        let api = Api::new(session.clone(), None);
        let details = api
            .api_torrent_details(TorrentIdOrHash::Hash(info_hash))
            .map_err(|e| format!("Метаданные торрента: {e}"))?;

        let output_folder = PathBuf::from(details.output_folder);
        let file_list = details
            .files
            .ok_or_else(|| "Нет списка файлов в метаданных".to_string())?;

        let mut copied = Vec::new();

        for (ci, &idx) in file_indices.iter().enumerate() {
            if state.export_cancel_triggered() {
                pause_torrent(&session, &handle).await;
                emit_cancelled(&app, &queue_labels);
                return Err("Скачивание остановлено".into());
            }

            let label = queue_labels
                .get(ci)
                .cloned()
                .unwrap_or_else(|| format!("Файл {}", idx + 1));

            if ci > 0 {
                let only = HashSet::from([idx]);
                tokio::select! {
                    r = session.update_only_files(&handle, &only) => {
                        r.map_err(|e| format!("Не удалось переключить файл: {e}"))?;
                    }
                    _ = export_cancel_detected(&*state) => {
                        pause_torrent(&session, &handle).await;
                        emit_cancelled(&app, &queue_labels);
                        return Err("Скачивание остановлено".into());
                    }
                }
            }

            wait_until_selected_finished(
                &app,
                &session,
                &handle,
                &*state,
                &queue_labels,
                ci + 1,
                batch_total,
                &label,
            )
            .await?;

            if state.export_cancel_triggered() {
                pause_torrent(&session, &handle).await;
                emit_cancelled(&app, &queue_labels);
                return Err("Скачивание остановлено".into());
            }

            emit_progress(
                &app,
                ExportProgressPayload {
                    phase: "copying".into(),
                    torrent_state: "live".into(),
                    progress_bytes: 0,
                    total_bytes: 0,
                    pct: 100.0,
                    queue_labels: queue_labels.clone(),
                    message: format!("Сохранение на диск: {label}"),
                    copy_index: Some(ci + 1),
                    copy_total: Some(batch_total),
                    copy_label: Some(label.clone()),
                    batch_index: Some(ci + 1),
                    batch_total: Some(batch_total),
                    batch_label: Some(label.clone()),
                },
            );

            if state.export_cancel_triggered() {
                pause_torrent(&session, &handle).await;
                emit_cancelled(&app, &queue_labels);
                return Err("Скачивание остановлено".into());
            }

            let f = file_list
                .get(idx)
                .ok_or_else(|| format!("Неверный индекс файла: {idx}"))?;

            let mut src = output_folder.clone();
            for c in &f.components {
                src.push(c);
            }

            if !src.is_file() {
                return Err(format!("Файл отсутствует на диске: {}", src.display()));
            }

            let base = Path::new(&f.name)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            let dest = unique_dest_path(&dest_root, base);

            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("Не удалось создать каталог: {e}"))?;
            }

            if state.export_cancel_triggered() {
                pause_torrent(&session, &handle).await;
                emit_cancelled(&app, &queue_labels);
                return Err("Скачивание остановлено".into());
            }

            tokio::fs::copy(&src, &dest)
                .await
                .map_err(|e| format!("Копирование {} → {}: {e}", src.display(), dest.display()))?;

            copied.push(dest.to_string_lossy().into_owned());
        }

        emit_progress(
            &app,
            ExportProgressPayload {
                phase: "done".into(),
                torrent_state: "live".into(),
                progress_bytes: 0,
                total_bytes: 0,
                pct: 100.0,
                queue_labels: queue_labels.clone(),
                message: format!("Готово: {} файл(ов)", copied.len()),
                copy_index: None,
                copy_total: None,
                copy_label: None,
                batch_index: None,
                batch_total: None,
                batch_label: None,
            },
        );

        Ok(TorrentExportResult { copied })
    }
    .await;

    state.inner.stream_cache.end_export().await;
    state.reclaim_stream_cache_best_effort().await;
    export_out
}

#[tauri::command]
pub async fn torrent_export_cancel(state: State<'_, TorrentStreamState>) -> Result<(), String> {
    state.export_cancel_trigger();
    Ok(())
}
