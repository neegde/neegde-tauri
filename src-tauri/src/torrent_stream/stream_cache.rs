use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use librqbit::api::TorrentIdOrHash;
use librqbit::dht::Id20;
use librqbit::Session;
use serde_json::json;
use tokio::sync::RwLock;

use crate::cache_settings::UserCacheSettings;

use super::debug_log::AppDebugLog;

pub struct StreamCache {
    last_access: DashMap<Id20, Instant>,
    ref_count: DashMap<Id20, u32>,
    token_to_hash: DashMap<String, Id20>,
    inner: tokio::sync::Mutex<StreamCacheState>,
    user_settings: Arc<RwLock<UserCacheSettings>>,
    debug_log: Arc<AppDebugLog>,
}

struct StreamCacheState {
    preparing: HashSet<Id20>,
    export_hash: Option<Id20>,
}

impl StreamCache {
    /// Builds bookkeeping with shared user-tunable limits.
    pub fn new(user_settings: Arc<RwLock<UserCacheSettings>>, debug_log: Arc<AppDebugLog>) -> Self {
        Self {
            last_access: DashMap::new(),
            ref_count: DashMap::new(),
            token_to_hash: DashMap::new(),
            inner: tokio::sync::Mutex::new(StreamCacheState {
                preparing: HashSet::new(),
                export_hash: None,
            }),
            user_settings,
            debug_log,
        }
    }

    /// Marks a torrent as mid-prepare so LRU will not delete it.
    ///
    /// Args:
    ///     hash: Info hash v1 for the magnet being opened.
    pub async fn begin_prepare(&self, hash: Id20) {
        let mut g = self.inner.lock().await;
        g.preparing.insert(hash);
        self.last_access.insert(hash, Instant::now());
    }

    /// Clears the mid-prepare guard after `prepare` finishes.
    ///
    /// Args:
    ///     hash: Same info hash passed to `begin_prepare`.
    pub async fn end_prepare(&self, hash: Id20) {
        let mut g = self.inner.lock().await;
        g.preparing.remove(&hash);
    }

    /// Pins the torrent used by the export-to-folder command so it survives eviction.
    ///
    /// Args:
    ///     hash: Info hash of the torrent being exported.
    pub async fn begin_export(&self, hash: Id20) {
        let mut g = self.inner.lock().await;
        g.export_hash = Some(hash);
        self.last_access.insert(hash, Instant::now());
    }

    /// Clears the export pin after `torrent_export_files` completes.
    pub async fn end_export(&self) {
        let mut g = self.inner.lock().await;
        g.export_hash = None;
    }

    /// Registers a streaming HTTP token so the torrent stays alive until `dispose`.
    ///
    /// Args:
    ///     token: URL segment returned to the player.
    ///     hash: Info hash for the torrent backing that stream.
    pub async fn register_stream_token(&self, token: String, hash: Id20) {
        self.last_access.insert(hash, Instant::now());
        self.ref_count
            .entry(hash)
            .and_modify(|v| *v = v.saturating_add(1))
            .or_insert(1);
        self.token_to_hash.insert(token, hash);
    }

    /// Clears all stream tokens (for example after `torrent_dispose_preview`).
    pub async fn clear_stream_tokens(&self) {
        let hashes: Vec<Id20> = self.token_to_hash.iter().map(|e| *e.value()).collect();
        self.token_to_hash.clear();
        for h in hashes {
            if let Some(mut c) = self.ref_count.get_mut(&h) {
                *c = c.saturating_sub(1);
            }
            if self.ref_count.get(&h).is_some_and(|v| *v == 0) {
                self.ref_count.remove(&h);
            }
        }
    }

    /// Drops one HTTP token from ref bookkeeping (call after removing the stream from `streams`).
    pub async fn unregister_stream_token(&self, token: &str) {
        let Some((_, h)) = self.token_to_hash.remove(token) else {
            return;
        };
        if let Some(mut c) = self.ref_count.get_mut(&h) {
            *c = c.saturating_sub(1);
        }
        if self.ref_count.get(&h).is_some_and(|v| *v == 0) {
            self.ref_count.remove(&h);
        }
    }

    /// Evicts least-recently-used idle torrents when over budget or past TTL.
    ///
    /// Args:
    ///     session: librqbit session that owns the torrents.
    ///     base_dir: Same folder passed to `Session::new_with_opts` for this session.
    pub async fn maybe_reclaim(&self, session: &Session, base_dir: &Path) {
        let (max_bytes, ttl) = {
            let g = self.user_settings.read().await;
            (
                g.stream_cache_max_bytes,
                Duration::from_secs(g.stream_cache_ttl_secs),
            )
        };
        const MAX_STEPS: usize = 256;
        for step in 0..MAX_STEPS {
            let size = directory_size_bytes(base_dir);
            let over_budget = size > max_bytes;
            let victim = {
                let g = self.inner.lock().await;
                g.pick_victim(
                    session,
                    over_budget,
                    ttl,
                    &self.last_access,
                    &self.ref_count,
                )
            };
            let Some(hash) = victim else {
                break;
            };
            if session
                .delete(TorrentIdOrHash::Hash(hash), true)
                .await
                .is_ok()
            {
                self.last_access.remove(&hash);
                self.ref_count.remove(&hash);
                self.token_to_hash.retain(|_, v| *v != hash);
                self.debug_log.push(
                    "cache",
                    format!("evicted {}", hash.as_string()),
                    Some(json!({
                        "step": step,
                        "dirSizeMiB": directory_size_bytes(base_dir) / (1024 * 1024),
                    })),
                );
                #[cfg(debug_assertions)]
                eprintln!(
                    "[stream_cache] evicted info_hash={} step={} dir_size≈{} MiB",
                    hash.as_string(),
                    step,
                    directory_size_bytes(base_dir) / (1024 * 1024)
                );
            } else {
                break;
            }
        }
    }
}

impl StreamCacheState {
    fn is_protected(&self, h: Id20, ref_count: &DashMap<Id20, u32>) -> bool {
        self.preparing.contains(&h)
            || self.export_hash == Some(h)
            || ref_count.get(&h).map(|v| *v).unwrap_or(0) > 0
    }

    fn pick_victim(
        &self,
        session: &Session,
        over_budget: bool,
        idle_ttl: Duration,
        last_access: &DashMap<Id20, Instant>,
        ref_count: &DashMap<Id20, u32>,
    ) -> Option<Id20> {
        let unknown_last_access = || {
            Instant::now()
                .checked_sub(Duration::from_secs(86400 * 365))
                .unwrap_or_else(Instant::now)
        };
        let mut candidates: Vec<(Id20, Instant)> = session.with_torrents(|iter| {
            iter.map(|(_, t)| {
                let ih = t.info_hash();
                let la = last_access
                    .get(&ih)
                    .map(|v| *v.value())
                    .unwrap_or_else(unknown_last_access);
                (ih, la)
            })
            .collect()
        });
        if candidates.is_empty() {
            return None;
        }
        candidates.sort_by_key(|(_, la)| *la);
        for (h, la) in candidates {
            if self.is_protected(h, ref_count) {
                continue;
            }
            if ref_count.get(&h).map(|v| *v).unwrap_or(0) > 0 {
                continue;
            }
            if over_budget {
                return Some(h);
            }
            if la.elapsed() >= idle_ttl {
                return Some(h);
            }
        }
        None
    }
}

/// Returns total file size under `path` (recursive).
pub fn directory_size_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&p) else {
            continue;
        };
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

/// Deletes every torrent in the session together with payload files on disk.
///
/// Args:
///     session: Active librqbit session.
pub async fn purge_session_torrents(session: &Session) {
    let ids: Vec<_> = session.with_torrents(|iter| iter.map(|(id, _)| id).collect());
    for id in ids {
        let _ = session.delete(TorrentIdOrHash::Id(id), true).await;
    }
}
