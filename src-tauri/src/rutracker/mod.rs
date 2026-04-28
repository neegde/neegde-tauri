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
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
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

/// Structured metadata extracted from `<span class="post-b">Label</span>: value<br>` rows.
/// Everything here is torrent-scoped (applies to every track in the release).
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct TopicMeta {
    pub year: Option<String>,
    pub genre: Option<String>,
    pub country: Option<String>,
    pub codec: Option<String>,
    pub rip_type: Option<String>,
    pub duration: Option<String>,
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
    /// Album name extracted from the post body ("Альбом: X") or derived from topic name.
    #[serde(default)]
    pub album: Option<String>,
    /// Structured fields from `<span class="post-b">Label</span>: value<br>` rows.
    #[serde(default)]
    pub meta: TopicMeta,
}

// ── Session file helpers ──────────────────────────────────────────────────────

/// Minimal profile data stored alongside the cookie jar so we can restore
/// the username and avatar without re-parsing the forum HTML on every startup.
#[derive(Serialize, Deserialize, Default)]
struct SessionMeta {
    username: Option<String>,
    /// base64 data: URL — cached so the WebView never needs Rutracker cookies.
    avatar_data_url: Option<String>,
    /// Mirror base URL used at login (`LoginResult`); cookies are scoped to that host.
    /// Restore must probe this URL, not whatever mirror the UI picked for “auto” mode.
    login_mirror: Option<String>,
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
    // Use `load_json_all` to include non-persistent cookies (e.g. phpBB's
    // `bb_session`, which is HttpOnly without Max-Age/Expires — the browser
    // treats it as session-only, but we need it across app restarts).
    path.as_ref()
        .and_then(|p| std::fs::File::open(p).ok())
        .and_then(|f| CookieStore::load_json_all(BufReader::new(f)).ok())
        .unwrap_or_else(|| CookieStore::new(None))
}

#[allow(deprecated)]
fn save_cookie_store(path: &Option<PathBuf>, store: &Arc<CookieStoreMutex>) {
    if let Some(p) = path {
        if let Ok(file) = std::fs::File::create(p) {
            let mut writer = BufWriter::new(file);
            if let Ok(locked) = store.lock() {
                // Persist session cookies too — see `load_cookie_store` note.
                let _ = locked.save_incl_expired_and_nonpersistent_json(&mut writer);
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
            Err(_) => {
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

/// Best-effort display name from forum index HTML (phpBB profile link text).
fn extract_username_from_forum_page(html: &str) -> Option<String> {
    for pat in &["mode=viewprofile&u=", "mode=viewprofile&amp;u="] {
        let mut scan = 0usize;
        while let Some(rel) = html[scan..].find(pat) {
            let hit = scan + rel;
            let after = &html[hit + pat.len()..];
            let uid_len = after
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(after.len());
            if uid_len == 0 {
                scan = hit + pat.len();
                continue;
            }
            let prefix = &html[..hit];
            let Some(a_open) = prefix.rfind("<a ") else {
                scan = hit + pat.len();
                continue;
            };
            let tail = &html[a_open..];
            let Some(gt) = tail.find('>') else {
                scan = hit + pat.len();
                continue;
            };
            let inner_start = a_open + gt + 1;
            let inner_rest = &html[inner_start..];
            let Some(close_a) = inner_rest.find("</a>") else {
                scan = hit + pat.len();
                continue;
            };
            let inner = inner_rest[..close_a].trim();
            if inner.contains("<img") || inner.is_empty() {
                scan = hit + pat.len();
                continue;
            }
            let name = strip_simple_inline_markup(inner);
            if !name.is_empty() && name.len() < 128 {
                return Some(name);
            }
            scan = hit + pat.len();
        }
    }
    None
}

/// Removes a single layer of common inline wrappers (`<b>`, `<span>`) from link HTML.
fn strip_simple_inline_markup(s: &str) -> String {
    let mut t = s.trim().to_string();
    for (o, c) in [
        ("<b>", "</b>"),
        ("<B>", "</B>"),
        ("<strong>", "</strong>"),
        ("<STRONG>", "</STRONG>"),
    ] {
        if t.starts_with(o) && t.ends_with(c) && t.len() > o.len() + c.len() {
            t = t[o.len()..t.len() - c.len()].trim().to_string();
        }
    }
    if let Some(i) = t.find('>') {
        if let Some(j) = t.rfind('<') {
            if j > i {
                t = t[i + 1..j].trim().to_string();
            }
        }
    }
    t.trim().to_string()
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

    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let (decoded, _, _) = WINDOWS_1251.decode(&bytes);

    // Detect the explicit "login form" markers on the POST response body.
    // phpBB returns the login form again (same `name="login_username"` field)
    // whenever credentials are wrong / CAPTCHA is required / account is banned.
    // If the form is NOT present AND the status is OK-ish, we treat the session
    // as most likely authenticated and confirm with a follow-up probe.
    let looks_like_login_form = decoded.contains(r#"name="login_username""#)
        || decoded.contains(r#"name='login_username'"#);

    // Fast path: some phpBB configs inline the full index into the POST response
    // and it already looks authenticated — no need to probe.
    let body_looks_logged_in = page_looks_logged_in(&decoded);

    // Slow path: POST responded with a meta-refresh "Login successful, redirecting…"
    // page without the usual auth markers. Probe the forum index with the
    // now-set session cookie; real auth is detectable there.
    let session_verified = if body_looks_logged_in {
        true
    } else if !looks_like_login_form && (status.is_success() || status.is_redirection()) {
        match client
            .get(format!("{}/forum/index.php", base))
            .send()
            .await
        {
            Ok(r) => {
                let probe_bytes = r.bytes().await.unwrap_or_default();
                let (probe_html, _, _) = WINDOWS_1251.decode(&probe_bytes);
                page_looks_logged_in(&probe_html)
            }
            Err(_) => false,
        }
    } else {
        false
    };

    if session_verified {
        let avatar_data_url = fetch_avatar(&client, &decoded, &base).await;

        state.persist(&SessionMeta {
            username: Some(username.clone()),
            avatar_data_url: avatar_data_url.clone(),
            login_mirror: Some(base.clone()),
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

    // Session NOT established — classify the failure. Order matters: CAPTCHA
    // markers often co-occur with "неверный"/"password" hint strings in phpBB,
    // so CAPTCHA must be checked before the generic bad-password branch.
    let is_captcha = decoded.contains("апч")
        || decoded.contains("captcha")
        || decoded.contains("CAPTCHA")
        || decoded.contains("cap_sid");
    let is_banned = decoded.contains("бан") || decoded.contains("заблокирован");
    let is_bad_creds = decoded.contains("неверный")
        || decoded.contains("Неверный")
        || decoded.contains("invalid")
        || decoded.contains("Invalid");

    let error = if is_captcha {
        "Требуется CAPTCHA — попробуйте войти через браузер".to_string()
    } else if is_banned {
        "Аккаунт заблокирован".to_string()
    } else if is_bad_creds {
        "Неверный логин или пароль".to_string()
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
    let meta = load_meta(&state.meta_path);
    let from_ui = mirror.trim().trim_end_matches('/').to_string();
    let base = meta
        .login_mirror
        .as_ref()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(from_ui);

    // Light healthcheck: try loading the forum index
    let resp = client
        .get(format!("{}/forum/index.php", base))
        .send()
        .await
        .map_err(|e| format!("Сетевая ошибка: {}", e))?;

    if resp.url().path().contains("login") {
        // Session expired — wipe files
        state.wipe();
        return Ok(LoginStatus {
            logged_in: false,
            username: None,
            avatar_url: None,
        });
    }

    // Tracker search page: same auth barrier as `search_music` — index alone can load for guests.
    let resp_t = client
        .get(format!("{}/forum/tracker.php", base))
        .query(&[("nm", ".")])
        .send()
        .await
        .map_err(|e| format!("Сетевая ошибка: {}", e))?;

    if resp_t.url().path().contains("login") {
        state.wipe();
        return Ok(LoginStatus {
            logged_in: false,
            username: None,
            avatar_url: None,
        });
    }

    let bytes = resp_t
        .bytes()
        .await
        .map_err(|e| format!("Ошибка чтения ответа трекера: {}", e))?;
    let html_track = if std::str::from_utf8(&bytes).is_ok() {
        String::from_utf8(bytes.to_vec()).unwrap()
    } else {
        let (cow, _, _) = WINDOWS_1251.decode(&bytes);
        cow.into_owned()
    };

    if html_track.contains(r#"name="login_username""#) {
        state.wipe();
        return Ok(LoginStatus {
            logged_in: false,
            username: None,
            avatar_url: None,
        });
    }

    // Index + tracker both indicate an authenticated session — restore from saved meta
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
/// Prefer the mirror used at login (cookies are scoped to that host); fall
/// back to the mirror the UI passes only when no login mirror is saved. Used
/// by every authenticated command so search / cover / details all hit the
/// host the cookie jar knows about.
pub(crate) fn auth_base_for_dev(state: &RutrackerState, from_ui: &str) -> String {
    auth_base(state, from_ui)
}

fn auth_base(state: &RutrackerState, from_ui: &str) -> String {
    let from_ui_norm = from_ui.trim().trim_end_matches('/').to_string();
    let meta = load_meta(&state.meta_path);
    meta.login_mirror
        .as_ref()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(from_ui_norm)
}

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
    let base = auth_base(&state, &mirror);
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

    let base = auth_base(&state, &mirror);
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
    let base = auth_base(&state, &mirror);
    let client = state.http_client()?;
    let details = topic::get_torrent_details(&client, &base, &topic_id).await?;
    // Persist cover to disk so grid loads are instant on next visit.
    if let Some(ref data_url) = details.cover_data_url {
        state.write_cover(&details.id, data_url);
    }
    Ok(details)
}

/// True if the topic’s `.torrent` lists at least one file with an extension the player supports.
#[tauri::command]
pub async fn rutracker_topic_has_playable_audio(
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
    topic_id: String,
) -> Result<bool, String> {
    {
        let inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
        if !inner.logged_in {
            return Err("Необходимо войти в Rutracker".into());
        }
    }
    let base = auth_base(&state, &mirror);
    let client = state.http_client()?;
    topic::topic_has_playable_audio(&client, &base, &topic_id).await
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
    let base = auth_base(&state, &mirror);
    let client = state.http_client()?;
    let raw = topic::download_torrent_file_bytes(&client, &base, &topic_id).await?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &raw,
    ))
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

fn page_looks_logged_in(html: &str) -> bool {
    let has_login_form = html.contains(r#"name="login_username""#)
        || html.contains(r#"name='login_username'"#);
    let has_guest_link = html.contains("login.php?redirect=");
    let has_cf_challenge = html.contains("cf-browser-verification")
        || html.contains("challenge-platform")
        || html.contains("just a moment");
    if has_login_form || has_guest_link || has_cf_challenge {
        return false;
    }

    let logged_in_markers = [
        "logout.php",
        "login.php?logout",
        "?logout=1",
        "&logout=1",
        "mode=logout",
        "profile.php?mode=editprofile",
        "privmsg.php?folder=inbox",
        "pm.php?folder=inbox",
        "ucp.php?mode=logout",
    ];
    logged_in_markers.iter().any(|m| html.contains(m))
}

/// Re-fetch and persist the logged-in user's avatar without requiring a full
/// re-login. Returns the new data URL, or `None` if not logged in or the
/// request fails (caller should keep the previously stored avatar).
#[tauri::command]
pub async fn rutracker_refresh_avatar(
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
) -> Result<Option<String>, String> {
    {
        let inner = state.inner.lock().map_err(|_| "lock error".to_string())?;
        if !inner.logged_in {
            return Ok(None);
        }
    }

    let client = state.http_client()?;
    let base = auth_base(&state, &mirror);

    let resp = match client
        .get(format!("{}/forum/index.php", base))
        .timeout(Duration::from_secs(15))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };

    let bytes = resp.bytes().await.unwrap_or_default();
    let (html, _, _) = WINDOWS_1251.decode(&bytes);
    let html = html.into_owned();

    let avatar_data_url = fetch_avatar(&client, &html, &base).await;

    if let Some(ref url) = avatar_data_url {
        let mut meta = load_meta(&state.meta_path);
        meta.avatar_data_url = Some(url.clone());
        save_meta(&state.meta_path, &meta);
        if let Ok(mut inner) = state.inner.lock() {
            inner.avatar_url = Some(url.clone());
        }
    }

    Ok(avatar_data_url)
}

// ── Connectivity probe ────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ConnectivityResult {
    pub reachable: bool,
    pub status: Option<u16>,
    pub using_proxy: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn rutracker_check_connectivity(
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
) -> Result<ConnectivityResult, String> {
    let base = mirror.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Ok(ConnectivityResult {
            reachable: false,
            status: None,
            using_proxy: load_http_proxy_url(&state.proxy_path),
            error: Some("Пустой URL зеркала".into()),
        });
    }
    let url = format!("{}/forum/index.php", base);
    let client = state.http_client()?;
    let using_proxy = load_http_proxy_url(&state.proxy_path);

    match client.get(&url).timeout(Duration::from_secs(10)).send().await {
        Ok(resp) => {
            let status = resp.status();
            let code = status.as_u16();
            let ok = status.is_success() || status.is_redirection();
            Ok(ConnectivityResult {
                reachable: ok,
                status: Some(code),
                using_proxy,
                error: if ok { None } else { Some(format!("HTTP {}", code)) },
            })
        }
        Err(e) => Ok(ConnectivityResult {
            reachable: false,
            status: None,
            using_proxy,
            error: Some(format!("{}", e)),
        }),
    }
}

// ── WebView login (для CAPTCHA / Cloudflare) ──────────────────────────────────

const LOGIN_WEBVIEW_LABEL: &str = "rt-login-webview";

fn ingest_webview_cookies(
    cookies: &[cookie::Cookie<'static>],
    request_url: &Url,
    store: &Arc<CookieStoreMutex>,
) -> usize {
    let Ok(mut guard) = store.lock() else {
        return 0;
    };
    let mut count = 0usize;
    for c in cookies {
        if guard.insert_raw(c, request_url).is_ok() {
            count += 1;
            continue;
        }
        let header = c.to_string();
        if guard.parse(&header, request_url).is_ok() {
            count += 1;
        }
    }
    count
}

async fn try_promote_webview_session(
    window: &tauri::WebviewWindow,
    state: &tauri::State<'_, RutrackerState>,
    base: &str,
    login_url: &Url,
) -> Result<Option<String>, String> {
    let mut all_cookies: Vec<cookie::Cookie<'static>> = window.cookies().unwrap_or_default();
    let for_url = window
        .cookies_for_url(login_url.clone())
        .unwrap_or_default();
    for c in for_url {
        let dup = all_cookies
            .iter()
            .any(|e| e.name() == c.name() && e.domain() == c.domain() && e.path() == c.path());
        if !dup {
            all_cookies.push(c);
        }
    }

    if all_cookies.is_empty() {
        return Ok(None);
    }

    let _ = ingest_webview_cookies(&all_cookies, login_url, &state.cookie_store);

    let probe_url = format!("{}/forum/index.php", base);
    let client = state.http_client()?;
    let resp = client
        .get(&probe_url)
        .send()
        .await
        .map_err(|e| format!("{}", e))?;

    let bytes = resp.bytes().await.unwrap_or_default();
    let (decoded, _, _) = WINDOWS_1251.decode(&bytes);
    let html = decoded.into_owned();

    if page_looks_logged_in(&html) {
        Ok(Some(html))
    } else {
        Ok(None)
    }
}

async fn finalize_webview_login(
    state: &tauri::State<'_, RutrackerState>,
    base: &str,
    html: &str,
) -> Result<LoginResult, String> {
    let client = state.http_client()?;
    let username = extract_username_from_forum_page(html);
    let avatar_data_url = fetch_avatar(&client, html, base).await;

    state.persist(&SessionMeta {
        username: username.clone(),
        avatar_data_url: avatar_data_url.clone(),
        login_mirror: Some(base.to_string()),
    });

    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "lock error".to_string())?;
        inner.logged_in = true;
        inner.username = username.clone();
        inner.avatar_url = avatar_data_url.clone();
    }

    Ok(LoginResult {
        success: true,
        error: None,
        username,
        avatar_url: avatar_data_url,
    })
}

/// Open an embedded WebView at the rutracker login page and wait for a session.
///
/// Polls every 1.5 s by copying webview cookies into the reqwest jar and
/// probing `/forum/index.php`. Returns once login is detected, the window is
/// closed, or the 10-minute timeout elapses.
#[tauri::command]
pub async fn rutracker_login_via_webview(
    app: tauri::AppHandle,
    state: tauri::State<'_, RutrackerState>,
    mirror: String,
) -> Result<LoginResult, String> {
    let base = mirror.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("Пустое зеркало".into());
    }
    let login_url_str = format!("{}/forum/login.php", base);
    let login_url: Url = login_url_str
        .parse()
        .map_err(|e| format!("Некорректный URL зеркала: {}", e))?;

    // Reuse an existing login window instead of destroying and recreating it.
    // Recreating races with Tauri's async label cleanup and causes "already exists"
    // errors when the IPC protocol fallback triggers a second command invocation.
    // Note: proxy_url() on WebviewWindowBuilder panics in tauri-runtime-wry on
    // Windows (RecvError in the wry event loop channel), so proxy is not forwarded
    // to the webview. Users who need proxy for the browser login should configure
    // a Windows system proxy.
    let window = if let Some(existing) = app.get_webview_window(LOGIN_WEBVIEW_LABEL) {
        let _ = existing.set_focus();
        existing
    } else {
        {
            let mut b = WebviewWindowBuilder::new(
                &app,
                LOGIN_WEBVIEW_LABEL,
                WebviewUrl::External(login_url.clone()),
            )
            .title("Rutracker — вход")
            .inner_size(720.0, 860.0)
            .min_inner_size(480.0, 600.0)
            .resizable(true)
            .focused(true)
            .center();

            // proxy_url() and additional_browser_args() applied to the shared
            // WebView2 environment both panic in tauri-runtime-wry on Windows.
            // Workaround: give the login window its own data directory so WebView2
            // creates an isolated environment where browser args are applied at
            // init time, before any shared state is locked.
            if let Some(proxy) = load_http_proxy_url(&state.proxy_path) {
                if let Ok(data_dir) = app.path().app_data_dir().map(|d| d.join("rt_login_webview")) {
                    b = b
                        .data_directory(data_dir)
                        .additional_browser_args(&format!("--proxy-server={}", proxy));
                }
            }

            b.build()
                .map_err(|e| format!("Не удалось открыть окно входа: {}", e))?
        }
    };

    let poll_interval = Duration::from_millis(1500);
    let timeout = Duration::from_secs(600);
    let start = std::time::Instant::now();

    loop {
        if app.get_webview_window(LOGIN_WEBVIEW_LABEL).is_none() {
            if let Ok(Some(html)) =
                try_promote_webview_session(&window, &state, &base, &login_url).await
            {
                return finalize_webview_login(&state, &base, &html).await;
            }
            return Ok(LoginResult {
                success: false,
                error: Some("Окно входа закрыто — вход отменён".into()),
                username: None,
                avatar_url: None,
            });
        }
        if start.elapsed() > timeout {
            let _ = window.destroy();
            return Ok(LoginResult {
                success: false,
                error: Some("Истекло время ожидания входа".into()),
                username: None,
                avatar_url: None,
            });
        }

        if let Ok(Some(html)) =
            try_promote_webview_session(&window, &state, &base, &login_url).await
        {
            let _ = window.destroy();
            return finalize_webview_login(&state, &base, &html).await;
        }

        tokio::time::sleep(poll_interval).await;
    }
}
