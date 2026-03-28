pub mod search;
pub mod topic;

use base64::Engine as _;
use encoding_rs::WINDOWS_1251;
use reqwest::{header, Client, ClientBuilder};
use reqwest_cookie_store::{CookieStore, CookieStoreMutex};
use serde::{Deserialize, Serialize};
use std::io::{BufReader, BufWriter};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tokio::sync::Semaphore;

// ── Shared data types ─────────────────────────────────────────────────────────

/// One row from Rutracker search results.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub id: String,
    pub name: String,
    pub category: String,
    pub size: u64,
    pub seeders: u64,
    pub leechers: u64,
    pub added: String, // Raw date string from Rutracker, e.g. "15-Jun-17"
    pub source: String,
}

/// A single file inside a torrent, with path split into components.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TorrentFile {
    /// Path components: ["Torrent Root", "Album", "01 Track.flac"]
    pub path: Vec<String>,
    pub size: u64,
}

/// Full details for a topic: cover image, magnet link, and file list.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TorrentDetails {
    pub id: String,
    pub cover_data_url: Option<String>,
    pub magnet: Option<String>,
    pub files: Vec<TorrentFile>,
}

// ── Session file helpers ──────────────────────────────────────────────────────

/// Minimal profile data stored alongside the cookie jar so we can restore
/// the username and avatar without re-parsing the forum HTML on every startup.
#[derive(Serialize, Deserialize, Default)]
struct SessionMeta {
    username: Option<String>,
    /// base64 data: URL — cached so the WebView never needs Rutracker cookies.
    avatar_data_url: Option<String>,
}

fn load_meta(path: &Option<PathBuf>) -> SessionMeta {
    path.as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_meta(path: &Option<PathBuf>, meta: &SessionMeta) {
    if let Some(p) = path {
        if let Ok(json) = serde_json::to_string(meta) {
            let _ = std::fs::write(p, json);
        }
    }
}

#[allow(deprecated)]
fn load_cookie_store(path: &Option<PathBuf>) -> CookieStore {
    path.as_ref()
        .and_then(|p| std::fs::File::open(p).ok())
        .and_then(|f| CookieStore::load_json(BufReader::new(f)).ok())
        .unwrap_or_else(|| CookieStore::new(None))
}

#[allow(deprecated)]
fn save_cookie_store(path: &Option<PathBuf>, store: &Arc<CookieStoreMutex>) {
    if let Some(p) = path {
        if let Ok(file) = std::fs::File::create(p) {
            let mut writer = BufWriter::new(file);
            if let Ok(locked) = store.lock() {
                let _ = locked.save_json(&mut writer);
            }
        }
    }
}

// ── State ─────────────────────────────────────────────────────────────────────

/// Max concurrent cover HTTP fetches (viewtopic.php + image).
const COVER_CONCURRENCY: usize = 4;

pub struct RutrackerState {
    pub client: Client,
    cookie_store: Arc<CookieStoreMutex>,
    inner: Mutex<RutrackerInner>,
    session_path: Option<PathBuf>,
    meta_path: Option<PathBuf>,
    cover_cache_dir: Option<PathBuf>,
    cover_semaphore: Semaphore,
}

pub struct RutrackerInner {
    pub logged_in: bool,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
}

impl RutrackerState {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let base_dir: Option<PathBuf> = app.path().app_data_dir().ok();
        if let Some(ref d) = base_dir {
            let _ = std::fs::create_dir_all(d);
        }
        let session_path: Option<PathBuf> = base_dir.as_ref().map(|d| d.join("rt_session.json"));
        let meta_path: Option<PathBuf> = base_dir.as_ref().map(|d| d.join("rt_meta.json"));
        let cover_cache_dir: Option<PathBuf> = base_dir.as_ref().map(|d| {
            let p = d.join("rt_cover_cache");
            let _ = std::fs::create_dir_all(&p);
            p
        });

        let saved = load_cookie_store(&session_path);
        let cookie_store = Arc::new(CookieStoreMutex::new(saved));

        let client = ClientBuilder::new()
            .cookie_provider(Arc::clone(&cookie_store))
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
                 AppleWebKit/537.36 (KHTML, like Gecko) \
                 Chrome/124.0.0.0 Safari/537.36",
            )
            .build()
            .expect("reqwest client init failed");

        Self {
            client,
            cookie_store,
            inner: Mutex::new(RutrackerInner {
                logged_in: false,
                username: None,
                avatar_url: None,
            }),
            session_path,
            meta_path,
            cover_cache_dir,
            cover_semaphore: Semaphore::new(COVER_CONCURRENCY),
        }
    }

    fn read_disk_cover(&self, topic_id: &str) -> Option<String> {
        let dir = self.cover_cache_dir.as_ref()?;
        std::fs::read_to_string(dir.join(topic_id)).ok()
    }

    fn write_disk_cover(&self, topic_id: &str, data_url: &str) {
        if let Some(ref dir) = self.cover_cache_dir {
            let _ = std::fs::write(dir.join(topic_id), data_url);
        }
    }

    fn persist(&self, meta: &SessionMeta) {
        save_cookie_store(&self.session_path, &self.cookie_store);
        save_meta(&self.meta_path, meta);
    }

    fn wipe(&self) {
        if let Some(p) = &self.session_path {
            let _ = std::fs::remove_file(p);
        }
        if let Some(p) = &self.meta_path {
            let _ = std::fs::remove_file(p);
        }
    }
}

// ── Encoding helper ───────────────────────────────────────────────────────────

fn urlencode_cp1251(s: &str) -> String {
    let (cow, _, _) = WINDOWS_1251.encode(s);
    cow.iter()
        .map(|&b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "+".to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

// ── Profile helpers ───────────────────────────────────────────────────────────

/// Extract user ID from any rutracker page HTML.
/// Handles both &u= and &amp;u= (HTML entity encoding in href attributes).
fn extract_user_id(html: &str) -> Option<String> {
    for marker in &["viewprofile&u=", "viewprofile&amp;u="] {
        if let Some(pos) = html.find(marker) {
            let after = &html[pos + marker.len()..];
            let end = after
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(after.len());
            let uid = &after[..end];
            if !uid.is_empty() {
                return Some(uid.to_string());
            }
        }
    }
    None
}

/// Extract avatar src from a profile page HTML.
/// Rutracker uses <img id="avatar-img" src="..."> on profile pages.
fn extract_avatar_from_profile(html: &str, base: &str) -> Option<String> {
    // Look for id="avatar-img" or id='avatar-img'
    for id_marker in &[r#"id="avatar-img""#, r#"id='avatar-img'"#] {
        if let Some(id_pos) = html.find(id_marker) {
            // Search backwards for the opening <img tag
            let tag_start = html[..id_pos].rfind('<')?;
            let raw_end = (id_pos
                + id_marker.len()
                + 200.min(html.len().saturating_sub(id_pos + id_marker.len())))
            .min(html.len());
            let tag_end = html.floor_char_boundary(raw_end);
            let tag = &html[tag_start..tag_end];

            // Extract src from within the tag
            for src_marker in &[r#"src=""#, r#"src='"#] {
                if let Some(src_pos) = tag.find(src_marker) {
                    let quote = src_marker.chars().last().unwrap();
                    let after = &tag[src_pos + src_marker.len()..];
                    if let Some(end) = after.find(quote) {
                        let raw = &after[..end];
                        if !raw.is_empty() {
                            return Some(resolve_url(raw, base));
                        }
                    }
                }
            }
        }
    }
    None
}

fn resolve_url(raw: &str, base: &str) -> String {
    if raw.starts_with("http") {
        raw.to_string()
    } else if raw.starts_with("//") {
        format!("https:{}", raw)
    } else {
        format!("{}{}", base, raw)
    }
}

/// Fetch avatar: find user ID in post-login HTML, load profile page, extract avatar.
async fn fetch_avatar(client: &Client, post_login_html: &str, base: &str) -> Option<String> {
    let uid = extract_user_id(post_login_html)?;
    let profile_url = format!("{}/forum/profile.php?mode=viewprofile&u={}", base, uid);

    let resp = client.get(&profile_url).send().await.ok()?;
    let bytes = resp.bytes().await.ok()?;
    let (html, _, _) = WINDOWS_1251.decode(&bytes);

    let avatar_url = extract_avatar_from_profile(&html, base)?;
    fetch_avatar_data_url(client, &avatar_url).await
}

/// Fetch the avatar image through the authenticated Rust client and encode it
/// as a base64 data: URL so the WebView can display it without session cookies.
async fn fetch_avatar_data_url(client: &Client, url: &str) -> Option<String> {
    let resp = client.get(url).send().await.ok()?;
    let mime = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, b64))
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LoginResult {
    pub success: bool,
    pub error: Option<String>,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Serialize)]
pub struct LoginStatus {
    pub logged_in: bool,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
}

#[tauri::command]
pub async fn rutracker_login(
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
    username: String,
    password: String,
) -> Result<LoginResult, String> {
    let client = state.client.clone();
    let base = mirror.trim_end_matches('/').to_string();
    let login_url = format!("{}/forum/login.php", base);

    // Step 1: Visit login page so phpBB sets its initial session cookie.
    client
        .get(&login_url)
        .send()
        .await
        .map_err(|e| format!("Нет соединения с {}: {}", base, e))?;

    // Step 2: POST credentials (CP1251 form-encoded).
    let body = format!(
        "redirect_to=&login_username={}&login_password={}&login=%C2%F5%EE%E4",
        urlencode_cp1251(&username),
        urlencode_cp1251(&password),
    );

    let resp = client
        .post(&login_url)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::REFERER, &login_url)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Сетевая ошибка при входе: {}", e))?;

    let final_url = resp.url().to_string();
    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let (decoded, _, _) = WINDOWS_1251.decode(&bytes);

    let redirected_away = !final_url.contains("/login.php");
    let body_says_logged_in = decoded.contains("logout.php") || decoded.contains("profile.php");

    if redirected_away || body_says_logged_in {
        // Fetch avatar through the authenticated client → base64 data: URL
        let avatar_data_url = fetch_avatar(&client, &decoded, &base).await;

        // Persist both the cookie jar and the meta
        state.persist(&SessionMeta {
            username: Some(username.clone()),
            avatar_data_url: avatar_data_url.clone(),
        });

        let mut inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
        inner.logged_in = true;
        inner.username = Some(username.clone());
        inner.avatar_url = avatar_data_url.clone();

        return Ok(LoginResult {
            success: true,
            error: None,
            username: Some(username),
            avatar_url: avatar_data_url,
        });
    }

    let error = if decoded.contains("неверный")
        || decoded.contains("Неверный")
        || decoded.contains("пароль")
        || decoded.contains("password")
        || decoded.contains("invalid")
        || decoded.contains("Invalid")
    {
        "Неверный логин или пароль".to_string()
    } else if decoded.contains("апч") || decoded.contains("captcha") || decoded.contains("CAPTCHA")
    {
        "Требуется CAPTCHA — попробуйте войти через браузер".to_string()
    } else if decoded.contains("бан") || decoded.contains("заблокирован") {
        "Аккаунт заблокирован".to_string()
    } else {
        format!("Ошибка входа (HTTP {})", status.as_u16())
    };

    Ok(LoginResult {
        success: false,
        error: Some(error),
        username: None,
        avatar_url: None,
    })
}

#[tauri::command]
pub async fn rutracker_logout(state: tauri::State<'_, RutrackerState>) -> Result<(), String> {
    state.wipe();
    let mut inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
    inner.logged_in = false;
    inner.username = None;
    inner.avatar_url = None;
    Ok(())
}

/// Validate saved cookies with a live HTTP request.
/// Called on app startup — restores logged-in state transparently if the
/// session is still alive, or clears stale files if it has expired.
#[tauri::command]
pub async fn rutracker_restore_session(
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
) -> Result<LoginStatus, String> {
    // Fast-path: no cookies stored at all
    {
        let store = state
            .cookie_store
            .lock()
            .map_err(|_| "lock error".to_string())?;
        if store.iter_any().count() == 0 {
            return Ok(LoginStatus {
                logged_in: false,
                username: None,
                avatar_url: None,
            });
        }
    }

    let client = state.client.clone();
    let base = mirror.trim_end_matches('/').to_string();

    // Light healthcheck: try loading the forum index
    let resp = client
        .get(format!("{}/forum/index.php", base))
        .send()
        .await
        .map_err(|e| format!("Сетевая ошибка: {}", e))?;

    if resp.url().to_string().contains("/login.php") {
        // Session expired — wipe files
        state.wipe();
        return Ok(LoginStatus {
            logged_in: false,
            username: None,
            avatar_url: None,
        });
    }

    // Session is valid — restore from saved meta (no extra network requests)
    let meta = load_meta(&state.meta_path);

    let mut inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
    inner.logged_in = true;
    inner.username = meta.username.clone();
    inner.avatar_url = meta.avatar_data_url.clone();

    Ok(LoginStatus {
        logged_in: true,
        username: meta.username,
        avatar_url: meta.avatar_data_url,
    })
}

#[tauri::command]
pub fn rutracker_status(state: tauri::State<'_, RutrackerState>) -> Result<LoginStatus, String> {
    let inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
    Ok(LoginStatus {
        logged_in: inner.logged_in,
        username: inner.username.clone(),
        avatar_url: inner.avatar_url.clone(),
    })
}

/// Try each candidate URL in order; return the first mirror whose `/forum/index.php` responds
/// with a successful or redirect status (site reachable).
#[tauri::command]
pub async fn rutracker_pick_mirror(
    state: tauri::State<'_, RutrackerState>,
    candidates: Vec<String>,
) -> Result<String, String> {
    if candidates.is_empty() {
        return Err("Список зеркал пуст".into());
    }

    let client = state.client.clone();
    let mut last_err = String::new();

    for raw in candidates {
        let base = raw.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            continue;
        }
        let url = format!("{}/forum/index.php", base);
        match client
            .get(&url)
            .timeout(Duration::from_secs(12))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() || status.is_redirection() {
                    return Ok(base);
                }
                last_err = format!("HTTP {}", status.as_u16());
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
    }

    Err(if last_err.is_empty() {
        "Не удалось подключиться ни к одному зеркалу".into()
    } else {
        format!("Не удалось подключиться ни к одному зеркалу ({})", last_err)
    })
}

/// Search Rutracker music sections by query string.
/// Requires an active authenticated session.
#[tauri::command]
pub async fn rutracker_search(
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    {
        let inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
        if !inner.logged_in {
            return Err("Необходимо войти в Rutracker".into());
        }
    }
    let base = mirror.trim_end_matches('/').to_string();
    search::search_music(&state.client, &base, &query).await
}

/// First-post cover as a base64 data URL (lightweight — no .torrent download).
#[tauri::command]
pub async fn rutracker_get_cover(
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
    topic_id: String,
) -> Result<Option<String>, String> {
    {
        let inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
        if !inner.logged_in {
            return Err("Необходимо войти в Rutracker".into());
        }
    }

    // Fast path: disk cache (survives restarts, no network needed).
    if let Some(cached) = state.read_disk_cover(&topic_id) {
        return Ok(Some(cached));
    }

    // Limit concurrent fetches to avoid hammering Rutracker.
    let _permit = state.cover_semaphore.acquire().await.map_err(|e| format!("{e}"))?;

    // Check again: another task might have populated the disk cache while we waited.
    if let Some(cached) = state.read_disk_cover(&topic_id) {
        return Ok(Some(cached));
    }

    let base = mirror.trim_end_matches('/').to_string();
    let result = topic::get_cover_data_url(&state.client, &base, &topic_id).await?;

    if let Some(ref data_url) = result {
        state.write_disk_cover(&topic_id, data_url);
    }

    Ok(result)
}

/// Fetch full torrent details for a topic: file list from the .torrent file
/// and cover image from the first post, returned as a base64 data URL.
#[tauri::command]
pub async fn rutracker_get_torrent_details(
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
    topic_id: String,
) -> Result<TorrentDetails, String> {
    {
        let inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
        if !inner.logged_in {
            return Err("Необходимо войти в Rutracker".into());
        }
    }
    let base = mirror.trim_end_matches('/').to_string();
    let details = topic::get_torrent_details(&state.client, &base, &topic_id).await?;
    // Persist cover to disk so grid loads are instant on next visit.
    if let Some(ref data_url) = details.cover_data_url {
        state.write_disk_cover(&details.id, data_url);
    }
    Ok(details)
}

/// Download `.torrent` for a topic (for streaming without magnet metadata resolution).
#[tauri::command]
pub async fn rutracker_download_torrent_file_b64(
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
    topic_id: String,
) -> Result<String, String> {
    {
        let inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
        if !inner.logged_in {
            return Err("Необходимо войти в Rutracker".into());
        }
    }
    let base = mirror.trim_end_matches('/').to_string();
    let raw = topic::download_torrent_file_bytes(&state.client, &base, &topic_id).await?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &raw,
    ))
}
