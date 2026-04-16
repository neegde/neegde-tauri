/// Lightweight image fetcher for album cover files inside torrents.
/// Uses a **separate** librqbit session so it never races with the audio streaming session.
///
/// Concurrent fetches for the same magnet share one handle and merge `only_files` into a union
/// so multiple covers download in parallel instead of serializing on a single mutex.
use base64::Engine as _;
use bytes::Bytes;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, Session, SessionOptions,
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

use crate::torrent_stream::debug_log::AppDebugLog;

type ManagedTorrentHandle = Arc<ManagedTorrent>;

const MAX_IMAGE_BYTES: usize = 3 * 1024 * 1024; // 3 MB hard cap
const FETCH_TIMEOUT_SECS: u64 = 15;

/// Subfolder under app data for the cover-art librqbit session (debug vs release).
pub fn torrent_images_dir_label() -> &'static str {
    if cfg!(debug_assertions) {
        "torrent_images_dev"
    } else {
        "torrent_images"
    }
}

fn torrent_images_dir_name() -> &'static str {
    torrent_images_dir_label()
}
/// In-memory cache for successful data URLs (avoids repeat BT work and IPC payload).
const CACHE_MAX_ENTRIES: usize = 128;

struct MagnetInner {
    handle: Option<ManagedTorrentHandle>,
    refcounts: HashMap<usize, usize>,
}

impl Default for MagnetInner {
    fn default() -> Self {
        Self {
            handle: None,
            refcounts: HashMap::new(),
        }
    }
}

impl MagnetInner {
    fn rollback_refcount(&mut self, file_idx: usize) {
        if let Some(c) = self.refcounts.get_mut(&file_idx) {
            *c = c.saturating_sub(1);
            if *c == 0 {
                self.refcounts.remove(&file_idx);
            }
        }
    }

    /// Registers interest in `file_idx`, ensures the torrent handle selects all active indices.
    /// `torrent_file`: optional `.torrent` bytes — skips DHT metadata resolution when provided.
    async fn register_file(
        &mut self,
        session: &Arc<Session>,
        magnet: &str,
        file_idx: usize,
        torrent_file: Option<Vec<u8>>,
    ) -> Result<Option<ManagedTorrentHandle>, String> {
        *self.refcounts.entry(file_idx).or_insert(0) += 1;
        let only_set: HashSet<_> = self.refcounts.keys().copied().collect();

        if self.handle.is_none() {
            let indices_vec: Vec<usize> = only_set.iter().copied().collect();
            let opts = AddTorrentOptions {
                only_files: Some(indices_vec),
                overwrite: true,
                ..Default::default()
            };

            let add_src = match torrent_file {
                Some(tf) if !tf.is_empty() => AddTorrent::TorrentFileBytes(Bytes::from(tf)),
                _ => AddTorrent::from_url(magnet),
            };
            let added = match session.add_torrent(add_src, Some(opts)).await {
                Ok(a) => a,
                Err(e) => {
                    self.rollback_refcount(file_idx);
                    return Err(format!("{e}"));
                }
            };

            let handle = match added {
                AddTorrentResponse::Added(_, h) => h,
                AddTorrentResponse::AlreadyManaged(_, h) => {
                    if let Err(e) = session.update_only_files(&h, &only_set).await {
                        self.rollback_refcount(file_idx);
                        return Err(format!("{e}"));
                    }
                    h
                }
                AddTorrentResponse::ListOnly(_) => {
                    self.rollback_refcount(file_idx);
                    return Ok(None);
                }
            };

            if let Err(e) = handle.wait_until_initialized().await {
                self.rollback_refcount(file_idx);
                return Err(format!("{e}"));
            }

            self.handle = Some(handle.clone());
            return Ok(Some(handle));
        }

        let handle = self
            .handle
            .as_ref()
            .expect("handle set when refcounts non-empty")
            .clone();
        session
            .update_only_files(&handle, &only_set)
            .await
            .map_err(|e| {
                self.rollback_refcount(file_idx);
                format!("{e}")
            })?;
        Ok(Some(handle))
    }

    /// Drops interest in `file_idx`; updates selected files for remaining refcounts.
    /// Returns `true` when this magnet has no active fetches left.
    async fn unregister_file(
        &mut self,
        session: &Arc<Session>,
        file_idx: usize,
    ) -> Result<bool, String> {
        self.rollback_refcount(file_idx);

        if self.refcounts.is_empty() {
            self.handle = None;
            return Ok(true);
        }

        let only_set: HashSet<_> = self.refcounts.keys().copied().collect();
        if let Some(ref handle) = self.handle {
            session
                .update_only_files(handle, &only_set)
                .await
                .map_err(|e| format!("{e}"))?;
        }
        Ok(false)
    }
}

pub struct TorrentImageState {
    session: Arc<Mutex<Option<Arc<Session>>>>,
    base_dir: Option<std::path::PathBuf>,
    /// Path to the vozduxan streaming cache (same dir VozduxanStreamState uses).
    /// When a cover image was already downloaded by the audio streaming session
    /// it can be read directly from disk, avoiding a second BitTorrent connection
    /// to the same swarm.
    vozduxan_storage: Option<std::path::PathBuf>,
    magnet_states: Arc<Mutex<HashMap<String, Arc<Mutex<MagnetInner>>>>>,
    data_url_cache: Arc<Mutex<HashMap<(String, usize), String>>>,
    debug_log: Arc<AppDebugLog>,
}

impl TorrentImageState {
    pub fn new(app: &tauri::AppHandle, debug_log: Arc<AppDebugLog>) -> Self {
        let base_dir = app.path().app_data_dir().ok().map(|d| {
            let p = d.join(torrent_images_dir_name());
            let _ = std::fs::create_dir_all(&p);
            p
        });
        let vozduxan_storage = app.path().app_data_dir().ok().map(|d| {
            let label = if cfg!(debug_assertions) {
                "vozduxan_streams_dev"
            } else {
                "vozduxan_streams"
            };
            d.join(label)
        });
        Self {
            session: Arc::new(Mutex::new(None)),
            base_dir,
            vozduxan_storage,
            magnet_states: Arc::new(Mutex::new(HashMap::new())),
            data_url_cache: Arc::new(Mutex::new(HashMap::new())),
            debug_log,
        }
    }

    fn dlog(&self, msg: impl Into<String>) {
        self.debug_log.push("cover", msg.into(), None);
    }

    fn cache_put(
        cache: &mut HashMap<(String, usize), String>,
        key: (String, usize),
        value: String,
    ) {
        if cache.len() >= CACHE_MAX_ENTRIES && !cache.contains_key(&key) {
            if let Some(k) = cache.keys().next().cloned() {
                cache.remove(&k);
            }
        }
        cache.insert(key, value);
    }

    async fn ensure_session(&self) -> Result<Arc<Session>, String> {
        let mut guard = self.session.lock().await;
        if let Some(ref s) = *guard {
            return Ok(s.clone());
        }
        let dir = self
            .base_dir
            .clone()
            .ok_or_else(|| "нет пути app_data_dir".to_string())?;
        let s = Session::new_with_opts(
            dir,
            SessionOptions {
                disable_dht_persistence: true,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("image session: {e}"))?;
        *guard = Some(s.clone());
        Ok(s)
    }

    async fn magnet_mutex(&self, magnet: &str) -> Arc<Mutex<MagnetInner>> {
        let mut map = self.magnet_states.lock().await;
        map.entry(magnet.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(MagnetInner::default())))
            .clone()
    }

    pub async fn fetch(
        &self,
        magnet: String,
        file_idx: usize,
        torrent_file_bytes: Option<Vec<u8>>,
    ) -> Result<Option<String>, String> {
        // Short prefix of the magnet for readable log lines (info-hash portion).
        let magnet_fp = magnet.get(..80).unwrap_or(&magnet);

        let key = (magnet.clone(), file_idx);
        {
            let cache = self.data_url_cache.lock().await;
            if let Some(_url) = cache.get(&key) {
                self.dlog(format!(
                    "torrent cover: cache hit — file_idx={file_idx} magnet={magnet_fp}…"
                ));
                return Ok(Some(_url.clone()));
            }
        }

        self.dlog(format!(
            "torrent cover: start — file_idx={file_idx} has_torrent_data={} magnet={magnet_fp}…",
            torrent_file_bytes.is_some(),
        ));

        let inner = self.magnet_mutex(&magnet).await;
        let session = self.ensure_session().await.map_err(|e| {
            self.dlog(format!("torrent cover: librqbit session init failed — {e}"));
            e
        })?;

        let handle = {
            let mut g = inner.lock().await;
            match g
                .register_file(&session, &magnet, file_idx, torrent_file_bytes)
                .await
                .map_err(|e| {
                    self.dlog(format!(
                        "torrent cover: register_file failed — file_idx={file_idx} err={e}"
                    ));
                    e
                })? {
                Some(h) => h,
                None => {
                    self.dlog(format!(
                        "torrent cover: got ListOnly response (no download) — file_idx={file_idx}"
                    ));
                    return Ok(None);
                }
            }
        };

        if let Err(e) = handle.wait_until_initialized().await {
            let mut g = inner.lock().await;
            let should_remove = g.unregister_file(&session, file_idx).await.unwrap_or(false);
            drop(g);
            if should_remove {
                let mut map = self.magnet_states.lock().await;
                map.remove(&magnet);
            }
            self.dlog(format!(
                "torrent cover: wait_until_initialized failed — file_idx={file_idx} err={e}"
            ));
            return Err(format!("{e}"));
        }

        let out = self.read_image_data_url(&handle, file_idx).await;

        {
            let mut g = inner.lock().await;
            let should_remove = g.unregister_file(&session, file_idx).await.unwrap_or(false);
            drop(g);
            if should_remove {
                let mut map = self.magnet_states.lock().await;
                map.remove(&magnet);
            }
        }

        match &out {
            Some(url) => {
                self.dlog(format!(
                    "torrent cover: OK — file_idx={file_idx} size={}B",
                    url.len(),
                ));
                let mut cache = self.data_url_cache.lock().await;
                Self::cache_put(&mut cache, key, url.clone());
            }
            None => {
                self.dlog(format!(
                    "torrent cover: read returned None — file_idx={file_idx} (see prior log for reason)"
                ));
            }
        }
        Ok(out)
    }

    async fn read_image_data_url(
        &self,
        handle: &ManagedTorrentHandle,
        file_idx: usize,
    ) -> Option<String> {
        // Metadata is already available (wait_until_initialized was called).
        // Extract relative_filename for both MIME detection and disk shortcut.
        let (mime, rel_path) = handle
            .with_metadata(|meta| {
                let fi = meta.file_infos.get(file_idx)?;
                let ext = fi.relative_filename
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                let mime = match ext.to_ascii_lowercase().as_str() {
                    "png"  => "image/png",
                    "webp" => "image/webp",
                    _      => "image/jpeg",
                };
                Some((mime.to_string(), fi.relative_filename.clone()))
            })
            .ok()
            .flatten()
            .unwrap_or_else(|| ("image/jpeg".to_string(), std::path::PathBuf::new()));

        /* ── Disk shortcut ────────────────────────────────────────────────
         * vozduxan (libtorrent) and this librqbit session both download to
         * separate directories.  If vozduxan already has the image file on
         * disk (from a previous or current streaming session of the same
         * album), reading it directly avoids a second BitTorrent connection
         * to the same swarm — seeders often rate-limit per-IP slots, so two
         * concurrent connections can slow down audio piece delivery.        */
        if !rel_path.as_os_str().is_empty() {
            if let Some(ref base) = self.vozduxan_storage {
                let full_path = base.join(&rel_path);
                if full_path.exists() {
                    match std::fs::read(&full_path) {
                        Ok(bytes) if !bytes.is_empty() && bytes.len() <= MAX_IMAGE_BYTES => {
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                            self.dlog(format!(
                                "torrent cover: disk shortcut — read from vozduxan cache \
                                 file_idx={file_idx} size={}B path={}",
                                bytes.len(),
                                full_path.display(),
                            ));
                            return Some(format!("data:{mime};base64,{b64}"));
                        }
                        Ok(_) => {} // empty or oversized — fall through to BitTorrent
                        Err(_) => {} // permission error or race — fall through
                    }
                }
            }
        }

        let stream_result = handle.clone().stream(file_idx);
        let mut stream = match stream_result {
            Ok(s) => s,
            Err(e) => {
                self.dlog(format!(
                    "torrent cover: stream() failed for file_idx={file_idx} — {e}"
                ));
                return None;
            }
        };

        let total = stream.len() as usize;
        if total == 0 {
            self.dlog(format!(
                "torrent cover: file_idx={file_idx} is 0 bytes (empty file in torrent)"
            ));
            return None;
        }
        if total > MAX_IMAGE_BYTES {
            self.dlog(format!(
                "torrent cover: file_idx={file_idx} too large ({total}B > {}B limit) — skipping",
                MAX_IMAGE_BYTES,
            ));
            return None;
        }

        let result = tokio::time::timeout(Duration::from_secs(FETCH_TIMEOUT_SECS), async move {
            let mut buf = vec![0u8; total];
            let mut pos = 0usize;
            while pos < total {
                match stream.read(&mut buf[pos..]).await {
                    Ok(0) => break,
                    Ok(n) => pos += n,
                    Err(e) => {
                        eprintln!("[cover] read error at pos={pos}/{total}: {e}");
                        return None;
                    }
                }
            }
            if pos == 0 { None } else { Some(buf[..pos].to_vec()) }
        })
        .await;

        let bytes = match result {
            Ok(Some(b)) => b,
            Ok(None) => {
                self.dlog(format!(
                    "torrent cover: read returned 0 bytes for file_idx={file_idx} \
                     (piece not available or read error — check stderr)"
                ));
                return None;
            }
            Err(_) => {
                self.dlog(format!(
                    "torrent cover: download timed out after {FETCH_TIMEOUT_SECS}s \
                     for file_idx={file_idx} size={total}B \
                     (torrent may have no seeders or tracker unreachable)"
                ));
                return None;
            }
        };

        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Some(format!("data:{};base64,{}", mime, b64))
    }

    /// Drops the image librqbit session, clears in-memory caches, and wipes the on-disk folder.
    pub async fn purge_all_data(&self) -> Result<(), String> {
        let mut sess_guard = self.session.lock().await;
        if let Some(s) = sess_guard.take() {
            crate::torrent_stream::purge_session_torrents(&s).await;
        }
        drop(sess_guard);
        self.magnet_states.lock().await.clear();
        self.data_url_cache.lock().await.clear();
        if let Some(ref base) = self.base_dir {
            if base.exists() {
                std::fs::remove_dir_all(base).map_err(|e| format!("Очистка кэша обложек: {e}"))?;
            }
            std::fs::create_dir_all(base).map_err(|e| format!("Очистка кэша обложек: {e}"))?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn torrent_fetch_image(
    state: tauri::State<'_, TorrentImageState>,
    magnet: String,
    file_idx: usize,
    torrent_file_b64: Option<String>,
) -> Result<Option<String>, String> {
    let torrent_file_bytes: Option<Vec<u8>> = match torrent_file_b64.as_deref() {
        None | Some("") => None,
        Some(s) => base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .ok(),
    };
    state.fetch(magnet, file_idx, torrent_file_bytes).await
}
