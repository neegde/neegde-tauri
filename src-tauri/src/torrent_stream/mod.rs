pub mod debug_api;
mod debug_log;
pub mod export;
mod http;
mod state;
mod stream_cache;
mod types;

pub use debug_api::apply_app_debug_from_disk;

pub use stream_cache::{directory_size_bytes, purge_session_torrents};

/// Subfolder under app data for the streaming librqbit session (debug vs release).
pub fn torrent_streams_dir_label() -> &'static str {
    if cfg!(debug_assertions) {
        "torrent_streams_dev"
    } else {
        "torrent_streams"
    }
}

/// Minimum (initial) prebuffer target — fast start at any connection speed.
/// 32 KB is enough to unblock Web Audio on most connections; speed is sampled
/// at 25% (8 KB) so adaptive upsizing happens early on fast links.
pub(super) const PREBUFFER_BYTES: usize = 32 * 1024;
/// Maximum prebuffer when connection is fast (>2 MB/s measured during the first read).
pub(super) const PREBUFFER_ADAPTIVE_MAX: usize = 512 * 1024;
/// One `read` on the file stream — if the swarm sends nothing, bail out of this wait quickly.
pub(super) const PREBUFFER_READ_TIMEOUT_SECS: u64 = 8;
/// Hard cap for the whole prebuffer loop (many small reads).
pub(super) const PREBUFFER_MAX_WALL_SECS: u64 = 20;
pub(super) const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
pub(super) const COPY_CHUNK_BYTES: usize = 256 * 1024;

pub use state::TorrentStreamState;
