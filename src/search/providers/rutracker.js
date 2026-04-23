import { searchMusic, getTorrentDetails } from "../../rutracker/search.js";
import { detectAlbums } from "../../lib/utils.js";

function formatFromExt(filename) {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (!ext) return null;
  if (ext === "flac") return "FLAC";
  if (ext === "mp3")  return "MP3";
  if (ext === "ape")  return "APE";
  if (ext === "wav")  return "WAV";
  if (ext === "ogg" || ext === "oga") return "OGG";
  if (ext === "m4a" || ext === "alac") return "ALAC";
  if (ext === "aac")  return "AAC";
  if (ext === "opus") return "OPUS";
  if (ext === "dsf" || ext === "dsd" || ext === "dff") return "DSD";
  return null;
}

/**
 * Pick a single format string for an Album. Albums are normally homogeneous —
 * take the first audio file's format; null if we can't tell. Real aggregation
 * (lossless beats lossy, pick the best) lands in the normalize/score stage
 * later when it matters for ranking.
 */
function aggregateFormat(tracks) {
  for (const t of tracks) if (t.format) return t.format;
  return null;
}

/**
 * Build Track + Album entities for one RuTracker topic by fetching its
 * details and running detectAlbums on the file tree.
 *
 * Returns an empty array for topics with no audio content — this replaces
 * the old `filterRutrackerRowsWithPlayableAudio`: the filter now comes
 * for free because audio-less topics produce zero albums.
 *
 * @param {*} topicRow    RuTracker SearchResult row
 * @param {import("../../types/entities.js").SearchContext} ctx
 * @returns {Promise<import("../../types/entities.js").Entity[]>}
 */
async function enrichTopic(topicRow, ctx) {
  if (ctx.signal.aborted) return [];
  const details = await getTorrentDetails(topicRow.id);
  if (ctx.signal.aborted) return [];

  const rawFiles = details.files ?? [];
  // Backend sends `TorrentFile.path` as an array of components; `detectAlbums`
  // expects a string. Flatten once, then keep the original torrent-order index
  // on each flat entry — the stream engine addresses files by that index.
  const flatFiles = rawFiles.map((f, i) => ({
    path: (f.path ?? []).join("/"),
    size: f.size,
    _origIdx: i,
    _origFile: f,
  }));

  const albums = detectAlbums(flatFiles);
  if (albums.length === 0) return [];

  const entities = [];
  for (const alb of albums) {
    const albumId = `rt:album:${topicRow.id}:${encodeURIComponent(alb.dirPath)}`;
    const albumTracks = [];
    const trackIds = [];

    for (const f of alb.audioFiles) {
      const fileIdx = f._origIdx;
      if (fileIdx === undefined) continue;
      const fileName = f.path.split("/").pop() ?? "";
      const trackId = `rt:track:${topicRow.id}:${fileIdx}`;
      const track = {
        type: "track",
        id: trackId,
        title: fileName,
        artist: details.artist ?? null,
        albumTitle: alb.name || null,
        fileName,
        format: formatFromExt(fileName),
        bitrate: null,    // unknown from file tree; filled by later enrichment if needed
        duration: null,
        size: f.size ?? null,
        albumId,
        sources: [{
          kind: "rutracker",
          refs: { topicId: String(topicRow.id), fileIdx },
          raw: { topicRow, details, file: f._origFile },
        }],
        score: 0,
        mergedFrom: 1,
      };
      albumTracks.push(track);
      trackIds.push(trackId);
    }

    if (albumTracks.length === 0) continue;

    const album = {
      type: "album",
      id: albumId,
      title: alb.name || "",
      artist: details.artist ?? null,
      year: null,
      coverUrl: details.cover_data_url ?? null,
      format: aggregateFormat(albumTracks),
      bitrate: null,
      size: albumTracks.reduce((s, t) => s + (t.size ?? 0), 0) || null,
      seeders: topicRow.seeders ?? null,
      leechers: topicRow.leechers ?? null,
      peers: null,
      trackIds,
      sources: [{
        kind: "rutracker",
        refs: { topicId: String(topicRow.id), rootPath: alb.dirPath },
        raw: { topicRow, details, albumDir: alb },
      }],
      score: 0,
      mergedFrom: 1,
    };

    entities.push(album, ...albumTracks);
  }

  return entities;
}

/**
 * RuTracker search provider.
 *
 * Flow:
 *   1. `rutracker_search` → list of topic rows
 *   2. For each topic, fetch full details in a pool of 8 workers and
 *      split into Album + Track entities via `detectAlbums`.
 *   3. Yield progressive snapshots — UI fills in as topics complete.
 *
 * Errors in individual topics are logged and the topic is dropped.
 * The provider only throws when every topic failed (meaningful signal
 * to surface as a network/auth error in the UI).
 *
 * @type {import("../../types/entities.js").SearchProvider}
 */
export const rutrackerProvider = {
  kind: "rutracker",

  async *search(query, ctx) {
    if (ctx.signal.aborted) return;
    const t0 = performance.now();
    ctx.log("rutracker", `search start: "${query}"`);

    const rows = await searchMusic(query);
    const tSearch = performance.now();
    if (ctx.signal.aborted) return;
    ctx.log("rutracker", `raw topics: ${rows.length} (search ${Math.round(tSearch - t0)}ms)`);
    if (rows.length === 0) { yield []; return; }

    const all = [];         // accumulator: every entity from every completed topic
    /** @type {Array<import("../../types/entities.js").Entity[]>} */
    const snapshotQueue = [];
    let pendingResolve = null;
    const nudge = () => { const r = pendingResolve; pendingResolve = null; r?.(); };

    let settled = 0;
    let errors = 0;
    const total = rows.length;

    // Fire ALL topic enrichments concurrently. The old 8-worker pool was a
    // defensive cap against hammering RuTracker, but through a proxy the
    // bottleneck is per-request latency, not concurrency; batching by 8
    // stretched 50 topics to ~150 s. With everything in-flight at once
    // total time ≈ slowest single topic instead of total_time/8.
    const enrichments = rows.map((row) =>
      enrichTopic(row, ctx)
        .then((ents) => {
          if (ctx.signal.aborted) return;
          all.push(...ents);
        })
        .catch((e) => {
          errors += 1;
          ctx.log("rutracker", `topic ${row?.id} failed: ${e?.message ?? e}`);
        })
        .finally(() => {
          settled += 1;
          snapshotQueue.push(all.slice());
          nudge();
        }),
    );

    const allDone = Promise.allSettled(enrichments).finally(nudge);

    try {
      while (true) {
        if (snapshotQueue.length) {
          const snap = snapshotQueue[snapshotQueue.length - 1];
          snapshotQueue.length = 0;
          yield snap;
        }
        if (settled >= total) break;
        if (ctx.signal.aborted) break;
        await new Promise((r) => { pendingResolve = r; });
      }
    } finally {
      await allDone.catch(() => {});
    }

    const albums = all.filter((e) => e.type === "album").length;
    const tracks = all.filter((e) => e.type === "track").length;
    const tDone = performance.now();
    ctx.log(
      "rutracker",
      `done: ${albums} albums, ${tracks} tracks from ${total - errors}/${total} topics (enrich ${Math.round(tDone - tSearch)}ms, total ${Math.round(tDone - t0)}ms)`,
    );

    if (errors === total && total > 0) {
      throw new Error(`all ${total} topics failed to load`);
    }
  },
};
