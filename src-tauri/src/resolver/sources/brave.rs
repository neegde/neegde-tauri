//! Brave Search source — independent index, the most robust of the
//! web-scrape fallbacks per the user's own testing.
//!
//! Brave guards /search with an Argon2id proof-of-work challenge that
//! returns HTTP 429 + a JSON challenge when it suspects a bot. We solve
//! it locally (~0.5–2 s on M-series CPU), POST the solution back, and
//! retry the search.
//!
//! Title extraction reuses the same "Artist - Title Lyrics" parsers as
//! other scrape sources (shared in `title_patterns.rs` — to land in the
//! next patch alongside DDG/Mojeek).

use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use std::time::Instant;

use crate::resolver::types::MatchKind;

/// Challenge shape served by Brave when we get a 429.
#[derive(Deserialize, Debug)]
struct Challenge {
    tokens: Vec<String>,
    zero_count: usize,
    hash_function_params: PowParams,
    solution_limit: Option<u32>,
    set_token: String,
}

#[derive(Deserialize, Debug)]
struct PowParams {
    iterations: u32,
    memory_size: u32,
    parallelism: u32,
    hash_length: usize,
}

/// Solution payload POSTed to `/api/captcha/pow?brave=0`.
#[derive(serde::Serialize, Debug)]
struct SolutionPayload<'a> {
    set_token: &'a str,
    solutions: std::collections::HashMap<String, String>,
    taken_time: u64,
}

/// Solve Argon2id for every token in the challenge. Returns the payload
/// Brave expects back, or `None` if we couldn't solve within
/// `solution_limit` tries per token.
fn solve_pow(challenge: &Challenge) -> Option<SolutionPayload<'_>> {
    let params = Params::new(
        challenge.hash_function_params.memory_size,
        challenge.hash_function_params.iterations,
        challenge.hash_function_params.parallelism,
        Some(challenge.hash_function_params.hash_length),
    )
    .ok()?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let limit = challenge.solution_limit.unwrap_or(5000);
    let zeros = challenge.zero_count;
    let hash_len = challenge.hash_function_params.hash_length;

    let t0 = Instant::now();
    let mut solutions = std::collections::HashMap::with_capacity(challenge.tokens.len());
    let mut rng = rand::thread_rng();
    let mut salt_bytes = [0u8; 16];
    let mut digest = vec![0u8; hash_len];

    for tok in &challenge.tokens {
        let mut found: Option<String> = None;
        for _ in 0..limit {
            rng.fill_bytes(&mut salt_bytes);
            // Brave expects the UTF-8 bytes of the salt's hex STRING as the
            // Argon2 salt input — not the raw 16 bytes. This matches the
            // Python prototype.
            let salt_hex = hex::encode(salt_bytes);
            if argon
                .hash_password_into(tok.as_bytes(), salt_hex.as_bytes(), &mut digest)
                .is_err()
            {
                return None;
            }
            let digest_hex = hex::encode(&digest);
            if digest_hex.bytes().take(zeros).all(|b| b == b'0') {
                found = Some(salt_hex);
                break;
            }
        }
        let salt = found?;
        solutions.insert(tok.clone(), salt);
    }

    Some(SolutionPayload {
        set_token: &challenge.set_token,
        solutions,
        taken_time: t0.elapsed().as_millis() as u64,
    })
}

// HTML regex-lite: find "snippet-title"-ish spans. Not a real HTML parser —
// deliberately forgiving because Brave tweaks class names periodically.
// Borrowed from the Python prototype where this shape worked in practice.
const TITLE_PAT: &str = r#"(?s)<(?:div|span|a)[^>]*class="[^"]*search-snippet-title[^"]*"[^>]*>([^<]{3,200})</"#;

fn extract_titles(html: &str) -> Vec<String> {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(TITLE_PAT).unwrap());
    re.captures_iter(html)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/// Shared "Artist - Title Lyrics" / album-page / artist-page parser.
/// Returns `(artist, title, kind)` where:
///   * Track   — canonical "Artist - Title Lyrics" shapes, title = song
///   * Album   — "Artist - Album Lyrics and Tracklist" (Genius), title = album
///   * Artist  — "X Lyrics, Songs, and Albums" (Genius) / RU artist hubs,
///               title empty
///
/// The kind drives downstream Intent classification and, via
/// `MatchKind`, the UI chip shown in the search hint.
fn parse_artist_title(raw: &str) -> Option<(String, String, MatchKind)> {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<Vec<(regex::Regex, bool)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        let make = |p: &str| regex::RegexBuilder::new(p).case_insensitive(true).build().unwrap();
        vec![
            // bool = true  → captured as (artist, title)
            // bool = false → captured as (title, artist)  [swap at emit time]
            (make(r"^(.+?)\s*[-–—]\s*(.+?)\s+Lyrics\s*[|\-–—].*$"), true),
            (make(r"^(.+?)\s*[-–—]\s*song\s+and\s+lyrics\s+by\s+(.+?)(?:\s*[|\-–—].*)?$"), false),
            (make(r"^(.+?)\s*[-–—]\s*(.+?):\s*Song\s+Lyrics"), false),
            (make(r"^(.+?)\s*[-–—]\s*(.+?)\s+Lyrics\s*$"), true),
            (make(r"^(.+?)\s+lyrics\s+by\s+(.+?)(?:\s*[-|].*)?$"), false),
            (make(r"^Текст\s+песни\s+(.+?)\s*[-–—]\s*(.+?)(?:\s*\|.*)?$"), true),
            (make(r#"^(.+?)\s*[-–—]\s*Текст\s+песни\s+["«](.+?)["»]"#), true),
        ]
    });

    // Strip HTML tags + unescape entities, trim.
    let text = {
        static TAG_RE: OnceLock<regex::Regex> = OnceLock::new();
        let tag_re = TAG_RE.get_or_init(|| regex::Regex::new(r"<.*?>").unwrap());
        let stripped = tag_re.replace_all(raw, "");
        html_unescape(&stripped).trim().to_string()
    };

    static JUNK: OnceLock<regex::Regex> = OnceLock::new();
    let junk = JUNK.get_or_init(|| {
        regex::RegexBuilder::new(r"\b(lyrics|paroles|letras?|testo|canzone|слова|песни|читать|текст)\b")
            .case_insensitive(true)
            .build()
            .unwrap()
    });

    // Album-level pages first — they carry a distinctive "Lyrics and
    // Tracklist" marker, and we want to pick them up BEFORE the
    // generic track-page patterns (which could also match
    // "Artist - Album Lyrics..." with wrong semantics).
    static ALBUM_RES: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let album_pats = ALBUM_RES.get_or_init(|| {
        let make = |p: &str| regex::RegexBuilder::new(p).case_insensitive(true).build().unwrap();
        vec![
            // Genius: "Artist - Album Lyrics and Tracklist | Genius"
            make(r"^(.+?)\s*[-–—]\s*(.+?)\s+Lyrics\s+and\s+Tracklist\s*\|\s*Genius\s*$"),
            // Genius (alt): "Artist - Album Lyrics and Tracklist"
            make(r"^(.+?)\s*[-–—]\s*(.+?)\s+Lyrics\s+and\s+Tracklist\s*$"),
        ]
    });
    for rx in album_pats {
        if let Some(cap) = rx.captures(&text) {
            let artist = cap.get(1)?.as_str().trim_matches(|c: char| " -–—|".contains(c)).trim();
            let album = cap.get(2)?.as_str().trim_matches(|c: char| " -–—|".contains(c)).trim();
            if artist.is_empty() || album.is_empty() { continue; }
            if junk.is_match(artist) || junk.is_match(album) { continue; }
            if artist.chars().count() > 60 || album.chars().count() > 80 { continue; }
            if artist.contains('|') || album.contains('|') { continue; }
            // Reject Genius's service accounts — "Genius Russian Translations",
            // "Genius Italian Translations" etc. publish translation pages
            // whose album-title shape matches our regex but the "artist"
            // is the translator account, not the real band. The title
            // itself typically contains "RealArtist - RealAlbum", so a
            // better resolution comes from the sibling Artist page hit —
            // which we let through elsewhere.
            let artist_lc = artist.to_lowercase();
            if artist_lc.contains("translations")
                || artist_lc.contains("перевод")
                || artist_lc.contains("переводы")
            {
                continue;
            }
            return Some((artist.to_string(), album.to_string(), MatchKind::Album));
        }
    }

    for (rx, order_at) in patterns {
        if let Some(cap) = rx.captures(&text) {
            let g1 = cap.get(1)?.as_str().trim_matches(|c: char| " -–—|".contains(c)).trim();
            let g2 = cap.get(2)?.as_str().trim_matches(|c: char| " -–—|".contains(c)).trim();
            let (artist, title) = if *order_at { (g1, g2) } else { (g2, g1) };
            if artist.is_empty() || title.is_empty() { continue; }
            if junk.is_match(artist) || junk.is_match(title) { continue; }
            if artist.chars().count() > 60 || title.chars().count() > 80 { continue; }
            // `|` inside either half means the regex swallowed a "| Source"
            // suffix into the capture (e.g. title="Radiohead | Genius").
            // The correct parse for such a page title needs a different
            // regex shape, so reject this match and let the next pattern try.
            if artist.contains('|') || title.contains('|') { continue; }
            return Some((artist.to_string(), title.to_string(), MatchKind::Track));
        }
    }

    // Artist-only pages — dedicated "landing" pages on lyrics sites. We
    // emit them with an empty title so downstream code can route to
    // Artist intent and search providers by artist alone. Patterns cover
    // several site conventions:
    //   * Genius:        "X Lyrics, Songs, and Albums | Genius"
    //   * amalgama-lab:  "X | Переводы и тексты песен | Дискография, ..."
    //   * generic RU:    "Тексты песен X (| ...)" / "Слова песен X..."
    static ARTIST_PAGE_RES: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let artist_pats = ARTIST_PAGE_RES.get_or_init(|| {
        let make = |p: &str| {
            regex::RegexBuilder::new(p)
                .case_insensitive(true)
                .build()
                .unwrap()
        };
        vec![
            // "X Lyrics, Songs, and Albums | Genius"
            make(r"^(.+?)\s+Lyrics,\s*(?:Songs(?:,\s*and\s*Albums)?|Songs\s*&\s*Albums)\s*\|\s*Genius\s*$"),
            // "X | Переводы и тексты песен ..."  (amalgama artist hub)
            make(r"^(.+?)\s*\|\s*Переводы\s+и\s+тексты"),
            // "Тексты песен X | ..."  / "Тексты песен X, слова песен X"
            make(r"^Тексты\s+песен\s+(.+?)(?:\s*[|,].*)?$"),
            // "Слова песен X, переводы песен X, ..."
            make(r"^Слова\s+песен\s+(.+?)(?:\s*[,|].*)?$"),
        ]
    });
    for rx in artist_pats {
        if let Some(cap) = rx.captures(&text) {
            let artist = cap.get(1)?.as_str().trim_matches(|c: char| " -–—|".contains(c)).trim();
            if !artist.is_empty()
                && !junk.is_match(artist)
                && artist.chars().count() <= 60
                && !artist.contains('|')
            {
                return Some((artist.to_string(), String::new(), MatchKind::Artist));
            }
        }
    }

    None
}

/// Minimal HTML entity decoder — covers &amp; &quot; &#39; &lt; &gt; &#NNNN;.
///
/// Char-based, NOT byte-based. The previous byte-walking version pushed
/// `b[i] as char` for every non-`&` byte, which mangled multibyte UTF-8
/// (Cyrillic/CJK) into Latin-1 codepoints — "королевский" became
/// "Ð\u{BA}Ð¾Ñ\u{80}…". Iterating by `char` keeps each Unicode codepoint
/// intact; we only drop into byte land when we actually need to parse an
/// entity, which is always pure ASCII between the `&` and `;`.
fn html_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.char_indices();
    while let Some((pos, ch)) = chars.next() {
        if ch != '&' {
            out.push(ch);
            continue;
        }
        // Try to locate the matching `;` within a reasonable lookahead —
        // entities are short (≤ ~8 chars after `&`). Longer runs aren't
        // real entities.
        let rest = &s[pos + 1..];
        let Some(semi) = rest.find(';') else {
            out.push('&');
            continue;
        };
        if semi > 16 {
            out.push('&');
            continue;
        }
        let entity = &rest[..semi];
        let consumed = pos + 1 + semi + 1; // index just past `;`

        let replacement = match entity {
            "amp" => Some("&"),
            "quot" => Some("\""),
            "apos" | "#39" => Some("'"),
            "lt" => Some("<"),
            "gt" => Some(">"),
            "nbsp" => Some(" "),
            _ => None,
        };
        if let Some(r) = replacement {
            out.push_str(r);
        } else if let Some(num_str) = entity.strip_prefix('#') {
            let cp = if let Some(hex_str) = num_str.strip_prefix('x').or_else(|| num_str.strip_prefix('X')) {
                u32::from_str_radix(hex_str, 16).ok()
            } else {
                num_str.parse::<u32>().ok()
            };
            if let Some(decoded) = cp.and_then(char::from_u32) {
                out.push(decoded);
            } else {
                out.push('&');
                continue;
            }
        } else {
            out.push('&');
            continue;
        }

        // Skip the input we just consumed (everything up to and including `;`).
        while let Some((idx, _)) = chars.clone().next() {
            if idx >= consumed { break; }
            chars.next();
        }
    }
    out
}

/// Known lyrics domains. Genius-only for now: it's the one source whose
/// page-title shapes (track/album/artist) we parse cleanly, has the
/// widest English catalog, and doesn't dilute the result set with
/// translation-portal noise the way amalgama / lyrsense / etc. do.
/// More sites can be added back once their title shapes are covered
/// by dedicated regex patterns.
const LYRICS_SITES: &[&str] = &["genius.com"];

pub async fn lookup(
    client: &Client,
    query: &str,
    limit: usize,
) -> Result<Vec<(String, String, MatchKind)>, String> {
    // Constrain the search to known lyrics pages. `site:X OR site:Y` is a
    // native Brave operator — we get only pages whose URL is on one of
    // these hosts, so the snippet-title parsers (which expect
    // "Artist - Title Lyrics | Genius" shapes) hit far more often and
    // random blog posts / Wikipedia / torrent trackers can't pollute
    // the top results.
    let sites_clause = LYRICS_SITES
        .iter()
        .map(|s| format!("site:{s}"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let q = format!("{query} ({sites_clause})");
    let base_url = "https://search.brave.com/search";

    // Try up to 3 times (initial + 2 retries after PoW). Brave may serve a
    // new challenge on a re-try — we solve whatever comes.
    let mut last_status: Option<StatusCode> = None;
    for _ in 0..3 {
        let res = client
            .get(base_url)
            .query(&[("q", q.as_str()), ("source", "web")])
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("brave: request failed: {e}"))?;

        last_status = Some(res.status());
        if res.status().is_success() {
            // Brave's HTML is UTF-8 but its Content-Type sometimes lacks an
            // explicit charset, so `res.text()` falls back to latin-1 and
            // mojibakes every Cyrillic byte pair. Read raw bytes and decode
            // as UTF-8 ourselves — lossy so malformed bytes become U+FFFD
            // instead of blowing up the whole search.
            let ct = res
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let ce = res
                .headers()
                .get("content-encoding")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let bytes = res
                .bytes()
                .await
                .map_err(|e| format!("brave: body read: {e}"))?;
            eprintln!(
                "[brave] got {} bytes, content-type={:?} content-encoding={:?}, first-30={:?}",
                bytes.len(),
                ct,
                ce,
                &bytes[..30.min(bytes.len())],
            );
            let html = String::from_utf8_lossy(&bytes);
            let mut out = Vec::new();
            for title in extract_titles(&html) {
                eprintln!("[brave] snippet-title: {title:?}");
                // Brave honours `site:genius.com` only loosely — it still
                // mixes in YouTube / Last.fm / Apple Music / Lenta / etc.
                // results when the corpus hit count is low. We force the
                // constraint client-side: if the page title doesn't end in
                // a Genius source marker, we're not looking at a Genius
                // page regardless of what Brave's URL says.
                if !title.to_lowercase().contains("genius") {
                    continue;
                }
                if let Some((a, t, k)) = parse_artist_title(&title) {
                    eprintln!("[brave] parsed: artist={a:?} title={t:?} kind={k:?}");
                    out.push((a, t, k));
                    if out.len() >= limit { break; }
                }
            }
            return Ok(out);
        }

        if res.status() != StatusCode::TOO_MANY_REQUESTS {
            return Err(format!("brave: http {}", res.status()));
        }
        // 429 — expect JSON challenge.
        let content_type = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !content_type.contains("application/json") {
            return Err(format!("brave: 429 without JSON challenge"));
        }
        let challenge: Challenge = res
            .json()
            .await
            .map_err(|e| format!("brave: challenge decode: {e}"))?;

        let solution = solve_pow(&challenge)
            .ok_or_else(|| "brave: PoW solve failed (exhausted solution_limit)".to_string())?;

        // POST solution — ignore its response body; the ticket is set
        // server-side via cookies.
        client
            .post("https://search.brave.com/api/captcha/pow?brave=0")
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(&solution)
            .send()
            .await
            .map_err(|e| format!("brave: pow submit: {e}"))?;
        // Loop retries the search.
    }

    Err(format!(
        "brave: giving up after retries (last status {:?})",
        last_status
    ))
}
