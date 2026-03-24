use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::net::{TcpListener, TcpStream};

use super::state::TorrentStreamInner;
use super::types::ParsedRequest;
use super::{COPY_CHUNK_BYTES, MAX_HTTP_HEADER_BYTES};

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
        if !req.path.starts_with("/stream/") {
            write_response_head(&mut socket, 404, "text/plain", 0, None).await?;
            return Ok(());
        }
        let token = req.path.trim_start_matches("/stream/").to_string();
        if token.is_empty() {
            write_response_head(&mut socket, 404, "text/plain", 0, None).await?;
            return Ok(());
        }

        let stream_entry = {
            let map = self.streams.lock().await;
            map.get(&token).cloned()
        };
        let Some(stream_entry) = stream_entry else {
            write_response_head(&mut socket, 404, "text/plain", 0, None).await?;
            return Ok(());
        };

        let mut prepared = stream_entry.lock().await;
        serve_stream(&mut socket, &mut prepared, req.range).await
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
    let end = parts
        .next()
        .and_then(|s| {
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
) -> Result<(), String> {
    if prepared.total_len == 0 {
        write_response_head(socket, 200, &prepared.mime, 0, None).await?;
        return Ok(());
    }

    let (start, end, status) = match range {
        Some((start, end)) => {
            if start >= prepared.total_len {
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
    let mut cursor = start;
    let mut remaining = content_len;

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

    let mut buf = vec![0u8; COPY_CHUNK_BYTES];
    while remaining > 0 {
        let to_read = remaining.min(COPY_CHUNK_BYTES as u64) as usize;
        let n = prepared
            .stream
            .read(&mut buf[..to_read])
            .await
            .map_err(|e| format!("Ошибка чтения из torrent stream: {e}"))?;
        if n == 0 {
            break;
        }
        socket
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("Ошибка отправки стрима: {e}"))?;
        prepared.stream_pos += n as u64;
        remaining = remaining.saturating_sub(n as u64);
    }

    Ok(())
}
