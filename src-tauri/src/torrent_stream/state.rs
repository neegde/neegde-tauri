//! Streaming state — uses blizorukost (libtorrent) for streaming,
//! keeps librqbit only for the `torrent_export_files` command.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use librqbit::{Session, SessionOptions};
use serde::Serialize;
use serde_json::json;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};

use crate::bliz_ffi::{self, BlizConfig, BlizSessionHandle};
use crate::cache_settings::{cache_settings_path, UserCacheSettings};

use super::debug_log::AppDebugLog;
use super::stream_cache::{directory_size_bytes, StreamCache};
use super::types::{PrefetchNextResponse, StreamReady};

// ── Progress event payload (same shape as before for frontend compat) ─────
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TorrentPrepareProgressPayload {
    state: String,
    progress_bytes: u64,
    total_bytes: u64,
    pct: f64,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_mbps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upload_mbps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eta_human: Option<String>,
    peers_queued: usize,
    peers_connecting: usize,
    peers_live: usize,
    peers_seen: usize,
    peers_dead: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    prebuffer_filled: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prebuffer_target: Option<u64>,
}

// ── Userdata passed into the C progress callback ──────────────────────────
struct ProgressCallbackData {
    app: tauri::AppHandle,
    emit: bool,
}

/// C-compatible progress callback forwarded from blizorukost.
unsafe extern "C" fn bliz_progress(
    progress: f32,
    status: *const c_char,
    userdata: *mut c_void,
) {
    if userdata.is_null() {
        return;
    }
    let data = &*(userdata as *const ProgressCallbackData);
    if !data.emit {
        return;
    }

    let msg = if status.is_null() {
        String::new()
    } else {
        CStr::from_ptr(status)
            .to_string_lossy()
            .into_owned()
    };

    let pct = (progress * 100.0) as f64;
    let payload = TorrentPrepareProgressPayload {
        state: "live".into(),
        progress_bytes: pct as u64,
        total_bytes: 100,
        pct,
        message: msg,
        download_mbps: None,
        upload_mbps: None,
        eta_human: None,
        peers_queued: 0,
        peers_connecting: 0,
        peers_live: 0,
        peers_seen: 0,
        peers_dead: 0,
        prebuffer_filled: None,
        prebuffer_target: None,
    };
    let _ = data.app.emit("torrent-prepare-progress", &payload);
}

// ─────────────────────────────────────────────────────────────────────────
//  State structs
// ─────────────────────────────────────────────────────────────────────────

pub struct TorrentStreamState {
    pub(super) inner: Arc<TorrentStreamInner>,
}

pub(super) struct TorrentStreamInner {
    pub(super) app: tauri::AppHandle,

    // ── blizorukost: streaming (new) ─────────────────────────────────────
    pub(super) bliz_session: Mutex<Option<BlizSessionHandle>>,
    /// Active stream tokens → () (for bulk-release in dispose)
    pub(super) bliz_tokens: DashMap<String, ()>,

    // ── librqbit: export only ─────────────────────────────────────────────
    pub(super) session: Mutex<Option<Arc<Session>>>,
    pub(super) stream_cache: Arc<StreamCache>,
    pub(super) cache_settings: Arc<RwLock<UserCacheSettings>>,

    // ── shared ───────────────────────────────────────────────────────────
    pub(super) debug_log: Arc<AppDebugLog>,
    pub(super) export_cancel_requested: Arc<AtomicBool>,
    pub(super) prepare_cancel_requested: Arc<AtomicBool>,
    /// Counter for nerd-stats / diagnostics (kept for API compat).
    pub(super) token_counter: AtomicU64,
}

// ─────────────────────────────────────────────────────────────────────────
//  Constructor
// ─────────────────────────────────────────────────────────────────────────

impl TorrentStreamState {
    pub fn new(app: tauri::AppHandle) -> Self {
        let cache_settings = Arc::new(RwLock::new(UserCacheSettings::default()));
        let debug_log = AppDebugLog::new(app.clone());
        Self {
            inner: Arc::new(TorrentStreamInner {
                app,
                bliz_session: Mutex::new(None),
                bliz_tokens: DashMap::new(),
                session: Mutex::new(None),
                stream_cache: Arc::new(StreamCache::new(
                    cache_settings.clone(),
                    debug_log.clone(),
                )),
                cache_settings,
                debug_log,
                export_cancel_requested: Arc::new(AtomicBool::new(false)),
                prepare_cancel_requested: Arc::new(AtomicBool::new(false)),
                token_counter: AtomicU64::new(1),
            }),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  blizorukost helpers
// ─────────────────────────────────────────────────────────────────────────

fn bliz_streams_dir_label() -> &'static str {
    if cfg!(debug_assertions) {
        "bliz_streams_dev"
    } else {
        "bliz_streams"
    }
}

impl TorrentStreamState {
    /// Returns (or lazily creates) the blizorukost session.
    async fn ensure_bliz_session(&self) -> Result<BlizSessionHandle, String> {
        let mut guard = self.inner.bliz_session.lock().await;
        if let Some(ref h) = *guard {
            return Ok(h.clone());
        }

        let base = self.stream_torrents_base()?;
        let storage = base.parent().unwrap_or(&base).join(bliz_streams_dir_label());
        std::fs::create_dir_all(&storage)
            .map_err(|e| format!("Не удалось создать директорию bliz: {e}"))?;

        let storage_str = storage
            .to_str()
            .ok_or("Путь содержит не-UTF8 символы")?;
        let storage_cstr =
            CString::new(storage_str).map_err(|e| format!("Bad path: {e}"))?;

        // Initialise blizorukost session
        let config = BlizConfig {
            storage_path: storage_cstr.as_ptr(),
            cache_max_bytes: 0, // 50 GB default inside C++
            cache_ttl_secs: 3600,
            listen_port: 0, // random
        };

        let ptr = unsafe { bliz_ffi::bliz_session_create(&config) };
        if ptr.is_null() {
            return Err("Не удалось создать blizorukost сессию".into());
        }

        let handle = BlizSessionHandle(ptr);
        *guard = Some(handle.clone());

        self.inner.debug_log.push(
            "bliz",
            "blizorukost session created",
            Some(json!({ "storage": storage_str })),
        );

        Ok(handle)
    }

    /// App-data base for blizorukost storage (sibling of torrent_streams).
    fn stream_torrents_base(&self) -> Result<PathBuf, String> {
        self.inner
            .app
            .path()
            .app_data_dir()
            .map(|p| p.join("torrent_streams"))
            .map_err(|e| format!("app_data_dir: {e}"))
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Streaming commands (blizorukost)
// ─────────────────────────────────────────────────────────────────────────

impl TorrentStreamState {
    /// Prepare a torrent file for streaming.
    /// Blocks (in spawn_blocking) until metadata is resolved.
    pub async fn prepare(
        &self,
        magnet: String,
        file_idx: usize,
        torrent_data: Option<Vec<u8>>,
        emit_progress: bool,
    ) -> Result<StreamReady, String> {
        // Reset cancel flag before each prepare
        self.inner
            .prepare_cancel_requested
            .store(false, Ordering::SeqCst);

        let session = self.ensure_bliz_session().await?;
        let app = self.inner.app.clone();
        let debug_log = self.inner.debug_log.clone();
        let tokens = self.inner.bliz_tokens.clone();

        debug_log.push(
            "bliz",
            "prepare start",
            Some(json!({ "fileIdx": file_idx, "magnetLen": magnet.len() })),
        );

        // Cast to usize so the closure is Send (*mut T is !Send by auto-trait,
        // even though BlizSessionHandle impls Send; usize is always Send).
        let session_raw = session.0 as usize;

        let result = tokio::task::spawn_blocking(move || -> Result<BlizPrepareResult, String> {
            let session_ptr = session_raw as *mut bliz_ffi::BlizSession;
            let magnet_cstr = CString::new(magnet.as_str())
                .map_err(|e| format!("magnet CString: {e}"))?;

            let (data_ptr, data_len) = match torrent_data.as_deref() {
                Some(d) if !d.is_empty() => (d.as_ptr(), d.len()),
                _ => (std::ptr::null(), 0),
            };

            // Stack-allocate callback data; pointer is valid for the duration of prepare()
            let cb_data = ProgressCallbackData {
                app: app.clone(),
                emit: emit_progress,
            };

            let info = unsafe {
                bliz_ffi::bliz_stream_prepare(
                    session_ptr,
                    magnet_cstr.as_ptr(),
                    data_ptr,
                    data_len,
                    file_idx as i32,
                    Some(bliz_progress),
                    &cb_data as *const ProgressCallbackData as *mut c_void,
                )
            };

            if info.error != bliz_ffi::BlizError::Ok {
                let msg = bliz_ffi::cchars_to_string(&info.error_msg);
                return Err(msg);
            }

            Ok(BlizPrepareResult {
                url: bliz_ffi::cchars_to_string(&info.url),
                token: bliz_ffi::cchars_to_string(&info.token),
                file_size: info.file_size,
            })
        })
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))??;

        // Check if cancelled while C++ was running
        if self
            .inner
            .prepare_cancel_requested
            .load(Ordering::SeqCst)
        {
            // Release the stream we just opened
            if !result.token.is_empty() {
                self.release_stream_token(&result.token).await;
            }
            return Err("Отменено пользователем".into());
        }

        tokens.insert(result.token.clone(), ());

        debug_log.push(
            "bliz",
            "prepare ready",
            Some(json!({
                "token": &result.token,
                "fileSize": result.file_size,
                "url": &result.url,
            })),
        );

        Ok(StreamReady {
            url: result.url,
            token: result.token,
        })
    }

    /// Release a single stream token (called when track playback ends).
    pub async fn release_stream_token(&self, token: &str) {
        let guard = self.inner.bliz_session.lock().await;
        if let Some(ref h) = *guard {
            if let Ok(ctoken) = CString::new(token) {
                unsafe { bliz_ffi::bliz_stream_release(h.0, ctoken.as_ptr()) };
            }
        }
        self.inner.bliz_tokens.remove(token);
    }

    /// Signal the ongoing prepare to cancel (checked after spawn_blocking returns).
    pub fn prepare_cancel_trigger(&self) {
        self.inner
            .prepare_cancel_requested
            .store(true, Ordering::SeqCst);
    }

    /// Release all active streams and evict idle torrents.
    pub async fn dispose(&self) {
        let guard = self.inner.bliz_session.lock().await;
        if let Some(ref h) = *guard {
            // Release all active stream tokens
            let tokens: Vec<String> = self
                .inner
                .bliz_tokens
                .iter()
                .map(|r| r.key().clone())
                .collect();

            for token in &tokens {
                if let Ok(ct) = CString::new(token.as_str()) {
                    unsafe { bliz_ffi::bliz_stream_release(h.0, ct.as_ptr()) };
                }
            }
            self.inner.bliz_tokens.clear();

            unsafe { bliz_ffi::bliz_session_evict(h.0) };
        }
    }

    /// Prefetch the next track while the current one plays.
    /// Both same-torrent and cross-torrent cases are handled by blizorukost:
    /// the engine keeps the first torrent cached, so a second prepare is fast.
    pub async fn prefetch_next_track(
        &self,
        _current_magnet: String,
        _current_file_idx: usize,
        next_magnet: String,
        next_file_idx: usize,
        next_torrent_data: Option<Vec<u8>>,
    ) -> Result<PrefetchNextResponse, String> {
        // Run silently (no progress events)
        let ready = self
            .prepare(next_magnet, next_file_idx, next_torrent_data, false)
            .await?;
        Ok(PrefetchNextResponse::StreamReady { url: ready.url })
    }

    /// Resolve magnet metadata and return the file list.
    pub async fn magnet_resolve_files(
        &self,
        magnet: String,
    ) -> Result<Vec<crate::rutracker::TorrentFile>, String> {
        let session = self.ensure_bliz_session().await?;

        let session_raw = session.0 as usize;

        tokio::task::spawn_blocking(move || -> Result<Vec<crate::rutracker::TorrentFile>, String> {
            let session_ptr = session_raw as *mut bliz_ffi::BlizSession;
            let magnet_cstr =
                CString::new(magnet.as_str()).map_err(|e| format!("magnet CString: {e}"))?;

            let mut list = unsafe {
                bliz_ffi::bliz_list_files(
                    session_ptr,
                    magnet_cstr.as_ptr(),
                    std::ptr::null(),
                    0,
                )
            };

            if list.error != bliz_ffi::BlizError::Ok {
                let msg = bliz_ffi::cchars_to_string(&list.error_msg);
                unsafe { bliz_ffi::bliz_file_list_free(&mut list) };
                return Err(msg);
            }

            // Build root name from the first entry's first path component
            let root = "Раздача".to_string();
            let mut files = Vec::with_capacity(list.count as usize);

            for i in 0..list.count {
                let entry = unsafe { &*list.files.add(i as usize) };
                let name = bliz_ffi::cchars_to_string(
                    // BlizFileEntry.name is [c_char; 512]
                    &entry.name,
                );
                files.push(crate::rutracker::TorrentFile {
                    path: vec![root.clone(), name],
                    size: entry.size as u64,
                });
            }

            unsafe { bliz_ffi::bliz_file_list_free(&mut list) };

            Ok(files)
        })
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
    }

    /// Notify the streaming engine of the current playback byte offset (for
    /// the priority window to follow).  Called from the frontend on timeupdate.
    pub async fn notify_position(&self, token: &str, byte_offset: i64) {
        let guard = self.inner.bliz_session.lock().await;
        if let Some(ref h) = *guard {
            if let Ok(ct) = CString::new(token) {
                unsafe { bliz_ffi::bliz_stream_notify_position(h.0, ct.as_ptr(), byte_offset) };
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  librqbit session — export only
// ─────────────────────────────────────────────────────────────────────────

impl TorrentStreamState {
    /// Returns (or lazily creates) the librqbit session used for file export.
    pub(super) async fn ensure_export_session(&self) -> Result<Arc<Session>, String> {
        let mut guard = self.inner.session.lock().await;
        if let Some(ref s) = *guard {
            return Ok(s.clone());
        }

        let base = self
            .inner
            .app
            .path()
            .app_data_dir()
            .map(|p| p.join("torrent_export"))
            .map_err(|e| format!("app_data_dir: {e}"))?;

        std::fs::create_dir_all(&base)
            .map_err(|e| format!("Не удалось создать директорию экспорта: {e}"))?;

        let session = Session::new_with_opts(
            base.clone(),
            SessionOptions {
                disable_dht_persistence: true,
                peer_opts: Some(librqbit::PeerConnectionOptions {
                    connect_timeout: Some(std::time::Duration::from_secs(4)),
                    ..Default::default()
                }),
                listen_port_range: Some(6883..6890), // different from blizorukost
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("librqbit export session: {e}"))?;

        // Session::new_with_opts already returns Arc<Session>
        *guard = Some(session.clone());
        Ok(session)
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Cache / settings  (unchanged from original, kept for export compat)
// ─────────────────────────────────────────────────────────────────────────

impl TorrentStreamState {
    pub async fn user_cache_settings(&self) -> UserCacheSettings {
        self.inner.cache_settings.read().await.clone()
    }

    pub async fn stream_cache_policy_limits(&self) -> (u64, u64) {
        let g = self.inner.cache_settings.read().await;
        (g.stream_cache_max_bytes, g.stream_cache_ttl_secs)
    }

    pub async fn apply_user_cache_settings(
        &self,
        settings: UserCacheSettings,
    ) -> Result<(), String> {
        settings.validate()?;
        let path = cache_settings_path(&self.inner.app)?;
        settings.save_to_disk(&path)?;
        *self.inner.cache_settings.write().await = settings;
        self.reclaim_stream_cache_best_effort().await;
        Ok(())
    }

    pub async fn load_cache_settings_from_disk(&self) -> Result<(), String> {
        let path = cache_settings_path(&self.inner.app)?;
        let mut s = UserCacheSettings::load_from_disk(&path);
        if s.validate().is_err() {
            s = UserCacheSettings::default();
        }
        *self.inner.cache_settings.write().await = s;
        Ok(())
    }

    pub async fn purge_streaming_cache_disk(&self) -> Result<(), String> {
        self.dispose().await;
        // Release export session
        let mut guard = self.inner.session.lock().await;
        if let Some(s) = guard.take() {
            super::stream_cache::purge_session_torrents(&s).await;
        }
        drop(guard);
        // Remove bliz storage
        let base = self.stream_torrents_base()?;
        let bliz_storage = base
            .parent()
            .unwrap_or(&base)
            .join(bliz_streams_dir_label());
        if bliz_storage.exists() {
            std::fs::remove_dir_all(&bliz_storage)
                .map_err(|e| format!("Ошибка удаления bliz-кэша: {e}"))?;
        }
        Ok(())
    }

    pub async fn reclaim_stream_cache_best_effort(&self) {
        let session_opt = self.inner.session.lock().await.clone();
        if let Some(s) = session_opt {
            let base = self
                .inner
                .app
                .path()
                .app_data_dir()
                .map(|p| p.join("torrent_export"))
                .unwrap_or_default();
            self.inner.stream_cache.maybe_reclaim(&s, &base).await;
        }
        // Also evict idle blizorukost torrents
        let bliz_opt = self.inner.bliz_session.lock().await.clone();
        if let Some(h) = bliz_opt {
            unsafe { bliz_ffi::bliz_session_evict(h.0) };
        }
    }

    /// Called on app exit: release blizorukost streams and shut down export session.
    pub async fn purge_torrent_data_on_exit(&self) {
        self.dispose().await;

        // Destroy blizorukost session
        let ptr = self.inner.bliz_session.lock().await.take();
        if let Some(h) = ptr {
            unsafe { bliz_ffi::bliz_session_destroy(h.0) };
        }

        // Shut down export librqbit session
        let session = self.inner.session.lock().await.take();
        if let Some(s) = session {
            super::stream_cache::purge_session_torrents(&s).await;
        }
    }

    /// Disk usage of the blizorukost streaming cache.
    /// Number of currently active stream tokens (for diagnostics).
    pub async fn streaming_torrent_count(&self) -> u32 {
        self.inner.bliz_tokens.len() as u32
    }

    pub async fn bliz_cache_bytes(&self) -> u64 {
        let base = match self.stream_torrents_base() {
            Ok(p) => p,
            Err(_) => return 0,
        };
        let bliz_dir = base
            .parent()
            .unwrap_or(&base)
            .join(bliz_streams_dir_label());
        directory_size_bytes(&bliz_dir)
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Export helpers (used by export.rs)
// ─────────────────────────────────────────────────────────────────────────

impl TorrentStreamState {
    /// Returns the librqbit session for export, creating it lazily.
    pub async fn torrent_session(&self) -> Result<Arc<Session>, String> {
        self.ensure_export_session().await
    }

    pub fn export_cancel_triggered(&self) -> bool {
        self.inner
            .export_cancel_requested
            .load(Ordering::SeqCst)
    }

    pub fn export_cancel_reset(&self) {
        self.inner
            .export_cancel_requested
            .store(false, Ordering::SeqCst);
    }

    pub fn export_cancel_trigger(&self) {
        self.inner
            .export_cancel_requested
            .store(true, Ordering::SeqCst);
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────────────────────────────────

struct BlizPrepareResult {
    url: String,
    token: String,
    file_size: i64,
}
