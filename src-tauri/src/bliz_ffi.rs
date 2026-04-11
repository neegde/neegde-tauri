//! Raw FFI bindings for blizorukost.
//! These are unsafe C declarations — use `bliz_stream` for the safe Rust wrapper.

#![allow(non_camel_case_types, dead_code)]

use std::ffi::{c_char, c_int, c_void};

/// Opaque C++ session handle.
#[repr(C)]
pub struct BlizSession {
    _private: [u8; 0],
}

/// Configuration passed to bliz_session_create.
#[repr(C)]
pub struct BlizConfig {
    /// Path to directory for torrent data (null-terminated).
    pub storage_path: *const c_char,
    /// Max disk usage; 0 = 50 GB.
    pub cache_max_bytes: u64,
    /// Idle-torrent TTL seconds; 0 = 3600.
    pub cache_ttl_secs: u32,
    /// BT listen port; 0 = random.
    pub listen_port: c_int,
    /// Optional log callback; NULL = stderr only.
    pub log_fn: BlizLogFn,
    /// Passed verbatim to log_fn.
    pub log_userdata: *mut c_void,
}

/// Error codes returned by blizorukost.
#[repr(C)]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BlizError {
    Ok = 0,
    MetadataTimeout = 1,
    InvalidFile = 2,
    BadInput = 3,
    Internal = 99,
}

/// Returned by bliz_stream_prepare.
#[repr(C)]
pub struct BlizStreamInfo {
    /// "http://127.0.0.1:PORT/stream/TOKEN\0..."
    pub url: [u8; 512],
    /// Opaque stream token.
    pub token: [u8; 128],
    pub file_size: i64,
    /// MIME type string.
    pub mime_type: [u8; 64],
    pub error: BlizError,
    pub error_msg: [u8; 256],
}

/// A single file entry returned by bliz_list_files.
#[repr(C)]
pub struct BlizFileEntry {
    pub name: [u8; 512],
    pub mime: [u8; 64],
    pub size: i64,
    pub index: c_int,
}

/// File list returned by bliz_list_files (heap-allocated; free with bliz_file_list_free).
#[repr(C)]
pub struct BlizFileList {
    pub files: *mut BlizFileEntry,
    pub count: c_int,
    pub error: BlizError,
    pub error_msg: [u8; 256],
}

/// Log callback: called for every BLIZ_LOG line (stderr is always written too).
pub type BlizLogFn = Option<unsafe extern "C" fn(message: *const c_char, userdata: *mut c_void)>;

/// Progress callback: called periodically during bliz_stream_prepare.
pub type BlizProgressFn = Option<
    unsafe extern "C" fn(progress: f32, status: *const c_char, userdata: *mut c_void),
>;

#[link(name = "blizorukost", kind = "static")]
unsafe extern "C" {
    pub fn bliz_session_create(config: *const BlizConfig) -> *mut BlizSession;
    pub fn bliz_session_destroy(session: *mut BlizSession);

    pub fn bliz_stream_prepare(
        session: *mut BlizSession,
        magnet: *const c_char,
        torrent_data: *const u8,
        torrent_len: usize,
        file_idx: c_int,
        progress_fn: BlizProgressFn,
        userdata: *mut c_void,
    ) -> BlizStreamInfo;

    pub fn bliz_stream_notify_position(
        session: *mut BlizSession,
        token: *const c_char,
        byte_offset: i64,
    );

    pub fn bliz_stream_release(session: *mut BlizSession, token: *const c_char);

    pub fn bliz_list_files(
        session: *mut BlizSession,
        magnet: *const c_char,
        torrent_data: *const u8,
        torrent_len: usize,
    ) -> BlizFileList;

    pub fn bliz_file_list_free(list: *mut BlizFileList);

    pub fn bliz_session_evict(session: *mut BlizSession);
    pub fn bliz_session_http_port(session: *mut BlizSession) -> u16;
}

/// Extract a null-terminated C string from a fixed-size byte array.
pub fn c_bytes_to_string(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}
