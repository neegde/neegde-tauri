/// Lightweight image fetcher for album cover files inside torrents.
/// Uses a **separate** librqbit session so it never races with the audio streaming session.
use base64::Engine as _;
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, Session};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

const MAX_IMAGE_BYTES: usize = 3 * 1024 * 1024; // 3 MB hard cap
const FETCH_TIMEOUT_SECS: u64 = 15;

pub struct TorrentImageState {
    session: Arc<Mutex<Option<Arc<Session>>>>,
    base_dir: Option<std::path::PathBuf>,
}

impl TorrentImageState {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let base_dir = app.path().app_data_dir().ok().map(|d| {
            let p = d.join("torrent_images");
            let _ = std::fs::create_dir_all(&p);
            p
        });
        Self {
            session: Arc::new(Mutex::new(None)),
            base_dir,
        }
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
        let s = Session::new(dir)
            .await
            .map_err(|e| format!("image session: {e}"))?;
        *guard = Some(s.clone());
        Ok(s)
    }

    pub async fn fetch(&self, magnet: String, file_idx: usize) -> Result<Option<String>, String> {
        let session = self.ensure_session().await?;

        let opts = AddTorrentOptions {
            only_files: Some(vec![file_idx]),
            overwrite: true,
            ..Default::default()
        };

        let added = session
            .add_torrent(AddTorrent::from_url(&magnet), Some(opts))
            .await
            .map_err(|e| format!("{e}"))?;

        let handle = match added {
            AddTorrentResponse::Added(_, h) => h,
            AddTorrentResponse::AlreadyManaged(_, h) => {
                // Re-focus: this torrent was already opened, switch to this file
                let mut only = HashSet::new();
                only.insert(file_idx);
                let _ = session.update_only_files(&h, &only).await;
                h
            }
            AddTorrentResponse::ListOnly(_) => return Ok(None),
        };

        handle
            .wait_until_initialized()
            .await
            .map_err(|e| format!("{e}"))?;

        // Determine MIME type from file extension
        let mime = handle
            .with_metadata(|meta| {
                meta.file_infos
                    .get(file_idx)
                    .and_then(|fi| fi.relative_filename.extension())
                    .and_then(|e| e.to_str())
                    .map(|ext| {
                        match ext.to_ascii_lowercase().as_str() {
                            "png" => "image/png",
                            "webp" => "image/webp",
                            _ => "image/jpeg",
                        }
                    })
                    .unwrap_or("image/jpeg")
                    .to_string()
            })
            .unwrap_or_else(|_| "image/jpeg".to_string());

        let mut stream = handle
            .clone()
            .stream(file_idx)
            .map_err(|e| format!("{e}"))?;

        let total = stream.len() as usize;
        if total == 0 || total > MAX_IMAGE_BYTES {
            return Ok(None);
        }

        // Read the entire image with a timeout — returns None on timeout or error
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
            _ => return Ok(None),
        };

        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(Some(format!("data:{};base64,{}", mime, b64)))
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
