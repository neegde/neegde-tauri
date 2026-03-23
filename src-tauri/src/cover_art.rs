use base64::Engine as _;
use reqwest::{header, Client};
use serde::Deserialize;

const MB_API: &str = "https://musicbrainz.org/ws/2";
const CAA_API: &str = "https://coverartarchive.org/release";
const USER_AGENT: &str = "neegde/1.0 (https://neegde.ru)";
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
struct MbSearchResult {
    releases: Vec<MbRelease>,
}

#[derive(Deserialize)]
struct MbRelease {
    id: String,
}

/// Fetch per-album cover art via MusicBrainz search + Cover Art Archive.
/// Returns a base64 data: URL or None if not found.
pub async fn fetch_album_cover(
    client: &Client,
    artist: &str,
    album: &str,
) -> Option<String> {
    if artist.trim().is_empty() && album.trim().is_empty() {
        return None;
    }

    let mbid = search_release(client, artist, album).await?;
    fetch_caa_front(client, &mbid).await
}

async fn search_release(client: &Client, artist: &str, album: &str) -> Option<String> {
    let query = build_query(artist, album);

    let resp = client
        .get(format!("{}/release", MB_API))
        .query(&[("query", &query), ("limit", &"3".to_string()), ("fmt", &"json".to_string())])
        .header(header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let data: MbSearchResult = resp.json().await.ok()?;
    data.releases.into_iter().next().map(|r| r.id)
}

async fn fetch_caa_front(client: &Client, mbid: &str) -> Option<String> {
    // front-250 is a 250px thumbnail — small enough to not bloat memory.
    let url = format!("{}/{}/front-250", CAA_API, mbid);

    let resp = client
        .get(&url)
        .header(header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let mime = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());

    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, b64))
}

fn build_query(artist: &str, album: &str) -> String {
    // Both supplied — prefer narrow search
    if !artist.trim().is_empty() && !album.trim().is_empty() {
        return format!(
            "release:\"{}\" AND artist:\"{}\"",
            escape_lucene(album),
            escape_lucene(artist)
        );
    }
    if !album.trim().is_empty() {
        return format!("release:\"{}\"", escape_lucene(album));
    }
    format!("artist:\"{}\"", escape_lucene(artist))
}

/// Escape MusicBrainz Lucene special chars inside quoted strings.
fn escape_lucene(s: &str) -> String {
    s.replace('"', "\\\"")
}
