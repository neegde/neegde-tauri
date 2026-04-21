//! SoulSeek integration: state management and Tauri commands.

mod proto;
mod session;
mod transfer;

use session::{next_token, Session, SlskFileResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
}

impl SoulSeekState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            streams: Mutex::new(HashMap::new()),
        }
    }

    fn get_session(&self) -> Result<Arc<Session>, String> {
        self.session
            .lock()
            .map_err(|_| "lock error".to_string())?
            .clone()
            .ok_or_else(|| "Not connected to SoulSeek".to_string())
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn soulseek_login(
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

    match Session::connect(username.clone(), password, ts.debug_log()).await {
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
        Some(s) => Ok(SlskStatus {
            connected: true,
            username: Some(s.username.clone()),
        }),
        None => Ok(SlskStatus { connected: false, username: None }),
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

fn stable_id(username: &str, filepath: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in username.bytes().chain(filepath.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}
