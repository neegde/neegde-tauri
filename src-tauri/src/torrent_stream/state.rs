use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, Session, SessionOptions};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use super::types::{PreparedStream, StreamReady};
use super::PREBUFFER_BYTES;

pub struct TorrentStreamState {
    pub(super) inner: Arc<TorrentStreamInner>,
}

pub(super) struct TorrentStreamInner {
    pub(super) app: tauri::AppHandle,
    pub(super) session: Mutex<Option<Arc<Session>>>,
    pub(super) server_addr: Mutex<Option<SocketAddr>>,
    pub(super) streams: Mutex<HashMap<String, Arc<Mutex<PreparedStream>>>>,
    pub(super) token_counter: AtomicU64,
}

impl TorrentStreamState {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            inner: Arc::new(TorrentStreamInner {
                app,
                session: Mutex::new(None),
                server_addr: Mutex::new(None),
                streams: Mutex::new(HashMap::new()),
                token_counter: AtomicU64::new(1),
            }),
        }
    }

    pub(super) async fn prepare(&self, magnet: String, file_idx: usize) -> Result<StreamReady, String> {
        if magnet.trim().is_empty() {
            return Err("Пустой magnet".into());
        }
        let addr = self.inner.ensure_http_server().await?;
        let session = self.inner.ensure_session().await?;

        let opts = AddTorrentOptions {
            only_files: Some(vec![file_idx]),
            overwrite: true,
            ..Default::default()
        };

        let added = session
            .add_torrent(AddTorrent::from_url(&magnet), Some(opts))
            .await
            .map_err(|e| format!("Ошибка открытия торрента: {e}"))?;

        let handle = match added {
            AddTorrentResponse::Added(_, handle) => handle,
            AddTorrentResponse::AlreadyManaged(_, handle) => handle,
            AddTorrentResponse::ListOnly(_) => {
                return Err("Не удалось открыть торрент для стриминга".into());
            }
        };

        handle
            .wait_until_initialized()
            .await
            .map_err(|e| format!("Ошибка инициализации торрента: {e}"))?;

        // Stream only the chosen file and prioritize pieces around stream cursor.
        let mut only = HashSet::new();
        only.insert(file_idx);
        session
            .update_only_files(&handle, &only)
            .await
            .map_err(|e| format!("Ошибка настройки sequential-режима: {e}"))?;

        let mime = handle
            .with_metadata(|meta| {
                meta.file_infos
                    .get(file_idx)
                    .and_then(|fi| fi.relative_filename.extension())
                    .and_then(|e| e.to_str())
                    .map(guess_audio_mime)
                    .unwrap_or("application/octet-stream")
                    .to_string()
            })
            .unwrap_or_else(|_| "application/octet-stream".to_string());

        let mut stream = handle
            .clone()
            .stream(file_idx)
            .map_err(|e| format!("Не удалось открыть поток файла: {e}"))?;

        let total_len = stream.len();
        let target = PREBUFFER_BYTES.min(total_len as usize);
        let mut prebuffer = vec![0u8; target];
        let mut filled = 0usize;
        while filled < target {
            let n = stream
                .read(&mut prebuffer[filled..target])
                .await
                .map_err(|e| format!("Ошибка предварительной буферизации: {e}"))?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        prebuffer.truncate(filled);

        let token = make_token(self.inner.token_counter.fetch_add(1, Ordering::Relaxed));
        let prepared = Arc::new(Mutex::new(PreparedStream {
            stream_pos: filled as u64,
            stream: Box::new(stream),
            prebuffer,
            total_len,
            mime,
        }));

        let mut map = self.inner.streams.lock().await;
        // Keep existing tokens alive: the UI may trigger multiple parallel prepare calls
        // (e.g. preview images + player). Clearing here can invalidate the URL that
        // was just returned to the player before <audio> makes its first HTTP request.
        map.insert(token.clone(), prepared);

        Ok(StreamReady {
            url: format!("http://{addr}/stream/{token}"),
        })
    }

    pub(super) async fn dispose(&self) {
        self.inner.streams.lock().await.clear();
    }
}

impl TorrentStreamInner {
    pub(super) async fn ensure_session(&self) -> Result<Arc<Session>, String> {
        let mut guard = self.session.lock().await;
        if let Some(existing) = &*guard {
            return Ok(existing.clone());
        }

        let base_dir = self
            .app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Не удалось получить app_data_dir: {e}"))?
            .join("torrent_streams");
        std::fs::create_dir_all(&base_dir)
            .map_err(|e| format!("Не удалось создать каталог стриминга: {e}"))?;

        // Avoid persistent DHT: two app sessions (stream + images) would fight the same
        // on-disk DHT state; initialization also fails on some setups ("error initializing persistent DHT").
        let session = Session::new_with_opts(
            base_dir,
            SessionOptions {
                disable_dht_persistence: true,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("Не удалось создать torrent session: {e}"))?;
        *guard = Some(session.clone());
        Ok(session)
    }

    pub(super) async fn ensure_http_server(self: &Arc<Self>) -> Result<SocketAddr, String> {
        let mut guard = self.server_addr.lock().await;
        if let Some(addr) = *guard {
            return Ok(addr);
        }

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| format!("Не удалось запустить HTTP стример: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("Не удалось определить адрес стримера: {e}"))?;
        *guard = Some(addr);

        let inner = self.clone();
        tauri::async_runtime::spawn(async move {
            inner.run_server(listener).await;
        });
        Ok(addr)
    }
}

fn guess_audio_mime(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "m4a" | "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        _ => "application/octet-stream",
    }
}

fn make_token(counter: u64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("{now:x}-{counter:x}")
}
