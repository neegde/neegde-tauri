use librqbit::dht::Id20;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, Magnet, Session, SessionOptions,
    TorrentStats, TorrentStatsState,
};
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, RwLock};
use tokio::time::MissedTickBehavior;

use crate::cache_settings::{cache_settings_path, UserCacheSettings};

use super::debug_log::AppDebugLog;
use super::stream_cache::{directory_size_bytes, StreamCache};
use super::types::{PreparedStream, StreamReady};
use super::PREBUFFER_BYTES;

/// Событие `torrent-prepare-progress` — статистика BitTorrent во время подготовки потока (плеер).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TorrentPrepareProgressPayload {
    state: String,
    progress_bytes: u64,
    total_bytes: u64,
    pct: f64,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_mbps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upload_mbps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eta_human: Option<String>,
    peers_queued: usize,
    peers_connecting: usize,
    peers_live: usize,
    peers_seen: usize,
    peers_dead: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    prebuffer_filled: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prebuffer_target: Option<u64>,
}

struct PrepareProgressShared {
    poller_stop: AtomicBool,
    prebuffer_filled: AtomicU64,
    prebuffer_target: AtomicU64,
}

impl PrepareProgressShared {
    fn new() -> Self {
        Self {
            poller_stop: AtomicBool::new(false),
            prebuffer_filled: AtomicU64::new(0),
            prebuffer_target: AtomicU64::new(0),
        }
    }
}

struct PrepareStopGuard(Arc<PrepareProgressShared>);

impl Drop for PrepareStopGuard {
    fn drop(&mut self) {
        self.0.poller_stop.store(true, Ordering::SeqCst);
    }
}

/// Serializes librqbit torrent stats for the streaming debug log (compact JSON).
fn torrent_stats_for_debug(s: &TorrentStats) -> serde_json::Value {
    let peers = s.live.as_ref().map(|l| {
        let p = &l.snapshot.peer_stats;
        json!({
            "queued": p.queued,
            "connecting": p.connecting,
            "live": p.live,
            "seen": p.seen,
            "dead": p.dead,
        })
    });
    let live = s.live.as_ref().map(|l| {
        json!({
            "downloadMbps": l.download_speed.mbps,
            "uploadMbps": l.upload_speed.mbps,
            "eta": l.time_remaining.as_ref().map(|t| format!("{}", t)),
        })
    });
    json!({
        "state": format!("{}", s.state),
        "progressBytes": s.progress_bytes,
        "totalBytes": s.total_bytes,
        "peers": peers,
        "live": live,
        "error": s.error,
    })
}

fn build_prepare_progress_payload(
    s: &TorrentStats,
    prebuffer_filled: u64,
    prebuffer_target: u64,
) -> TorrentPrepareProgressPayload {
    let pct = if s.total_bytes > 0 {
        (s.progress_bytes.min(s.total_bytes) as f64 / s.total_bytes as f64) * 100.0
    } else {
        0.0
    };
    let message = match s.state {
        TorrentStatsState::Initializing => "Получение метаданных торрента…".to_string(),
        TorrentStatsState::Live => "Загрузка по BitTorrent (нужен стартовый буфер)…".to_string(),
        TorrentStatsState::Paused => "Пауза — возобновляем…".to_string(),
        TorrentStatsState::Error => s
            .error
            .clone()
            .unwrap_or_else(|| "Ошибка торрента".to_string()),
    };
    let (download_mbps, upload_mbps, eta_human) = if let Some(ref live) = s.live {
        (
            Some(live.download_speed.mbps),
            Some(live.upload_speed.mbps),
            live.time_remaining.as_ref().map(|t| format!("{}", t)),
        )
    } else {
        (None, None, None)
    };
    let (peers_queued, peers_connecting, peers_live, peers_seen, peers_dead) = s
        .live
        .as_ref()
        .map(|l| {
            let p = &l.snapshot.peer_stats;
            (p.queued, p.connecting, p.live, p.seen, p.dead)
        })
        .unwrap_or((0, 0, 0, 0, 0));
    let (prebuffer_filled_opt, prebuffer_target_opt) = if prebuffer_target > 0 {
        (Some(prebuffer_filled), Some(prebuffer_target))
    } else {
        (None, None)
    };
    TorrentPrepareProgressPayload {
        state: format!("{}", s.state),
        progress_bytes: s.progress_bytes,
        total_bytes: s.total_bytes,
        pct,
        message,
        download_mbps,
        upload_mbps,
        eta_human,
        peers_queued,
        peers_connecting,
        peers_live,
        peers_seen,
        peers_dead,
        prebuffer_filled: prebuffer_filled_opt,
        prebuffer_target: prebuffer_target_opt,
    }
}

pub struct TorrentStreamState {
    pub(super) inner: Arc<TorrentStreamInner>,
}

pub(super) struct TorrentStreamInner {
    pub(super) app: tauri::AppHandle,
    pub(super) session: Mutex<Option<Arc<Session>>>,
    pub(super) server_addr: Mutex<Option<SocketAddr>>,
    pub(super) streams: Mutex<HashMap<String, Arc<Mutex<PreparedStream>>>>,
    pub(super) token_counter: AtomicU64,
    pub(super) stream_cache: Arc<StreamCache>,
    pub(super) cache_settings: Arc<RwLock<UserCacheSettings>>,
    pub(super) debug_log: Arc<AppDebugLog>,
    /// Запрос остановки текущего `torrent_export_files` (из UI).
    pub(super) export_cancel_requested: Arc<AtomicBool>,
    /// Отмена долгого `torrent_prepare_stream` (prebuffer и т.д.).
    pub(super) prepare_cancel_requested: Arc<AtomicBool>,
}

impl TorrentStreamState {
    pub fn new(app: tauri::AppHandle) -> Self {
        let cache_settings = Arc::new(RwLock::new(UserCacheSettings::default()));
        let debug_log = AppDebugLog::new(app.clone());
        Self {
            inner: Arc::new(TorrentStreamInner {
                app,
                session: Mutex::new(None),
                server_addr: Mutex::new(None),
                streams: Mutex::new(HashMap::new()),
                token_counter: AtomicU64::new(1),
                stream_cache: Arc::new(StreamCache::new(
                    cache_settings.clone(),
                    debug_log.clone(),
                )),
                cache_settings,
                debug_log,
                export_cancel_requested: Arc::new(AtomicBool::new(false)),
                prepare_cancel_requested: Arc::new(AtomicBool::new(false)),
            }),
        }
    }

    /// Returns the current user cache limits (RAM limits are not included).
    pub async fn user_cache_settings(&self) -> UserCacheSettings {
        self.inner.cache_settings.read().await.clone()
    }

    /// Returns `(max_bytes, ttl_secs)` for diagnostics without exposing `inner`.
    pub async fn stream_cache_policy_limits(&self) -> (u64, u64) {
        let g = self.inner.cache_settings.read().await;
        (g.stream_cache_max_bytes, g.stream_cache_ttl_secs)
    }

    /// Validates, persists, and applies new cache limits.
    pub async fn apply_user_cache_settings(
        &self,
        settings: UserCacheSettings,
    ) -> Result<(), String> {
        settings.validate()?;
        let path = cache_settings_path(&self.inner.app)?;
        settings.save_to_disk(&path)?;
        *self.inner.cache_settings.write().await = settings;
        self.reclaim_stream_cache_best_effort().await;
        Ok(())
    }

    /// Loads `cache_settings.json` or keeps defaults when missing or invalid.
    pub async fn load_cache_settings_from_disk(&self) -> Result<(), String> {
        let path = cache_settings_path(&self.inner.app)?;
        let mut s = UserCacheSettings::load_from_disk(&path);
        if s.validate().is_err() {
            s = UserCacheSettings::default();
        }
        *self.inner.cache_settings.write().await = s;
        Ok(())
    }

    /// Clears streaming sessions, removes all torrent payload under the stream folder, and recreates it.
    pub async fn purge_streaming_cache_disk(&self) -> Result<(), String> {
        self.dispose().await;
        let mut guard = self.inner.session.lock().await;
        if let Some(s) = guard.take() {
            super::stream_cache::purge_session_torrents(&s).await;
        }
        drop(guard);
        let base = self.inner.stream_torrents_base()?;
        if base.exists() {
            std::fs::remove_dir_all(&base)
                .map_err(|e| format!("Не удалось очистить каталог стриминга: {e}"))?;
        }
        std::fs::create_dir_all(&base)
            .map_err(|e| format!("Не удалось создать каталог стриминга: {e}"))?;
        Ok(())
    }

    fn check_prepare_cancel(&self) -> Result<(), String> {
        if self.inner.prepare_cancel_requested.load(Ordering::SeqCst) {
            self.inner
                .prepare_cancel_requested
                .store(false, Ordering::SeqCst);
            return Err("Загрузка отменена".into());
        }
        Ok(())
    }

    pub(super) async fn prepare(
        &self,
        magnet: String,
        file_idx: usize,
    ) -> Result<StreamReady, String> {
        self.inner
            .prepare_cancel_requested
            .store(false, Ordering::SeqCst);
        if magnet.trim().is_empty() {
            return Err("Пустой magnet".into());
        }
        let m = Magnet::parse(&magnet).map_err(|e| format!("Неверный magnet: {e}"))?;
        let info_hash = m.as_id20().ok_or_else(|| "В magnet нет BTIH".to_string())?;

        self.inner.stream_cache.begin_prepare(info_hash).await;
        let magnet_for_log = magnet.clone();
        let result = self.prepare_inner(magnet, file_idx, info_hash).await;
        self.inner.stream_cache.end_prepare(info_hash).await;
        if let Err(ref e) = result {
            self.inner.debug_log.push(
                "prepare",
                "failed",
                Some(json!({
                    "error": e,
                    "fileIdx": file_idx,
                    "infoHash": info_hash.as_string(),
                    "magnet": magnet_for_log,
                })),
            );
        }
        result
    }

    async fn prepare_inner(
        &self,
        magnet: String,
        file_idx: usize,
        info_hash: Id20,
    ) -> Result<StreamReady, String> {
        self.inner.debug_log.push(
            "prepare",
            "start",
            Some(json!({
                "fileIdx": file_idx,
                "infoHash": info_hash.as_string(),
                "magnet": &magnet,
            })),
        );
        let addr = self.inner.ensure_http_server().await?;
        let session = self.inner.ensure_session().await?;
        let base_dir = self.inner.stream_torrents_base()?;
        let t_reclaim = Instant::now();
        let reclaim_before_mb = if self.inner.debug_log.is_enabled() {
            Some(directory_size_bytes(&base_dir) / (1024 * 1024))
        } else {
            None
        };
        self.inner
            .stream_cache
            .maybe_reclaim(&session, &base_dir)
            .await;
        if let Some(before) = reclaim_before_mb {
            let after = directory_size_bytes(&base_dir) / (1024 * 1024);
            self.inner.debug_log.push(
                "prepare",
                "maybe_reclaim done",
                Some(json!({
                    "ms": t_reclaim.elapsed().as_millis(),
                    "dirSizeMiBBefore": before,
                    "dirSizeMiBAfter": after,
                })),
            );
        }

        let opts = AddTorrentOptions {
            only_files: Some(vec![file_idx]),
            overwrite: true,
            ..Default::default()
        };

        self.inner.debug_log.push(
            "prepare",
            "add_torrent (magnet + only_files)",
            Some(json!({
                "fileIdx": file_idx,
                "magnetLen": magnet.len(),
                "magnet": &magnet,
            })),
        );
        let t_add = Instant::now();
        let add_torrent_await_done = Arc::new(AtomicBool::new(false));
        if self.inner.debug_log.is_enabled() {
            let dbg_hb = self.inner.debug_log.clone();
            let done_flag = Arc::clone(&add_torrent_await_done);
            let info_hash_str = info_hash.as_string();
            let magnet_hb = magnet.clone();
            let t0 = t_add;
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if done_flag.load(Ordering::SeqCst) {
                        break;
                    }
                    dbg_hb.push(
                        "prepare",
                        "add_torrent still awaiting (inside librqbit)",
                        Some(json!({
                            "infoHash": info_hash_str,
                            "fileIdx": file_idx,
                            "msInAwait": t0.elapsed().as_millis(),
                            "magnet": magnet_hb,
                        })),
                    );
                }
            });
        }
        let added = session
            .add_torrent(AddTorrent::from_url(&magnet), Some(opts))
            .await
            .map_err(|e| format!("Ошибка открытия торрента: {e:#}"))?;
        add_torrent_await_done.store(true, Ordering::SeqCst);
        self.inner.debug_log.push(
            "prepare",
            "add_torrent finished",
            Some(json!({ "ms": t_add.elapsed().as_millis() })),
        );

        self.check_prepare_cancel()?;

        let handle = match added {
            AddTorrentResponse::Added(_, handle) => {
                self.inner.debug_log.push(
                    "prepare",
                    "add_torrent response",
                    Some(json!({ "kind": "Added" })),
                );
                handle
            }
            AddTorrentResponse::AlreadyManaged(_, handle) => {
                self.inner.debug_log.push(
                    "prepare",
                    "add_torrent response",
                    Some(json!({ "kind": "AlreadyManaged" })),
                );
                handle
            }
            AddTorrentResponse::ListOnly(_) => {
                self.inner.debug_log.push(
                    "prepare",
                    "add_torrent response",
                    Some(json!({ "kind": "ListOnly" })),
                );
                return Err("Не удалось открыть торрент для стриминга".into());
            }
        };

        self.inner.debug_log.push(
            "prepare",
            "stats before wait_until_initialized",
            Some(torrent_stats_for_debug(&handle.stats())),
        );

        let prep_shared = Arc::new(PrepareProgressShared::new());
        let app_handle = self.inner.app.clone();
        let dbg = self.inner.debug_log.clone();
        let h_poll = handle.clone();
        let prep_for_task = Arc::clone(&prep_shared);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(380));
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if prep_for_task.poller_stop.load(Ordering::SeqCst) {
                    break;
                }
                let s = h_poll.stats();
                let pf = prep_for_task.prebuffer_filled.load(Ordering::Relaxed);
                let pt = prep_for_task.prebuffer_target.load(Ordering::Relaxed);
                let payload = build_prepare_progress_payload(&s, pf, pt);
                let _ = app_handle.emit("torrent-prepare-progress", &payload);
                if dbg.is_enabled() {
                    dbg.push(
                        "prepare",
                        "stats (poller)",
                        Some(json!({
                            "torrent": torrent_stats_for_debug(&s),
                            "prebufferFilled": if pt > 0 { Some(pf) } else { None },
                            "prebufferTarget": if pt > 0 { Some(pt) } else { None },
                        })),
                    );
                }
            }
        });
        let _prep_stop_guard = PrepareStopGuard(Arc::clone(&prep_shared));

        self.inner.debug_log.push(
            "prepare",
            "wait_until_initialized started (metadata + peers; often the slow step)",
            Some(json!({
                "hint": "If this hangs, check peers/state below (tick every 1s until ready)",
            })),
        );
        let wait_done = Arc::new(AtomicBool::new(false));
        let h_wait_log = handle.clone();
        let dbg_wait = self.inner.debug_log.clone();
        let wd = wait_done.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            interval.tick().await;
            loop {
                interval.tick().await;
                if wd.load(Ordering::SeqCst) {
                    break;
                }
                dbg_wait.push(
                    "prepare",
                    "still waiting for torrent init",
                    Some(torrent_stats_for_debug(&h_wait_log.stats())),
                );
            }
        });
        let t_wait = Instant::now();
        handle
            .wait_until_initialized()
            .await
            .map_err(|e| format!("Ошибка инициализации торрента: {e:#}"))?;
        wait_done.store(true, Ordering::SeqCst);
        let wait_ms = t_wait.elapsed().as_millis();
        self.inner.debug_log.push(
            "prepare",
            "torrent initialized",
            Some(json!({
                "infoHash": info_hash.as_string(),
                "waitMs": wait_ms,
                "statsAfterWait": torrent_stats_for_debug(&handle.stats()),
            })),
        );

        self.check_prepare_cancel()?;

        // Stream only the chosen file and prioritize pieces around stream cursor.
        let mut only = HashSet::new();
        only.insert(file_idx);
        session
            .update_only_files(&handle, &only)
            .await
            .map_err(|e| format!("Ошибка настройки sequential-режима: {e:#}"))?;
        self.inner.debug_log.push(
            "prepare",
            "update_only_files done",
            Some(json!({ "fileIdx": file_idx })),
        );

        self.check_prepare_cancel()?;

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
            .map_err(|e| format!("Не удалось открыть поток файла: {e:#}"))?;

        let total_len = stream.len();
        let target = PREBUFFER_BYTES.min(total_len as usize);
        prep_shared
            .prebuffer_target
            .store(target as u64, Ordering::Relaxed);
        let mut prebuffer = vec![0u8; target];
        let mut filled = 0usize;
        const PREBUFFER_LOG_STEP: usize = 64 * 1024;
        self.inner.debug_log.push(
            "prepare",
            "prebuffer loop starting",
            Some(json!({
                "targetBytes": target,
                "totalLen": total_len,
            })),
        );
        let t_pre = Instant::now();
        while filled < target {
            self.check_prepare_cancel()?;
            let before = filled;
            let n = stream
                .read(&mut prebuffer[filled..target])
                .await
                .map_err(|e| format!("Ошибка предварительной буферизации: {e:#}"))?;
            if n == 0 {
                self.inner.debug_log.push(
                    "prepare",
                    "prebuffer read returned 0 (EOF)",
                    Some(json!({
                        "filled": filled,
                        "target": target,
                        "msSoFar": t_pre.elapsed().as_millis(),
                    })),
                );
                break;
            }
            filled += n;
            prep_shared
                .prebuffer_filled
                .store(filled as u64, Ordering::Relaxed);
            if (before / PREBUFFER_LOG_STEP) != (filled / PREBUFFER_LOG_STEP) || filled >= target {
                self.inner.debug_log.push(
                    "prepare",
                    "prebuffer progress",
                    Some(json!({
                        "filled": filled,
                        "target": target,
                        "lastRead": n,
                        "msSoFar": t_pre.elapsed().as_millis(),
                    })),
                );
            }
        }
        prebuffer.truncate(filled);

        self.inner.debug_log.push(
            "prepare",
            "prebuffer done",
            Some(json!({
                "filled": filled,
                "target": target,
                "totalLen": total_len,
                "prebufferMs": t_pre.elapsed().as_millis(),
            })),
        );

        let token = make_token(self.inner.token_counter.fetch_add(1, Ordering::Relaxed));
        self.inner.debug_log.push(
            "prepare",
            "ready",
            Some(json!({
                "urlToken": &token,
                "mime": &mime,
                "totalLen": total_len,
            })),
        );
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
        self.inner
            .stream_cache
            .register_stream_token(token.clone(), info_hash)
            .await;

        Ok(StreamReady {
            url: format!("http://{addr}/stream/{token}"),
        })
    }

    pub(super) async fn dispose(&self) {
        self.inner
            .debug_log
            .push("lifecycle", "dispose preview (clear streams)", None);
        self.inner.stream_cache.clear_stream_tokens().await;
        self.inner.streams.lock().await.clear();
    }

    /// Removes all torrents and their files when the app process exits.
    pub async fn purge_torrent_data_on_exit(&self) {
        let session = self.inner.session.lock().await;
        if let Some(s) = session.as_ref() {
            super::stream_cache::purge_session_torrents(s.as_ref()).await;
        }
    }

    /// Returns how many torrents are registered in the streaming session (0 if not started).
    ///
    /// Returns:
    ///     Count of torrents in the librqbit session, or 0 if the session was never created.
    pub async fn streaming_torrent_count(&self) -> u32 {
        let guard = self.inner.session.lock().await;
        if let Some(s) = guard.as_ref() {
            s.with_torrents(|iter| iter.count() as u32)
        } else {
            0
        }
    }

    /// Triggers cache eviction if the session exists; ignores errors.
    ///
    /// Used after export and on app startup so TTL and the byte cap apply to torrents
    /// that survived in the librqbit session (for example after a crash before exit purge).
    pub async fn reclaim_stream_cache_best_effort(&self) {
        let Ok(session) = self.torrent_session().await else {
            return;
        };
        let Ok(base) = self.inner.stream_torrents_base() else {
            return;
        };
        self.inner.stream_cache.maybe_reclaim(&session, &base).await;
    }

    pub(crate) async fn torrent_session(&self) -> Result<Arc<Session>, String> {
        self.inner.ensure_session().await
    }

    pub(crate) fn export_cancel_reset(&self) {
        self.inner
            .export_cancel_requested
            .store(false, Ordering::SeqCst);
    }

    pub(crate) fn export_cancel_trigger(&self) {
        self.inner
            .export_cancel_requested
            .store(true, Ordering::SeqCst);
    }

    pub(crate) fn export_cancel_triggered(&self) -> bool {
        self.inner.export_cancel_requested.load(Ordering::SeqCst)
    }

    /// Запрос отмены из UI (кнопка «стоп» во время подготовки потока).
    pub fn prepare_cancel_trigger(&self) {
        self.inner.debug_log.push("prepare", "cancel requested", None);
        self.inner
            .prepare_cancel_requested
            .store(true, Ordering::SeqCst);
    }
}

impl TorrentStreamInner {
    /// Returns the filesystem directory used for the streaming librqbit session.
    pub(super) fn stream_torrents_base(&self) -> Result<PathBuf, String> {
        Ok(self
            .app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Не удалось получить app_data_dir: {e}"))?
            .join(super::torrent_streams_dir_label()))
    }

    pub(super) async fn ensure_session(&self) -> Result<Arc<Session>, String> {
        let mut guard = self.session.lock().await;
        if let Some(existing) = &*guard {
            self.debug_log.push(
                "session",
                "reuse existing librqbit session",
                None,
            );
            return Ok(existing.clone());
        }

        let base_dir = self
            .app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Не удалось получить app_data_dir: {e}"))?
            .join(super::torrent_streams_dir_label());
        let session_dir_log = base_dir.to_string_lossy().to_string();
        std::fs::create_dir_all(&base_dir)
            .map_err(|e| format!("Не удалось создать каталог стриминга: {e}"))?;

        // Avoid persistent DHT: two app sessions (stream + images) would fight the same
        // on-disk DHT state; initialization also fails on some setups ("error initializing persistent DHT").
        let session = Session::new_with_opts(
            base_dir,
            SessionOptions {
                disable_dht_persistence: true,
                defer_writes_up_to: Some(32),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("Не удалось создать torrent session: {e}"))?;
        self.debug_log.push(
            "session",
            "new librqbit session",
            Some(json!({ "dir": session_dir_log })),
        );
        *guard = Some(session.clone());
        Ok(session)
    }

    pub(super) async fn ensure_http_server(self: &Arc<Self>) -> Result<SocketAddr, String> {
        let mut guard = self.server_addr.lock().await;
        if let Some(addr) = *guard {
            self.debug_log.push(
                "prepare",
                "http server (reuse)",
                Some(json!({ "addr": addr.to_string() })),
            );
            return Ok(addr);
        }

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| format!("Не удалось запустить HTTP стример: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("Не удалось определить адрес стримера: {e}"))?;
        *guard = Some(addr);
        self.debug_log.push(
            "prepare",
            "http server started",
            Some(json!({ "addr": addr.to_string() })),
        );

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
