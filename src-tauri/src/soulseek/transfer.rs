//! SoulSeek peer file transfer and local HTTP streaming.

use super::proto::{recv_msg, Msg};
use super::session::{next_token, Session};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CONNECT_TIMEOUT_SECS: u64 = 8;
const TRANSFER_TIMEOUT_SECS: u64 = 30;
const HTTP_CHUNK: usize = 32 * 1024;

// ── Public types ──────────────────────────────────────────────────────────────

pub struct StreamHandle {
    pub url: String,
    pub token: u32,
    pub temp_path: PathBuf,
    pub download_abort: tokio::task::AbortHandle,
    pub http_abort: tokio::task::AbortHandle,
}

// ── Main entry point ──────────────────────────────────────────────────────────

/// Connect to a SoulSeek peer, request a file, and start a local HTTP server to serve it.
pub async fn download_and_stream(
    session: Arc<Session>,
    username: String,
    filepath: String,
    filesize: u64,
    token: u32,
) -> Result<StreamHandle, String> {
    // ── 1. Resolve peer address ───────────────────────────────────────────────
    let (peer_ip, peer_port) = session
        .get_peer_addr(&username)
        .await
        .ok_or_else(|| format!("Cannot resolve SoulSeek address for user '{username}'"))?;

    eprintln!("[soulseek] resolved {username} → {peer_ip}:{peer_port}");

    // ── 2. Open P connection (peer protocol) ──────────────────────────────────
    let mut p_stream = tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECS),
        TcpStream::connect((peer_ip, peer_port)),
    )
    .await
    .map_err(|_| format!("Peer connect timed out: {peer_ip}:{peer_port}"))?
    .map_err(|e| format!("Peer connect failed: {e}"))?;
    p_stream.set_nodelay(true).ok();

    // PeerInit: [u32 length][u8 code=0x01][u32 token][str username][str "P"]
    // Handshake messages use 1-byte codes; field order is token, username, type.
    let our_p_token = next_token();
    {
        let uname = session.username.as_bytes();
        let body_len = 1 + 4 + 4 + uname.len() + 4 + 1usize; // code + token + strlen + username + strlen + "P"
        let mut peer_init = Vec::with_capacity(4 + body_len);
        peer_init.extend_from_slice(&(body_len as u32).to_le_bytes());
        peer_init.push(0x01); // code = PeerInit (1 byte)
        peer_init.extend_from_slice(&our_p_token.to_le_bytes());
        peer_init.extend_from_slice(&(uname.len() as u32).to_le_bytes());
        peer_init.extend_from_slice(uname);
        peer_init.extend_from_slice(&1u32.to_le_bytes()); // "P".len()
        peer_init.push(b'P');
        p_stream.write_all(&peer_init).await
            .map_err(|e| format!("PeerInit send error: {e}"))?;
        p_stream.flush().await.ok();
    }

    // ── 3. Register F-connection waiter, then send TransferRequest ────────────
    let xfer_token = token;
    let f_rx = session.register_f_waiter(xfer_token);

    // TransferRequest (peer code 40): direction=0 (we want to download)
    let xfer_req = Msg::new(40)
        .u32(0)           // direction: download
        .u32(xfer_token)
        .str(&filepath)
        .u64(filesize)    // 0 or actual size; peer fills in actual on response
        .build();
    p_stream.write_all(&xfer_req).await
        .map_err(|e| format!("TransferRequest send error: {e}"))?;
    p_stream.flush().await.ok();

    // ── 4. Read TransferResponse (peer code 41) ───────────────────────────────
    let (mut p_rh, p_wh) = p_stream.into_split();
    let resp = tokio::time::timeout(
        Duration::from_secs(TRANSFER_TIMEOUT_SECS),
        recv_msg(&mut p_rh),
    )
    .await
    .map_err(|_| "TransferResponse timed out".to_string())?
    .map_err(|e| format!("TransferResponse read error: {e}"))?;
    drop(p_wh);

    let mut rb = super::proto::Buf::new(&resp);
    let resp_code = rb.u32().unwrap_or(0);
    if resp_code != 41 {
        session.unregister_f_waiter(xfer_token);
        return Err(format!("Expected TransferResponse (41), got code {resp_code}"));
    }
    let _resp_token = rb.u32().unwrap_or(0); // should match xfer_token
    let allowed = rb.bool().unwrap_or(false);
    if !allowed {
        session.unregister_f_waiter(xfer_token);
        let reason = rb.str().unwrap_or_else(|| "Queued or busy".to_string());
        return Err(format!("File transfer denied: {reason}"));
    }
    let actual_size = rb.u64().unwrap_or(filesize);
    let final_size = if actual_size > 0 { actual_size } else { filesize };

    eprintln!("[soulseek] TransferResponse OK, size={final_size}, waiting for F connection…");

    // ── 5. Wait for the F (file transfer) TcpStream ───────────────────────────
    // The peer will connect to our session.listen_port with PeerInit("F", xfer_token).
    // session.peer_listener_loop will intercept and deliver the TcpStream via f_rx.
    let f_stream = match tokio::time::timeout(Duration::from_secs(TRANSFER_TIMEOUT_SECS), f_rx).await {
        Ok(Ok(s)) => s,
        Ok(Err(_)) => {
            return Err("F connection channel dropped".to_string());
        }
        Err(_) => {
            session.unregister_f_waiter(xfer_token);
            return Err("Timed out waiting for file transfer connection from peer".to_string());
        }
    };
    f_stream.set_nodelay(true).ok();

    eprintln!("[soulseek] F connection established");

    // Read PeerInit on the F stream (if present — some clients skip it)
    // We do a short non-blocking read and discard whatever we get before the file data.
    // Actually the F init was already consumed by peer_listener before passing us the stream.
    // We just need to send FileOffset.

    // ── 6. Send FileOffset = 0 (8 raw bytes, no framing) ─────────────────────
    let (f_rh, mut f_wh) = f_stream.into_split();
    let offset = 0u64.to_le_bytes();
    f_wh.write_all(&offset).await
        .map_err(|e| format!("FileOffset send error: {e}"))?;
    f_wh.flush().await.ok();
    drop(f_wh);

    // ── 7. Create temp file, start download task ──────────────────────────────
    let temp_path = std::env::temp_dir().join(format!("neegde_slsk_{token}.tmp"));
    let downloaded = Arc::new(AtomicU64::new(0));
    let complete = Arc::new(AtomicBool::new(false));

    let tp_dl = temp_path.clone();
    let dl_bytes = Arc::clone(&downloaded);
    let dl_done = Arc::clone(&complete);
    let dl_jh = tokio::task::spawn(async move {
        download_loop(f_rh, tp_dl, dl_bytes, dl_done).await;
    });
    let download_abort = dl_jh.abort_handle();

    // ── 8. Start local HTTP server ────────────────────────────────────────────
    let http_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("HTTP bind error: {e}"))?;
    let http_port = http_listener.local_addr().map(|a| a.port()).unwrap_or(0);

    let ext = filepath
        .rsplit(|c| c == '\\' || c == '/')
        .next()
        .and_then(|n| n.rsplit('.').next())
        .unwrap_or("mp3")
        .to_lowercase();

    let tp_srv = temp_path.clone();
    let srv_dl = Arc::clone(&downloaded);
    let srv_done = Arc::clone(&complete);
    let http_jh = tokio::task::spawn(async move {
        http_server_loop(http_listener, tp_srv, final_size, srv_dl, srv_done, ext).await;
    });
    let http_abort = http_jh.abort_handle();

    let url = format!("http://127.0.0.1:{http_port}/stream");
    eprintln!("[soulseek] ready: {url}  (file: {filepath})");

    Ok(StreamHandle { url, token, temp_path, download_abort, http_abort })
}

// ── Download loop ─────────────────────────────────────────────────────────────

async fn download_loop(
    mut rh: tokio::net::tcp::OwnedReadHalf,
    temp_path: PathBuf,
    downloaded: Arc<AtomicU64>,
    complete: Arc<AtomicBool>,
) {
    let tp = temp_path.clone();
    // Create the file
    let result = tokio::task::spawn_blocking(move || std::fs::File::create(&tp)).await;
    let file = match result {
        Ok(Ok(f)) => f,
        _ => { complete.store(true, Ordering::Release); return; }
    };
    let file = Arc::new(std::sync::Mutex::new(file));

    let mut buf = vec![0u8; HTTP_CHUNK];
    loop {
        match rh.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                let f = Arc::clone(&file);
                tokio::task::spawn_blocking(move || {
                    use std::io::Write;
                    if let Ok(mut g) = f.lock() { let _ = g.write_all(&chunk); }
                }).await.ok();
                downloaded.fetch_add(n as u64, Ordering::Release);
            }
            Err(e) => { eprintln!("[soulseek/dl] read error: {e}"); break; }
        }
    }
    complete.store(true, Ordering::Release);
    eprintln!("[soulseek/dl] done: {}B", downloaded.load(Ordering::Relaxed));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

async fn http_server_loop(
    listener: TcpListener,
    temp_path: PathBuf,
    file_size: u64,
    downloaded: Arc<AtomicU64>,
    complete: Arc<AtomicBool>,
    ext: String,
) {
    loop {
        let (socket, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => break,
        };
        let tp = temp_path.clone();
        let dl = Arc::clone(&downloaded);
        let dc = Arc::clone(&complete);
        let ex = ext.clone();
        tauri::async_runtime::spawn(async move {
            serve_request(socket, tp, file_size, dl, dc, ex).await;
        });
    }
}

async fn serve_request(
    mut socket: TcpStream,
    temp_path: PathBuf,
    file_size: u64,
    downloaded: Arc<AtomicU64>,
    complete: Arc<AtomicBool>,
    ext: String,
) {
    // Read HTTP request
    let mut req_buf = [0u8; 4096];
    let n = match tokio::time::timeout(
        Duration::from_secs(10),
        socket.read(&mut req_buf),
    )
    .await
    {
        Ok(Ok(n)) => n,
        _ => return,
    };
    let req = String::from_utf8_lossy(&req_buf[..n]);

    let max_end = file_size.saturating_sub(1);
    let (range_start, range_end) = parse_range(&req, max_end);
    let content_len = range_end - range_start + 1;
    let ct = mime_for_ext(&ext);
    let is_range = range_start > 0 || range_end < max_end;

    // Wait for data at range_start
    let wait_dl = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let dl = downloaded.load(Ordering::Acquire);
        if dl > range_start || complete.load(Ordering::Acquire) { break; }
        if tokio::time::Instant::now() >= wait_dl {
            let _ = socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\n\r\n").await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }

    let headers = if is_range {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {ct}\r\n\
             Content-Range: bytes {range_start}-{range_end}/{file_size}\r\n\
             Content-Length: {content_len}\r\nAccept-Ranges: bytes\r\nCache-Control: no-cache\r\n\r\n"
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\n\
             Content-Length: {file_size}\r\nAccept-Ranges: bytes\r\nCache-Control: no-cache\r\n\r\n"
        )
    };
    if socket.write_all(headers.as_bytes()).await.is_err() {
        return;
    }

    let tp = Arc::new(temp_path);
    let mut pos = range_start;

    while pos <= range_end {
        // Wait for available data
        let chunk_wait = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let dl = downloaded.load(Ordering::Acquire);
            if dl > pos || complete.load(Ordering::Acquire) { break; }
            if tokio::time::Instant::now() >= chunk_wait { return; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        let avail = downloaded.load(Ordering::Acquire).min(range_end + 1);
        if avail <= pos {
            if complete.load(Ordering::Acquire) { break; }
            continue;
        }

        let read_len = (avail - pos) as usize;
        let read_len = read_len.min(HTTP_CHUNK);
        let rpos = pos;
        let path = Arc::clone(&tp);

        let chunk = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
            use std::io::{Read, Seek};
            let mut f = std::fs::File::open(path.as_ref())?;
            f.seek(std::io::SeekFrom::Start(rpos))?;
            let mut buf = vec![0u8; read_len];
            let n = f.read(&mut buf)?;
            buf.truncate(n);
            Ok(buf)
        })
        .await
        .ok()
        .and_then(|r| r.ok());

        match chunk {
            Some(c) if !c.is_empty() => {
                if socket.write_all(&c).await.is_err() { return; }
                pos += c.len() as u64;
            }
            _ => break,
        }
    }
    let _ = socket.flush().await;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn parse_range(req: &str, max_end: u64) -> (u64, u64) {
    for line in req.lines() {
        let lower = line.to_lowercase();
        if let Some(rest) = lower.strip_prefix("range: bytes=") {
            let parts: Vec<&str> = rest.trim().splitn(2, '-').collect();
            if parts.len() == 2 {
                let start = parts[0].parse::<u64>().unwrap_or(0);
                let end = if parts[1].is_empty() {
                    max_end
                } else {
                    parts[1].parse::<u64>().unwrap_or(max_end).min(max_end)
                };
                if start <= end && start <= max_end {
                    return (start, end);
                }
            }
        }
    }
    (0, max_end)
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        "wma" => "audio/x-ms-wma",
        "ape" => "audio/x-monkeys-audio",
        _ => "audio/mpeg",
    }
}
