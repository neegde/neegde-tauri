//! Hand-written FFI bindings for blizorukost (libtorrent streaming engine).
//! Mirrors `blizorukost/include/blizorukost.h`.

#![allow(non_camel_case_types, dead_code)]

use std::os::raw::{c_char, c_int, c_void};

/* ── Opaque C handle ────────────────────────────────────────────────────── */
#[repr(C)]
pub struct BlizSession {
    _private: [u8; 0],
}

/* ── Config ─────────────────────────────────────────────────────────────── */
#[repr(C)]
pub struct BlizConfig {
    pub storage_path: *const c_char,
    pub cache_max_bytes: u64,
    pub cache_ttl_secs: u32,
    pub listen_port: c_int,
}

/* ── Error codes ─────────────────────────────────────────────────────────── */
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlizError {
    Ok               = 0,
    MetadataTimeout  = 1,
    InvalidFile      = 2,
    BadInput         = 3,
    Internal         = 99,
}

/* ── Stream result ───────────────────────────────────────────────────────── */
#[repr(C)]
pub struct BlizStreamInfo {
    pub url:       [c_char; 512],
    pub token:     [c_char; 128],
    pub file_size: i64,
    pub mime_type: [c_char; 64],
    pub error:     BlizError,
    pub error_msg: [c_char; 256],
}

impl Default for BlizStreamInfo {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

/* ── File entry ──────────────────────────────────────────────────────────── */
#[repr(C)]
pub struct BlizFileEntry {
    pub name:  [c_char; 512],
    pub mime:  [c_char; 64],
    pub size:  i64,
    pub index: c_int,
}

#[repr(C)]
pub struct BlizFileList {
    pub files:     *mut BlizFileEntry,
    pub count:     c_int,
    pub error:     BlizError,
    pub error_msg: [c_char; 256],
}

impl Default for BlizFileList {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

/* ── Progress callback type ──────────────────────────────────────────────── */
pub type BlizProgressFn = unsafe extern "C" fn(f32, *const c_char, *mut c_void);

/* ── Extern declarations ─────────────────────────────────────────────────── */
extern "C" {
    pub fn bliz_session_create(config: *const BlizConfig) -> *mut BlizSession;
    pub fn bliz_session_destroy(session: *mut BlizSession);

    pub fn bliz_stream_prepare(
        session:      *mut BlizSession,
        magnet:       *const c_char,
        torrent_data: *const u8,
        torrent_len:  usize,
        file_idx:     c_int,
        progress_fn:  Option<BlizProgressFn>,
        userdata:     *mut c_void,
    ) -> BlizStreamInfo;

    pub fn bliz_stream_notify_position(
        session:     *mut BlizSession,
        token:       *const c_char,
        byte_offset: i64,
    );

    pub fn bliz_stream_release(session: *mut BlizSession, token: *const c_char);

    pub fn bliz_list_files(
        session:      *mut BlizSession,
        magnet:       *const c_char,
        torrent_data: *const u8,
        torrent_len:  usize,
    ) -> BlizFileList;

    pub fn bliz_file_list_free(list: *mut BlizFileList);

    pub fn bliz_session_evict(session: *mut BlizSession);

    pub fn bliz_session_http_port(session: *mut BlizSession) -> u16;
}

/* ── Safe wrapper for the raw pointer ───────────────────────────────────── */

/// Newtype that makes the raw C pointer `Send + Sync` so it can live in Tokio
/// `Mutex` and be captured by `spawn_blocking` closures.
/// Safety: blizorukost is internally thread-safe (all shared state behind mutexes).
pub struct BlizSessionHandle(pub *mut BlizSession);

unsafe impl Send for BlizSessionHandle {}
unsafe impl Sync for BlizSessionHandle {}

impl Clone for BlizSessionHandle {
    fn clone(&self) -> Self {
        BlizSessionHandle(self.0)
    }
}

/// Converts a fixed-length C char array to an owned `String`.
/// Returns an empty string on null terminator issues.
pub fn cchars_to_string(buf: &[c_char]) -> String {
    let bytes: Vec<u8> = buf
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}
