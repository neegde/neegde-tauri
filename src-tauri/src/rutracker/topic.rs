use base64::Engine as _;
use encoding_rs::WINDOWS_1251;
use reqwest::{header, Client};

use super::{TorrentDetails, TorrentFile};

// ── Public API ────────────────────────────────────────────────────────────────

/// Fetch full torrent details for a Rutracker topic:
/// 1. GET viewtopic.php → extract first-post image URL + magnet link
/// 2. GET dl.php        → download .torrent file and parse file list
/// 3. Fetch image URL   → return as base64 data: URL
pub async fn get_torrent_details(
    client: &Client,
    base: &str,
    topic_id: &str,
) -> Result<TorrentDetails, String> {
    let topic_url = format!("{}/forum/viewtopic.php?t={}", base, topic_id);
    let dl_url = format!("{}/forum/dl.php?t={}", base, topic_id);

    // ── 1+2. Topic page and .torrent file in parallel ─────────────────────────
    let (topic_result, torrent_result) = tokio::join!(
        async {
            client
                .get(&topic_url)
                .send()
                .await
                .map_err(|e| format!("Ошибка загрузки страницы раздачи: {}", e))?
                .bytes()
                .await
                .map_err(|e| format!("Ошибка чтения страницы: {}", e))
        },
        async {
            client
                .get(&dl_url)
                .send()
                .await
                .map_err(|e| format!("Ошибка загрузки торрент-файла: {}", e))?
                .bytes()
                .await
                .map_err(|e| format!("Ошибка чтения торрент-файла: {}", e))
        }
    );
    let topic_bytes = topic_result?;
    let torrent_bytes = torrent_result?;
    let (topic_html, _, _) = WINDOWS_1251.decode(&topic_bytes);

    // ── 3. Parse ──────────────────────────────────────────────────────────────
    let (cover_img_url, magnet) = parse_topic_page(topic_html.as_ref(), base);
    let files = parse_torrent_bytes(&torrent_bytes)?;

    let cover_data_url = match cover_img_url {
        Some(url) => fetch_image_data_url(client, &url).await,
        None => None,
    };

    Ok(TorrentDetails {
        id: topic_id.to_string(),
        cover_data_url,
        magnet,
        files,
    })
}

/// Raw `.torrent` from `forum/dl.php` (same as in `get_torrent_details`, without topic HTML).
pub async fn download_torrent_file_bytes(
    client: &Client,
    base: &str,
    topic_id: &str,
) -> Result<Vec<u8>, String> {
    let dl_url = format!("{}/forum/dl.php?t={}", base, topic_id);
    let torrent_bytes = client
        .get(&dl_url)
        .send()
        .await
        .map_err(|e| format!("Ошибка загрузки торрент-файла: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("Ошибка чтения торрент-файла: {}", e))?;
    Ok(torrent_bytes.to_vec())
}

/// Load topic page only, fetch first-post cover image → data URL (for result-grid previews).
pub async fn get_cover_data_url(
    client: &Client,
    base: &str,
    topic_id: &str,
) -> Result<Option<String>, String> {
    let topic_url = format!("{}/forum/viewtopic.php?t={}", base, topic_id);
    let topic_bytes = client
        .get(&topic_url)
        .send()
        .await
        .map_err(|e| format!("Ошибка загрузки страницы раздачи: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("Ошибка чтения страницы: {}", e))?;
    let (topic_html, _, _) = WINDOWS_1251.decode(&topic_bytes);
    let (cover_img_url, _) = parse_topic_page(topic_html.as_ref(), base);
    Ok(match cover_img_url {
        Some(url) => fetch_image_data_url(client, &url).await,
        None => None,
    })
}

// ── Topic page parsing ────────────────────────────────────────────────────────

/// Returns (cover_image_url, magnet_link) extracted from the topic HTML.
fn parse_topic_page(html: &str, base: &str) -> (Option<String>, Option<String>) {
    let image_url = extract_first_post_image(html, base);
    let magnet = extract_magnet(html);
    (image_url, magnet)
}

/// Find `magnet:?xt=urn:btih:…` in the page HTML.
fn extract_magnet(html: &str) -> Option<String> {
    let start = html.find("magnet:?xt=")?;
    // Terminate at HTML attribute delimiters or whitespace
    let end = html[start..]
        .find(|c: char| matches!(c, '"' | '\'' | '<' | ' ' | '\n' | '\r' | '\t'))
        .map(|p| start + p)
        .unwrap_or(html.len());
    // HTML entities inside href — decode &amp; → &
    let magnet = html[start..end].replace("&amp;", "&");
    if magnet.contains("btih:") {
        Some(magnet)
    } else {
        None
    }
}

/// Extract the first cover-like image URL from the first post body.
/// Handles both Rutracker's `<var class="postImg" title="URL">` embeds
/// and plain `<img src="URL">` tags.
fn extract_first_post_image(html: &str, base: &str) -> Option<String> {
    let body_pos = html.find(r#"class="post_body""#)?;
    // Cap the search area; large posts can be hundreds of KB.
    // `body_pos + N` is a byte offset — must align to a UTF-8 char boundary.
    let raw_end = (body_pos + 40_000).min(html.len());
    let area_end = html.floor_char_boundary(raw_end);
    let area = &html[body_pos..area_end];

    // Strategy 1: <var class="postImg" title="URL"> — Rutracker's own image embed
    if let Some(url) = find_post_img_embed(area) {
        return Some(resolve_url(&url, base));
    }

    // Strategy 2: plain <img src="URL">
    if let Some(url) = find_img_src(area) {
        return Some(resolve_url(&url, base));
    }

    None
}

fn find_post_img_embed(html: &str) -> Option<String> {
    let pos = html.find("postImg")?;
    let tag_start = html[..pos].rfind('<').unwrap_or(0);
    let tag_end = html[pos..]
        .find('>')
        .map(|p| pos + p + 1)
        .unwrap_or(html.len());
    let tag = &html[tag_start..tag_end];
    extract_attr(tag, "title")
        .filter(|u| !u.is_empty())
        .map(String::from)
}

fn find_img_src(html: &str) -> Option<String> {
    let mut search_pos = 0;
    loop {
        let pos = html[search_pos..].find("<img ")? + search_pos;
        let tag_end = html[pos..]
            .find('>')
            .map(|p| pos + p + 1)
            .unwrap_or(html.len());
        let tag = &html[pos..tag_end];
        if let Some(src) = extract_attr(tag, "src") {
            // Skip relative paths (Rutracker smileys, icons) — covers are always external
            if src.starts_with("http") || src.starts_with("//") {
                return Some(src.to_string());
            }
        }
        search_pos = tag_end;
        if search_pos >= html.len() {
            break;
        }
    }
    None
}

/// Extract an attribute value from an HTML tag string, handling both quote styles.
fn extract_attr<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    for &q in &['"', '\''] {
        let marker = format!("{}={}", attr, q);
        if let Some(p) = tag.find(&marker) {
            let start = p + marker.len();
            if let Some(offset) = tag[start..].find(q) {
                return Some(&tag[start..start + offset]);
            }
        }
    }
    None
}

fn resolve_url(raw: &str, base: &str) -> String {
    if raw.starts_with("http") {
        raw.to_string()
    } else if raw.starts_with("//") {
        format!("https:{}", raw)
    } else {
        format!("{}{}", base, raw)
    }
}

// ── Image fetch ───────────────────────────────────────────────────────────────

/// Fetch `url` and return as `data:<mime>;base64,<b64>`.
/// Returns None on failure or if the image exceeds the size cap.
async fn fetch_image_data_url(client: &Client, url: &str) -> Option<String> {
    const MAX_BYTES: usize = 3 * 1024 * 1024; // 3 MB

    let resp = client.get(url).send().await.ok()?;

    let mime = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());

    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, b64))
}

// ── Minimal bencode parser ────────────────────────────────────────────────────
//
// Only the subset needed to read a standard .torrent file:
//   info.name, info.length (single-file), info.files[].path + info.files[].length
//
// No external crate required — bencode is a simple format.

enum BVal {
    Int(i64),
    Bytes(Vec<u8>),
    List(Vec<BVal>),
    Dict(Vec<(Vec<u8>, BVal)>),
}

type BDict = Vec<(Vec<u8>, BVal)>;

fn dict_get<'a>(dict: &'a BDict, key: &[u8]) -> Option<&'a BVal> {
    dict.iter()
        .find(|(k, _)| k.as_slice() == key)
        .map(|(_, v)| v)
}

/// Lossy-UTF8 decode: try UTF-8, fall back to replacing invalid sequences.
fn lossy_str(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec())
        .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned())
}

fn parse_val(data: &[u8], pos: usize) -> Result<(BVal, usize), String> {
    match data.get(pos) {
        Some(b'i') => parse_int(data, pos),
        Some(b'l') => parse_list(data, pos),
        Some(b'd') => parse_dict(data, pos),
        Some(b'0'..=b'9') => parse_bytes(data, pos),
        Some(b) => Err(format!(
            "Unknown bencode byte 0x{:02x} at offset {}",
            b, pos
        )),
        None => Err("Unexpected end of torrent data".into()),
    }
}

fn parse_int(data: &[u8], pos: usize) -> Result<(BVal, usize), String> {
    // i<decimal>e
    let start = pos + 1;
    let end = data[start..]
        .iter()
        .position(|&b| b == b'e')
        .map(|p| start + p)
        .ok_or("Unterminated integer in torrent")?;
    let n = std::str::from_utf8(&data[start..end])
        .map_err(|_| "Non-UTF8 integer")?
        .parse::<i64>()
        .map_err(|e| format!("Bad integer: {}", e))?;
    Ok((BVal::Int(n), end + 1))
}

fn parse_bytes(data: &[u8], pos: usize) -> Result<(BVal, usize), String> {
    // <length>:<bytes>
    let colon = data[pos..]
        .iter()
        .position(|&b| b == b':')
        .map(|p| pos + p)
        .ok_or("Missing ':' in byte string")?;
    let len: usize = std::str::from_utf8(&data[pos..colon])
        .map_err(|_| "Non-UTF8 byte length")?
        .parse()
        .map_err(|_| "Invalid byte string length")?;
    let start = colon + 1;
    let end = start + len;
    if end > data.len() {
        return Err("Byte string extends past end of torrent data".into());
    }
    Ok((BVal::Bytes(data[start..end].to_vec()), end))
}

fn parse_list(data: &[u8], pos: usize) -> Result<(BVal, usize), String> {
    // l<item>...<item>e
    let mut items = Vec::new();
    let mut cur = pos + 1;
    while data.get(cur) != Some(&b'e') {
        let (val, next) = parse_val(data, cur)?;
        items.push(val);
        cur = next;
    }
    Ok((BVal::List(items), cur + 1))
}

fn parse_dict(data: &[u8], pos: usize) -> Result<(BVal, usize), String> {
    // d<key><value>...<key><value>e
    let mut items: BDict = Vec::new();
    let mut cur = pos + 1;
    while data.get(cur) != Some(&b'e') {
        let (key_val, next) = parse_val(data, cur)?;
        let key = match key_val {
            BVal::Bytes(b) => b,
            _ => return Err("Dict key must be a byte string".into()),
        };
        cur = next;
        let (val, next) = parse_val(data, cur)?;
        items.push((key, val));
        cur = next;
    }
    Ok((BVal::Dict(items), cur + 1))
}

/// Parse a standard .torrent file and return its file list.
pub fn parse_torrent_bytes(data: &[u8]) -> Result<Vec<TorrentFile>, String> {
    if data.is_empty() {
        return Err("Торрент-файл пустой или не загрузился".into());
    }

    let (root, _) = parse_val(data, 0)?;

    let info = match &root {
        BVal::Dict(d) => match dict_get(d, b"info") {
            Some(BVal::Dict(info)) => info,
            _ => return Err("Торрент не содержит словарь info".into()),
        },
        _ => return Err("Корень торрент-файла не является словарём".into()),
    };

    let name = match dict_get(info, b"name") {
        Some(BVal::Bytes(b)) => lossy_str(b),
        _ => return Err("Торрент не содержит поле name".into()),
    };

    // Multi-file torrent: info.files is a list of {path, length} dicts
    if let Some(BVal::List(files)) = dict_get(info, b"files") {
        let mut result = Vec::new();
        for fval in files {
            let BVal::Dict(fd) = fval else { continue };
            let size = match dict_get(fd, b"length") {
                Some(BVal::Int(n)) => *n as u64,
                _ => 0,
            };
            // path components live under "path" or "path.utf-8"
            let path_key: &[u8] = if dict_get(fd, b"path.utf-8").is_some() {
                b"path.utf-8"
            } else {
                b"path"
            };
            let mut path = vec![name.clone()];
            if let Some(BVal::List(parts)) = dict_get(fd, path_key) {
                for p in parts {
                    if let BVal::Bytes(b) = p {
                        path.push(lossy_str(b));
                    }
                }
            }
            result.push(TorrentFile { path, size });
        }
        return Ok(result);
    }

    // Single-file torrent: info.length is the file size
    let size = match dict_get(info, b"length") {
        Some(BVal::Int(n)) => *n as u64,
        _ => 0,
    };
    Ok(vec![TorrentFile {
        path: vec![name],
        size,
    }])
}
