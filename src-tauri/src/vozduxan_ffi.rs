//! Raw FFI bindings for vozduxan.
//! These are unsafe C declarations — use `vozduxan_stream` for the safe Rust wrapper.

#![allow(non_camel_case_types, dead_code)]

use std::ffi::{c_char, c_int, c_void};

/// Opaque C++ session handle.
#[repr(C)]
pub struct VozduxanSession {
    _private: [u8; 0],
}

/// Configuration passed to vozduxan_session_create.
#[repr(C)]
pub struct VozduxanConfig {
    /// Path to directory for torrent data (null-terminated).
    pub storage_path: *const c_char,
    /// Max disk usage; 0 = 50 GB.
    pub cache_max_bytes: u64,
    /// Idle-torrent TTL seconds; 0 = 3600.
    pub cache_ttl_secs: u32,
    /// BT listen port; 0 = random.
    pub listen_port: c_int,
    /// Optional log callback; NULL = stderr only.
    pub log_fn: VozduxanLogFn,
    /// Passed verbatim to log_fn.
    pub log_userdata: *mut c_void,
}

/// Error codes returned by vozduxan.
#[repr(C)]
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum VozduxanError {
    Ok = 0,
    MetadataTimeout = 1,
    InvalidFile = 2,
    BadInput = 3,
    Internal = 99,
}

/// Returned by vozduxan_stream_prepare.
#[repr(C)]
pub struct VozduxanStreamInfo {
    /// "http://127.0.0.1:PORT/stream/TOKEN\0..."
    pub url: [u8; 512],
    /// Opaque stream token.
    pub token: [u8; 128],
    pub file_size: i64,
    /// MIME type string.
    pub mime_type: [u8; 64],
    pub error: VozduxanError,
    pub error_msg: [u8; 256],
}

/// A single file entry returned by vozduxan_list_files.
#[repr(C)]
pub struct VozduxanFileEntry {
    pub name: [u8; 512],
    pub mime: [u8; 64],
    pub size: i64,
    pub index: c_int,
}

/// File list returned by vozduxan_list_files (heap-allocated; free with vozduxan_file_list_free).
#[repr(C)]
pub struct VozduxanFileList {
    pub files: *mut VozduxanFileEntry,
    pub count: c_int,
    pub error: VozduxanError,
    pub error_msg: [u8; 256],
}

/// Returned by vozduxan_stream_stats.
#[repr(C)]
pub struct VozduxanStreamStats {
    pub download_rate_bytes: i32,
    pub num_peers: i32,
}

/// Log callback: called for every VOZDUXAN_LOG line (stderr is always written too).
pub type VozduxanLogFn = Option<unsafe extern "C" fn(message: *const c_char, userdata: *mut c_void)>;

/// Progress callback: called periodically during vozduxan_stream_prepare.
pub type VozduxanProgressFn = Option<
    unsafe extern "C" fn(progress: f32, status: *const c_char, userdata: *mut c_void),
>;

#[link(name = "vozduxan", kind = "static")]
unsafe extern "C" {
    pub fn vozduxan_session_create(config: *const VozduxanConfig) -> *mut VozduxanSession;
    pub fn vozduxan_session_destroy(session: *mut VozduxanSession);

    pub fn vozduxan_stream_prepare(
        session: *mut VozduxanSession,
        magnet: *const c_char,
        torrent_data: *const u8,
        torrent_len: usize,
        file_idx: c_int,
        // Non-zero for the active playback track; zero for prefetch/hover.
        is_main: c_int,
        progress_fn: VozduxanProgressFn,
        userdata: *mut c_void,
    ) -> VozduxanStreamInfo;

    pub fn vozduxan_stream_stats(
        session: *mut VozduxanSession,
        token: *const c_char,
    ) -> VozduxanStreamStats;

    pub fn vozduxan_stream_notify_position(
        session: *mut VozduxanSession,
        token: *const c_char,
        byte_offset: i64,
    );

    pub fn vozduxan_stream_release(session: *mut VozduxanSession, token: *const c_char);

    pub fn vozduxan_list_files(
        session: *mut VozduxanSession,
        magnet: *const c_char,
        torrent_data: *const u8,
        torrent_len: usize,
    ) -> VozduxanFileList;

    pub fn vozduxan_file_list_free(list: *mut VozduxanFileList);

    pub fn vozduxan_session_evict(session: *mut VozduxanSession);
    pub fn vozduxan_session_http_port(session: *mut VozduxanSession) -> u16;
}

/// Extract a null-terminated C string from a fixed-size byte array.
pub fn c_bytes_to_string(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}
