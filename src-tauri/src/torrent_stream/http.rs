use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::net::{TcpListener, TcpStream};

use super::debug_log::AppDebugLog;
use super::state::TorrentStreamInner;
use super::types::ParsedRequest;
use super::{COPY_CHUNK_BYTES, MAX_HTTP_HEADER_BYTES};

const STREAM_MEMORY_CACHE_CAP_BYTES: usize = 24 * 1024 * 1024;
const READAHEAD_TARGET_BYTES: u64 = 20 * 1024 * 1024;

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
        let req = read_request(&mut socket).await?;
        let dbg = &self.debug_log;
        if !req.path.starts_with("/stream/") {
            dbg.push(
                "http",
                format!("404 not /stream: {}", req.path),
                None,
            );
            write_response_head(&mut socket, 404, "text/plain", 0, None).await?;
            return Ok(());
        }
        let token = req.path.trim_start_matches("/stream/").to_string();
        if token.is_empty() {
            dbg.push("http", "404 empty token", None);
            write_response_head(&mut socket, 404, "text/plain", 0, None).await?;
            return Ok(());
        }

        let stream_entry = self.streams.get(&token).map(|v| v.value().clone());
        let Some(stream_entry) = stream_entry else {
            dbg.push(
                "http",
                format!("404 unknown token {}", &token[..token.len().min(24)]),
                None,
            );
            write_response_head(&mut socket, 404, "text/plain", 0, None).await?;
            return Ok(());
        };

        let mut prepared = stream_entry.lock().await;
        dbg.push(
            "http",
            "request",
            Some(json!({
                "token": &token,
                "range": req.range.map(|(a, b)| format!("{a}-{b:?}")),
                "totalLen": prepared.total_len,
            })),
        );
        serve_stream(&mut socket, &mut prepared, req.range, Some(dbg)).await
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

    let mut parsed = ParsedRequest { path, range: None };
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("range:") {
            continue;
        }
        if let Some(idx) = line.find(':') {
            let value = line[idx + 1..].trim();
            parsed.range = parse_range_header(value);
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
         Connection: close\r\n\
         Accept-Ranges: bytes\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: Range\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {content_len}\r\n"
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
    prepared: &mut super::types::PreparedStream,
    range: Option<(u64, Option<u64>)>,
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
        write_response_head(socket, 200, &prepared.mime, 0, None).await?;
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
                write_response_head(socket, 416, &prepared.mime, 0, None).await?;
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
    write_response_head(socket, status, &prepared.mime, content_len, content_range).await?;

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

    if prepared.stream_pos != cursor {
        prepared
            .stream
            .seek(SeekFrom::Start(cursor))
            .await
            .map_err(|e| format!("Ошибка seek в потоке: {e}"))?;
        prepared.stream_pos = cursor;
    }

    refill_readahead_buffer(prepared, cursor).await?;
    let mut buf = vec![0u8; COPY_CHUNK_BYTES];
    while remaining > 0 {
        let from_mem = write_from_memory_cache(socket, prepared, cursor, remaining).await?;
        if from_mem > 0 {
            cursor += from_mem;
            remaining = remaining.saturating_sub(from_mem);
            continue;
        }
        let to_read = remaining.min(COPY_CHUNK_BYTES as u64) as usize;
        let n = prepared
            .stream
            .read(&mut buf[..to_read])
            .await
            .map_err(|e| format!("Ошибка чтения из torrent stream: {e}"))?;
        if n == 0 {
            break;
        }
        push_readahead_slice(prepared, cursor, &buf[..n]);
        socket
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("Ошибка отправки стрима: {e}"))?;
        cursor += n as u64;
        prepared.stream_pos += n as u64;
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

/// Maintains an in-memory cache window ahead of playback.
///
/// Args:
///     prepared: Prepared stream state.
///     playback_cursor: Current playback cursor.
async fn refill_readahead_buffer(
    prepared: &mut super::types::PreparedStream,
    playback_cursor: u64,
) -> Result<(), String> {
    let target_end = playback_cursor
        .saturating_add(READAHEAD_TARGET_BYTES)
        .min(prepared.total_len);
    let scheduler_stream = prepared.scheduler_stream.clone();
    let mut scheduler = scheduler_stream.lock().await;
    let mut local_offset = prepared
        .readahead
        .start_offset
        .saturating_add(prepared.readahead.buffer.len() as u64);
    if local_offset >= target_end {
        return Ok(());
    }
    if local_offset < playback_cursor {
        prepared.readahead.start_offset = playback_cursor;
        prepared.readahead.buffer.clear();
        local_offset = playback_cursor;
    }
    scheduler
        .seek(SeekFrom::Start(local_offset))
        .await
        .map_err(|e| format!("Ошибка seek readahead: {e}"))?;
    let mut tmp = vec![0u8; COPY_CHUNK_BYTES];
    while local_offset < target_end {
        let to_read = (target_end - local_offset).min(COPY_CHUNK_BYTES as u64) as usize;
        let n = scheduler
            .read(&mut tmp[..to_read])
            .await
            .map_err(|e| format!("Ошибка readahead чтения: {e}"))?;
        if n == 0 {
            break;
        }
        push_readahead_slice(prepared, local_offset, &tmp[..n]);
        local_offset += n as u64;
    }
    Ok(())
}

fn push_readahead_slice(prepared: &mut super::types::PreparedStream, offset: u64, data: &[u8]) {
    if prepared.readahead.buffer.is_empty() {
        prepared.readahead.start_offset = offset;
    }
    let expected = prepared
        .readahead
        .start_offset
        .saturating_add(prepared.readahead.buffer.len() as u64);
    if offset != expected {
        prepared.readahead.start_offset = offset;
        prepared.readahead.buffer.clear();
    }
    prepared.readahead.buffer.extend_from_slice(data);
    if prepared.readahead.buffer.len() > STREAM_MEMORY_CACHE_CAP_BYTES {
        let trim = prepared.readahead.buffer.len() - STREAM_MEMORY_CACHE_CAP_BYTES;
        prepared.readahead.buffer.drain(0..trim);
        prepared.readahead.start_offset = prepared.readahead.start_offset.saturating_add(trim as u64);
    }
}

async fn write_from_memory_cache(
    socket: &mut TcpStream,
    prepared: &mut super::types::PreparedStream,
    cursor: u64,
    remaining: u64,
) -> Result<u64, String> {
    let cache_start = prepared.readahead.start_offset;
    let cache_end = cache_start.saturating_add(prepared.readahead.buffer.len() as u64);
    if cursor < cache_start || cursor >= cache_end {
        return Ok(0);
    }
    let start = (cursor - cache_start) as usize;
    let max_end = start + remaining.min((cache_end - cursor) as u64) as usize;
    socket
        .write_all(&prepared.readahead.buffer[start..max_end])
        .await
        .map_err(|e| format!("Ошибка отправки memory cache: {e}"))?;
    Ok((max_end - start) as u64)
}
