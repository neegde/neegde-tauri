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
    // Suppress high-frequency peer-connection noise that floods the log.
    let lower = msg.to_ascii_lowercase();
    if lower.contains("connecttopeer") || lower.contains("connect to peer") {
        return;
    }
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
    /// Set to true to cancel the next prepare result after it arrives.
    prepare_cancelled: AtomicBool,
    /// Incremented at the start of every `prepare()`; stale completions compare against this.
    prepare_version: AtomicU64,
    /// Counts releases; evict() is called every N-th release to remove stale idle torrents.
    evict_counter: AtomicU64,
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
                prepare_cancelled: AtomicBool::new(false),
                prepare_version: AtomicU64::new(0),
                evict_counter: AtomicU64::new(0),
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

            dlog(format!(
                "prepare: dispatching to C++ — file_idx={file_idx} \
                 has_torrent_data={} version={my_version} \
                 (current={:?} prefetch={:?})",
                torrent_bytes.is_some(),
                inner.current_token.lock().unwrap().as_deref().unwrap_or("—"),
                inner.prefetch_token.lock().unwrap().as_deref().unwrap_or("—"),
            ));

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
                    1, // is_main — cancels any in-flight fast-start
                    Some(on_progress),
                    ctx_ptr,
                )
            };

            // Free the ProgressCtx (callback will not be called after this).
            let _ = unsafe { Box::from_raw(ctx_ptr as *mut ProgressCtx) };

            if inner.prepare_version.load(Ordering::Acquire) != my_version {
                // A newer prepare() call was started before this one finished — its result wins.
                dlog(format!(
                    "prepare: version mismatch (my={my_version} current={}) — \
                     track changed mid-prepare, releasing stale result",
                    inner.prepare_version.load(Ordering::Acquire),
                ));
                if info.error == ffi::VozduxanError::Ok {
                    let token = ffi::c_bytes_to_string(&info.token);
                    let token_c = CString::new(token).unwrap();
                    unsafe { ffi::vozduxan_stream_release(inner.ptr, token_c.as_ptr()) };
                }
                return Err("Отменено".into());
            }

            // Handle cancel (prepare finished but caller gave up before result was used).
            if inner.prepare_cancelled.load(Ordering::Relaxed) {
                dlog("prepare: cancelled flag was set while C++ was running — releasing result".into());
                if info.error == ffi::VozduxanError::Ok {
                    let token_c =
                        CString::new(ffi::c_bytes_to_string(&info.token)).unwrap();
                    unsafe { ffi::vozduxan_stream_release(inner.ptr, token_c.as_ptr()) };
                }
                return Err("Отменено".into());
            }

            if info.error != ffi::VozduxanError::Ok {
                let msg = ffi::c_bytes_to_string(&info.error_msg);
                dlog(format!("prepare: C++ returned error {:?} — {msg}", info.error));
                return Err(msg);
            }

            let url   = ffi::c_bytes_to_string(&info.url);
            let token = ffi::c_bytes_to_string(&info.token);

            // Take the old token and drop the mutex BEFORE calling into C++.
            // vozduxan_stream_release joins the priority thread (~100 ms); holding
            // current_token locked during that call would stall any concurrent
            // torrent_release_stream for the full join duration.
            let old_token = inner.current_token.lock().unwrap().take();
            if let Some(ref old) = old_token {
                let old_c = CString::new(old.as_str()).unwrap();
                unsafe { ffi::vozduxan_stream_release(inner.ptr, old_c.as_ptr()) };
            }
            *inner.current_token.lock().unwrap() = Some(token.clone());
            dlog(format!(
                "prepare: ready — new token={token} replaced={}",
                old_token.as_deref().unwrap_or("—"),
            ));

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
        let token_c = CString::new(token).unwrap();
        let t0 = std::time::Instant::now();
        unsafe { ffi::vozduxan_stream_release(self.inner.ptr, token_c.as_ptr()) };
        let elapsed = t0.elapsed();

        // Determine which bucket(s) held this token so the log is meaningful.
        let mut current = self.inner.current_token.lock().unwrap();
        let was_current = current.as_deref() == Some(token);
        if was_current { *current = None; }
        let mut prefetch = self.inner.prefetch_token.lock().unwrap();
        let was_prefetch = prefetch.as_deref() == Some(token);
        if was_prefetch { *prefetch = None; }
        let mut warm = self.inner.warm_prefetch_token.lock().unwrap();
        let was_warm = warm.as_deref() == Some(token);
        if was_warm { *warm = None; }

        let bucket = match (was_current, was_prefetch, was_warm) {
            (true, _, _) => "current",
            (_, true, _) => "prefetch",
            (_, _, true) => "warm",
            _            => "unknown/external",
        };
        self.dlog(format!("release: token={token} bucket={bucket} took={elapsed:.1?}"));
    }

    /* ── dispose (release all) ─────────────────────────────────────────── */
    pub fn dispose(&self) {
        let mut released = Vec::<String>::new();

        let mut current = self.inner.current_token.lock().unwrap();
        if let Some(token) = current.take() {
            let c = CString::new(token.as_str()).unwrap();
            unsafe { ffi::vozduxan_stream_release(self.inner.ptr, c.as_ptr()) };
            released.push(format!("current={token}"));
        }
        let mut prefetch = self.inner.prefetch_token.lock().unwrap();
        if let Some(token) = prefetch.take() {
            let c = CString::new(token.as_str()).unwrap();
            unsafe { ffi::vozduxan_stream_release(self.inner.ptr, c.as_ptr()) };
            released.push(format!("prefetch={token}"));
        }
        let mut warm = self.inner.warm_prefetch_token.lock().unwrap();
        if let Some(token) = warm.take() {
            let c = CString::new(token.as_str()).unwrap();
            unsafe { ffi::vozduxan_stream_release(self.inner.ptr, c.as_ptr()) };
            released.push(format!("warm={token}"));
        }

        if released.is_empty() {
            self.dlog("dispose: no active tokens — nothing to release");
        } else {
            self.dlog(format!("dispose: released {} token(s) — {}", released.len(), released.join(", ")));
        }
    }

    /* ── cancel_prepare ────────────────────────────────────────────────── */
    pub fn cancel_prepare(&self) {
        self.inner.prepare_cancelled.store(true, Ordering::Relaxed);
        self.dlog("prepare: cancel flag set (C++ call still running, will discard result when it returns)");
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
        let dlog_arc = self.debug_log.clone();

        let url = tokio::task::spawn_blocking(move || {
            let dlog = |msg: String| { dlog_arc.push("vozduxan", msg, None); };
            let bucket_name = if warm_only { "warm" } else { "prefetch" };
            dlog(format!(
                "prefetch-{bucket_name}: dispatching to C++ — \
                 file_idx={file_idx} has_torrent_data={}",
                torrent_bytes.is_some(),
            ));

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
                    0, // is_main=0 — background prefetch must not cancel playback
                    None,
                    std::ptr::null_mut(),
                )
            };

            if info.error != ffi::VozduxanError::Ok {
                let msg = ffi::c_bytes_to_string(&info.error_msg);
                dlog(format!("prefetch-{bucket_name}: C++ error — {msg}"));
                return Err(msg);
            }

            let url = ffi::c_bytes_to_string(&info.url);
            let token = ffi::c_bytes_to_string(&info.token);

            // Same pattern as prepare(): take old token, drop mutex, call C++, re-lock to store new.
            if warm_only {
                let old = inner.warm_prefetch_token.lock().unwrap().take();
                if let Some(ref old_tok) = old {
                    let old_c = CString::new(old_tok.as_str()).unwrap();
                    unsafe { ffi::vozduxan_stream_release(inner.ptr, old_c.as_ptr()) };
                }
                *inner.warm_prefetch_token.lock().unwrap() = Some(token.clone());
                dlog(format!(
                    "prefetch-warm: ready — token={token} replaced={}",
                    old.as_deref().unwrap_or("—"),
                ));
            } else {
                let old = inner.prefetch_token.lock().unwrap().take();
                if let Some(ref old_tok) = old {
                    let old_c = CString::new(old_tok.as_str()).unwrap();
                    unsafe { ffi::vozduxan_stream_release(inner.ptr, old_c.as_ptr()) };
                }
                *inner.prefetch_token.lock().unwrap() = Some(token.clone());
                dlog(format!(
                    "prefetch-next: ready — token={token} replaced={}",
                    old.as_deref().unwrap_or("—"),
                ));
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
    // release_stream() joins the priority_thread (~100ms) — must not block the async executor.
    let inner = state.inner.clone();
    let dlog = state.debug_log.clone();
    tokio::task::spawn_blocking(move || {
        let token_c = CString::new(token.as_str()).unwrap();
        let t0 = std::time::Instant::now();
        unsafe { ffi::vozduxan_stream_release(inner.ptr, token_c.as_ptr()) };
        let elapsed = t0.elapsed();

        // Clear the bucket entry that held this token (no mutex held during C++ call above).
        let was_current  = { let mut g = inner.current_token.lock().unwrap();
                               let yes = g.as_deref() == Some(token.as_str()); if yes { *g = None; } yes };
        let was_prefetch = { let mut g = inner.prefetch_token.lock().unwrap();
                               let yes = g.as_deref() == Some(token.as_str()); if yes { *g = None; } yes };
        let was_warm     = { let mut g = inner.warm_prefetch_token.lock().unwrap();
                               let yes = g.as_deref() == Some(token.as_str()); if yes { *g = None; } yes };

        let bucket = match (was_current, was_prefetch, was_warm) {
            (true, _, _) => "current",
            (_, true, _) => "prefetch",
            (_, _, true) => "warm",
            _            => "unknown/external",
        };
        dlog.push("vozduxan", format!("release: token={token} bucket={bucket} took={elapsed:.1?}"), None);

        // Every 10 releases, evict idle torrents whose TTL has expired so they
        // don't accumulate indefinitely in the libtorrent session.
        let n = inner.evict_counter.fetch_add(1, Ordering::Relaxed) + 1;
        if n % 10 == 0 {
            unsafe { ffi::vozduxan_session_evict(inner.ptr) };
            dlog.push("vozduxan", format!("evict: triggered at release #{n}"), None);
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))
}

/// Dispose the current preview stream (and any prefetch).
#[tauri::command]
pub async fn torrent_dispose_preview(
    state: tauri::State<'_, VozduxanStreamState>,
) -> Result<(), String> {
    // dispose() calls release_stream() for up to 3 tokens — must not block the async executor.
    let inner = state.inner.clone();
    let dlog = state.debug_log.clone();
    tokio::task::spawn_blocking(move || {
        // Collect all tokens and drop ALL mutex guards before calling into C++.
        // vozduxan_stream_release blocks for a priority-thread join (~100 ms per token);
        // holding any of the three Mutex<Option<String>> locks during those calls would
        // serialize unrelated Tauri commands for up to 300 ms total.
        let tokens: Vec<(&'static str, String)> = {
            let mut v = Vec::new();
            if let Some(t) = inner.current_token.lock().unwrap().take()      { v.push(("current", t)); }
            if let Some(t) = inner.prefetch_token.lock().unwrap().take()     { v.push(("prefetch", t)); }
            if let Some(t) = inner.warm_prefetch_token.lock().unwrap().take(){ v.push(("warm", t)); }
            v
        };

        let mut released = Vec::<String>::new();
        for (bucket, token) in &tokens {
            let c = CString::new(token.as_str()).unwrap();
            unsafe { ffi::vozduxan_stream_release(inner.ptr, c.as_ptr()) };
            released.push(format!("{bucket}={token}"));
        }

        // Evict stale idle torrents on explicit cache purge so they don't
        // accumulate in memory between dispose calls.
        unsafe { ffi::vozduxan_session_evict(inner.ptr) };

        if released.is_empty() {
            dlog.push("vozduxan", "dispose: no active tokens — nothing to release (evict done)", None);
        } else {
            dlog.push("vozduxan",
                format!("dispose: released {} token(s) — {}; evict done", released.len(), released.join(", ")),
                None);
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking error: {e}"))
}

/// Cancel an in-flight prepare call.
#[tauri::command]
pub async fn torrent_prepare_cancel(
    state: tauri::State<'_, VozduxanStreamState>,
) -> Result<(), String> {
    state.cancel_prepare();
    Ok(())
}

/// Download stats for a stream token — fast, no blocking disk I/O.
#[derive(Serialize)]
pub struct VozduxanStreamStatsResult {
    pub download_rate: i32, // bytes/sec
    pub num_peers: i32,
}

#[tauri::command]
pub async fn vozduxan_stream_stats(
    state: tauri::State<'_, VozduxanStreamState>,
    token: String,
) -> Result<VozduxanStreamStatsResult, String> {
    let inner = state.inner.clone();
    let token_c = CString::new(token).map_err(|e| e.to_string())?;
    let stats = unsafe { ffi::vozduxan_stream_stats(inner.ptr, token_c.as_ptr()) };
    Ok(VozduxanStreamStatsResult {
        download_rate: stats.download_rate_bytes,
        num_peers: stats.num_peers,
    })
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
