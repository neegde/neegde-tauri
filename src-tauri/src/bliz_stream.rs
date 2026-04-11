//! Safe Rust wrapper around blizorukost C API + Tauri command handlers.
//!
//! This module replaces the librqbit-backed streaming commands in torrent_stream
//! while leaving the export (full-download) functionality untouched.
//!
//! Key design points:
//! - BlizSessionInner owns the *mut BlizSession raw pointer; dropped via bliz_session_destroy.
//! - All blocking C calls run in spawn_blocking to avoid blocking the async executor.
//! - seek_gen (seek_generation) is bumped on every Range request by the C++ HTTP server,
//!   so stale serve_range loops abort within 100 ms.
//! - bliz_notify_position is a new command the frontend should call on seek events.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use base64::Engine as _;
use crate::bliz_ffi as ffi;
use crate::rutracker::TorrentFile;

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

/* ── Inner session (owns the C++ object) ───────────────────────────────── */
struct BlizSessionInner {
    ptr: *mut ffi::BlizSession,
    /// Token of the currently active stream.
    current_token: Mutex<Option<String>>,
    /// Token of the prefetched (background) stream.
    prefetch_token: Mutex<Option<String>>,
    /// Set to true to cancel the next prepare result after it arrives.
    prepare_cancelled: AtomicBool,
}

// SAFETY: BlizSessionImpl is fully thread-safe internally (mutexes + atomics).
unsafe impl Send for BlizSessionInner {}
unsafe impl Sync for BlizSessionInner {}

impl Drop for BlizSessionInner {
    fn drop(&mut self) {
        unsafe { ffi::bliz_session_destroy(self.ptr) };
    }
}

/* ── Public state handle ───────────────────────────────────────────────── */
pub struct BlizStreamState {
    inner: Arc<BlizSessionInner>,
}

impl BlizStreamState {
    pub fn new(app: &AppHandle) -> Self {
        let storage_path = {
            let dir_label = if cfg!(debug_assertions) {
                "bliz_streams_dev"
            } else {
                "bliz_streams"
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

        let cfg = ffi::BlizConfig {
            storage_path: storage_c.as_ptr(),
            cache_max_bytes: 0, // 50 GB default
            cache_ttl_secs: 0,  // 3600 s default
            listen_port: 0,     // random
        };

        let ptr = unsafe { ffi::bliz_session_create(&cfg) };
        assert!(!ptr.is_null(), "bliz_session_create returned null");

        BlizStreamState {
            inner: Arc::new(BlizSessionInner {
                ptr,
                current_token: Mutex::new(None),
                prefetch_token: Mutex::new(None),
                prepare_cancelled: AtomicBool::new(false),
            }),
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

        // Emit "connecting" immediately so the UI shows a spinner.
        let _ = app.emit(
            "torrent-prepare-progress",
            PrepareProgressPayload::buffering(5.0, "Подключение к рою..."),
        );

        let inner = self.inner.clone();
        let app_clone = app.clone();

        // All blizorukost calls happen inside spawn_blocking.
        // We do cancel-check and token management inside the closure
        // so that `inner` doesn't need to be used both inside and outside.
        let url = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let magnet_c = CString::new(magnet.as_str()).unwrap();

            eprintln!("[bliz-rs] prepare spawn_blocking start — file_idx={file_idx} has_torrent_data={}",
                      torrent_bytes.is_some());

            let ctx = Box::new(ProgressCtx { app: app_clone });
            let ctx_ptr = Box::into_raw(ctx) as *mut c_void;

            let info = unsafe {
                ffi::bliz_stream_prepare(
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

            // Handle cancel (prepare finished but caller gave up).
            if inner.prepare_cancelled.load(Ordering::Relaxed) {
                eprintln!("[bliz-rs] prepare was cancelled after C++ returned");
                if info.error == ffi::BlizError::Ok {
                    let token_c =
                        CString::new(ffi::c_bytes_to_string(&info.token)).unwrap();
                    unsafe { ffi::bliz_stream_release(inner.ptr, token_c.as_ptr()) };
                }
                return Err("Отменено".into());
            }

            if info.error != ffi::BlizError::Ok {
                let msg = ffi::c_bytes_to_string(&info.error_msg);
                eprintln!("[bliz-rs] prepare ERROR: {:?} — {msg}", info.error);
                return Err(msg);
            }

            let url   = ffi::c_bytes_to_string(&info.url);
            let token = ffi::c_bytes_to_string(&info.token);
            eprintln!("[bliz-rs] prepare OK — token={token} url={url}");

            // Release old current stream.
            let mut current = inner.current_token.lock().unwrap();
            if let Some(old) = current.take() {
                eprintln!("[bliz-rs] releasing old stream token={old}");
                let old_c = CString::new(old).unwrap();
                unsafe { ffi::bliz_stream_release(inner.ptr, old_c.as_ptr()) };
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
        eprintln!("[bliz-rs] release_token({token}) — called from async context (will block until join)");
        let token_c = CString::new(token).unwrap();
        let t0 = std::time::Instant::now();
        unsafe { ffi::bliz_stream_release(self.inner.ptr, token_c.as_ptr()) };
        eprintln!("[bliz-rs] release_token({token}) done in {:?}", t0.elapsed());
        // Also clear from current_token if it matches.
        let mut current = self.inner.current_token.lock().unwrap();
        if current.as_deref() == Some(token) {
            *current = None;
        }
    }

    /* ── dispose (release all) ─────────────────────────────────────────── */
    pub fn dispose(&self) {
        let mut current = self.inner.current_token.lock().unwrap();
        if let Some(token) = current.take() {
            let c = CString::new(token).unwrap();
            unsafe { ffi::bliz_stream_release(self.inner.ptr, c.as_ptr()) };
        }
        let mut prefetch = self.inner.prefetch_token.lock().unwrap();
        if let Some(token) = prefetch.take() {
            let c = CString::new(token).unwrap();
            unsafe { ffi::bliz_stream_release(self.inner.ptr, c.as_ptr()) };
        }
    }

    /* ── cancel_prepare ────────────────────────────────────────────────── */
    pub fn cancel_prepare(&self) {
        self.inner.prepare_cancelled.store(true, Ordering::Relaxed);
    }

    /* ── notify_position ───────────────────────────────────────────────── */
    pub fn notify_position(&self, token: &str, byte_offset: i64) {
        let token_c = CString::new(token).unwrap();
        unsafe { ffi::bliz_stream_notify_position(self.inner.ptr, token_c.as_ptr(), byte_offset) };
    }

    /* ── list_files ────────────────────────────────────────────────────── */
    pub async fn list_files(
        &self,
        magnet: String,
        torrent_bytes: Option<Vec<u8>>,
    ) -> Result<Vec<TorrentFile>, String> {
        let inner = self.inner.clone();

        let list = tokio::task::spawn_blocking(move || {
            let magnet_c = CString::new(magnet.as_str()).unwrap();

            let mut list = unsafe {
                ffi::bliz_list_files(
                    inner.ptr,
                    magnet_c.as_ptr(),
                    torrent_bytes
                        .as_deref()
                        .map(|b| b.as_ptr())
                        .unwrap_or(std::ptr::null()),
                    torrent_bytes.as_deref().map(|b| b.len()).unwrap_or(0),
                )
            };

            if list.error != ffi::BlizError::Ok {
                let msg = ffi::c_bytes_to_string(&list.error_msg);
                unsafe { ffi::bliz_file_list_free(&mut list) };
                return Err(msg);
            }

            // Convert BlizFileEntry array → Vec<TorrentFile>.
            let entries = unsafe { std::slice::from_raw_parts(list.files, list.count as usize) };
            let files: Vec<TorrentFile> = entries
                .iter()
                .map(|e| TorrentFile {
                    path: vec![ffi::c_bytes_to_string(&e.name)],
                    size: e.size as u64,
                })
                .collect();

            unsafe { ffi::bliz_file_list_free(&mut list) };
            Ok(files)
        })
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;

        Ok(list)
    }

    /* ── prefetch_next_track ────────────────────────────────────────────── */
    /// Warm the next track in the background. Returns its URL or empty string.
    pub async fn prefetch_next(
        &self,
        magnet: String,
        file_idx: usize,
        torrent_bytes: Option<Vec<u8>>,
    ) -> Result<String, String> {
        let inner = self.inner.clone();

        let url = tokio::task::spawn_blocking(move || {
            let magnet_c = CString::new(magnet.as_str()).unwrap();

            let info = unsafe {
                ffi::bliz_stream_prepare(
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

            if info.error != ffi::BlizError::Ok {
                return Err(ffi::c_bytes_to_string(&info.error_msg));
            }

            let url = ffi::c_bytes_to_string(&info.url);
            let token = ffi::c_bytes_to_string(&info.token);

            // Park the prefetch token.
            let mut prefetch = inner.prefetch_token.lock().unwrap();
            if let Some(old) = prefetch.take() {
                let old_c = CString::new(old).unwrap();
                unsafe { ffi::bliz_stream_release(inner.ptr, old_c.as_ptr()) };
            }
            *prefetch = Some(token);
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
    SameTorrentMerged,
    StreamReady { url: String },
}

/// Prepare a stream and return its localhost URL.
/// Replaces the librqbit-backed torrent_prepare_stream command.
#[tauri::command]
pub async fn torrent_prepare_stream(
    app: AppHandle,
    state: tauri::State<'_, BlizStreamState>,
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
    state: tauri::State<'_, BlizStreamState>,
    token: String,
) -> Result<(), String> {
    state.release_token(&token);
    Ok(())
}

/// Dispose the current preview stream (and any prefetch).
#[tauri::command]
pub async fn torrent_dispose_preview(
    state: tauri::State<'_, BlizStreamState>,
) -> Result<(), String> {
    state.dispose();
    Ok(())
}

/// Cancel an in-flight prepare call.
#[tauri::command]
pub async fn torrent_prepare_cancel(
    state: tauri::State<'_, BlizStreamState>,
) -> Result<(), String> {
    state.cancel_prepare();
    Ok(())
}

/// Notify the engine of the current playback byte offset (for seek).
/// Call this whenever the audio element fires `timeupdate` or a seek.
#[tauri::command]
pub async fn bliz_notify_position(
    state: tauri::State<'_, BlizStreamState>,
    token: String,
    byte_offset: i64,
) -> Result<(), String> {
    state.notify_position(&token, byte_offset);
    Ok(())
}

/// List files inside a magnet/torrent.
#[tauri::command]
pub async fn torrent_magnet_list_files(
    state: tauri::State<'_, BlizStreamState>,
    magnet: String,
) -> Result<Vec<TorrentFile>, String> {
    state.list_files(magnet, None).await
}

/// Warm the next track while the current one plays.
#[tauri::command]
pub async fn torrent_prefetch_next_track(
    state: tauri::State<'_, BlizStreamState>,
    current_magnet: String,
    current_file_idx: usize,
    next_magnet: String,
    next_file_idx: usize,
    next_torrent_file_b64: Option<String>,
) -> Result<PrefetchNextResponse, String> {
    let _ = (current_magnet, current_file_idx); // unused in bliz path

    let torrent_bytes: Option<Vec<u8>> = match next_torrent_file_b64.as_deref() {
        None | Some("") => None,
        Some(s) => Some(
            base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|e| format!("Неверный base64 торрент-файла: {e}"))?,
        ),
    };

    let url = state
        .prefetch_next(next_magnet, next_file_idx, torrent_bytes)
        .await?;

    Ok(PrefetchNextResponse::StreamReady { url })
}
