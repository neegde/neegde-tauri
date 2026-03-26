use librqbit::ManagedTorrent;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
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

pub(super) struct StreamMemoryCache {
    pub(super) start_offset: u64,
    pub(super) end_offset: u64,
    pub(super) chunks: VecDeque<(u64, Vec<u8>)>,
    pub(super) total_bytes: usize,
    pub(super) cap_bytes: usize,
}

impl StreamMemoryCache {
    pub(super) fn new(cap_bytes: usize) -> Self {
        Self {
            start_offset: 0,
            end_offset: 0,
            chunks: VecDeque::new(),
            total_bytes: 0,
            cap_bytes,
        }
    }

    pub(super) fn push_sequential(&mut self, offset: u64, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        if self.total_bytes == 0 {
            self.start_offset = offset;
            self.end_offset = offset;
        }
        if offset != self.end_offset {
            self.clear();
            self.start_offset = offset;
            self.end_offset = offset;
        }
        self.chunks.push_back((offset, data.to_vec()));
        self.end_offset = offset.saturating_add(data.len() as u64);
        self.total_bytes = self.total_bytes.saturating_add(data.len());
        while self.total_bytes > self.cap_bytes {
            let Some((_, front)) = self.chunks.pop_front() else {
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(front.len());
            self.start_offset = self.start_offset.saturating_add(front.len() as u64);
        }
        if self.total_bytes == 0 {
            self.start_offset = self.end_offset;
        }
    }

    pub(super) fn read_copy(&self, offset: u64, max_len: usize) -> Vec<u8> {
        if max_len == 0 || offset < self.start_offset || offset >= self.end_offset {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(max_len);
        for (chunk_offset, chunk) in &self.chunks {
            let chunk_end = chunk_offset.saturating_add(chunk.len() as u64);
            if chunk_end <= offset || *chunk_offset >= offset.saturating_add(max_len as u64) {
                continue;
            }
            let start = offset.saturating_sub(*chunk_offset) as usize;
            if start >= chunk.len() {
                continue;
            }
            let take = (max_len - out.len()).min(chunk.len() - start);
            out.extend_from_slice(&chunk[start..start + take]);
            if out.len() >= max_len {
                break;
            }
        }
        out
    }

    pub(super) fn clear(&mut self) {
        self.chunks.clear();
        self.total_bytes = 0;
        self.start_offset = 0;
        self.end_offset = 0;
    }
}

pub(super) struct PreparedStream {
    pub(super) torrent: Arc<ManagedTorrent>,
    pub(super) file_idx: usize,
    pub(super) prebuffer: Vec<u8>,
    pub(super) memory_cache: Arc<Mutex<StreamMemoryCache>>,
    pub(super) total_len: u64,
    pub(super) playback_offset: Arc<AtomicU64>,
    pub(super) file_torrent_offset: u64,
    pub(super) file_torrent_end_offset: u64,
    pub(super) piece_size: u64,
    pub(super) priority_window_pieces: u64,
    pub(super) download_mode: Arc<AtomicU64>,
    pub(super) mime: String,
}

impl PreparedStream {
    pub(super) fn mode(&self) -> DownloadMode {
        if self.download_mode.load(Ordering::Relaxed) == 1 {
            DownloadMode::HybridStreaming
        } else {
            DownloadMode::SequentialStartup
        }
    }

    pub(super) fn set_mode(&self, mode: DownloadMode) {
        let v = match mode {
            DownloadMode::SequentialStartup => 0,
            DownloadMode::HybridStreaming => 1,
        };
        self.download_mode.store(v, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub(super) struct ParsedRequest {
    pub(super) path: String,
    pub(super) range: Option<(u64, Option<u64>)>,
    pub(super) keep_alive: bool,
}
