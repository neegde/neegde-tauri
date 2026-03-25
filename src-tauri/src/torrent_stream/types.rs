use serde::Serialize;
use tokio::io::{AsyncRead, AsyncSeek};

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

pub(super) struct PreparedStream {
    pub(super) stream: Box<dyn AsyncReadSeek>,
    pub(super) prebuffer: Vec<u8>,
    pub(super) total_len: u64,
    pub(super) stream_pos: u64,
    pub(super) mime: String,
}

#[derive(Default)]
pub(super) struct ParsedRequest {
    pub(super) path: String,
    pub(super) range: Option<(u64, Option<u64>)>,
}

pub(super) trait AsyncReadSeek: AsyncRead + AsyncSeek + Unpin + Send {}
impl<T> AsyncReadSeek for T where T: AsyncRead + AsyncSeek + Unpin + Send {}
