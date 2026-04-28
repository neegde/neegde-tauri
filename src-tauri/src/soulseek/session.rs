//! SoulSeek server connection, search, and peer coordination.

use super::proto::{recv_msg, recv_peer_init_or_fti_lead, Buf, Msg, PeerFramedOrRawFti};
use crate::torrent_stream::debug_log::AppDebugLog;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::net::Ipv4Addr;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex as StdMutex,
};
use std::time::Duration;
use tokio::io::{AsyncWriteExt};
use tokio::net::tcp::OwnedReadHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex};
use tauri::{AppHandle, Emitter};

const SERVER_HOST: &str = "server.slsknet.org";
const SERVER_PORT: u16 = 2242;
const CLIENT_VERSION: u32 = 160;
const SEARCH_TIMEOUT_SECS: u64 = 12;
const PEER_ADDR_TIMEOUT_SECS: u64 = 5;
const MAX_SEARCH_RESULTS: usize = 500;
const CONNECT_TO_PEER_TCP_ATTEMPTS: u32 = 4;
const CONNECT_TO_PEER_TCP_TIMEOUT_SECS: u64 = 18;

/// Delivered F socket plus optional state when raw FileTransferInit was consumed early.
pub(crate) struct FConnReady {
    pub(crate) stream: TcpStream,
    /// Set if the 4-byte FileTransferInit was already read from the peer (see `recv_peer_init_or_fti_lead`).
    pub(crate) file_transfer_init_consumed: Option<u32>,
}

/// Shared slot so xfer token (TransferRequest) and server ConnectToPeer token can both match.
pub(crate) struct FConnSlot {
    tx: StdMutex<Option<oneshot::Sender<FConnReady>>>,
    pub(crate) peer_username: String,
}

// ── Token counter ─────────────────────────────────────────────────────────────

pub fn next_token() -> u32 {
    static COUNTER: AtomicU32 = AtomicU32::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

// ── MD5 ───────────────────────────────────────────────────────────────────────

fn md5_hex(s: &str) -> String {
    use md5::{Digest, Md5};
    let mut h = Md5::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

// ── File result ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlskFileResult {
    pub username: String,
    pub filepath: String,
    pub size: u64,
    pub bitrate: Option<u32>,
    pub duration: Option<u32>,
    /// True when this row is an image file from search (cover art), not audio.
    pub is_image: bool,
    /// Peer has at least one free upload slot (value of `slotsFree` from the
    /// search response, applied to every row the peer returned in this batch).
    pub slots_free: bool,
    /// Peer's advertised average upload speed in bytes/second (0 if unknown).
    pub avg_speed: u32,
    /// Current length of the peer's upload queue (0 = empty).
    pub queue_length: u64,
}

// ── Session ───────────────────────────────────────────────────────────────────

/// Payload of the `soulseek-disconnected` Tauri event, emitted exactly once when
/// the server connection or peer listener of a live session terminates.
#[derive(Serialize, Clone)]
struct SlskDisconnectedEvent {
    username: String,
    reason: String,
}

pub struct Session {
    pub username: String,
    pub listen_port: u16,
    writer: Mutex<tokio::net::tcp::OwnedWriteHalf>,
    /// token → sender of batches of search results
    pub pending_searches: Arc<DashMap<u32, mpsc::UnboundedSender<Vec<SlskFileResult>>>>,
    /// username → oneshot for (ip, port) from GetPeerAddress response
    pub pending_peer_addr: Arc<DashMap<String, oneshot::Sender<(Ipv4Addr, u16)>>>,
    /// xfer / server token → shared slot for the F-type TcpStream
    pub pending_f_conns: Arc<DashMap<u32, Arc<FConnSlot>>>,
    /// Lowercase SoulSeek username → FIFO of xfer tokens waiting for `ConnectToPeer` type F.
    pending_f_peer_order: Arc<DashMap<String, VecDeque<u32>>>,
    pub debug_log: Arc<AppDebugLog>,
    /// Set when the underlying server connection or peer listener has terminated.
    /// Read by `is_dead()` / `soulseek_status` / `SoulSeekState::get_session` so the UI
    /// surfaces the broken socket immediately instead of after a 12 s search timeout.
    dead: AtomicBool,
    /// Used to emit `soulseek-disconnected` exactly once when the session goes stale.
    app_handle: AppHandle,
}

impl Session {
    /// Route a message to the in-app debug window.
    pub fn slog(&self, msg: impl Into<String>) {
        self.debug_log.push("soulseek", msg, None);
    }

    /// Returns true if this session's network plumbing has terminated.
    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Acquire)
    }

    /// Marks the session as dead and notifies the frontend exactly once. Subsequent
    /// calls are no-ops thanks to the atomic swap, so it is safe to invoke from any
    /// failure path (server reader exit, peer listener exit, write error in
    /// `send_raw`).
    ///
    /// Args:
    ///     reason: Short human-readable explanation routed to the debug log and
    ///         the `soulseek-disconnected` event payload.
    pub fn mark_dead_and_notify(&self, reason: impl Into<String>) {
        if self.dead.swap(true, Ordering::AcqRel) {
            return;
        }
        let reason = reason.into();
        self.slog(format!("session marked dead: {reason}"));
        let _ = self.app_handle.emit(
            "soulseek-disconnected",
            SlskDisconnectedEvent {
                username: self.username.clone(),
                reason,
            },
        );
    }
}

impl Session {
    /// Connect to the SoulSeek server and authenticate. Returns `Arc<Session>` on success.
    ///
    /// Args:
    ///     app_handle: Tauri handle used to emit `soulseek-disconnected` if the session
    ///         later goes stale (server idle-kick, NAT timeout, sleep/wake).
    ///     username: SoulSeek account name.
    ///     password: SoulSeek password.
    ///     debug_log: Shared debug log sink so server/peer protocol traces appear in
    ///         the in-app console alongside C++ and torrent logs.
    ///
    /// Returns:
    ///     Live session on success or a human-readable error string on login failure.
    pub async fn connect(app_handle: AppHandle, username: String, password: String, debug_log: Arc<AppDebugLog>) -> Result<Arc<Self>, String> {
        let stream = TcpStream::connect((SERVER_HOST, SERVER_PORT))
            .await
            .map_err(|e| format!("Cannot connect to SoulSeek server: {e}"))?;
        stream.set_nodelay(true).ok();

        let (mut read_half, mut write_half) = stream.into_split();

        // Send Login (code 1)
        let hash = md5_hex(&format!("{username}{password}"));
        let login_msg = Msg::new(1)
            .str(&username)
            .str(&password)
            .u32(CLIENT_VERSION)
            .str(&hash)
            .u32(1)
            .build();
        write_half.write_all(&login_msg).await
            .map_err(|e| format!("Login send error: {e}"))?;
        write_half.flush().await.ok();

        // Read login response
        let resp = tokio::time::timeout(Duration::from_secs(15), recv_msg(&mut read_half))
            .await
            .map_err(|_| "Login timed out".to_string())?
            .map_err(|e| format!("Login response read error: {e}"))?;

        let mut b = Buf::new(&resp);
        if b.u32().unwrap_or(0) != 1 {
            return Err("Unexpected login response code".to_string());
        }
        let success = b.bool().unwrap_or(false);
        if !success {
            let reason = b.str().unwrap_or_else(|| "Unknown error".to_string());
            return Err(format!("Login rejected by server: {reason}"));
        }
        // Ignore greeting / IP / MOTD

        // Bind peer listener
        let listener = TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| format!("Cannot bind peer listener: {e}"))?;
        let listen_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);

        // SetWaitPort (code 2)
        let setwait = Msg::new(2).u32(listen_port as u32).build();
        write_half.write_all(&setwait).await.ok();
        write_half.flush().await.ok();

        let pending_searches = Arc::new(DashMap::new());
        let pending_peer_addr = Arc::new(DashMap::new());
        let pending_f_conns = Arc::new(DashMap::new());
        let pending_f_peer_order = Arc::new(DashMap::new());

        let session = Arc::new(Session {
            username: username.clone(),
            listen_port,
            writer: Mutex::new(write_half),
            pending_searches: Arc::clone(&pending_searches),
            pending_peer_addr: Arc::clone(&pending_peer_addr),
            pending_f_conns: Arc::clone(&pending_f_conns),
            pending_f_peer_order: Arc::clone(&pending_f_peer_order),
            debug_log,
            dead: AtomicBool::new(false),
            app_handle,
        });

        // Post-login housekeeping messages expected by the server
        {
            // HaveNoParent (71, bool=true): we're not in the distributed network
            let msg = Msg::new(71).bool(true).build();
            session.send_raw(msg).await.ok();

            // SharedFolderFiles (35): report 0 shared dirs/files (needed to appear as valid client)
            let msg = Msg::new(35).u32(0).u32(0).build();
            session.send_raw(msg).await.ok();

            // CheckPrivileges (92)
            let msg = Msg::new(92).build();
            session.send_raw(msg).await.ok();
        }

        // Spawn background tasks (hold Weak so tasks exit when Arc is dropped)
        {
            let sess = Arc::downgrade(&session);
            tauri::async_runtime::spawn(async move {
                server_reader_loop(read_half, sess).await;
            });
        }
        {
            let sess = Arc::downgrade(&session);
            tauri::async_runtime::spawn(async move {
                peer_listener_loop(listener, sess).await;
            });
        }

        session.slog(format!("logged in as '{username}', listen_port={listen_port}"));
        Ok(session)
    }

    /// Send a pre-built message to the server. On any I/O failure the session is
    /// flagged dead immediately so subsequent searches fail fast with a useful
    /// error instead of silently waiting out the 12 s search timeout.
    pub async fn send_raw(&self, data: Vec<u8>) -> std::io::Result<()> {
        let res = {
            let mut w = self.writer.lock().await;
            match w.write_all(&data).await {
                Ok(()) => w.flush().await,
                Err(e) => Err(e),
            }
        };
        if let Err(ref e) = res {
            self.mark_dead_and_notify(format!("server write failed: {e}"));
        }
        res
    }

    /// Network-wide file search. Blocks up to SEARCH_TIMEOUT_SECS collecting results.
    ///
    /// When `app` is set, each non-empty peer batch is emitted as `soulseek-search-batch`
    /// with `{ requestId, rows }` so the UI can update incrementally.
    ///
    /// Args:
    ///     query: Search string sent to the SoulSeek server.
    ///     app: When `Some`, emits `soulseek-search-batch` after each batch; use `None` to skip.
    ///     request_id: Correlates events with the frontend `invoke` call (ignore stale searches).
    ///
    /// Returns:
    ///     Deduped file hits in network batch order (same as the final command payload).
    pub async fn search(
        &self,
        query: String,
        app: Option<AppHandle>,
        request_id: u64,
    ) -> Vec<SlskFileResult> {
        let token = next_token();
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<SlskFileResult>>();
        self.pending_searches.insert(token, tx);

        self.slog(format!("search: sending FileSearch token={} query={:?}", token, query));
        let msg = Msg::new(26).u32(token).str(&query).build();
        if self.send_raw(msg).await.is_err() {
            self.slog("search: failed to send FileSearch");
            self.pending_searches.remove(&token);
            return vec![];
        }
        self.slog(format!("search: FileSearch sent, waiting {}s for results…", SEARCH_TIMEOUT_SECS));

        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(SEARCH_TIMEOUT_SECS);
        let mut results: Vec<SlskFileResult> = Vec::new();

        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(batch)) => {
                    if !batch.is_empty() {
                        if let Some(ref app) = app {
                            let rows = super::file_results_to_rows(batch.clone());
                            let payload = super::SlskSearchBatchEvent { request_id, rows };
                            let _ = app.emit("soulseek-search-batch", &payload);
                        }
                    }
                    results.extend(batch);
                    if results.len() >= MAX_SEARCH_RESULTS {
                        break;
                    }
                }
                _ => break,
            }
        }

        self.pending_searches.remove(&token);
        self.slog(format!("search: collected {} raw results for {:?}", results.len(), query));

        // Dedup: keep one entry per (username, filepath) — first occurrence wins (arrival order)
        let mut seen = std::collections::HashSet::new();
        results.retain(|r| {
            let key = format!("{}|{}", r.username, r.filepath.to_lowercase());
            seen.insert(key)
        });

        results
    }

    /// Ask server for a peer's IP and port. Times out after PEER_ADDR_TIMEOUT_SECS.
    pub async fn get_peer_addr(&self, username: &str) -> Option<(Ipv4Addr, u16)> {
        let (tx, rx) = oneshot::channel();
        self.pending_peer_addr.insert(username.to_string(), tx);

        let msg = Msg::new(3).str(username).build();
        if self.send_raw(msg).await.is_err() {
            self.pending_peer_addr.remove(username);
            return None;
        }

        match tokio::time::timeout(Duration::from_secs(PEER_ADDR_TIMEOUT_SECS), rx).await {
            Ok(Ok(v)) => Some(v),
            _ => {
                self.pending_peer_addr.remove(username);
                None
            }
        }
    }

    /// Register a oneshot for an incoming F (file-transfer) TcpStream identified by xfer_token.
    pub fn register_f_waiter(&self, xfer_token: u32, peer_username: String) -> oneshot::Receiver<FConnReady> {
        let (tx, rx) = oneshot::channel();
        let slot = Arc::new(FConnSlot {
            tx: StdMutex::new(Some(tx)),
            peer_username: peer_username.clone(),
        });
        self.pending_f_conns.insert(xfer_token, Arc::clone(&slot));
        let key = peer_username.to_ascii_lowercase();
        self.pending_f_peer_order.entry(key).or_default().push_back(xfer_token);
        rx
    }

    /// Map server `ConnectToPeer` F token to the xfer-token waiter for this peer (FIFO per username).
    pub fn link_server_f_token(&self, server_token: u32, peer_username: &str) {
        if self.pending_f_conns.contains_key(&server_token) {
            return;
        }
        let key = peer_username.to_ascii_lowercase();
        let xfer_token = {
            let mut ent = self.pending_f_peer_order.entry(key).or_default();
            ent.pop_front()
        };
        let Some(xfer_token) = xfer_token else {
            self.slog(format!("link_server_f_token: no pending F queue entry for user {peer_username}"));
            return;
        };
        let Some(slot) = self.pending_f_conns.get(&xfer_token).map(|e| Arc::clone(e.value())) else {
            self.slog(format!("link_server_f_token: missing slot for xfer_token={xfer_token}"));
            return;
        };
        self.pending_f_conns.insert(server_token, slot);
        self.slog(format!("linked server F token {server_token} → xfer_token={xfer_token} ({peer_username})"));
    }

    /// Remove a registered F waiter (cleanup on cancel/timeout).
    pub fn unregister_f_waiter(&self, xfer_token: u32) {
        let Some((_, slot)) = self.pending_f_conns.remove(&xfer_token) else {
            return;
        };
        self.purge_all_keys_for_slot(&slot);
    }

    /// Drops the F waiter after outbound F failed before a valid PeerInit (see `handle_server_connect_to_peer`).
    pub fn cancel_pending_f_after_outbound_handshake_failure(
        &self,
        server_token: u32,
        peer_username: &str,
    ) {
        if self.pending_f_conns.contains_key(&server_token) {
            self.unregister_f_waiter(server_token);
            return;
        }
        let key = peer_username.to_ascii_lowercase();
        if let Some(xfer_tok) = self.pending_f_peer_order.get(&key).and_then(|q| q.front().copied())
        {
            if self.pending_f_conns.contains_key(&xfer_tok) {
                self.unregister_f_waiter(xfer_tok);
                return;
            }
        }
        if let Some(e) = self.pending_f_conns.iter().next() {
            self.unregister_f_waiter(*e.key());
        }
    }

    fn purge_all_keys_for_slot(&self, slot: &Arc<FConnSlot>) {
        let p = Arc::as_ptr(slot);
        let keys: Vec<u32> = self
            .pending_f_conns
            .iter()
            .filter(|e| Arc::as_ptr(e.value()) == p)
            .map(|e| *e.key())
            .collect();
        let uname_lower = slot.peer_username.to_ascii_lowercase();
        for k in &keys {
            self.pending_f_conns.remove(k);
        }
        if let Some(mut q) = self.pending_f_peer_order.get_mut(&uname_lower) {
            q.retain(|t| !keys.contains(t));
        }
    }

    fn try_deliver_to_slot(slot: &Arc<FConnSlot>, ready: FConnReady) -> bool {
        if let Ok(mut g) = slot.tx.lock() {
            if let Some(tx) = g.take() {
                let _ = tx.send(ready);
                return true;
            }
        }
        false
    }

    /// When exactly one logical F transfer is pending (possibly under multiple token keys).
    fn f_slot_if_unique_transfer(&self) -> Option<Arc<FConnSlot>> {
        let mut first: Option<Arc<FConnSlot>> = None;
        for e in self.pending_f_conns.iter() {
            let s = Arc::clone(e.value());
            match &first {
                None => first = Some(s),
                Some(f) if Arc::as_ptr(f) == Arc::as_ptr(&s) => {}
                Some(_) => return None,
            }
        }
        first
    }

    /// Deliver an F-connection stream to whichever pending_f_conns entry matches token.
    fn deliver_f_stream(&self, token: u32, ready: FConnReady) {
        let slot = self
            .pending_f_conns
            .get(&token)
            .map(|e| Arc::clone(e.value()))
            .or_else(|| {
                // Inbound PeerInit may use a token we never mapped; only safe if one transfer.
                self.f_slot_if_unique_transfer()
            });
        let Some(slot) = slot else {
            self.slog(format!("deliver_f_stream: no F waiter (token={token}), stream dropped"));
            return;
        };
        if Self::try_deliver_to_slot(&slot, ready) {
            self.purge_all_keys_for_slot(&slot);
            return;
        }
        self.slog(format!("deliver_f_stream: slot already consumed (token={token})"));
    }
}

// ── Server reader loop ────────────────────────────────────────────────────────

async fn server_reader_loop(mut rh: OwnedReadHalf, sess: std::sync::Weak<Session>) {
    loop {
        let payload = match recv_msg(&mut rh).await {
            Ok(p) => p,
            Err(e) => {
                // Skip notification if the only remaining strong refs are gone — the
                // session was already replaced by `soulseek_login`/`soulseek_logout`,
                // so a stale "disconnected" event would just flicker the UI.
                if let Some(s) = sess.upgrade() {
                    s.mark_dead_and_notify(format!("server read error: {e}"));
                }
                break;
            }
        };
        let Some(session) = sess.upgrade() else { break };
        if payload.len() < 4 {
            continue;
        }
        let mut b = Buf::new(&payload);
        let code = b.u32().unwrap_or(u32::MAX);
        match code {
            3 => {
                // GetPeerAddress response
                let username = b.str().unwrap_or_default();
                let ip_u32 = b.u32().unwrap_or(0);
                let port = b.u32().unwrap_or(0) as u16;
                if ip_u32 != 0 && port != 0 {
                    // IP is 4 raw bytes in the packet; read as LE u32, reconstruct via to_le_bytes
                    let ip = Ipv4Addr::from(ip_u32.to_be_bytes());
                    session.slog(format!("GetPeerAddress: {username} → {ip}:{port}"));
                    if let Some((_, tx)) = session.pending_peer_addr.remove(&username) {
                        let _ = tx.send((ip, port));
                    }
                }
            }
            18 => {
                // ConnectToPeer: server asks us to connect to a peer
                if let Some((username, conn_type, ip, port, token)) = parse_connect_to_peer(&mut b)
                {
                    if conn_type == "F" {
                        if let Some(s) = sess.upgrade() {
                            s.link_server_f_token(token, &username);
                        }
                    }
                    let sess_weak = std::sync::Weak::clone(&sess);
                    tauri::async_runtime::spawn(async move {
                        handle_server_connect_to_peer(
                            username, conn_type, ip, port, token, sess_weak,
                        )
                        .await;
                    });
                }
            }
            64 | 69 | 83 | 84 | 89 | 90 | 91 | 92 | 93 | 100 | 102 | 104 => {
                // Server keepalive / housekeeping messages — ignore silently
            }
            _ => {
                session.slog(format!("server: unknown code={code}"));
            }
        }
    }
}

fn parse_connect_to_peer(
    b: &mut Buf,
) -> Option<(String, String, Ipv4Addr, u16, u32)> {
    // Try the two known formats for ConnectToPeer (server→client, code 18):
    //   Format A (most clients): token(u32), username(str), type(str), ip(u32), port(u32), ...
    //   Format B (older):        username(str), type(str), ip(u32), port(u32), token(u32)
    // We try token-first (A), validate the resulting IP, fall back to username-first (B).

    let saved_pos = b.pos;

    // Format A: token first
    if let Some(result) = parse_ctp_token_first(b) {
        let ip = result.2;
        if is_reachable_ip(ip) || ip.octets()[0] < 224 {
            return Some(result);
        }
    }

    // Reset and try Format B: username first
    b.pos = saved_pos;
    parse_ctp_username_first(b)
}

fn parse_ctp_token_first(b: &mut Buf) -> Option<(String, String, Ipv4Addr, u16, u32)> {
    let token = b.u32()?;
    let username = b.str()?;
    let conn_type = b.str()?;
    let ip_u32 = b.u32()?;
    let port = b.u32()? as u16;
    // skip optional unknown/privileged fields
    let ip = Ipv4Addr::from(ip_u32.to_be_bytes());
    Some((username, conn_type, ip, port, token))
}

fn parse_ctp_username_first(b: &mut Buf) -> Option<(String, String, Ipv4Addr, u16, u32)> {
    let username = b.str()?;
    let conn_type = b.str()?;
    let ip_u32 = b.u32()?;
    let port = b.u32()? as u16;
    let token = b.u32()?;
    let ip = Ipv4Addr::from(ip_u32.to_be_bytes());
    Some((username, conn_type, ip, port, token))
}

fn is_reachable_ip(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    // Skip unspecified, loopback, multicast, reserved
    if o[0] == 0 || o[0] == 127 || o[0] >= 224 {
        return false;
    }
    // Skip private ranges (NAT — we likely can't reach them)
    // Comment this out if we want to try LAN peers
    // if o[0] == 10 { return false; }
    // if o[0] == 172 && (16..=31).contains(&o[1]) { return false; }
    // if o[0] == 192 && o[1] == 168 { return false; }
    true
}

async fn handle_server_connect_to_peer(
    username: String,
    conn_type: String,
    ip: Ipv4Addr,
    port: u16,
    server_token: u32,
    sess: std::sync::Weak<Session>,
) {
    if !is_reachable_ip(ip) || port == 0 {
        return;
    }

    let Some(session) = sess.upgrade() else { return };

    let mut stream_opt: Option<TcpStream> = None;
    for attempt in 0..CONNECT_TO_PEER_TCP_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 + u64::from(attempt) * 500)).await;
        }
        match tokio::time::timeout(
            Duration::from_secs(CONNECT_TO_PEER_TCP_TIMEOUT_SECS),
            TcpStream::connect((ip, port)),
        )
        .await
        {
            Ok(Ok(s)) => {
                s.set_nodelay(true).ok();
                stream_opt = Some(s);
                break;
            }
            Ok(Err(_)) | Err(_) => {}
        }
    }

    let mut stream = match stream_opt {
        Some(s) => s,
        None => return,
    };

    // PierceFirewall: [u32 length=5][u8 code=0x00][u32 token]
    // Handshake messages (code 0 and 1) use 1-byte codes, NOT 4-byte.
    let mut pierce = Vec::with_capacity(9);
    pierce.extend_from_slice(&5u32.to_le_bytes());
    pierce.push(0x00); // code = PierceFirewall (1 byte)
    pierce.extend_from_slice(&server_token.to_le_bytes());
    if stream.write_all(&pierce).await.is_err() {
        return;
    }
    let _ = stream.flush().await;
    session.slog(format!(
        "PierceFirewall sent to {username}, waiting for {} response…",
        if conn_type.as_str() == "F" { "F handshake" } else { "P-conn" }
    ));

    match conn_type.as_str() {
        "P" => {
            let (mut rh, _wh) = stream.into_split();
            handle_p_connection(&mut rh, &session).await;
        }
        "F" => {
            let (mut rh, wh) = stream.into_split();
            // Framed PierceFirewall / PeerInit, or raw FileTransferInit (must not use recv_msg — token
            // looks like a multi-byte frame length).
            let mut fti_consumed: Option<u32> = None;
            let mut handshake_ok = false;
            for _attempt in 0..16 {
                let lead = match tokio::time::timeout(
                    Duration::from_secs(60),
                    recv_peer_init_or_fti_lead(&mut rh),
                )
                .await
                {
                    Ok(Ok(l)) => l,
                    Ok(Err(_)) | Err(_) => { break; }
                };
                match lead {
                    PeerFramedOrRawFti::FramedPayload(payload) => {
                        match payload.first() {
                            Some(0) => continue,
                            Some(1) => { handshake_ok = true; break; }
                            _ => break,
                        }
                    }
                    PeerFramedOrRawFti::RawFileTransferInit(tok) => {
                        fti_consumed = Some(tok);
                        handshake_ok = true;
                        break;
                    }
                }
            }
            if handshake_ok {
                if let Ok(s) = rh.reunite(wh) {
                    session.deliver_f_stream(
                        server_token,
                        FConnReady {
                            stream: s,
                            file_transfer_init_consumed: fti_consumed,
                        },
                    );
                }
            } else {
                session.cancel_pending_f_after_outbound_handshake_failure(server_token, &username);
                drop(rh.reunite(wh));
            }
        }
        _ => {}
    }
}

// ── Peer listener loop ────────────────────────────────────────────────────────

async fn peer_listener_loop(listener: TcpListener, sess: std::sync::Weak<Session>) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                // Listener death means firewalled peers can no longer reach us, which
                // is enough to make `search` return zero hits — treat it as a fatal
                // session failure so the frontend reconnects from scratch.
                if let Some(s) = sess.upgrade() {
                    s.mark_dead_and_notify(format!("peer listener error: {e}"));
                }
                break;
            }
        };
        stream.set_nodelay(true).ok();
        let Some(session) = sess.upgrade() else { break };
        tauri::async_runtime::spawn(async move {
            handle_inbound_peer(stream, session).await;
        });
    }
}

async fn handle_inbound_peer(stream: TcpStream, session: Arc<Session>) {
    // Split so we can read the init message
    let (mut rh, wh) = stream.into_split();

    let payload = match tokio::time::timeout(Duration::from_secs(10), recv_msg(&mut rh)).await {
        Ok(Ok(p)) => p,
        _ => return,
    };

    let mut b = Buf::new(&payload);
    // Handshake messages PierceFirewall(0) and PeerInit(1) use 1-byte codes.
    let code = b.u8().unwrap_or(u8::MAX);

    match code {
        0 => {
            // PierceFirewall — peer responding to our ConnectToPeer
            let token = b.u32().unwrap_or(0);
            session.slog(format!("inbound: PierceFirewall token={token}"));
            if let Ok(full_stream) = rh.reunite(wh) {
                session.deliver_f_stream(
                    token,
                    FConnReady {
                        stream: full_stream,
                        file_transfer_init_consumed: None,
                    },
                );
            }
        }
        1 => {
            // PeerInit format: [u8 code=1][str username][str type][u32 token]
            let peer_username = b.str().unwrap_or_default();
            let conn_type = b.str().unwrap_or_default();
            let token = b.u32().unwrap_or(0);
            session.slog(format!("inbound: PeerInit user={peer_username} type={conn_type} token={token}"));
            match conn_type.as_str() {
                "P" => {
                    handle_p_connection(&mut rh, &session).await;
                }
                "F" => {
                    if let Ok(full_stream) = rh.reunite(wh) {
                        session.deliver_f_stream(
                            token,
                            FConnReady {
                                stream: full_stream,
                                file_transfer_init_consumed: None,
                            },
                        );
                    }
                }
                _ => {}
            }
        }
        _ => {
            session.slog(format!("inbound: unexpected init code={code}"));
        }
    }
}

/// Handle a "P" peer connection: read messages looking for FileSearchResponse (code 9).
/// Skips PeerInit (code 1) which some peers send before data.
async fn handle_p_connection(rh: &mut OwnedReadHalf, session: &Session) {
    let deadline =
        tokio::time::Instant::now() + Duration::from_secs(SEARCH_TIMEOUT_SECS + 2);
    loop {
        let payload = match tokio::time::timeout_at(deadline, recv_msg(rh)).await {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => { session.slog(format!("P-conn: recv_msg error: {e}")); break; }
            Err(_) => { session.slog("P-conn: recv_msg timed out"); break; }
        };
        if payload.len() < 4 {
            continue;
        }
        let mut b = Buf::new(&payload);
        let code = b.u32().unwrap_or(u32::MAX);
        match code {
            1 => {
                // PeerInit — skip, wait for next message
            }
            9 => {
                let rest = b.rest();
                if let Some((token, results)) = parse_file_search_response(rest) {
                    session.slog(format!("P-conn: FileSearchResponse token={token} results={}", results.len()));
                    if let Some(tx) = session.pending_searches.get(&token) {
                        let _ = tx.send(results);
                    }
                }
                break; // one search response per peer connection
            }
            _ => {
                // Unknown peer message — ignore and continue
            }
        }
    }
}

// ── FileSearchResponse parser ─────────────────────────────────────────────────

fn try_zlib_decompress(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut dec = flate2::read::ZlibDecoder::new(data);
    let mut out = Vec::new();
    dec.read_to_end(&mut out).ok()?;
    if out.is_empty() { None } else { Some(out) }
}

pub fn parse_file_search_response(data: &[u8]) -> Option<(u32, Vec<SlskFileResult>)> {
    let storage: Vec<u8>;
    let body = match try_zlib_decompress(data) {
        Some(d) => { storage = d; &storage[..] }
        None => data,
    };

    let mut b = Buf::new(body);
    let username = b.str()?;
    let token = b.u32()?;
    let num = b.u32()?;

    // First pass: collect raw (filepath, size, bitrate, duration, is_audio, is_image).
    struct RawRow {
        filepath: String,
        size: u64,
        bitrate: Option<u32>,
        duration: Option<u32>,
        is_image: bool,
    }
    let mut raw_rows: Vec<RawRow> = Vec::with_capacity(num.min(200) as usize);
    for _ in 0..num {
        let _attr = b.u8()?;      // always 1
        let filepath = b.str()?;
        let size = b.u64()?;
        let _ext = b.str()?;
        let num_attrs = b.u32()?;
        let mut bitrate: Option<u32> = None;
        let mut duration: Option<u32> = None;
        for _ in 0..num_attrs {
            let atype = b.u32()?;
            let aval = b.u32()?;
            match atype {
                0 => bitrate = Some(aval),
                1 => duration = Some(aval),
                _ => {}
            }
        }
        let lower = filepath.to_lowercase();
        let is_audio = lower.ends_with(".mp3")
            || lower.ends_with(".flac")
            || lower.ends_with(".ogg")
            || lower.ends_with(".m4a")
            || lower.ends_with(".wav")
            || lower.ends_with(".aac")
            || lower.ends_with(".opus")
            || lower.ends_with(".wma")
            || lower.ends_with(".ape");
        let is_image = lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".png")
            || lower.ends_with(".webp")
            || lower.ends_with(".gif");
        if size == 0 {
            continue;
        }
        if is_audio {
            raw_rows.push(RawRow { filepath, size, bitrate, duration, is_image: false });
        } else if is_image && size >= 256 {
            raw_rows.push(RawRow { filepath, size, bitrate: None, duration: None, is_image: true });
        }
    }

    // After the results list, the peer sends its own availability stats once:
    //   u8   slotsFree     (0 = all slots busy)
    //   u32  avgSpeed      (bytes/s, peer-declared)
    //   u64  queueLength   (pending uploads)
    // These are *per peer*, not per file — we stamp the same values on every
    // row from this batch so later ranking can treat "which peer to try first".
    // Older clients or zlib truncation may cut the tail, so treat all three as
    // best-effort: missing → slots=true (assume OK), speed=0, queue=0.
    let slots_free = b.u8().map(|v| v != 0).unwrap_or(true);
    let avg_speed = b.u32().unwrap_or(0);
    let queue_length = b.u64().unwrap_or(0);

    let mut results = Vec::with_capacity(raw_rows.len());
    for r in raw_rows {
        results.push(SlskFileResult {
            username: username.clone(),
            filepath: r.filepath,
            size: r.size,
            bitrate: r.bitrate,
            duration: r.duration,
            is_image: r.is_image,
            slots_free,
            avg_speed,
            queue_length,
        });
    }

    Some((token, results))
}
