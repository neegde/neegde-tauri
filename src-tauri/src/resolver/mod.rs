//! Query intent resolver.
//!
//! Takes a raw user query (a song name, an artist, an album, or even a
//! lyric snippet) and returns a set of normalized `(artist, title)`
//! candidates plus an `Intent` classification. Downstream, the search
//! engine uses the canonical pair to query BitTorrent / SoulSeek
//! providers with a clean "{artist} {title}" string instead of the raw
//! user input — dramatically improving hit quality and unlocking
//! lyric-snippet search (which file-based providers can't do).
//!
//! Architecture: a **fast tier** (catalog & lyric APIs) runs in
//! parallel; a **slow tier** (web-search scrapers like Brave with PoW
//! challenge) fires only if fast tier returned nothing. This file
//! wires the tiers together; each source lives in its own module
//! under `sources/`.

mod norm;
mod sources;
mod types;

pub use types::{ArtistTitle, Intent, MatchKind, ResolveResult, TrackCandidate};

use reqwest::Client;
use std::collections::HashMap;
use std::future::Future;
use std::time::{Duration, Instant};
use tauri::State;

/// Default per-source ceiling so a blocked / slow endpoint doesn't tank
/// the whole resolver. Catalog APIs (iTunes, LRCLIB, Deezer, MusicBrainz)
/// answer well under a second when reachable, so 3 s is generous.
const DEFAULT_SOURCE_TIMEOUT: Duration = Duration::from_millis(3000);

/// Brave often replies 429 with an Argon2id PoW challenge. Healthy path
/// (PoW-free or simple challenge) resolves in <2 s. When Brave escalates
/// difficulty we'd rather give up and fall through to raw search than make
/// the user stare at a spinner — the raw path works perfectly well without
/// canonical resolution.
const BRAVE_TIMEOUT: Duration = Duration::from_millis(4000);

/// Run one lookup, log its timing, swallow errors into an empty result.
/// Generic on the future type so each source keeps its own opaque future
/// — a closure can't infer this because the first call pins the type.
async fn run_source<F>(
    name: &'static str,
    timeout: Duration,
    fut: F,
) -> Vec<(String, String, MatchKind)>
where
    F: Future<Output = Result<Vec<(String, String, MatchKind)>, String>>,
{
    let t = Instant::now();
    let res = tokio::time::timeout(timeout, fut).await;
    let ms = t.elapsed().as_millis();
    match res {
        Ok(Ok(v)) => {
            eprintln!("[resolver] {name}: {} hits in {ms} ms", v.len());
            v
        }
        Ok(Err(e)) => {
            eprintln!("[resolver] {name}: ERR in {ms} ms — {e}");
            Vec::new()
        }
        Err(_) => {
            eprintln!("[resolver] {name}: TIMEOUT after {ms} ms");
            Vec::new()
        }
    }
}

/// Managed state: a single `reqwest::Client` shared across resolver
/// commands so connection pooling works across sources.
pub struct ResolverState {
    client: Client,
}

impl ResolverState {
    pub fn new() -> Self {
        // UA mirrors the test/track_search.py prototype so we get the same
        // behaviour on APIs that sniff headers (Brave definitely does).
        const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                          AppleWebKit/537.36 (KHTML, like Gecko) \
                          Chrome/122.0.0.0 Safari/537.36";
        let client = Client::builder()
            .user_agent(UA)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12))
            .pool_max_idle_per_host(4)
            .build()
            .expect("failed to build resolver reqwest client");
        Self { client }
    }
}

impl Default for ResolverState {
    fn default() -> Self {
        Self::new()
    }
}

/// Merge kinded (artist, title, kind) triples from multiple sources,
/// deduplicating by normalized (kind, artist, title) and recording every
/// source that reported each. Kind is part of the key so an Artist hit
/// and a same-named Track hit from different pages stay distinct.
fn merge_candidates(
    by_source: Vec<(&'static str, Vec<(String, String, MatchKind)>)>,
) -> Vec<TrackCandidate> {
    /// Preserve insertion order while allowing O(1) dedup by normalized key.
    let mut order: Vec<(MatchKind, String, String)> = Vec::new();
    let mut by_key: HashMap<(MatchKind, String, String), TrackCandidate> = HashMap::new();

    for (source, triples) in by_source {
        for (artist, title, kind) in triples {
            let key = (kind, norm::norm(&artist), norm::norm(&title));
            // Artist is mandatory; title is not — Artist-kind candidates
            // carry an empty title on purpose.
            if key.1.is_empty() {
                continue;
            }
            let entry = by_key.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                TrackCandidate {
                    artist: artist.clone(),
                    title: title.clone(),
                    kind,
                    sources: Vec::new(),
                }
            });
            let s = source.to_string();
            if !entry.sources.contains(&s) {
                entry.sources.push(s);
            }
        }
    }

    order
        .into_iter()
        .filter_map(|k| by_key.remove(&k))
        .collect()
}

/// Lowercase alnum tokens split on any non-alnum boundary.
fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

/// Drop bracketed annotations before scoring. Brave surfaces Genius
/// titles like "Сукины дети (Sons of Bitches)" where the parenthetical
/// is a translation, not part of the name; those extra tokens dilute
/// the token-overlap ratio and make good matches look weak.
fn strip_bracket_annotations(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth_paren = 0i32;
    let mut depth_brack = 0i32;
    for ch in s.chars() {
        match ch {
            '(' => depth_paren += 1,
            ')' => if depth_paren > 0 { depth_paren -= 1 },
            '[' => depth_brack += 1,
            ']' => if depth_brack > 0 { depth_brack -= 1 },
            _ => if depth_paren == 0 && depth_brack == 0 { out.push(ch) },
        }
    }
    out
}

/// True if `candidate_part` looks like it matches the query. Two signals:
///   1. Token overlap ≥ 50 % — catches word-level matches like
///      "Paranoid Android" vs query "radiohead paranoid".
///   2. Substring in normalized form, either direction — catches no-space
///      glue-writing like "Нон стоп" vs query "нонстоп".
/// Either signal alone is enough; a candidate part with neither is skipped.
///
/// The candidate part is stripped of bracketed annotations before scoring
/// — "Сукины дети (Sons of Bitches)" is counted as the two tokens
/// "сукины","дети", not five including the English translation.
fn part_matches(
    query_tokens: &std::collections::HashSet<String>,
    query_norm: &str,
    candidate_part: &str,
) -> bool {
    let stripped = strip_bracket_annotations(candidate_part);
    let cand_tokens = tokenize(&stripped);
    if !cand_tokens.is_empty() {
        let overlap = cand_tokens
            .iter()
            .filter(|t| query_tokens.contains(*t))
            .count();
        if overlap * 2 >= cand_tokens.len() {
            return true;
        }
    }
    let cand_norm = norm::norm(&stripped);
    if cand_norm.is_empty() {
        return false;
    }
    query_norm.contains(&cand_norm) || cand_norm.contains(query_norm)
}

/// Rough "how well does this candidate match the raw query" score.
/// Returns a number in `[0, 4]` — higher is better.
///
///   * +1 when the candidate's **artist** overlaps the query (token or substring).
///   * +1 when the candidate's **title** overlaps the query (token or substring).
///   * +1 extra when normalized **artist** exactly equals normalized query.
///   * +1 extra when normalized **title** exactly equals normalized query —
///     this is the case "user typed the track name directly", e.g.
///     "первый класс" → any candidate with title "Первый класс". Without
///     this bonus the query has to mention both artist AND title to clear
///     the 2.0 threshold, which makes title-only searches impossible.
///   * +0.5 × (sources.len() − 1) as a confidence tiebreaker — more sources
///     agreeing on the same pair nudges it up, but never beats a genuine
///     text-match.
fn match_score(query: &str, cand: &TrackCandidate) -> f32 {
    let q_norm = norm::norm(query);
    let q_tokens: std::collections::HashSet<String> = tokenize(query).into_iter().collect();
    let artist_stripped = strip_bracket_annotations(&cand.artist);
    let title_stripped = strip_bracket_annotations(&cand.title);
    let mut score = 0.0_f32;
    if part_matches(&q_tokens, &q_norm, &cand.artist) { score += 1.0; }
    if part_matches(&q_tokens, &q_norm, &cand.title)  { score += 1.0; }
    if !q_norm.is_empty() && norm::norm(&artist_stripped) == q_norm { score += 1.0; }
    if !q_norm.is_empty() && norm::norm(&title_stripped)  == q_norm { score += 1.0; }
    score += 0.5 * (cand.sources.len().saturating_sub(1) as f32);
    score
}

/// Classify the query's intent from the aggregated candidate set.
///
/// Heuristics (intentionally simple — can be refined when we have
/// enough real traffic to see failure modes):
///
///  - **Lyric**: LRCLIB matched AND query looks like a phrase (long,
///    no explicit `artist - title` separator).
///  - **Artist**: normalized query equals the top candidate's artist
///    and we see ≥2 distinct tracks from that artist.
///  - **Track**: we have at least one candidate — default.
///  - **Raw**: no candidates at all.
fn classify_intent(query: &str, cands: &[TrackCandidate], has_canonical: bool) -> Intent {
    if cands.is_empty() {
        return Intent::Raw;
    }

    let q_norm = norm::norm(query);
    let top_artist_norm = norm::norm(&cands[0].artist);

    // Artist-only: the raw query IS the artist name, and we've got at
    // least two different tracks by them. Doesn't require a canonical
    // (since artist alone doesn't pin down a specific track).
    if !top_artist_norm.is_empty() && q_norm == top_artist_norm {
        let same_artist = cands
            .iter()
            .filter(|c| norm::norm(&c.artist) == top_artist_norm)
            .count();
        if same_artist >= 2 {
            return Intent::Artist;
        }
    }

    // Lyric: LRCLIB matched AND query looks like a phrase. Requires an
    // actual canonical so we don't label something Lyric when the whole
    // match was low-confidence.
    if has_canonical {
        let lrclib_hit = cands
            .iter()
            .any(|c| c.sources.iter().any(|s| s == "lrclib"));
        let has_explicit_separator =
            query.contains(" - ") || query.contains(" – ") || query.contains(" — ");
        let char_len = query.chars().count();
        if lrclib_hit && char_len > 25 && !has_explicit_separator {
            return Intent::Lyric;
        }
        return Intent::Track;
    }

    // We have candidates but none matched tightly enough to canonicalize —
    // providers search the raw string. Candidates still surface in the UI
    // hint so the user can see what resolver considered.
    Intent::Raw
}

/// Resolve a raw query into a set of `(artist, title)` candidates.
///
/// Runs every enabled source in parallel, merges the results, and picks
/// a canonical pair + intent. Returns within the resolver client's
/// timeout (currently 12 s per source; typical run 0.3–1.5 s).
#[tauri::command]
pub async fn resolve_query(
    state: State<'_, ResolverState>,
    query: String,
) -> Result<ResolveResult, String> {
    let t0 = Instant::now();
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(ResolveResult::empty(query, 0));
    }

    let client = state.client.clone();

    // Fast tier: all sources fire in parallel. Each source's own error
    // is logged-and-ignored here; we only fail the whole command if a
    // panic or cancel bubbles up (shouldn't happen with our sources).
    // Per-source timing is logged so a slow source is immediately
    // visible instead of hiding inside the aggregate elapsed_ms.
    // Fast tier is Brave only now. iTunes and LRCLIB were both dropped:
    // iTunes ranked by global popularity and surfaced wrong tracks;
    // LRCLIB is blocked on user's network and always timed out after
    // 3 s, single-handedly adding 3 s to every search. Brave alone
    // reliably resolves artist/album/track/lyric pages with its
    // site:genius.com constraint and returns in ~700–1200 ms.
    let brave_pairs = run_source(
        "brave",
        BRAVE_TIMEOUT,
        sources::brave::lookup(&client, trimmed, 10),
    )
    .await;

    let merged = merge_candidates(vec![
        ("brave", brave_pairs),
    ]);

    // Re-rank by how well each candidate matches the raw query — iTunes
    // otherwise returns by global popularity, which surfaces totally wrong
    // tracks when the user asked for a different song by the same artist.
    //
    // Cross-candidate boost: if a Track candidate shares its artist with
    // an Artist-page candidate in the same result set, the artist is
    // validated by two independent sources (the track-page and the
    // artist hub). That's strong evidence the user meant a specific
    // song BY that artist — bump the score by +1 so a cross-script
    // track name (e.g. "1.Kla$ - Сукины дети" for a Cyrillic query
    // "первый класс сукины дети") clears the 2.0 threshold.
    let artist_hub_norms: std::collections::HashSet<String> = merged
        .iter()
        .filter(|c| c.kind == MatchKind::Artist)
        .map(|c| norm::norm(&c.artist))
        .filter(|n| !n.is_empty())
        .collect();
    let mut ranked: Vec<(f32, TrackCandidate)> = merged
        .into_iter()
        .map(|c| {
            let mut s = match_score(trimmed, &c);
            if c.kind == MatchKind::Track
                && artist_hub_norms.contains(&norm::norm(&c.artist))
            {
                s += 1.0;
            }
            (s, c)
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
    });

    // Extract special-kind candidates (Album / Artist pages) BEFORE
    // truncation — text-score is 0 for them, so `truncate(10)` would
    // cull them below tracks that happen to contain the query words.
    //
    // We DO require the candidate to overlap the query (score >= 1),
    // otherwise Brave's random album/artist pages for unrelated artists
    // would become canonical. Example: query "первый класс" and Brave's
    // first Album hit was "Джон Гарик — Классика" — zero overlap, but
    // my earlier code trusted it unconditionally. Script-mismatch
    // (Cyrillic query, Latin-only canonical) is an explicit escape hatch
    // that bypasses the overlap check (since cross-script compare can't
    // score properly).
    let special_trust = |c: &TrackCandidate| -> bool {
        let s = match_score(trimmed, c);
        if s >= 1.0 { return true; }
        // Cyrillic query + Latin-only candidate → allow: user is probably
        // typing a transliteration and the semantic match is fine.
        let q_cyrl = trimmed
            .chars()
            .any(|ch| matches!(ch, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё'));
        let full = format!("{} {}", c.artist, c.title);
        let c_latin_only = full
            .chars()
            .all(|ch| !matches!(ch, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё'));
        q_cyrl && c_latin_only
    };
    let album_page_cand = ranked
        .iter()
        .find(|(_, c)| c.kind == MatchKind::Album && special_trust(c))
        .map(|(_, c)| c.clone());
    let artist_page_cand = ranked
        .iter()
        .find(|(_, c)| c.kind == MatchKind::Artist && !c.artist.is_empty() && special_trust(c))
        .map(|(_, c)| c.clone());

    ranked.truncate(10);

    let candidates: Vec<TrackCandidate> = ranked.iter().map(|(_, c)| c.clone()).collect();

    // Canonicalization has two modes:
    //
    //  A) Normal queries (track/artist/album) — top candidate must overlap
    //     the raw query in both artist AND title (score >= 2.0). Otherwise
    //     we reject the canonical: iTunes's popularity-sorted top is often
    //     wrong when user asked for a different song by the same artist.
    //
    //  B) Lyric-specialist hits — if the query looks like a lyric phrase
    //     AND a lyric-specialist source (LRCLIB or Brave) returned
    //     candidates, we trust the top-1 without a text-match check. A
    //     lyric query by definition does NOT contain the track's artist
    //     or title words — that's the whole point of lyric lookup.
    const CANONICAL_MIN_SCORE: f32 = 2.0;

    let looks_like_lyric = {
        let char_len = trimmed.chars().count();
        let has_separator = trimmed.contains(" - ")
            || trimmed.contains(" – ")
            || trimmed.contains(" — ");
        char_len > 20 && !has_separator
    };
    let has_lyric_source_hit = candidates.iter().any(|c| {
        c.sources
            .iter()
            .any(|s| s == "lrclib" || s == "brave")
    });

    // Script mismatch = user typed transliteration. "параноид андроид" ←→
    // top candidate "Radiohead - Paranoid Android". match_score can't bridge
    // Cyrillic↔Latin, so it always reports 0; without this branch we'd fall
    // back to Raw and send the useless transliterated string to providers.
    let query_has_cyrillic = trimmed
        .chars()
        .any(|c| matches!(c, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё'));
    let top_is_latin_only = ranked.first().is_some_and(|(_, c)| {
        let full = format!("{} {}", c.artist, c.title);
        full.chars().all(|ch| !matches!(ch, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё'))
    });
    let script_mismatch = query_has_cyrillic && top_is_latin_only;

    let trust_lyric_source =
        (looks_like_lyric || script_mismatch) && has_lyric_source_hit;

    // Artist-page candidates (title empty) are their own signal: a lyrics
    // site shipped a dedicated "X Lyrics, Songs, and Albums" page, which
    // only exists for recognised artists. We trust the first such hit
    // WITHOUT text-match because Brave's ranking is semantic — e.g. it
    // knows that a search for "первый класс" matches the artist "1.Kla$"
    // (a stylized spelling of the same name), even though pure string
    // comparison would never bridge the two. The site: filter in
    // brave.rs already constrains results to lyrics domains, so a random
    // gibberish query won't get a plausible-looking false positive here.
    // Pick the candidate with the highest score that also passes its
    // kind-specific acceptance threshold. Highest score wins across
    // kinds — an exact Track match (query has both artist AND title
    // words) should beat an Artist-page candidate that only matches
    // the artist. Previously we preferred Artist-page unconditionally
    // and ignored strong Track matches.
    //
    //   Track kind   → requires score ≥ 2.0  OR trust_lyric_source
    //   Album kind   → requires score ≥ 1.0  OR script_mismatch
    //   Artist kind  → requires score ≥ 1.0  OR script_mismatch
    let accepts = |score: f32, kind: MatchKind, c: &TrackCandidate| -> bool {
        match kind {
            MatchKind::Track => score >= CANONICAL_MIN_SCORE || trust_lyric_source,
            MatchKind::Album | MatchKind::Artist => {
                if score >= 1.0 { return true; }
                // special_trust script-mismatch escape
                let q_cyrl = trimmed
                    .chars()
                    .any(|ch| matches!(ch, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё'));
                let full = format!("{} {}", c.artist, c.title);
                let c_latin_only = full
                    .chars()
                    .all(|ch| !matches!(ch, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё'));
                q_cyrl && c_latin_only
            }
        }
    };

    // Include album_page_cand / artist_page_cand from the full pre-
    // truncation list so we don't miss a great match that fell off the
    // top 10 due to zero text-score.
    let mut kinded: Vec<(f32, &TrackCandidate)> = ranked
        .iter()
        .map(|(s, c)| (*s, c))
        .collect();
    if let Some(c) = &album_page_cand {
        if !kinded.iter().any(|(_, x)| x.kind == MatchKind::Album && x.artist == c.artist) {
            kinded.push((match_score(trimmed, c), c));
        }
    }
    if let Some(c) = &artist_page_cand {
        if !kinded.iter().any(|(_, x)| x.kind == MatchKind::Artist && x.artist == c.artist) {
            kinded.push((match_score(trimmed, c), c));
        }
    }
    kinded.sort_by(|a, b| {
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
    });

    // Artist-only query test: if every token of the raw query is a token
    // of some candidate's artist, the user is naming an artist and
    // nothing else — force an Artist-intent canonical. Without this the
    // highest-score ties among dozens of Track candidates by the same
    // artist (each scoring ~2.0 via artist-hub boost) resolve randomly
    // to whichever track Brave listed first ("Пошлая Молли" → АКНЕ).
    let q_tokens_set: std::collections::HashSet<String> = tokenize(trimmed).into_iter().collect();
    let artist_only_query = artist_page_cand.as_ref().is_some_and(|c| {
        if q_tokens_set.is_empty() { return false; }
        let stripped = strip_bracket_annotations(&c.artist);
        let a_tokens: std::collections::HashSet<String> =
            tokenize(&stripped).into_iter().collect();
        q_tokens_set.iter().all(|t| a_tokens.contains(t))
    });

    let (canonical, canonical_kind) = if artist_only_query {
        let c = artist_page_cand.as_ref().unwrap();
        (
            Some(ArtistTitle {
                artist: c.artist.clone(),
                title: String::new(),
            }),
            Some(MatchKind::Artist),
        )
    } else {
        let picked: Option<(f32, TrackCandidate)> = kinded
            .iter()
            .find(|(s, c)| accepts(*s, c.kind, c))
            .map(|(s, c)| (*s, (*c).clone()));
        let canonical = picked.as_ref().map(|(_, c)| {
            let title = if c.kind == MatchKind::Artist {
                String::new()
            } else {
                c.title.clone()
            };
            ArtistTitle {
                artist: c.artist.clone(),
                title,
            }
        });
        let canonical_kind = picked.as_ref().map(|(_, c)| c.kind);
        (canonical, canonical_kind)
    };
    let intent = match canonical_kind {
        Some(MatchKind::Album) => Intent::Album,
        Some(MatchKind::Artist) => Intent::Artist,
        Some(MatchKind::Track) => {
            // Lyric heuristic: the query looks like a free phrase (length,
            // no "Artist - Title" separator) AND contains words the
            // top candidate's metadata does NOT cover — those extra
            // words are the lyric fragment. If every query token is
            // already inside artist+title, it's a plain Track query,
            // not a lyric.
            let top_cand = canonical.as_ref().map(|c| {
                let a_strip = strip_bracket_annotations(&c.artist);
                let t_strip = strip_bracket_annotations(&c.title);
                let mut set: std::collections::HashSet<String> = std::collections::HashSet::new();
                for t in tokenize(&a_strip) { set.insert(t); }
                for t in tokenize(&t_strip) { set.insert(t); }
                set
            }).unwrap_or_default();
            let q_has_extra_words = q_tokens_set.iter().any(|t| !top_cand.contains(t));
            if looks_like_lyric && has_lyric_source_hit && q_has_extra_words {
                Intent::Lyric
            } else {
                Intent::Track
            }
        }
        None => classify_intent(trimmed, &candidates, false),
    };

    let elapsed_ms = t0.elapsed().as_millis() as u64;
    eprintln!(
        "[resolver] \"{}\" → {:?} ({} candidates, {} ms)",
        trimmed,
        intent,
        candidates.len(),
        elapsed_ms,
    );

    Ok(ResolveResult {
        query,
        canonical,
        candidates,
        intent,
        elapsed_ms,
    })
}
