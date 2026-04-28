use reqwest::Client;
use serde::Deserialize;

use crate::resolver::types::MatchKind;

#[derive(Deserialize)]
struct Entry {
    #[serde(rename = "artistName")]
    artist_name: Option<String>,
    #[serde(rename = "trackName")]
    track_name: Option<String>,
}

/// LRCLIB — open lyrics database. Critically important for lyric-snippet
/// queries: someone types a line from a song, LRCLIB's full-text search
/// over lyrics finds the track, and we surface it as `(artist, title)`.
/// iTunes and most catalog APIs can't do this — they index metadata, not text.
///
/// Also strong for Russian tracks since LRCLIB is community-fed and covers
/// Cyrillic catalogs that Western services miss.
pub async fn lookup(
    client: &Client,
    query: &str,
    limit: usize,
) -> Result<Vec<(String, String, MatchKind)>, String> {
    let res = client
        .get("https://lrclib.net/api/search")
        .query(&[("q", query)])
        .send()
        .await
        .map_err(|e| format!("lrclib: request failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("lrclib: http {}", res.status()));
    }
    let body: Vec<Entry> = res
        .json()
        .await
        .map_err(|e| format!("lrclib: decode failed: {e}"))?;

    Ok(body
        .into_iter()
        .take(limit)
        .filter_map(|it| {
            let a = it.artist_name?;
            let t = it.track_name?;
            (!a.is_empty() && !t.is_empty()).then_some((a, t, MatchKind::Track))
        })
        .collect())
}
