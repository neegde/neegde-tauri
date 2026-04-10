use serde::Serialize;

/// Returned by `torrent_prepare_stream` on success.
#[derive(Serialize)]
pub struct StreamReady {
    pub url: String,
    /// Opaque token — pass back to `torrent_notify_position` on timeupdate.
    pub token: String,
}

/// Result of background prefetch for the next queue item.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrefetchNextResponse {
    /// Both current and next track are in the same torrent — the existing
    /// URL already covers the next file (legacy librqbit behaviour).
    /// With blizorukost we always return StreamReady, but keep the variant
    /// for frontend compatibility.
    SameTorrentMerged,
    StreamReady { url: String },
}
