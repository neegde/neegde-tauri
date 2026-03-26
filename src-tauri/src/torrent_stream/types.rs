use serde::Serialize;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncSeek};
use tokio::sync::Mutex;

#[derive(Serialize)]
pub struct StreamReady {
    pub url: String,
}

/// Result of background prefetch for the next queue item (`torrent_prefetch_next_track`).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrefetchNextResponse {
    SameTorrentMerged,
    StreamReady { url: String },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DownloadMode {
    SequentialStartup,
    HybridStreaming,
}

pub(super) struct ReadaheadBuffer {
    pub(super) buffer: Vec<u8>,
    pub(super) start_offset: u64,
}

pub(super) struct PreparedStream {
    pub(super) stream: Box<dyn AsyncReadSeek>,
    pub(super) scheduler_stream: Arc<Mutex<Box<dyn AsyncReadSeek>>>,
    pub(super) prebuffer: Vec<u8>,
    pub(super) readahead: ReadaheadBuffer,
    pub(super) total_len: u64,
    pub(super) stream_pos: u64,
    pub(super) playback_offset: Arc<AtomicU64>,
    pub(super) file_torrent_offset: u64,
    pub(super) download_mode: DownloadMode,
    pub(super) mime: String,
}

#[derive(Default)]
pub(super) struct ParsedRequest {
    pub(super) path: String,
    pub(super) range: Option<(u64, Option<u64>)>,
}

pub(super) trait AsyncReadSeek: AsyncRead + AsyncSeek + Unpin + Send {}
impl<T> AsyncReadSeek for T where T: AsyncRead + AsyncSeek + Unpin + Send {}
