use serde::Serialize;

/// What kind of page the source returned this candidate from.
///
/// Lyrics sites have distinct page shapes for tracks ("Artist - Title
/// Lyrics"), albums ("Artist - Album Lyrics and Tracklist"), and
/// artists ("X Lyrics, Songs, and Albums"). Keeping the kind explicit
/// on every candidate lets the resolver map it to the right `Intent`
/// without re-parsing strings downstream — and it carries over to the
/// UI chip so the hint shows «Трек» / «Альбом» / «Исполнитель».
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    Track,
    Album,
    Artist,
}

/// One (artist, title) pair with the set of sources that returned it.
/// For Artist matches `title` is empty; for Album matches `title` is
/// the album name; for Track matches `title` is the song title.
/// The more sources, the higher the confidence → drives ranking and
/// the "canonical" pick in `ResolveResult`.
#[derive(Serialize, Debug, Clone)]
pub struct TrackCandidate {
    pub artist: String,
    pub title: String,
    pub kind: MatchKind,
    /// Source identifiers that returned this candidate — e.g. `"itunes"`,
    /// `"lrclib"`, `"genius"`. Order = insertion order.
    pub sources: Vec<String>,
}

/// What the query looks like, decided after aggregating resolver results.
///
/// - **Track**: one clear song (typical match)
/// - **Artist**: query ~= artist name; multiple songs of one artist returned
/// - **Album**: resolver returned a tight cluster of tracks from one album
/// - **Lyric**: LRCLIB matched AND query looks like a lyric snippet (long, no separator)
/// - **Raw**: nothing useful resolved — provider search falls back to the original string
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Intent {
    Track,
    Artist,
    Album,
    Lyric,
    Raw,
}

/// Structured (artist, title) pair — kept as a real struct so JS consumers
/// read `.artist` / `.title` instead of indexing into a tuple serialized
/// as an array.
#[derive(Serialize, Debug, Clone)]
pub struct ArtistTitle {
    pub artist: String,
    pub title: String,
}

/// Result of `resolve_query` — consumed by `src/search/resolver` on the JS side.
#[derive(Serialize, Debug)]
pub struct ResolveResult {
    /// Raw user input, echoed back for logging / cache keys on the consumer.
    pub query: String,
    /// Best (artist, title) guess — `null` when every source was empty.
    pub canonical: Option<ArtistTitle>,
    /// Up to ~10 deduplicated candidates, best-first.
    pub candidates: Vec<TrackCandidate>,
    pub intent: Intent,
    pub elapsed_ms: u64,
}

impl ResolveResult {
    pub fn empty(query: String, elapsed_ms: u64) -> Self {
        Self {
            query,
            canonical: None,
            candidates: Vec::new(),
            intent: Intent::Raw,
            elapsed_ms,
        }
    }
}
