//! Safe Rust wrapper around vozduxan C API + Tauri command handlers.
//!
//! This module replaces the librqbit-backed streaming commands in torrent_stream
//! while leaving the export (full-download) functionality untouched.
//!
//! Key design points:
//! - VozduxanSessionInner owns the *mut VozduxanSession raw pointer; dropped via vozduxan_session_destroy.
//! - All blocking C calls run in spawn_blocking to avoid blocking the async executor.
//! - seek_generation is bumped only when a stream is released; parallel Range
//!   requests must not cancel each other (browser often fetches start + end).
//! - Each `prepare()` bumps `prepare_version`; stale blocking results are dropped
//!   so a slow prepare cannot overwrite state after the user switched tracks.
//! - vozduxan_notify_position updates piece-priority window from the UI seek position.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use base64::Engine as _;
use crate::vozduxan_ffi as ffi;
use crate::rutracker::TorrentFile;
use crate::torrent_stream::debug_log::AppDebugLog;

/* ── Progress event payload ─────────────────────────────────────────────
   Same shape as TorrentPrepareProgressPayload so the Vue component works
   without changes.                                                        */
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PrepareProgressPayload {
    state: String,
    progress_bytes: u64,
    total_bytes: u64,
    pct: f64,
    message: String,
    download_mbps: Option<f64>,
    upload_mbps: Option<f64>,
    eta_human: Option<String>,
    peers_queued: usize,
    peers_connecting: usize,
    peers_live: usize,
    peers_seen: usize,
    peers_dead: usize,
    prebuffer_filled: Option<u64>,
    prebuffer_target: Option<u64>,
}

impl PrepareProgressPayload {
    fn buffering(pct: f64, message: impl Into<String>) -> Self {
        Self {
            state: "live".into(),
            progress_bytes: 0,
            total_bytes: 0,
            pct,
            message: message.into(),
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
        }
    }
}

/* ── userdata for C progress callback ──────────────────────────────────── */
struct ProgressCtx {
    app: AppHandle,
}

unsafe extern "C" fn on_progress(progress: f32, status: *const c_char, userdata: *mut c_void) {
    let ctx = unsafe { &*(userdata as *const ProgressCtx) };
    let msg = if status.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(status) }
            .to_string_lossy()
            .into_owned()
    };
    let _ = ctx.app.emit(
        "torrent-prepare-progress",
        PrepareProgressPayload::buffering((progress as f64) * 100.0, msg),
    );
}

/* ── C log callback — forwards vozduxan C++ log lines to AppDebugLog ── */
unsafe extern "C" fn on_vozduxan_log(message: *const c_char, userdata: *mut c_void) {
    if message.is_null() || userdata.is_null() {
        return;
    }
    // SAFETY: userdata is an Arc<AppDebugLog> raw pointer kept alive by VozduxanSessionInner.
    let debug_log = unsafe { &*(userdata as *const AppDebugLog) };
    let msg = unsafe { CStr::from_ptr(message) }
        .to_string_lossy()
        .into_owned();
    debug_log.push("vozduxan", msg, None);
}

/* ── Inner session (owns the C++ object) ───────────────────────────────── */
struct VozduxanSessionInner {
    ptr: *mut ffi::VozduxanSession,
    /// Token of the currently active stream.
    current_token: Mutex<Option<String>>,
    /// Token of the prefetched (background) stream (queue look-ahead).
    prefetch_token: Mutex<Option<String>>,
    /// Second-ahead warm-up only — must not evict `prefetch_token` (next track).
    warm_prefetch_token: Mutex<Option<String>>,
    /// Token prepared by hover-prefetch. NEVER releases current_token.
    hover_token: Mutex<Option<String>>,
    /// Set to true to cancel the next prepare result after it arrives.
    prepare_cancelled: AtomicBool,
    /// Incremented at the start of every `prepare()`; stale completions compare against this.
    prepare_version: AtomicU64,
    /// Keeps the Arc alive so the raw pointer in VozduxanConfig stays valid.
    _debug_log_arc: Arc<AppDebugLog>,
}

// SAFETY: VozduxanSessionImpl is fully thread-safe internally (mutexes + atomics).
unsafe impl Send for VozduxanSessionInner {}
unsafe impl Sync for VozduxanSessionInner {}

impl Drop for VozduxanSessionInner {
    fn drop(&mut self) {
        unsafe { ffi::vozduxan_session_destroy(self.ptr) };
    }
}

/* ── Public state handle ───────────────────────────────────────────────── */
pub struct VozduxanStreamState {
    inner: Arc<VozduxanSessionInner>,
    pub debug_log: Arc<AppDebugLog>,
}

impl VozduxanStreamState {
    fn dlog(&self, msg: impl Into<String>) {
        self.debug_log.push("vozduxan", msg.into(), None);
    }
}

impl VozduxanStreamState {
    pub fn new(app: &AppHandle, debug_log: Arc<AppDebugLog>) -> Self {
        let storage_path = {
            let dir_label = if cfg!(debug_assertions) {
                "vozduxan_streams_dev"
            } else {
                "vozduxan_streams"
            };
            let path = app
                .path()
                .app_data_dir()
                .expect("no app_data_dir")
                .join(dir_label);
            std::fs::create_dir_all(&path).ok();
            path
        };

        let storage_c = CString::new(storage_path.to_string_lossy().as_ref()).unwrap();

        // Pass a raw pointer to the AppDebugLog into the C++ log callback.
        // VozduxanSessionInner keeps _debug_log_arc alive so the pointer is valid.
        let log_userdata = Arc::as_ptr(&debug_log) as *mut c_void;

        let cfg = ffi::VozduxanConfig {
            storage_path: storage_c.as_ptr(),
            cache_max_bytes: 0, // 50 GB default
            cache_ttl_secs: 0,  // 3600 s default
            listen_port: 0,     // random
            log_fn: Some(on_vozduxan_log),
            log_userdata,
        };

        let ptr = unsafe { ffi::vozduxan_session_create(&cfg) };
        assert!(!ptr.is_null(), "vozduxan_session_create returned null");

        VozduxanStreamState {
            inner: Arc::new(VozduxanSessionInner {
                ptr,
                current_token: Mutex::new(None),
                prefetch_token: Mutex::new(None),
                warm_prefetch_token: Mutex::new(None),
                hover_token: Mutex::new(None),
                prepare_cancelled: AtomicBool::new(false),
                prepare_version: AtomicU64::new(0),
                _debug_log_arc: debug_log.clone(),
            }),
            debug_log,
        }
    }

    /* ── prepare_stream ─────────────────────────────────────────────────── */
    pub async fn prepare(
        &self,
        app: AppHandle,
        magnet: String,
        file_idx: usize,
        torrent_bytes: Option<Vec<u8>>,
    ) -> Result<String, String> {
        self.inner.prepare_cancelled.store(false, Ordering::Relaxed);
        self.inner.prepare_version.fetch_add(1, Ordering::AcqRel);
        let my_version = self.inner.prepare_version.load(Ordering::Acquire);

        // Emit "connecting" immediately so the UI shows a spinner.
        let _ = app.emit(
            "torrent-prepare-progress",
            PrepareProgressPayload::buffering(5.0, "Подключение к рою..."),
        );

        let inner = self.inner.clone();
        let app_clone = app.clone();
        let dlog = self.debug_log.clone();

        // All vozduxan calls happen inside spawn_blocking.
        // We do cancel-check and token management inside the closure
        // so that `inner` doesn't need to be used both inside and outside.
        let url = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let dlog = |msg: String| { dlog.push("vozduxan", msg, None); };
            let magnet_c = CString::new(magnet.as_str()).unwrap();

            dlog(format!("prepare start — file_idx={file_idx} has_torrent_data={}", torrent_bytes.is_some()));

            let ctx = Box::new(ProgressCtx { app: app_clone });
            let ctx_ptr = Box::into_raw(ctx) as *mut c_void;

            let info = unsafe {
                ffi::vozduxan_stream_prepare(
                    inner.ptr,
                    magnet_c.as_ptr(),
                    torrent_bytes
                        .as_deref()
                        .map(|b| b.as_ptr())
                        .unwrap_or(std::ptr::null()),
                    torrent_bytes.as_deref().map(|b| b.len()).unwrap_or(0),
                    file_idx as c_int,
                    Some(on_progress),
                    ctx_ptr,
                )
            };

            // Free the ProgressCtx (callback will not be called after this).
            let _ = unsafe { Box::from_raw(ctx_ptr as *mut ProgressCtx) };

            if inner.prepare_version.load(Ordering::Acquire) != my_version {
                dlog("prepare superseded — discarding result (track changed)".into());
                if info.error == ffi::VozduxanError::Ok {
                    let token = ffi::c_bytes_to_string(&info.token);
                    let token_c = CString::new(token).unwrap();
                    unsafe { ffi::vozduxan_stream_release(inner.ptr, token_c.as_ptr()) };
                }
                return Err("Отменено".into());
            }

            // Handle cancel (prepare finished but caller gave up).
            if inner.prepare_cancelled.load(Ordering::Relaxed) {
                dlog("prepare cancelled after C++ returned".into());
                if info.error == ffi::VozduxanError::Ok {
                    let token_c =
                        CString::new(ffi::c_bytes_to_string(&info.token)).unwrap();
                    unsafe { ffi::vozduxan_stream_release(inner.ptr, token_c.as_ptr()) };
                }
                return Err("Отменено".into());
            }

            if info.error != ffi::VozduxanError::Ok {
                let msg = ffi::c_bytes_to_string(&info.error_msg);
                dlog(format!("prepare ERROR: {:?} — {msg}", info.error));
                return Err(msg);
            }

            let url   = ffi::c_bytes_to_string(&info.url);
            let token = ffi::c_bytes_to_string(&info.token);
            dlog(format!("prepare OK — token={token}"));

            // Release old current stream.
            let mut current = inner.current_token.lock().unwrap();
            if let Some(old) = current.take() {
                dlog(format!("prepare: releasing old current token={old}"));
                let old_c = CString::new(old).unwrap();
                unsafe { ffi::vozduxan_stream_release(inner.ptr, old_c.as_ptr()) };
            }
            *current = Some(token);

            Ok(url)
        })
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

        let _ = app.emit(
            "torrent-prepare-progress",
            PrepareProgressPayload::buffering(100.0, "Готово"),
        );

        Ok(url)
    }

    /* ── release_token ─────────────────────────────────────────────────── */
    pub fn release_token(&self, token: &str) {
        self.dlog(format!("release_token({token})"));
        let token_c = CString::new(token).unwrap();
        let t0 = std::time::Instant::now();
        unsafe { ffi::vozduxan_stream_release(self.inner.ptr, token_c.as_ptr()) };
        self.dlog(format!("release_token({token}) done in {:?}", t0.elapsed()));
        let mut current = self.inner.current_token.lock().unwrap();
        if current.as_deref() == Some(token) {
            *current = None;
        }
        let mut prefetch = self.inner.prefetch_token.lock().unwrap();
        if prefetch.as_deref() == Some(token) {
            *prefetch = None;
        }
        let mut warm = self.inner.warm_prefetch_token.lock().unwrap();
        if warm.as_deref() == Some(token) {
            *warm = None;
        }
    }

    /* ── dispose (release all) ─────────────────────────────────────────── */
    pub fn dispose(&self) {
        let mut current = self.inner.current_token.lock().unwrap();
        if let Some(token) = current.take() {
            let c = CString::new(token).unwrap();
            unsafe { ffi::vozduxan_stream_release(self.inner.ptr, c.as_ptr()) };
        }
        let mut prefetch = self.inner.prefetch_token.lock().unwrap();
        if let Some(token) = prefetch.take() {
            let c = CString::new(token).unwrap();
            unsafe { ffi::vozduxan_stream_release(self.inner.ptr, c.as_ptr()) };
        }
        let mut warm = self.inner.warm_prefetch_token.lock().unwrap();
        if let Some(token) = warm.take() {
            let c = CString::new(token).unwrap();
            unsafe { ffi::vozduxan_stream_release(self.inner.ptr, c.as_ptr()) };
        }
        let mut hover = self.inner.hover_token.lock().unwrap();
        if let Some(token) = hover.take() {
            let c = CString::new(token).unwrap();
            unsafe { ffi::vozduxan_stream_release(self.inner.ptr, c.as_ptr()) };
        }
    }

    /* ── hover_prepare ─────────────────────────────────────────────────── */
    /// Prepare a stream speculatively on hover. Never releases current_token —
    /// stores result in hover_token instead. Safe to call concurrently with
    /// an active stream.
    pub async fn hover_prepare(
        &self,
        app: AppHandle,
        magnet: String,
        file_idx: usize,
        torrent_bytes: Option<Vec<u8>>,
    ) -> Result<String, String> {
        let inner = self.inner.clone();
        let app_clone = app.clone();
        let dlog_arc = self.debug_log.clone();

        let url = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let dlog = |msg: String| { dlog_arc.push("vozduxan", msg, None); };
            let magnet_c = CString::new(magnet.as_str()).unwrap();
            dlog(format!("hover_prepare start — file_idx={file_idx}"));

            let ctx = Box::new(ProgressCtx { app: app_clone });
            let ctx_ptr = Box::into_raw(ctx) as *mut c_void;

            let info = unsafe {
                ffi::vozduxan_stream_prepare(
                    inner.ptr,
                    magnet_c.as_ptr(),
                    torrent_bytes
                        .as_deref()
                        .map(|b| b.as_ptr())
                        .unwrap_or(std::ptr::null()),
                    torrent_bytes.as_deref().map(|b| b.len()).unwrap_or(0),
                    file_idx as c_int,
                    Some(on_progress),
                    ctx_ptr,
                )
            };
            let _ = unsafe { Box::from_raw(ctx_ptr as *mut ProgressCtx) };

            if info.error != ffi::VozduxanError::Ok {
                let msg = ffi::c_bytes_to_string(&info.error_msg);
                dlog(format!("hover_prepare ERROR: {msg}"));
                return Err(msg);
            }

            let url   = ffi::c_bytes_to_string(&info.url);
            let token = ffi::c_bytes_to_string(&info.token);
            dlog(format!("hover_prepare OK — token={token}"));

            // Release old hover token (if any) and park the new one.
            // NEVER touch current_token.
            let mut hover = inner.hover_token.lock().unwrap();
            if let Some(old) = hover.take() {
                dlog(format!("hover_prepare releasing old hover token={old}"));
                let old_c = CString::new(old).unwrap();
                unsafe { ffi::vozduxan_stream_release(inner.ptr, old_c.as_ptr()) };
            }
            *hover = Some(token);
            Ok(url)
        })
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))??;

        Ok(url)
    }

    /* ── hover_release ─────────────────────────────────────────────────── */
    /// Release the hover-prefetch token explicitly (user navigated away without clicking).
    pub fn hover_release(&self, token: &str) {
        self.dlog(format!("hover_release({token})"));
        let token_c = CString::new(token).unwrap();
        unsafe { ffi::vozduxan_stream_release(self.inner.ptr, token_c.as_ptr()) };
        let mut hover = self.inner.hover_token.lock().unwrap();
        if hover.as_deref() == Some(token) {
            *hover = None;
        }
    }

    /* ── hover_activate ────────────────────────────────────────────────── */
    /// Called when the player actually starts using the hover-prefetch URL.
    /// Moves the token from hover_token → current_token, releasing old current.
    pub fn hover_activate(&self, token: &str) {
        self.dlog(format!("hover_activate({token}) — promoting hover→current"));
        // Release old current.
        let mut current = self.inner.current_token.lock().unwrap();
        if let Some(old) = current.take() {
            if old != token {
                self.dlog(format!("hover_activate releasing old current={old}"));
                let old_c = CString::new(old).unwrap();
                unsafe { ffi::vozduxan_stream_release(self.inner.ptr, old_c.as_ptr()) };
            }
        }
        *current = Some(token.to_owned());
        // Remove from hover_token.
        let mut hover = self.inner.hover_token.lock().unwrap();
        if hover.as_deref() == Some(token) {
            *hover = None;
        }
    }

    /* ── cancel_prepare ────────────────────────────────────────────────── */
    pub fn cancel_prepare(&self) {
        self.inner.prepare_cancelled.store(true, Ordering::Relaxed);
    }

    /* ── notify_position ───────────────────────────────────────────────── */
    pub fn notify_position(&self, token: &str, byte_offset: i64) {
        let token_c = CString::new(token).unwrap();
        unsafe { ffi::vozduxan_stream_notify_position(self.inner.ptr, token_c.as_ptr(), byte_offset) };
    }

    /* ── list_files ────────────────────────────────────────────────────── */
    pub async fn list_files(
        &self,
        magnet: String,
        torrent_bytes: Option<Vec<u8>>,
    ) -> Result<Vec<TorrentFile>, String> {
        // Clear any stale cancel flag so that a previous closeMagnetPanel() call
        // does not poison this new list_files request with "Загрузка отменена".
        self.inner.prepare_cancelled.store(false, Ordering::Relaxed);

        let inner = self.inner.clone();

        let list = tokio::task::spawn_blocking(move || {
            let magnet_c = CString::new(magnet.as_str()).unwrap();

            let mut list = unsafe {
                ffi::vozduxan_list_files(
                    inner.ptr,
                    magnet_c.as_ptr(),
                    torrent_bytes
                        .as_deref()
                        .map(|b| b.as_ptr())
                        .unwrap_or(std::ptr::null()),
                    torrent_bytes.as_deref().map(|b| b.len()).unwrap_or(0),
                )
            };

            if list.error != ffi::VozduxanError::Ok {
                let msg = ffi::c_bytes_to_string(&list.error_msg);
                unsafe { ffi::vozduxan_file_list_free(&mut list) };
                return Err(msg);
            }

            // Convert VozduxanFileEntry array → Vec<TorrentFile>.
            let entries = unsafe { std::slice::from_raw_parts(list.files, list.count as usize) };
            let files: Vec<TorrentFile> = entries
                .iter()
                .map(|e| TorrentFile {
                    path: vec![ffi::c_bytes_to_string(&e.name)],
                    size: e.size as u64,
                })
                .collect();

            unsafe { ffi::vozduxan_file_list_free(&mut list) };
            Ok(files)
        })
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

        Ok(list)
    }

    /* ── prefetch_next_track ────────────────────────────────────────────── */
    /// Warm the next track in the background. Returns its URL or empty string.
    ///
    /// `warm_only`: second-ahead cache warm-up — parks in `warm_prefetch_token` only so the
    /// real next-track prefetch in `prefetch_token` is never released.
    pub async fn prefetch_next(
        &self,
        magnet: String,
        file_idx: usize,
        torrent_bytes: Option<Vec<u8>>,
        warm_only: bool,
    ) -> Result<String, String> {
        let inner = self.inner.clone();

        let url = tokio::task::spawn_blocking(move || {
            let magnet_c = CString::new(magnet.as_str()).unwrap();

            let info = unsafe {
                ffi::vozduxan_stream_prepare(
                    inner.ptr,
                    magnet_c.as_ptr(),
                    torrent_bytes
                        .as_deref()
                        .map(|b| b.as_ptr())
                        .unwrap_or(std::ptr::null()),
                    torrent_bytes.as_deref().map(|b| b.len()).unwrap_or(0),
                    file_idx as c_int,
                    None,
                    std::ptr::null_mut(),
                )
            };

            if info.error != ffi::VozduxanError::Ok {
                return Err(ffi::c_bytes_to_string(&info.error_msg));
            }

            let url = ffi::c_bytes_to_string(&info.url);
            let token = ffi::c_bytes_to_string(&info.token);

            if warm_only {
                let mut warm = inner.warm_prefetch_token.lock().unwrap();
                if let Some(old) = warm.take() {
                    let old_c = CString::new(old).unwrap();
                    unsafe { ffi::vozduxan_stream_release(inner.ptr, old_c.as_ptr()) };
                }
                *warm = Some(token);
            } else {
                let mut prefetch = inner.prefetch_token.lock().unwrap();
                if let Some(old) = prefetch.take() {
                    let old_c = CString::new(old).unwrap();
                    unsafe { ffi::vozduxan_stream_release(inner.ptr, old_c.as_ptr()) };
                }
                *prefetch = Some(token);
            }
            Ok(url)
        })
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

        Ok(url)
    }
}

/* ══════════════════════════════════════════════════════════════════════════
 *  Tauri command handlers
 * ══════════════════════════════════════════════════════════════════════════ */

#[derive(Serialize)]
pub struct StreamReady {
    pub url: String,
}

/// Result of background prefetch for the next queue item.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrefetchNextResponse {
    StreamReady { url: String },
}

/// Prepare a stream and return its localhost URL.
/// Replaces the librqbit-backed torrent_prepare_stream command.
#[tauri::command]
pub async fn torrent_prepare_stream(
    app: AppHandle,
    state: tauri::State<'_, VozduxanStreamState>,
    magnet: String,
    file_idx: usize,
    torrent_file_b64: Option<String>,
) -> Result<StreamReady, String> {
    let torrent_bytes: Option<Vec<u8>> = match torrent_file_b64.as_deref() {
        None | Some("") => None,
        Some(s) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|e| format!("Неверный base64 торрент-файла: {e}"))?,
        ),
    };

    let url = state.prepare(app, magnet, file_idx, torrent_bytes).await?;
    Ok(StreamReady { url })
}

/// Release a stream by its token.
#[tauri::command]
pub async fn torrent_release_stream(
    state: tauri::State<'_, VozduxanStreamState>,
    token: String,
) -> Result<(), String> {
    state.release_token(&token);
    Ok(())
}

/// Dispose the current preview stream (and any prefetch).
#[tauri::command]
pub async fn torrent_dispose_preview(
    state: tauri::State<'_, VozduxanStreamState>,
) -> Result<(), String> {
    state.dispose();
    Ok(())
}

/// Cancel an in-flight prepare call.
#[tauri::command]
pub async fn torrent_prepare_cancel(
    state: tauri::State<'_, VozduxanStreamState>,
) -> Result<(), String> {
    state.cancel_prepare();
    Ok(())
}

/// Notify the engine of the current playback byte offset (for seek).
/// Call this whenever the audio element fires `timeupdate` or a seek.
#[tauri::command]
pub async fn vozduxan_notify_position(
    state: tauri::State<'_, VozduxanStreamState>,
    token: String,
    byte_offset: i64,
) -> Result<(), String> {
    state.notify_position(&token, byte_offset);
    Ok(())
}

/// Prepare a stream speculatively on hover. Stores in hover_token, NEVER releases
/// the current stream. Replace the old `streamUrl` call in hover-prefetch code.
#[tauri::command]
pub async fn torrent_hover_prepare_stream(
    app: AppHandle,
    state: tauri::State<'_, VozduxanStreamState>,
    magnet: String,
    file_idx: usize,
    torrent_file_b64: Option<String>,
) -> Result<StreamReady, String> {
    let torrent_bytes: Option<Vec<u8>> = match torrent_file_b64.as_deref() {
        None | Some("") => None,
        Some(s) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|e| format!("base64: {e}"))?,
        ),
    };
    let url = state.hover_prepare(app, magnet, file_idx, torrent_bytes).await?;
    Ok(StreamReady { url })
}

/// Release a hover-prefetch stream without activating it (user navigated away).
#[tauri::command]
pub async fn torrent_hover_release_stream(
    state: tauri::State<'_, VozduxanStreamState>,
    token: String,
) -> Result<(), String> {
    state.hover_release(&token);
    Ok(())
}

/// Activate the hover-prefetch: promotes token from hover→current and releases old current.
/// Must be called before assigning the hover URL to the audio element.
#[tauri::command]
pub async fn torrent_hover_activate(
    state: tauri::State<'_, VozduxanStreamState>,
    token: String,
) -> Result<(), String> {
    state.hover_activate(&token);
    Ok(())
}

/// List files inside a magnet/torrent.
#[tauri::command]
pub async fn torrent_magnet_list_files(
    state: tauri::State<'_, VozduxanStreamState>,
    magnet: String,
) -> Result<Vec<TorrentFile>, String> {
    state.list_files(magnet, None).await
}

/// Warm the next track while the current one plays.
#[tauri::command]
pub async fn torrent_prefetch_next_track(
    state: tauri::State<'_, VozduxanStreamState>,
    current_magnet: String,
    current_file_idx: usize,
    next_magnet: String,
    next_file_idx: usize,
    next_torrent_file_b64: Option<String>,
    warm_only: Option<bool>,
) -> Result<PrefetchNextResponse, String> {
    let _ = (current_magnet, current_file_idx); // unused in vozduxan path
    let warm_only = warm_only.unwrap_or(false);

    let torrent_bytes: Option<Vec<u8>> = match next_torrent_file_b64.as_deref() {
        None | Some("") => None,
        Some(s) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|e| format!("Неверный base64 торрент-файла: {e}"))?,
        ),
    };

    let url = state
        .prefetch_next(next_magnet, next_file_idx, torrent_bytes, warm_only)
        .await?;

    Ok(PrefetchNextResponse::StreamReady { url })
}
