pub mod search;
pub mod topic;

use base64::Engine as _;
use encoding_rs::WINDOWS_1251;
use lru::LruCache;
use reqwest::{header, Client, ClientBuilder, Proxy, Url};
use reqwest_cookie_store::{CookieStore, CookieStoreMutex};
use serde::{Deserialize, Serialize};
use std::io::{BufReader, BufWriter};
use std::num::NonZeroUsize;
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
    /// Artist extracted from the post body (e.g. "Исполнитель: Кровосток"), if found.
    pub artist: Option<String>,
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

fn load_http_proxy_url(path: &Option<PathBuf>) -> Option<String> {
    let p = path.as_ref()?;
    let s = std::fs::read_to_string(p).ok()?;
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn save_http_proxy_url(path: &Option<PathBuf>, url: Option<&str>) -> Result<(), String> {
    let Some(p) = path else {
        return Ok(());
    };
    match url {
        None | Some("") => {
            let _ = std::fs::remove_file(p);
        }
        Some(u) => {
            std::fs::write(p, u).map_err(|e| format!("Не удалось сохранить прокси: {}", e))?;
        }
    }
    Ok(())
}

fn build_reqwest_client(
    cookie_store: Arc<CookieStoreMutex>,
    proxy_url: Option<&str>,
) -> Result<Client, String> {
    let mut builder = ClientBuilder::new()
        .cookie_provider(cookie_store)
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
             AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/124.0.0.0 Safari/537.36",
        );

    if let Some(raw) = proxy_url {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let proxy = Proxy::all(trimmed)
                .map_err(|e| format!("Некорректный прокси: {}", e))?;
            builder = builder.proxy(proxy);
        }
    }

    builder
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("Не удалось инициализировать HTTP-клиент: {}", e))
}

/// Ephemeral client for proxy checks (no session cookies).
fn build_probe_client(proxy_url: Option<&str>) -> Result<Client, String> {
    let mut builder = ClientBuilder::new()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
             AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(Duration::from_secs(15));

    if let Some(raw) = proxy_url {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let proxy = Proxy::all(trimmed)
                .map_err(|e| format!("Некорректный прокси: {}", e))?;
            builder = builder.proxy(proxy);
        }
    }

    builder
        .build()
        .map_err(|e| format!("Не удалось собрать клиент проверки: {}", e))
}

// ── State ─────────────────────────────────────────────────────────────────────

/// Max concurrent cover HTTP fetches (viewtopic.php + image).
const COVER_CONCURRENCY: usize = 4;
/// In-process LRU for recently loaded cover data: URLs (avoids disk I/O on repeated views).
const COVER_MEM_CACHE_CAP: usize = 100;

pub struct RutrackerState {
    client: Mutex<Client>,
    cookie_store: Arc<CookieStoreMutex>,
    inner: Mutex<RutrackerInner>,
    session_path: Option<PathBuf>,
    meta_path: Option<PathBuf>,
    proxy_path: Option<PathBuf>,
    cover_cache_dir: Option<PathBuf>,
    cover_semaphore: Semaphore,
    cover_mem_cache: Mutex<LruCache<String, String>>,
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
        let proxy_path: Option<PathBuf> = base_dir.as_ref().map(|d| d.join("rt_http_proxy.txt"));

        let saved = load_cookie_store(&session_path);
        let cookie_store = Arc::new(CookieStoreMutex::new(saved));

        let loaded_proxy = load_http_proxy_url(&proxy_path);
        let client = match build_reqwest_client(Arc::clone(&cookie_store), loaded_proxy.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[neegde] invalid saved HTTP proxy, using direct connection: {}", e);
                build_reqwest_client(Arc::clone(&cookie_store), None)
                    .expect("reqwest client init failed")
            }
        };

        Self {
            client: Mutex::new(client),
            cookie_store,
            inner: Mutex::new(RutrackerInner {
                logged_in: false,
                username: None,
                avatar_url: None,
            }),
            session_path,
            meta_path,
            proxy_path,
            cover_cache_dir,
            cover_semaphore: Semaphore::new(COVER_CONCURRENCY),
            cover_mem_cache: Mutex::new(LruCache::new(
                NonZeroUsize::new(COVER_MEM_CACHE_CAP).unwrap(),
            )),
        }
    }

    pub fn http_client(&self) -> Result<Client, String> {
        self.client
            .lock()
            .map_err(|_| "lock error".to_string())
            .map(|c| c.clone())
    }

    /// Check memory cache first, fall back to disk, populate memory on disk hit.
    fn read_cover(&self, topic_id: &str) -> Option<String> {
        // Fast path: in-memory LRU
        if let Ok(mut mem) = self.cover_mem_cache.lock() {
            if let Some(v) = mem.get(topic_id) {
                return Some(v.clone());
            }
        }
        // Slow path: disk cache
        let dir = self.cover_cache_dir.as_ref()?;
        let data_url = std::fs::read_to_string(dir.join(topic_id)).ok()?;
        // Promote to memory cache for next access
        if let Ok(mut mem) = self.cover_mem_cache.lock() {
            mem.put(topic_id.to_string(), data_url.clone());
        }
        Some(data_url)
    }

    /// Write to both memory cache and disk.
    fn write_cover(&self, topic_id: &str, data_url: &str) {
        if let Ok(mut mem) = self.cover_mem_cache.lock() {
            mem.put(topic_id.to_string(), data_url.to_string());
        }
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
    if raw.starts_with("https://") {
        raw.to_string()
    } else if raw.starts_with("http://") {
        format!("https://{}", &raw["http://".len()..])
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
    let profile_uri = Url::parse(&profile_url).ok()?;
    if profile_uri.scheme() != "https" {
        return None;
    }

    let resp = client.get(profile_uri).send().await.ok()?;
    let bytes = resp.bytes().await.ok()?;
    let (html, _, _) = WINDOWS_1251.decode(&bytes);

    let avatar_url = extract_avatar_from_profile(&html, base)?;
    fetch_avatar_data_url(client, &avatar_url).await
}

/// Fetch the avatar image through the authenticated Rust client and encode it
/// as a base64 data: URL so the WebView can display it without session cookies.
async fn fetch_avatar_data_url(client: &Client, url: &str) -> Option<String> {
    let avatar_uri = Url::parse(url).ok()?;
    if avatar_uri.scheme() != "https" {
        return None;
    }

    let resp = client.get(avatar_uri).send().await.ok()?;
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
    let client = state.http_client()?;
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

    // `profile.php` must not be used here: the guest login page links to
    // registration (`profile.php?mode=register`, etc.), which would falsely
    // mark any credentials as valid.
    let redirected_away = !final_url.contains("/login.php");
    let body_has_logout_link = decoded.contains("logout.php");

    if redirected_away || body_has_logout_link {
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

    let client = state.http_client()?;
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

/// Persisted HTTP proxy for Rutracker and related backend HTTP (same `reqwest` client as cookies).
#[tauri::command]
pub fn rutracker_get_http_proxy(state: tauri::State<'_, RutrackerState>) -> Result<Option<String>, String> {
    Ok(load_http_proxy_url(&state.proxy_path))
}

#[tauri::command]
pub async fn rutracker_set_http_proxy(
    state: tauri::State<'_, RutrackerState>,
    proxy_url: Option<String>,
) -> Result<(), String> {
    let normalized = proxy_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    save_http_proxy_url(&state.proxy_path, normalized.as_deref())?;

    let new_client = build_reqwest_client(
        Arc::clone(&state.cookie_store),
        normalized.as_deref(),
    )?;

    let mut guard = state
        .client
        .lock()
        .map_err(|_| "lock error".to_string())?;
    *guard = new_client;
    Ok(())
}

/// GET `target_url` with an optional HTTP proxy (same preset as in settings). Does not use Rutracker cookies.
#[tauri::command]
pub async fn rutracker_probe_http_proxy(
    proxy_url: Option<String>,
    target_url: String,
) -> Result<(), String> {
    let normalized = proxy_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let client = build_probe_client(normalized.as_deref())?;
    let url = target_url.trim();
    if url.is_empty() {
        return Err("Пустой URL проверки".into());
    }
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Нет соединения: {}", e))?;
    let status = resp.status();
    if status.is_success() || status.is_redirection() {
        Ok(())
    } else {
        Err(format!("Сервер вернул HTTP {}", status.as_u16()))
    }
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

    let client = state.http_client()?;
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
    let client = state.http_client()?;
    search::search_music(&client, &base, &query).await
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
    if let Some(cached) = state.read_cover(&topic_id) {
        return Ok(Some(cached));
    }

    // Limit concurrent fetches to avoid hammering Rutracker.
    let _permit = state
        .cover_semaphore
        .acquire()
        .await
        .map_err(|e| format!("{e}"))?;

    // Check again: another task might have populated the disk cache while we waited.
    if let Some(cached) = state.read_cover(&topic_id) {
        return Ok(Some(cached));
    }

    let base = mirror.trim_end_matches('/').to_string();
    let client = state.http_client()?;
    let result = topic::get_cover_data_url(&client, &base, &topic_id).await?;

    if let Some(ref data_url) = result {
        state.write_cover(&topic_id, data_url);
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
    let client = state.http_client()?;
    let details = topic::get_torrent_details(&client, &base, &topic_id).await?;
    // Persist cover to disk so grid loads are instant on next visit.
    if let Some(ref data_url) = details.cover_data_url {
        state.write_cover(&details.id, data_url);
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
    let client = state.http_client()?;
    let raw = topic::download_torrent_file_bytes(&client, &base, &topic_id).await?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &raw,
    ))
}
