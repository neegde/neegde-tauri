/**
 * Deezer-backed canonical name resolver (Stage 2).
 *
 * The deterministic resolver in `nameResolver.ts` gives us best-effort
 * `{artist, title, album}` from filepath alone. Every track where we landed
 * on "medium" or "low" confidence is a candidate for upgrading via the
 * Deezer public search API — a free, rate-generous catalog that has
 * broader coverage than MusicBrainz for Russian/CIS music and returns
 * clean canonical strings.
 *
 * Flow:
 *   1. `enrichTrackNames(track)` queries Deezer with the resolver's guess.
 *   2. If we get a hit whose normalized title matches ours, stamp the
 *      canonical `{artist, title, albumTitle, coverUrl}` onto `track.data`
 *      (Deezer album art HTTPS URL when present) and call
 *      `bumpEntitiesVersion()` so Vue re-renders every row pointing at
 *      the track.
 *   3. Results are cached by `artist|title` so a repeated query skips
 *      the network.
 *
 * Deezer quotes 50 req/s as the public-API ceiling. The rate-limited
 * queue is configured well below that so bursts from a 60-track search
 * don't trip any limiter.
 */

import { invoke } from "@tauri-apps/api/core";
import { RateLimitedFetchQueue } from "../lib/RateLimitedFetchQueue.js";
import { bumpEntitiesVersion, getTrack } from "../stores/entities.js";
import { putTrack } from "../persistence/trackCache.js";
import type { Track } from "./Track.js";
import { nameConfidence } from "./factory.js";
import { appDebugLog } from "../appDebugLog.js";

interface DeezerTrack {
  title?: string;
  title_short?: string;
  artist?: { name?: string };
  album?: { title?: string; cover_medium?: string | null; cover_big?: string | null };
}

interface DeezerResponse {
  data?: DeezerTrack[];
}

/** Cached canonical results, keyed by normalized `artist|title`. */
const cache = new Map<string, { artist: string; title: string; album: string; coverUrl: string | null } | null>();

/** In-flight lookups — dedupes concurrent requests for the same query. */
const pending = new Map<string, Promise<unknown>>();

/**
 * Rate-limited queue over the `deezer_search` Tauri command. We proxy
 * through Rust because WKWebView returns a generic "Load failed" for
 * direct fetches to `api.deezer.com` from the dev origin on macOS.
 */
const queue = new RateLimitedFetchQueue<{ query: string; limit: number }, string>({
  intervalMs: 60, // well under Deezer's 50/s public quota
  executor: async ({ query, limit }) => invoke<string>("deezer_search", { query, limit }),
});

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");
}

function cacheKey(artist: string, title: string): string {
  return `${normalize(artist)}|${normalize(title)}`;
}

/** Plain `artist title` query — Deezer's `q=` technically accepts
 *  `artist:"X" track:"Y"` quoted-field syntax, but that form returns zero
 *  hits for Cyrillic queries in practice (probably a tokenizer issue on
 *  their side). The plain-text form matches both Latin and Cyrillic. */
function buildQuery(artist: string, title: string): string {
  return `${artist} ${title}`.trim();
}

async function fetchCanonical(artist: string, title: string): Promise<{ artist: string; title: string; album: string; coverUrl: string | null } | null> {
  const query = buildQuery(artist, title);
  void appDebugLog("deezer", `query artist="${artist}" title="${title}"`).catch(() => {});
  let bodyText: string;
  try {
    bodyText = await queue.enqueue({ query, limit: 3 });
  } catch (e) {
    void appDebugLog("deezer", `fetch error: ${(e as Error)?.message ?? e}`).catch(() => {});
    return null;
  }
  let json: DeezerResponse;
  try {
    json = JSON.parse(bodyText) as DeezerResponse;
  } catch {
    return null;
  }
  const hit = json.data?.[0];
  if (!hit) {
    void appDebugLog("deezer", `no hit for artist="${artist}" title="${title}"`).catch(() => {});
    return null;
  }
  const hitTitle = hit.title ?? hit.title_short ?? "";
  const hitArtist = hit.artist?.name ?? "";
  if (!hitTitle || !hitArtist) return null;
  // Sanity gate: normalized title must share substring with ours.
  const a = normalize(title);
  const b = normalize(hitTitle);
  if (!a || !b) return null;
  if (!a.includes(b) && !b.includes(a)) {
    void appDebugLog("deezer", `reject title mismatch: ours="${title}" deezer="${hitTitle}"`).catch(() => {});
    return null;
  }
  // Artist gate: if we had an artist, it must share substring with the
  // Deezer hit. Prevents "Пошлая Молли / Нон стоп" mutating into an
  // unrelated song called "Non Stop" by a different artist.
  if (artist) {
    const x = normalize(artist);
    const y = normalize(hitArtist);
    if (!x.includes(y) && !y.includes(x)) {
      void appDebugLog("deezer", `reject artist mismatch: ours="${artist}" deezer="${hitArtist}"`).catch(() => {});
      return null;
    }
  }
  void appDebugLog("deezer", `hit: "${artist}" / "${title}" → "${hitArtist}" / "${hitTitle}" / "${hit.album?.title ?? ""}"`).catch(() => {});
  return {
    artist: hitArtist,
    title: hitTitle,
    album: hit.album?.title ?? "",
    coverUrl: hit.album?.cover_medium ?? hit.album?.cover_big ?? null,
  };
}

/**
 * Kick off a Deezer lookup for a track.
 *
 * Behaviour by resolver confidence:
 *   - `medium` / `low` → full canonical rewrite: artist, title, album, cover.
 *   - `high` → cover-only enrichment. Filename names are trusted, but the
 *     SoulSeek peer often refuses to share album art (Upload denied / early
 *     eof / cannot resolve address). When that happens the row would stay
 *     blank — Deezer is a free fallback for the thumbnail.
 *   - unknown → skip entirely.
 *
 * Noop when the track already has an `albumTitle` AND `coverUrl` in
 * cover-only mode, or when there is nothing to query with.
 *
 * On a hit, mutates `track.data` in place (cover-only fills only missing
 * fields) and bumps the entities version so every Vue consumer re-renders.
 */
export function enrichTrackNames(track: Track): void {
  const conf = nameConfidence.get(track.id);
  if (conf !== "medium" && conf !== "low" && conf !== "high") {
    void appDebugLog("deezer", `skip ${track.id} conf=${conf ?? "?"}`).catch(() => {});
    return;
  }
  const coverOnly = conf === "high";

  if (coverOnly) {
    const cur = track.toJSON() as { coverUrl?: string | null; albumTitle?: string | null };
    if (cur.coverUrl && cur.albumTitle) return;
  }

  const artist = (track.artist ?? "").trim();
  const title = (track.title ?? "").trim();
  if (!artist && !title) return;
  if (title.length < 3) return;

  const key = cacheKey(artist, title);
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (cached) applyCanonical(track, cached, coverOnly);
    return;
  }
  const inflight = pending.get(key);
  if (inflight) {
    void inflight.then(() => {
      const c = cache.get(key);
      if (c) applyCanonical(track, c, coverOnly);
    });
    return;
  }

  const p = fetchCanonical(artist || title, title).then((result) => {
    cache.set(key, result);
    pending.delete(key);
    if (result) applyCanonical(track, result, coverOnly);
  });
  pending.set(key, p);
}

function applyCanonical(
  track: Track,
  c: { artist: string; title: string; album: string; coverUrl: string | null },
  coverOnly = false,
): void {
  // Streaming search calls `registerEntities` on every batch; the same id
  // may refer to a newer `Track` instance than the one captured when
  // `enrichTrackNames` ran. Always stamp the registry copy so coverUrl /
  // canonical names land on what the UI actually renders.
  const live = getTrack(track.id);
  const target = live ?? track;
  // `target.data` is marked `protected readonly` in TypeScript, but the
  // runtime object is a plain POJO reachable through `toJSON()`. We write
  // through that reference so the class getters (`target.artist`, etc) pick
  // up the new values immediately without any wrapper re-instantiation.
  const data = target.toJSON();
  let mutated = false;
  if (coverOnly) {
    if (c.coverUrl && !data.coverUrl) {
      data.coverUrl = c.coverUrl;
      mutated = true;
    }
    if (c.album && !data.albumTitle) {
      data.albumTitle = c.album;
      mutated = true;
    }
    if (!mutated) return;
  } else {
    data.artist = c.artist;
    data.title = c.title;
    if (c.album) data.albumTitle = c.album;
    if (c.coverUrl) data.coverUrl = c.coverUrl;
    // Canonical names are authoritative — bump the tier so a repeat call
    // (e.g. if the track lands back in a search result set) doesn't re-query.
    nameConfidence.set(target.id, "high");
  }
  // Push the mutated TrackData back through the persistence cache so
  // likes / playlists / queue pick up the canonical names after a restart.
  // We pass a shallow clone — the cache's `put` bails out when prev ===
  // data (same reference, trivially equal), so only a fresh object forces
  // it to treat this as a change and schedule the localStorage save.
  putTrack({ ...data });
  bumpEntitiesVersion();
}
