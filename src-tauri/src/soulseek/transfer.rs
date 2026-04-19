//! SoulSeek peer file transfer and local HTTP streaming.

use super::proto::{recv_msg, Msg};
use super::session::{FConnReady, Session};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CONNECT_TIMEOUT_SECS: u64 = 8;
const TRANSFER_TIMEOUT_SECS: u64 = 120;
const HTTP_CHUNK: usize = 32 * 1024;
/// Peer message 40: peer uploads to us (we download).
const PEER_TRANSFER_UPLOAD: u32 = 1;
/// Peer message 40: legacy download request (we ask peer to send).
const PEER_TRANSFER_DOWNLOAD: u32 = 0;

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
///
/// Uses QueueUpload (43) first (SoulseekQt / Nicotine+). Falls back to legacy TransferRequest
/// (direction download) on failure.
pub async fn download_and_stream(
    session: Arc<Session>,
    username: String,
    filepath: String,
    filesize: u64,
    prepare_token: u32,
) -> Result<StreamHandle, String> {
    match download_modern_queue_upload(
        Arc::clone(&session),
        &username,
        &filepath,
        filesize,
        prepare_token,
    )
    .await
    {
        Ok(h) => Ok(h),
        Err(e_modern) => {
            eprintln!("[soulseek] modern handshake failed: {e_modern}");
            eprintln!("[soulseek] retrying with legacy TransferRequest (direction=download)…");
            download_legacy_transfer_request(session, &username, &filepath, filesize, prepare_token).await
        }
    }
}

/// QueueUpload (43): peer sends TransferRequest upload (40); we reply with TransferResponse (41).
async fn download_modern_queue_upload(
    session: Arc<Session>,
    username: &str,
    filepath: &str,
    filesize: u64,
    prepare_token: u32,
) -> Result<StreamHandle, String> {
    let mut p_stream = connect_peer_p(&session, username).await?;
    send_peer_init(&mut p_stream, &session).await?;

    let (mut p_rh, mut p_wh) = p_stream.into_split();

    let queue_msg = Msg::new(43).str(filepath).build();
    p_wh.write_all(&queue_msg).await
        .map_err(|e| format!("QueueUpload send error: {e}"))?;
    p_wh.flush().await.ok();

    let mut skip_peer_init = 0u8;
    let (peer_xfer_token, final_size) = loop {
        let raw = tokio::time::timeout(
            Duration::from_secs(TRANSFER_TIMEOUT_SECS),
            recv_msg(&mut p_rh),
        )
        .await
        .map_err(|_| "Timed out waiting for peer after QueueUpload".to_string())?
        .map_err(|e| format!("P-conn read error after QueueUpload: {e}"))?;

        if raw.get(0) == Some(&1u8) {
            skip_peer_init += 1;
            if skip_peer_init > 32 {
                return Err("Too many PeerInit frames after QueueUpload".to_string());
            }
            eprintln!("[soulseek] P-conn: skipped peer PeerInit");
            continue;
        }
        if raw.len() < 4 {
            return Err(format!("Short P-conn message after QueueUpload (len={})", raw.len()));
        }

        let msg_code = u32::from_le_bytes(raw[0..4].try_into().unwrap());
        match msg_code {
            44 => {
                let mut b = super::proto::Buf::new(&raw);
                let _c = b.u32();
                let fname = b.str().unwrap_or_default();
                let place = b.u32().unwrap_or(0);
                eprintln!("[soulseek] P-conn: PlaceInQueueResponse file={fname:?} place={place}");
                continue;
            }
            50 => {
                let mut b = super::proto::Buf::new(&raw);
                let _c = b.u32();
                let f = b.str().unwrap_or_default();
                let reason = b.str().unwrap_or_else(|| "Upload denied".to_string());
                return Err(format!("Upload denied: {reason} (file={f})"));
            }
            40 => {
                let mut b = super::proto::Buf::new(&raw);
                let c = b.u32().unwrap_or(0);
                if c != 40 {
                    return Err("TransferRequest parse error".to_string());
                }
                let direction = b.u32().unwrap_or(u32::MAX);
                let tr_token = b.u32().unwrap_or(0);
                let _remote_file = b.str().unwrap_or_default();
                if direction != PEER_TRANSFER_UPLOAD {
                    return Err(format!(
                        "Expected TransferRequest upload (direction={PEER_TRANSFER_UPLOAD}), got direction={direction}"
                    ));
                }
                let sz = b.u64().unwrap_or(0);
                let final_sz = if sz > 0 { sz } else { filesize };
                eprintln!("[soulseek] P-conn: TransferRequest upload token={tr_token} size={final_sz}");
                break (tr_token, final_sz);
            }
            41 => {
                return Err(
                    "Unexpected TransferResponse (41) before TransferRequest — trying legacy path"
                        .to_string(),
                );
            }
            other => {
                eprintln!(
                    "[soulseek] P-conn: ignoring peer message code={other} (len={})",
                    raw.len()
                );
                continue;
            }
        }
    };

    let f_rx = session.register_f_waiter(peer_xfer_token, username.to_string());

    let tr_ok = Msg::new(41)
        .u32(peer_xfer_token)
        .bool(true)
        .u64(final_size)
        .build();
    p_wh.write_all(&tr_ok).await
        .map_err(|e| format!("TransferResponse send error: {e}"))?;
    p_wh.flush().await.ok();
    drop(p_wh);

    eprintln!("[soulseek] TransferResponse sent, waiting for F connection (token={peer_xfer_token})…");

    run_download_pipeline(
        session,
        p_rh,
        f_rx,
        filepath,
        peer_xfer_token,
        final_size,
        prepare_token,
    )
    .await
}

/// Legacy: TransferRequest direction 0; peer answers with TransferResponse (41).
async fn download_legacy_transfer_request(
    session: Arc<Session>,
    username: &str,
    filepath: &str,
    filesize: u64,
    prepare_token: u32,
) -> Result<StreamHandle, String> {
    let mut p_stream = connect_peer_p(&session, username).await?;
    send_peer_init(&mut p_stream, &session).await?;

    let f_rx = session.register_f_waiter(prepare_token, username.to_string());

    let xfer_req = Msg::new(40)
        .u32(PEER_TRANSFER_DOWNLOAD)
        .u32(prepare_token)
        .str(filepath)
        .build();
    p_stream.write_all(&xfer_req).await
        .map_err(|e| format!("TransferRequest send error: {e}"))?;
    p_stream.flush().await.ok();

    let (mut p_rh, p_wh) = p_stream.into_split();
    drop(p_wh);

    let mut skip_peer_init = 0u8;
    let resp = loop {
        let raw = tokio::time::timeout(
            Duration::from_secs(TRANSFER_TIMEOUT_SECS),
            recv_msg(&mut p_rh),
        )
        .await
        .map_err(|_| "TransferResponse timed out (legacy)".to_string())?
        .map_err(|e| format!("TransferResponse read error: {e}"))?;

        if raw.get(0) == Some(&1u8) {
            skip_peer_init += 1;
            if skip_peer_init > 16 {
                session.unregister_f_waiter(prepare_token);
                return Err("Too many PeerInit frames before TransferResponse".to_string());
            }
            eprintln!("[soulseek] P-conn: skipped peer PeerInit (handshake)");
            continue;
        }
        if raw.len() >= 4 {
            let msg_code = u32::from_le_bytes(raw[0..4].try_into().unwrap());
            if msg_code == 41 {
                break raw;
            }
        }
        session.unregister_f_waiter(prepare_token);
        return Err(format!(
            "Unexpected message on P connection before TransferResponse (len={})",
            raw.len()
        ));
    };

    let mut rb = super::proto::Buf::new(&resp);
    let resp_code = rb.u32().unwrap_or(0);
    if resp_code != 41 {
        session.unregister_f_waiter(prepare_token);
        return Err(format!("Expected TransferResponse (41), got code {resp_code}"));
    }
    let _resp_token = rb.u32().unwrap_or(0);
    let allowed = rb.bool().unwrap_or(false);
    if !allowed {
        session.unregister_f_waiter(prepare_token);
        let reason = rb.str().unwrap_or_else(|| "Queued or busy".to_string());
        return Err(format!("File transfer denied: {reason}"));
    }
    let actual_size = rb.u64().unwrap_or(filesize);
    let final_size = if actual_size > 0 { actual_size } else { filesize };

    eprintln!("[soulseek] TransferResponse OK (legacy), size={final_size}, waiting for F connection…");

    run_download_pipeline(
        session,
        p_rh,
        f_rx,
        filepath,
        prepare_token,
        final_size,
        prepare_token,
    )
    .await
}

async fn connect_peer_p(session: &Session, username: &str) -> Result<TcpStream, String> {
    let (peer_ip, peer_port) = session
        .get_peer_addr(username)
        .await
        .ok_or_else(|| format!("Cannot resolve SoulSeek address for user '{username}'"))?;

    eprintln!("[soulseek] resolved {username} → {peer_ip}:{peer_port}");

    let s = tokio::time::timeout(
        Duration::from_secs(CONNECT_TIMEOUT_SECS),
        TcpStream::connect((peer_ip, peer_port)),
    )
    .await
    .map_err(|_| format!("Peer connect timed out: {peer_ip}:{peer_port}"))?
    .map_err(|e| format!("Peer connect failed: {e}"))?;
    s.set_nodelay(true).ok();
    Ok(s)
}

async fn send_peer_init(stream: &mut TcpStream, session: &Session) -> Result<(), String> {
    let uname = session.username.as_bytes();
    let mut body = Vec::new();
    body.push(0x01);
    body.extend_from_slice(&(uname.len() as u32).to_le_bytes());
    body.extend_from_slice(uname);
    body.extend_from_slice(&1u32.to_le_bytes());
    body.push(b'P');
    body.extend_from_slice(&0u32.to_le_bytes());

    let mut peer_init = Vec::with_capacity(4 + body.len());
    peer_init.extend_from_slice(&(body.len() as u32).to_le_bytes());
    peer_init.extend_from_slice(&body);
    stream.write_all(&peer_init).await
        .map_err(|e| format!("PeerInit send error: {e}"))?;
    stream.flush().await.ok();
    Ok(())
}

async fn run_download_pipeline(
    session: Arc<Session>,
    p_rh: tokio::net::tcp::OwnedReadHalf,
    f_rx: tokio::sync::oneshot::Receiver<FConnReady>,
    filepath: &str,
    xfer_token: u32,
    final_size: u64,
    http_release_token: u32,
) -> Result<StreamHandle, String> {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        let mut rh = p_rh;
        loop {
            match rh.read(&mut buf).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    let f_ready = match tokio::time::timeout(Duration::from_secs(TRANSFER_TIMEOUT_SECS), f_rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => {
            return Err("F connection channel dropped".to_string());
        }
        Err(_) => {
            session.unregister_f_waiter(xfer_token);
            return Err(
                "Таймаут файлового соединения с пиром (NAT/файрвол или пир не отвечает). Попробуйте другой источник."
                    .to_string(),
            );
        }
    };
    let FConnReady {
        stream: f_stream,
        file_transfer_init_consumed,
    } = f_ready;
    f_stream.set_nodelay(true).ok();

    eprintln!("[soulseek] F connection established");

    let (mut f_rh, mut f_wh) = f_stream.into_split();

    match file_transfer_init_consumed {
        Some(tok) => {
            eprintln!(
                "[soulseek] FileTransferInit already read from peer (token={tok}, xfer={xfer_token})"
            );
        }
        None => {
            let mut ft = [0u8; 4];
            let mut got = 0usize;
            while got < 4 {
                let n = match tokio::time::timeout(Duration::from_secs(30), f_rh.read(&mut ft[got..])).await {
                    Ok(Ok(n)) => n,
                    Ok(Err(e)) => {
                        return Err(format!("FileTransferInit read error: {e}"));
                    }
                    Err(_) => {
                        return Err("Таймаут FileTransferInit от пира".to_string());
                    }
                };
                if n == 0 {
                    return Err("Соединение закрыто до FileTransferInit".to_string());
                }
                got += n;
            }
            let ft_tok = u32::from_le_bytes(ft);
            if ft_tok != xfer_token {
                eprintln!(
                    "[soulseek] FileTransferInit token {ft_tok} != xfer {xfer_token} (continuing)"
                );
            } else {
                eprintln!("[soulseek] FileTransferInit ok token={ft_tok}");
            }
        }
    }

    let offset = 0u64.to_le_bytes();
    f_wh.write_all(&offset).await
        .map_err(|e| format!("FileOffset send error: {e}"))?;
    f_wh.flush().await.ok();

    let temp_path = std::env::temp_dir().join(format!("neegde_slsk_{xfer_token}.tmp"));
    let downloaded = Arc::new(AtomicU64::new(0));
    let complete = Arc::new(AtomicBool::new(false));

    let tp_dl = temp_path.clone();
    let dl_bytes = Arc::clone(&downloaded);
    let dl_done = Arc::clone(&complete);
    let dl_jh = tokio::task::spawn(async move {
        download_loop(f_rh, f_wh, tp_dl, dl_bytes, dl_done).await;
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

    let url = format!("http://127.0.0.1:{http_port}/slsk/{http_release_token}");
    eprintln!("[soulseek] ready: {url}  (file: {filepath})");

    Ok(StreamHandle {
        url,
        token: http_release_token,
        temp_path,
        download_abort,
        http_abort,
    })
}

// ── Download loop ─────────────────────────────────────────────────────────────

/// Reads file bytes from the peer into a temp file for HTTP serving.
///
/// The write half must stay alive for the whole download: dropping it after
/// `FileOffset` shuts down our TCP send side (FIN), and many peers then stop
/// uploading or close the connection, yielding zero payload bytes.
///
/// Args:
///     rh: Read half of the file (F) connection.
///     _wh: Write half; held until this function returns so the socket stays open.
///     temp_path: Destination path for the downloaded bytes.
///     downloaded: Running byte count for progress.
///     complete: Set when the read side is done (EOF or error).
async fn download_loop(
    mut rh: tokio::net::tcp::OwnedReadHalf,
    _wh: tokio::net::tcp::OwnedWriteHalf,
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

// CORS: dev UI is localhost, stream is 127.0.0.1 — cross-origin; matches torrent_stream/http.rs.
const SL_HTTP_CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\n";

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

    let first = req.lines().next().unwrap_or("").trim();
    let first_up = first.to_ascii_uppercase();
    if first_up.starts_with("OPTIONS ") {
        let resp = format!(
            "HTTP/1.1 204 No Content\r\n\
             {SL_HTTP_CORS}\
             Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
             Access-Control-Max-Age: 86400\r\n\
             Content-Length: 0\r\n\
             \r\n"
        );
        let _ = socket.write_all(resp.as_bytes()).await;
        return;
    }

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
            let resp = format!(
                "HTTP/1.1 503 Service Unavailable\r\n{SL_HTTP_CORS}\r\n"
            );
            let _ = socket.write_all(resp.as_bytes()).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }

    let headers = if is_range {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {ct}\r\n\
             Content-Range: bytes {range_start}-{range_end}/{file_size}\r\n\
             Content-Length: {content_len}\r\nAccept-Ranges: bytes\r\nCache-Control: no-cache\r\n\
             {SL_HTTP_CORS}\r\n"
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {ct}\r\n\
             Content-Length: {file_size}\r\nAccept-Ranges: bytes\r\nCache-Control: no-cache\r\n\
             {SL_HTTP_CORS}\r\n"
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
