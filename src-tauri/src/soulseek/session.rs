//! SoulSeek server connection, search, and peer coordination.

use super::proto::{recv_msg, Buf, Msg};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::io::{AsyncWriteExt};
use tokio::net::tcp::OwnedReadHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex};

const SERVER_HOST: &str = "server.slsknet.org";
const SERVER_PORT: u16 = 2242;
const CLIENT_VERSION: u32 = 160;
const SEARCH_TIMEOUT_SECS: u64 = 12;
const PEER_ADDR_TIMEOUT_SECS: u64 = 5;
const MAX_SEARCH_RESULTS: usize = 500;

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
}

// ── Session ───────────────────────────────────────────────────────────────────

pub struct Session {
    pub username: String,
    pub listen_port: u16,
    writer: Mutex<tokio::net::tcp::OwnedWriteHalf>,
    /// token → sender of batches of search results
    pub pending_searches: Arc<DashMap<u32, mpsc::UnboundedSender<Vec<SlskFileResult>>>>,
    /// username → oneshot for (ip, port) from GetPeerAddress response
    pub pending_peer_addr: Arc<DashMap<String, oneshot::Sender<(Ipv4Addr, u16)>>>,
    /// xfer_token → oneshot for the F-type TcpStream delivered by peer_listener or server
    pub pending_f_conns: Arc<DashMap<u32, oneshot::Sender<TcpStream>>>,
}

impl Session {
    /// Connect to the SoulSeek server and authenticate. Returns `Arc<Session>` on success.
    pub async fn connect(username: String, password: String) -> Result<Arc<Self>, String> {
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

        let session = Arc::new(Session {
            username: username.clone(),
            listen_port,
            writer: Mutex::new(write_half),
            pending_searches: Arc::clone(&pending_searches),
            pending_peer_addr: Arc::clone(&pending_peer_addr),
            pending_f_conns: Arc::clone(&pending_f_conns),
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

        eprintln!("[soulseek] logged in as '{username}', listen_port={listen_port}");
        Ok(session)
    }

    /// Send a pre-built message to the server.
    pub async fn send_raw(&self, data: Vec<u8>) -> std::io::Result<()> {
        let mut w = self.writer.lock().await;
        w.write_all(&data).await?;
        w.flush().await
    }

    /// Network-wide file search. Blocks up to SEARCH_TIMEOUT_SECS collecting results.
    pub async fn search(&self, query: String) -> Vec<SlskFileResult> {
        let token = next_token();
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<SlskFileResult>>();
        self.pending_searches.insert(token, tx);

        eprintln!("[soulseek] search: sending FileSearch token={} query={:?}", token, query);
        let msg = Msg::new(26).u32(token).str(&query).build();
        if self.send_raw(msg).await.is_err() {
            eprintln!("[soulseek] search: failed to send FileSearch");
            self.pending_searches.remove(&token);
            return vec![];
        }
        eprintln!("[soulseek] search: FileSearch sent, waiting {}s for results…", SEARCH_TIMEOUT_SECS);

        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(SEARCH_TIMEOUT_SECS);
        let mut results: Vec<SlskFileResult> = Vec::new();

        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(batch)) => {
                    results.extend(batch);
                    if results.len() >= MAX_SEARCH_RESULTS {
                        break;
                    }
                }
                _ => break,
            }
        }

        self.pending_searches.remove(&token);
        eprintln!("[soulseek] search: collected {} raw results for {:?}", results.len(), query);

        // Sort by size descending (larger = likely higher quality)
        results.sort_by(|a, b| b.size.cmp(&a.size));

        // Dedup: keep one entry per (username, filepath)
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
    pub fn register_f_waiter(&self, xfer_token: u32) -> oneshot::Receiver<TcpStream> {
        let (tx, rx) = oneshot::channel();
        self.pending_f_conns.insert(xfer_token, tx);
        rx
    }

    /// Remove a registered F waiter (cleanup on cancel/timeout).
    pub fn unregister_f_waiter(&self, xfer_token: u32) {
        self.pending_f_conns.remove(&xfer_token);
    }

    /// Deliver an F-connection stream to whichever pending_f_conns entry matches token.
    /// For server-mediated ("F" ConnectToPeer), any single pending entry suffices.
    fn deliver_f_stream(&self, token: u32, stream: TcpStream) {
        // Try exact token match first
        if let Some((_, tx)) = self.pending_f_conns.remove(&token) {
            let _ = tx.send(stream);
            return;
        }
        // Fall back: deliver to the first pending entry (single-transfer assumption)
        let key = self.pending_f_conns.iter().next().map(|e| *e.key());
        if let Some(k) = key {
            if let Some((_, tx)) = self.pending_f_conns.remove(&k) {
                let _ = tx.send(stream);
            }
        }
    }
}

// ── Server reader loop ────────────────────────────────────────────────────────

async fn server_reader_loop(mut rh: OwnedReadHalf, sess: std::sync::Weak<Session>) {
    loop {
        let payload = match recv_msg(&mut rh).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[soulseek] server disconnected: {e}");
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
                    eprintln!("[soulseek] GetPeerAddress: {}  →  {}:{}", username, ip, port);
                    if let Some((_, tx)) = session.pending_peer_addr.remove(&username) {
                        let _ = tx.send((ip, port));
                    }
                }
            }
            18 => {
                // ConnectToPeer: server asks us to connect to a peer
                // Dump first 3 messages raw for diagnostics
                static DUMP_COUNT: AtomicU32 = AtomicU32::new(0);
                let dump_idx = DUMP_COUNT.fetch_add(1, Ordering::Relaxed);
                if dump_idx < 3 {
                    let hex: String = payload.iter().map(|x| format!("{:02x}", x)).collect::<Vec<_>>().join(" ");
                    eprintln!("[soulseek] ConnectToPeer raw[{}]: {}", dump_idx, &hex[..hex.len().min(200)]);
                }
                if let Some((username, conn_type, ip, port, token)) = parse_connect_to_peer(&mut b)
                {
                    eprintln!("[soulseek] server: ConnectToPeer user={} type={} {}:{} token={}", username, conn_type, ip, port, token);
                    let sess_weak = std::sync::Weak::clone(&sess);
                    tauri::async_runtime::spawn(async move {
                        handle_server_connect_to_peer(
                            username, conn_type, ip, port, token, sess_weak,
                        )
                        .await;
                    });
                }
            }
            64 | 69 | 83 | 84 | 89 | 90 | 91 | 92 | 93 | 100 | 104 => {
                // Server keepalive / housekeeping messages — ignore silently
            }
            _ => {
                eprintln!("[soulseek] server: unknown code={}", code);
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
    if !is_reachable_ip(ip) {
        eprintln!("[soulseek] ConnectToPeer skipping invalid IP {ip}:{port} for {username}");
        return;
    }
    if port == 0 {
        return;
    }

    let mut stream = match tokio::time::timeout(
        Duration::from_secs(8),
        TcpStream::connect((ip, port)),
    )
    .await
    {
        Ok(Ok(s)) => { s.set_nodelay(true).ok(); s }
        Ok(Err(e)) => { eprintln!("[soulseek] ConnectToPeer TCP error {username} {ip}:{port}: {e}"); return; }
        Err(_) => { eprintln!("[soulseek] ConnectToPeer timeout {username} {ip}:{port}"); return; }
    };

    eprintln!("[soulseek] TCP connected to {username} {ip}:{port} token={server_token}");

    let Some(session) = sess.upgrade() else { return };

    // PierceFirewall: [u32 length=5][u8 code=0x00][u32 token]
    // Handshake messages (code 0 and 1) use 1-byte codes, NOT 4-byte.
    let mut pierce = Vec::with_capacity(9);
    pierce.extend_from_slice(&5u32.to_le_bytes());
    pierce.push(0x00); // code = PierceFirewall (1 byte)
    pierce.extend_from_slice(&server_token.to_le_bytes());
    if stream.write_all(&pierce).await.is_err() {
        eprintln!("[soulseek] PierceFirewall write failed to {username} {ip}:{port}");
        return;
    }
    let _ = stream.flush().await;
    eprintln!("[soulseek] PierceFirewall sent to {username}, waiting for P-conn response…");

    match conn_type.as_str() {
        "P" => {
            let (mut rh, _wh) = stream.into_split();
            handle_p_connection(&mut rh, &session).await;
        }
        "F" => {
            session.deliver_f_stream(server_token, stream);
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
                eprintln!("[soulseek] peer listener error: {e}");
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
            eprintln!("[soulseek] inbound: PierceFirewall token={}", token);
            if let Ok(full_stream) = rh.reunite(wh) {
                session.deliver_f_stream(token, full_stream);
            }
        }
        1 => {
            // PeerInit format: [u8 code=1][u32 token][str username][str type]
            let token = b.u32().unwrap_or(0);
            let peer_username = b.str().unwrap_or_default();
            let conn_type = b.str().unwrap_or_default();
            eprintln!("[soulseek] inbound: PeerInit user={} type={} token={}", peer_username, conn_type, token);
            match conn_type.as_str() {
                "P" => {
                    handle_p_connection(&mut rh, &session).await;
                }
                "F" => {
                    if let Ok(full_stream) = rh.reunite(wh) {
                        session.deliver_f_stream(token, full_stream);
                    }
                }
                _ => {}
            }
        }
        _ => {
            eprintln!("[soulseek] inbound: unexpected init code={}", code);
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
            Ok(Err(e)) => { eprintln!("[soulseek] P-conn: recv_msg error: {e}"); break; }
            Err(_) => { eprintln!("[soulseek] P-conn: recv_msg timed out (10s, no data)"); break; }
        };
        if payload.len() < 4 {
            continue;
        }
        let mut b = Buf::new(&payload);
        let code = b.u32().unwrap_or(u32::MAX);
        match code {
            1 => {
                // PeerInit — skip, wait for next message
                eprintln!("[soulseek] P-conn: got PeerInit, continuing");
            }
            9 => {
                let rest = b.rest();
                eprintln!("[soulseek] P-conn: got FileSearchResponse, {} bytes compressed", rest.len());
                if let Some((token, results)) = parse_file_search_response(rest) {
                    eprintln!("[soulseek] P-conn: parsed token={} results={}", token, results.len());
                    if let Some(tx) = session.pending_searches.get(&token) {
                        let _ = tx.send(results);
                    } else {
                        eprintln!("[soulseek] P-conn: no pending search for token={}", token);
                    }
                } else {
                    eprintln!("[soulseek] P-conn: parse_file_search_response failed");
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

    let mut results = Vec::with_capacity(num.min(200) as usize);
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
        if is_audio && size > 0 {
            results.push(SlskFileResult {
                username: username.clone(),
                filepath,
                size,
                bitrate,
                duration,
            });
        }
    }

    Some((token, results))
}
