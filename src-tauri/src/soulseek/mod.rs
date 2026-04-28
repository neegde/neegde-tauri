//! SoulSeek integration: state management and Tauri commands.

mod proto;
mod session;
mod transfer;

use session::{next_token, Session, SlskFileResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

// ── Public types (serialised to frontend) ────────────────────────────────────

#[derive(Serialize)]
pub struct SlskLoginResult {
    pub success: bool,
    pub error: Option<String>,
    pub username: Option<String>,
}

#[derive(Serialize)]
pub struct SlskStatus {
    pub connected: bool,
    pub username: Option<String>,
}

/// One search result row — must be compatible with the rutracker SearchResult shape.
#[derive(Serialize, Clone)]
pub struct SlskSearchResultRow {
    // Standard SearchResult fields
    pub id: String,
    pub name: String,
    pub category: String,
    pub size: u64,
    pub seeders: u64,
    pub leechers: u64,
    pub added: String,
    pub source: String,
    // SoulSeek-specific extras (passed through to the queue item)
    pub slsk_username: String,
    pub slsk_filepath: String,
    pub bitrate: Option<u32>,
    pub duration: Option<u32>,
    /// True for image files from search (used for folder cover matching).
    #[serde(default)]
    pub slsk_is_image: bool,
    /// Peer has at least one free upload slot (from FileSearchResponse tail).
    #[serde(default, rename = "slotsFree")]
    pub slots_free: bool,
    /// Peer's advertised average upload speed in bytes/second.
    #[serde(default, rename = "avgSpeed")]
    pub avg_speed: u32,
    /// Current length of the peer's upload queue (0 = free).
    #[serde(default, rename = "queueLength")]
    pub queue_length: u64,
}

#[derive(Serialize)]
pub struct SlskStreamReady {
    pub url: String,
    pub token: String,
}

/// Cover preview for UI: first bytes of an image file from a peer.
#[derive(Serialize)]
pub struct SlskCoverPreview {
    pub mime: String,
    pub base64: String,
}

/// Progress event emitted during `soulseek_export_file` (compatible with DownloadProgressOverlay).
#[derive(Serialize, Clone)]
struct SlskExportProgress {
    phase: String,
    #[serde(rename = "progressBytes")]
    progress_bytes: u64,
    #[serde(rename = "totalBytes")]
    total_bytes: u64,
    pct: u32,
    #[serde(rename = "queueLabels")]
    queue_labels: Vec<String>,
    message: String,
    #[serde(rename = "torrentState")]
    torrent_state: String,
}

/// Incremental search: emitted from the backend as peer batches arrive.
#[derive(Serialize, Clone)]
pub(super) struct SlskSearchBatchEvent {
    #[serde(rename = "requestId")]
    pub request_id: u64,
    pub rows: Vec<SlskSearchResultRow>,
}

// ── State ─────────────────────────────────────────────────────────────────────

struct ActiveStream {
    temp_path: PathBuf,
    download_abort: tokio::task::AbortHandle,
    http_abort: tokio::task::AbortHandle,
}

pub struct SoulSeekState {
    session: Mutex<Option<Arc<Session>>>,
    streams: Mutex<HashMap<String, ActiveStream>>,
    export_cancel: AtomicBool,
}

impl SoulSeekState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            streams: Mutex::new(HashMap::new()),
            export_cancel: AtomicBool::new(false),
        }
    }

    pub(crate) fn get_session(&self) -> Result<Arc<Session>, String> {
        let guard = self.session.lock().map_err(|_| "lock error".to_string())?;
        let Some(s) = guard.as_ref() else {
            return Err("Not connected to SoulSeek".to_string());
        };
        if s.is_dead() {
            // Reader/listener loop already emitted `soulseek-disconnected`; the
            // frontend listener will trigger an auto-reconnect using saved creds.
            return Err("Соединение с SoulSeek потеряно — переподключение…".to_string());
        }
        Ok(Arc::clone(s))
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn soulseek_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, SoulSeekState>,
    ts: tauri::State<'_, crate::torrent_stream::TorrentStreamState>,
    username: String,
    password: String,
) -> Result<SlskLoginResult, String> {
    // If already connected, disconnect first
    {
        let mut guard = state.session.lock().map_err(|_| "lock error".to_string())?;
        *guard = None; // drops Arc, background tasks see Weak upgrade fail and exit
    }

    match Session::connect(app, username.clone(), password, ts.debug_log()).await {
        Ok(sess) => {
            let mut guard = state.session.lock().map_err(|_| "lock error".to_string())?;
            *guard = Some(sess);
            Ok(SlskLoginResult {
                success: true,
                error: None,
                username: Some(username),
            })
        }
        Err(e) => Ok(SlskLoginResult {
            success: false,
            error: Some(e),
            username: None,
        }),
    }
}

#[tauri::command]
pub fn soulseek_logout(state: tauri::State<'_, SoulSeekState>) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|_| "lock error".to_string())?;
    *guard = None;

    // Abort all active streams
    let mut streams = state.streams.lock().map_err(|_| "lock error".to_string())?;
    for (_, s) in streams.drain() {
        s.download_abort.abort();
        s.http_abort.abort();
        let _ = std::fs::remove_file(&s.temp_path);
    }
    Ok(())
}

#[tauri::command]
pub fn soulseek_status(state: tauri::State<'_, SoulSeekState>) -> Result<SlskStatus, String> {
    let guard = state.session.lock().map_err(|_| "lock error".to_string())?;
    match guard.as_ref() {
        // A dead session is logically disconnected — the network plumbing already
        // terminated, only the struct lingers until `soulseek_login` replaces it.
        Some(s) if !s.is_dead() => Ok(SlskStatus {
            connected: true,
            username: Some(s.username.clone()),
        }),
        _ => Ok(SlskStatus { connected: false, username: None }),
    }
}

#[derive(Serialize)]
pub struct SlskConnectivityResult {
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn soulseek_check_connectivity() -> Result<SlskConnectivityResult, String> {
    use std::time::Instant;
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    const HOST: &str = "server.slsknet.org";
    const PORT: u16 = 2242;
    const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

    let start = Instant::now();
    match timeout(PROBE_TIMEOUT, TcpStream::connect((HOST, PORT))).await {
        Ok(Ok(_)) => Ok(SlskConnectivityResult {
            reachable: true,
            latency_ms: Some(start.elapsed().as_millis() as u64),
            error: None,
        }),
        Ok(Err(e)) => Ok(SlskConnectivityResult {
            reachable: false,
            latency_ms: None,
            error: Some(e.to_string()),
        }),
        Err(_) => Ok(SlskConnectivityResult {
            reachable: false,
            latency_ms: None,
            error: Some(format!("Нет ответа от {HOST}:{PORT} (таймаут {}с)", PROBE_TIMEOUT.as_secs())),
        }),
    }
}

#[tauri::command]
pub async fn soulseek_search(
    app: tauri::AppHandle,
    state: tauri::State<'_, SoulSeekState>,
    query: String,
    request_id: u64,
) -> Result<Vec<SlskSearchResultRow>, String> {
    let session = state.get_session()?;

    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let results: Vec<SlskFileResult> = session.search(query, Some(app), request_id).await;
    Ok(file_results_to_rows(results))
}

pub(super) fn file_results_to_rows(results: Vec<SlskFileResult>) -> Vec<SlskSearchResultRow> {
    results
        .into_iter()
        .map(|r| {
            let filename = r
                .filepath
                .rsplit(|c| c == '\\' || c == '/')
                .next()
                .unwrap_or(&r.filepath)
                .to_string();
            let display_name = filename.clone();
            let category = if r.is_image {
                "Image".to_string()
            } else {
                bitrate_category(r.bitrate)
            };
            let id = format!("slsk_{}", stable_id(&r.username, &r.filepath));
            SlskSearchResultRow {
                id,
                name: display_name,
                category,
                size: r.size,
                seeders: 1,
                leechers: 0,
                added: "—".to_string(),
                source: "soulseek".to_string(),
                slsk_username: r.username,
                slsk_filepath: r.filepath,
                bitrate: r.bitrate,
                duration: r.duration,
                slsk_is_image: r.is_image,
                slots_free: r.slots_free,
                avg_speed: r.avg_speed,
                queue_length: r.queue_length,
            }
        })
        .collect()
}

#[tauri::command]
pub async fn soulseek_prepare_stream(
    state: tauri::State<'_, SoulSeekState>,
    username: String,
    filepath: String,
    filesize: u64,
) -> Result<SlskStreamReady, String> {
    let session = state.get_session()?;

    let token = next_token();

    let handle = transfer::download_and_stream(
        Arc::clone(&session),
        username,
        filepath,
        filesize,
        token,
    )
    .await?;

    let token_str = token.to_string();
    {
        let mut streams = state.streams.lock().map_err(|_| "lock error".to_string())?;
        streams.insert(
            token_str.clone(),
            ActiveStream {
                temp_path: handle.temp_path,
                download_abort: handle.download_abort,
                http_abort: handle.http_abort,
            },
        );
    }

    Ok(SlskStreamReady {
        url: handle.url,
        token: token_str,
    })
}

#[tauri::command]
pub fn soulseek_release_stream(
    state: tauri::State<'_, SoulSeekState>,
    token: String,
) -> Result<(), String> {
    let mut streams = state.streams.lock().map_err(|_| "lock error".to_string())?;
    if let Some(s) = streams.remove(&token) {
        s.download_abort.abort();
        s.http_abort.abort();
        let _ = std::fs::remove_file(&s.temp_path);
    }
    Ok(())
}

/// Download at most ~512 KiB of an image file for cover display (does not register a long-lived stream).
///
/// Args:
///     username: SoulSeek username hosting the file.
///     filepath: Full share path to the image (as in search results).
///     filesize: Declared size in bytes (used for the transfer handshake).
///
/// Returns:
///     MIME type and base64 payload suitable for a `data:` URL in the webview.
#[tauri::command]
pub async fn soulseek_cover_preview(
    state: tauri::State<'_, SoulSeekState>,
    username: String,
    filepath: String,
    filesize: u64,
) -> Result<SlskCoverPreview, String> {
    let session = state.get_session()?;
    const MAX: u64 = 512 * 1024;
    let mime = cover_mime_from_path(&filepath);
    let bytes = transfer::download_cover_preview(session, username, filepath, filesize, MAX).await?;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok(SlskCoverPreview {
        mime,
        base64: STANDARD.encode(&bytes),
    })
}

/// Download a SoulSeek file to disk with progress events.
///
/// Emits `slsk-export-progress` events (same shape as torrent export overlay).
/// Returns the path of the saved file on success.
#[tauri::command]
pub async fn soulseek_export_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, SoulSeekState>,
    username: String,
    filepath: String,
    filesize: u64,
    dest_dir: String,
    file_name: String,
) -> Result<String, String> {
    use tauri::Emitter;

    let session = state.get_session()?;
    state.export_cancel.store(false, Ordering::Release);

    let label = file_name.clone();

    let _ = app.emit(
        "slsk-export-progress",
        SlskExportProgress {
            phase: "preparing".to_string(),
            progress_bytes: 0,
            total_bytes: filesize,
            pct: 0,
            queue_labels: vec![label.clone()],
            message: "Подключение к пиру…".to_string(),
            torrent_state: "".to_string(),
        },
    );

    let token = next_token();
    let handle = transfer::download_and_stream(
        Arc::clone(&session),
        username,
        filepath.clone(),
        filesize,
        token,
    )
    .await?;

    let total = handle.total_size;
    let downloaded = Arc::clone(&handle.downloaded);
    let complete = Arc::clone(&handle.complete);

    // Poll until download finishes or user cancels
    loop {
        let dl = downloaded.load(Ordering::Acquire);
        let done = complete.load(Ordering::Acquire);
        let cancelled = state.export_cancel.load(Ordering::Acquire);

        let pct = if total > 0 {
            ((dl as f64 / total as f64) * 100.0) as u32
        } else {
            0
        };
        let _ = app.emit(
            "slsk-export-progress",
            SlskExportProgress {
                phase: "downloading".to_string(),
                progress_bytes: dl,
                total_bytes: total,
                pct,
                queue_labels: vec![label.clone()],
                message: format!("{} / {}", slsk_fmt_bytes(dl), slsk_fmt_bytes(total)),
                torrent_state: "".to_string(),
            },
        );

        if cancelled {
            handle.download_abort.abort();
            handle.http_abort.abort();
            let _ = std::fs::remove_file(&handle.temp_path);
            return Err("Скачивание остановлено".to_string());
        }
        // Peer may not close the F-connection after sending all bytes — treat
        // "received >= declared size" as completion even without EOF.
        if done || (total > 0 && dl >= total) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    handle.http_abort.abort();

    let dl_final = downloaded.load(Ordering::Acquire);
    if total > 0 && dl_final < total * 90 / 100 {
        let _ = std::fs::remove_file(&handle.temp_path);
        return Err(format!(
            "Загрузка прервана пиром: получено {} из {}",
            slsk_fmt_bytes(dl_final),
            slsk_fmt_bytes(total)
        ));
    }

    let _ = app.emit(
        "slsk-export-progress",
        SlskExportProgress {
            phase: "copying".to_string(),
            progress_bytes: dl_final,
            total_bytes: total,
            pct: 100,
            queue_labels: vec![label.clone()],
            message: "Сохранение файла…".to_string(),
            torrent_state: "".to_string(),
        },
    );

    let dest_path = slsk_unique_dest_path(&dest_dir, &file_name);
    let temp = handle.temp_path.clone();
    let dest = dest_path.clone();
    tokio::task::spawn_blocking(move || std::fs::copy(&temp, &dest).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Ошибка сохранения: {e}"))?;

    let _ = std::fs::remove_file(&handle.temp_path);

    let _ = app.emit(
        "slsk-export-progress",
        SlskExportProgress {
            phase: "done".to_string(),
            progress_bytes: dl_final,
            total_bytes: total,
            pct: 100,
            queue_labels: vec![label.clone()],
            message: "Готово".to_string(),
            torrent_state: "".to_string(),
        },
    );

    Ok(dest_path.to_string_lossy().to_string())
}

/// Cancel an in-progress `soulseek_export_file` call.
#[tauri::command]
pub fn soulseek_export_cancel(state: tauri::State<'_, SoulSeekState>) -> Result<(), String> {
    state.export_cancel.store(true, Ordering::Release);
    Ok(())
}

// ── Credential persistence ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct SlskCredentials {
    username: String,
    password: String,
}

#[tauri::command]
pub fn soulseek_save_credentials(
    app: tauri::AppHandle,
    username: String,
    password: String,
) -> Result<(), String> {
    use tauri::Manager;
    let path = app.path().app_data_dir()
        .map_err(|e| e.to_string())?
        .join("slsk_creds.json");
    let json = serde_json::to_string(&SlskCredentials { username, password })
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn soulseek_load_credentials(app: tauri::AppHandle) -> Option<(String, String)> {
    use tauri::Manager;
    let path = app.path().app_data_dir().ok()?.join("slsk_creds.json");
    let data = std::fs::read_to_string(&path).ok()?;
    let creds: SlskCredentials = serde_json::from_str(&data).ok()?;
    Some((creds.username, creds.password))
}

/// Deletes saved SoulSeek credentials (after explicit logout from settings).
#[tauri::command]
pub fn soulseek_clear_saved_credentials(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("slsk_creds.json");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn cover_mime_from_path(filepath: &str) -> String {
    let ext = Path::new(filepath)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    }
    .to_string()
}

fn bitrate_category(bitrate: Option<u32>) -> String {
    match bitrate {
        Some(b) if b >= 320 => format!("MP3 {b} kbps"),
        Some(b) if b >= 128 => format!("MP3 {b} kbps"),
        Some(b) => format!("{b} kbps"),
        None => "SoulSeek".to_string(),
    }
}

fn slsk_fmt_bytes(n: u64) -> String {
    if n < 1024 {
        return format!("{n} Б");
    }
    let units = ["КБ", "МБ", "ГБ"];
    // Start already in КБ (first division done here), then loop into МБ/ГБ as needed.
    let mut v = n as f64 / 1024.0;
    let mut i = 0usize;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if v < 10.0 {
        format!("{:.1} {}", v, units[i])
    } else {
        format!("{} {}", v.round() as u64, units[i])
    }
}

fn slsk_unique_dest_path(dest_dir: &str, file_name: &str) -> PathBuf {
    let base = PathBuf::from(dest_dir);
    let candidate = base.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    for i in 1..=999 {
        let name = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        let p = base.join(&name);
        if !p.exists() {
            return p;
        }
    }
    candidate // fallback, overwrite
}

fn stable_id(username: &str, filepath: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in username.bytes().chain(filepath.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}
