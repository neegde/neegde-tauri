use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::net::{TcpListener, TcpStream};

use super::debug_log::AppDebugLog;
use super::state::TorrentStreamInner;
use super::types::ParsedRequest;
use super::{COPY_CHUNK_BYTES, MAX_HTTP_HEADER_BYTES};

pub(super) const STREAM_MEMORY_CACHE_CAP_BYTES: usize = 256 * 1024 * 1024;
pub(super) const READAHEAD_TARGET_BYTES: u64 = 128 * 1024 * 1024;
pub(super) const INITIAL_FAST_START_BYTES: u64 = 1 * 1024 * 1024;

impl TorrentStreamInner {
    pub(super) async fn run_server(self: Arc<Self>, listener: TcpListener) {
        loop {
            let accepted = listener.accept().await;
            let (socket, _) = match accepted {
                Ok(v) => v,
                Err(_) => continue,
            };
            let inner = self.clone();
            tauri::async_runtime::spawn(async move {
                let _ = inner.handle_connection(socket).await;
            });
        }
    }

    async fn handle_connection(self: Arc<Self>, mut socket: TcpStream) -> Result<(), String> {
        loop {
            let req = match read_request(&mut socket).await {
                Ok(req) => req,
                Err(_) => break,
            };
            let dbg = &self.debug_log;
            if !req.path.starts_with("/stream/") {
                dbg.push(
                    "http",
                    format!("404 not /stream: {}", req.path),
                    None,
                );
                write_response_head(&mut socket, 404, "text/plain", 0, None, req.keep_alive).await?;
                if !req.keep_alive {
                    break;
                }
                continue;
            }
            let token = req.path.trim_start_matches("/stream/").to_string();
            if token.is_empty() {
                dbg.push("http", "404 empty token", None);
                write_response_head(&mut socket, 404, "text/plain", 0, None, req.keep_alive).await?;
                if !req.keep_alive {
                    break;
                }
                continue;
            }
            let stream_entry = self.streams.get(&token).map(|v| v.value().clone());
            let Some(stream_entry) = stream_entry else {
                dbg.push(
                    "http",
                    format!("404 unknown token {}", &token[..token.len().min(24)]),
                    None,
                );
                write_response_head(&mut socket, 404, "text/plain", 0, None, req.keep_alive).await?;
                if !req.keep_alive {
                    break;
                }
                continue;
            };
            dbg.push(
                "http",
                "request",
                Some(json!({
                    "token": &token,
                    "range": req.range.map(|(a, b)| format!("{a}-{b:?}")),
                    "totalLen": stream_entry.total_len,
                })),
            );
            serve_stream(&mut socket, &stream_entry, req.range, req.keep_alive, Some(dbg)).await?;
            if !req.keep_alive {
                break;
            }
        }
        Ok(())
    }
}

async fn read_request(socket: &mut TcpStream) -> Result<ParsedRequest, String> {
    let mut raw = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1024];
    loop {
        let n = socket
            .read(&mut tmp)
            .await
            .map_err(|e| format!("Ошибка чтения HTTP запроса: {e}"))?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&tmp[..n]);
        if raw.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if raw.len() > MAX_HTTP_HEADER_BYTES {
            return Err("Слишком большие HTTP заголовки".into());
        }
    }

    let text = String::from_utf8_lossy(&raw);
    let mut lines = text.lines();
    let first = lines.next().unwrap_or_default();
    let mut first_parts = first.split_whitespace();
    let _method = first_parts.next().unwrap_or_default();
    let path = first_parts.next().unwrap_or("/").to_string();

    let mut parsed = ParsedRequest {
        path,
        range: None,
        keep_alive: true,
    };
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("range:") {
            if let Some(idx) = line.find(':') {
                let value = line[idx + 1..].trim();
                parsed.range = parse_range_header(value);
            }
        } else if lower.starts_with("connection:") && lower.contains("close") {
            parsed.keep_alive = false;
        }
    }
    Ok(parsed)
}

fn parse_range_header(v: &str) -> Option<(u64, Option<u64>)> {
    let value = v.trim();
    let bytes = value.strip_prefix("bytes=")?;
    let mut parts = bytes.splitn(2, '-');
    let start = parts.next()?.trim().parse::<u64>().ok()?;
    let end = parts.next().and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            t.parse::<u64>().ok()
        }
    });
    Some((start, end))
}

async fn write_response_head(
    socket: &mut TcpStream,
    status: u16,
    content_type: &str,
    content_len: u64,
    content_range: Option<String>,
    keep_alive: bool,
) -> Result<(), String> {
    let status_text = match status {
        200 => "OK",
        206 => "Partial Content",
        404 => "Not Found",
        416 => "Range Not Satisfiable",
        _ => "OK",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Connection: {}\r\n\
         Accept-Ranges: bytes\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: Range\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {content_len}\r\n"
        ,
        if keep_alive { "keep-alive" } else { "close" }
    );
    if let Some(range) = content_range {
        head.push_str(&format!("Content-Range: {range}\r\n"));
    }
    head.push_str("\r\n");
    socket
        .write_all(head.as_bytes())
        .await
        .map_err(|e| format!("Ошибка записи HTTP заголовков: {e}"))
}

async fn serve_stream(
    socket: &mut TcpStream,
    prepared: &super::types::PreparedStream,
    range: Option<(u64, Option<u64>)>,
    keep_alive: bool,
    debug: Option<&AppDebugLog>,
) -> Result<(), String> {
    if prepared.total_len == 0 {
        if let Some(d) = debug {
            d.push(
                "http",
                "response 200 empty body (totalLen 0)",
                Some(json!({ "mime": &prepared.mime })),
            );
        }
        write_response_head(socket, 200, &prepared.mime, 0, None, keep_alive).await?;
        return Ok(());
    }

    let (start, end, status) = match range {
        Some((start, end)) => {
            if start >= prepared.total_len {
                if let Some(d) = debug {
                    d.push(
                        "http",
                        "response 416 range not satisfiable",
                        Some(json!({
                            "rangeStart": start,
                            "totalLen": prepared.total_len,
                        })),
                    );
                }
                write_response_head(socket, 416, &prepared.mime, 0, None, keep_alive).await?;
                return Ok(());
            }
            let end = end
                .unwrap_or(prepared.total_len - 1)
                .min(prepared.total_len - 1);
            (start, end, 206)
        }
        None => (0, prepared.total_len - 1, 200),
    };

    let content_len = end - start + 1;
    let content_range = if status == 206 {
        Some(format!("bytes {start}-{end}/{}", prepared.total_len))
    } else {
        None
    };
    write_response_head(socket, status, &prepared.mime, content_len, content_range, keep_alive).await?;

    let pre_len = prepared.prebuffer.len() as u64;
    let content_len_start = content_len;
    let mut cursor = start;
    let mut remaining = content_len;
    prepared
        .playback_offset
        .store(start, std::sync::atomic::Ordering::Relaxed);

    if cursor < pre_len && remaining > 0 {
        let pre_end = end.min(pre_len.saturating_sub(1));
        let s = cursor as usize;
        let e = pre_end as usize + 1;
        socket
            .write_all(&prepared.prebuffer[s..e])
            .await
            .map_err(|e| format!("Ошибка отправки prebuffer: {e}"))?;
        let sent = (e - s) as u64;
        cursor += sent;
        remaining = remaining.saturating_sub(sent);
    }

    if remaining == 0 {
        if let Some(d) = debug {
            d.push(
                "http",
                format!("response {status} sent 0 B (prebuffer only)"),
                Some(json!({
                    "mime": &prepared.mime,
                    "rangeStart": start,
                    "rangeEnd": end,
                })),
            );
        }
        return Ok(());
    }

    let mut stream = prepared
        .torrent
        .clone()
        .stream(prepared.file_idx)
        .map_err(|e| format!("Ошибка открытия потока для HTTP: {e:#}"))?;
    stream
        .seek(SeekFrom::Start(cursor))
        .await
        .map_err(|e| format!("Ошибка seek в потоке: {e}"))?;
    let mut buf = vec![0u8; COPY_CHUNK_BYTES];
    while remaining > 0 {
        let from_mem = write_from_memory_cache(socket, prepared, cursor, remaining).await?;
        if from_mem > 0 {
            cursor += from_mem;
            remaining = remaining.saturating_sub(from_mem);
            continue;
        }
        let to_read = remaining.min(COPY_CHUNK_BYTES as u64) as usize;
        let n = stream
            .read(&mut buf[..to_read])
            .await
            .map_err(|e| format!("Ошибка чтения из torrent stream: {e}"))?;
        if n == 0 {
            break;
        }
        {
            let mut cache = prepared.memory_cache.lock().await;
            cache.push_sequential(cursor, &buf[..n]);
        }
        socket
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("Ошибка отправки стрима: {e}"))?;
        cursor += n as u64;
        prepared
            .playback_offset
            .store(cursor, std::sync::atomic::Ordering::Relaxed);
        remaining = remaining.saturating_sub(n as u64);
    }

    let sent = content_len_start.saturating_sub(remaining);
    if let Some(d) = debug {
        d.push(
            "http",
            format!("response {status} sent {sent} B"),
            Some(json!({
                "mime": &prepared.mime,
                "rangeStart": start,
                "rangeEnd": end,
                "plannedLen": content_len_start,
            })),
        );
    }

    Ok(())
}

async fn write_from_memory_cache(
    socket: &mut TcpStream,
    prepared: &super::types::PreparedStream,
    cursor: u64,
    remaining: u64,
) -> Result<u64, String> {
    let data = {
        let cache = prepared.memory_cache.lock().await;
        cache.read_copy(cursor, remaining.min(COPY_CHUNK_BYTES as u64) as usize)
    };
    if data.is_empty() {
        return Ok(0);
    }
    socket
        .write_all(&data)
        .await
        .map_err(|e| format!("Ошибка отправки memory cache: {e}"))?;
    Ok(data.len() as u64)
}
