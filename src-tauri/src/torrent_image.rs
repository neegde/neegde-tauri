/// Lightweight image fetcher for album cover files inside torrents.
/// Uses a **separate** librqbit session so it never races with the audio streaming session.
///
/// Concurrent fetches for the same magnet share one handle and merge `only_files` into a union
/// so multiple covers download in parallel instead of serializing on a single mutex.
use base64::Engine as _;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, Session, SessionOptions,
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

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
    async fn register_file(
        &mut self,
        session: &Arc<Session>,
        magnet: &str,
        file_idx: usize,
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

            let added = match session
                .add_torrent(AddTorrent::from_url(magnet), Some(opts))
                .await
            {
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
    magnet_states: Arc<Mutex<HashMap<String, Arc<Mutex<MagnetInner>>>>>,
    data_url_cache: Arc<Mutex<HashMap<(String, usize), String>>>,
}

impl TorrentImageState {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let base_dir = app.path().app_data_dir().ok().map(|d| {
            let p = d.join(torrent_images_dir_name());
            let _ = std::fs::create_dir_all(&p);
            p
        });
        Self {
            session: Arc::new(Mutex::new(None)),
            base_dir,
            magnet_states: Arc::new(Mutex::new(HashMap::new())),
            data_url_cache: Arc::new(Mutex::new(HashMap::new())),
        }
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

    pub async fn fetch(&self, magnet: String, file_idx: usize) -> Result<Option<String>, String> {
        let key = (magnet.clone(), file_idx);
        {
            let cache = self.data_url_cache.lock().await;
            if let Some(url) = cache.get(&key) {
                return Ok(Some(url.clone()));
            }
        }

        let inner = self.magnet_mutex(&magnet).await;
        let session = self.ensure_session().await?;

        let handle = {
            let mut g = inner.lock().await;
            match g.register_file(&session, &magnet, file_idx).await? {
                Some(h) => h,
                None => return Ok(None),
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

        if let Some(ref url) = out {
            let mut cache = self.data_url_cache.lock().await;
            Self::cache_put(&mut cache, key, url.clone());
        }
        Ok(out)
    }

    async fn read_image_data_url(
        &self,
        handle: &ManagedTorrentHandle,
        file_idx: usize,
    ) -> Option<String> {
        let mime = handle
            .with_metadata(|meta| {
                meta.file_infos
                    .get(file_idx)
                    .and_then(|fi| fi.relative_filename.extension())
                    .and_then(|e| e.to_str())
                    .map(|ext| match ext.to_ascii_lowercase().as_str() {
                        "png" => "image/png",
                        "webp" => "image/webp",
                        _ => "image/jpeg",
                    })
                    .unwrap_or("image/jpeg")
                    .to_string()
            })
            .unwrap_or_else(|_| "image/jpeg".to_string());

        let mut stream = handle.clone().stream(file_idx).ok()?;

        let total = stream.len() as usize;
        if total == 0 || total > MAX_IMAGE_BYTES {
            return None;
        }

        let result = tokio::time::timeout(Duration::from_secs(FETCH_TIMEOUT_SECS), async move {
            let mut buf = vec![0u8; total];
            let mut pos = 0usize;
            while pos < total {
                match stream.read(&mut buf[pos..]).await {
                    Ok(0) => break,
                    Ok(n) => pos += n,
                    Err(_) => return None,
                }
            }
            if pos == 0 {
                None
            } else {
                Some(buf[..pos].to_vec())
            }
        })
        .await;

        let bytes = match result {
            Ok(Some(b)) => b,
            _ => return None,
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
) -> Result<Option<String>, String> {
    state.fetch(magnet, file_idx).await
}
