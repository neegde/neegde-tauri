import { listen } from "@tauri-apps/api/event";
import { soulseekSearch } from "../../soulseek/api.js";
import { parseAudioTrackPrefix } from "../../lib/utils.js";

// ── Path helpers ──────────────────────────────────────────────────────────────

function folderKey(filepath) {
  const norm = (filepath ?? "").replace(/\\/g, "/");
  const last = norm.lastIndexOf("/");
  return last > 0 ? norm.slice(0, last) : "";
}

/** Cross-user album dedup key — last two path segments, alnum only. */
function albumNormKey(folderPath) {
  const parts = folderPath.split("/").filter(Boolean);
  return parts.slice(-2).join("/").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function basename(filepath) {
  return (filepath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
}

function bestBitrate(rows) {
  return rows.reduce((b, r) => ((r.bitrate ?? 0) > b ? (r.bitrate ?? 0) : b), 0);
}

/**
 * Normalized track title extracted from a file name — used as the dedup
 * key when many peers hold copies of the same song under slightly
 * different filenames. Strips extension, leading date stamps, leading
 * track numbers, and bracketed meta tags.
 *
 * Deliberately does NOT try to drop "Artist - " prefixes: SoulSeek
 * peers sometimes name files "Song - Artist" (reversed) or use dashes
 * in the song title itself ("Get Out - You Stay"), and a greedy strip
 * kept picking the wrong half. Prefixes that carry artist info stay in
 * the key, so a handful of close variants may survive as separate
 * tracks — better than silently collapsing distinct songs.
 */
function titleNormKey(filepath) {
  let s = basename(filepath ?? "");
  if (!s) return "";
  s = s.replace(/\.[^.]+$/, "");
  s = s
    .replace(/^[\[(]\d{4}[-./]\d{2}[-./]\d{2}[\])]\s*/, "")
    .replace(/^\d{4}[-./]\d{2}[-./]\d{2}\s+/, "");
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, "");
  // Strip leading track number ONLY when it is clearly separated from
  // the rest of the title — i.e. followed by whitespace. Without this
  // guard we also ate "1." out of artist names like "1.Kla$", merging
  // distinct artists ("Kla$" vs "1.Kla$") into one dedup key.
  s = s.replace(/^\(?\d{1,3}\)?[-.)]?\s+/, "");
  // Strip everything that is not a letter or digit in any script (Cyrillic,
  // CJK, etc. all pass through). The old ASCII-only `[^a-z0-9]` regex ate
  // every Cyrillic filename and collapsed it to "" — causing Russian tracks
  // to vanish from the feed entirely.
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// ── Cover selection ───────────────────────────────────────────────────────────

/** Lower = better — matches common release-folder art names. */
function coverPriority(filename) {
  const n = (filename ?? "").toLowerCase();
  const order = [
    "folder.jpg", "folder.jpeg", "cover.jpg", "cover.jpeg", "front.jpg", "front.jpeg",
    "album.jpg", "artwork.jpg", "cover.png", "folder.png", "front.png", "album.png",
  ];
  for (let i = 0; i < order.length; i++) if (n.endsWith(order[i])) return i;
  return 40;
}

function pickCover(imageRows) {
  if (!imageRows?.length) return null;
  const scored = imageRows.map((c) => ({
    c,
    pr: coverPriority(basename(c.slsk_filepath ?? c.name ?? "")),
    size: c.size ?? 0,
  }));
  scored.sort((a, b) => a.pr - b.pr || b.size - a.size);
  return scored[0].c;
}

function inferFormatFromExt(filepath) {
  const ext = basename(filepath ?? "").toLowerCase().split(".").pop();
  if (!ext) return null;
  if (ext === "flac") return "FLAC";
  if (ext === "mp3")  return "MP3";
  if (ext === "ogg" || ext === "oga") return "OGG";
  if (ext === "wav")  return "WAV";
  if (ext === "ape")  return "APE";
  if (ext === "m4a" || ext === "alac") return "ALAC";
  if (ext === "aac")  return "AAC";
  if (ext === "opus") return "OPUS";
  if (ext === "dsd" || ext === "dsf" || ext === "dff") return "DSD";
  return null;
}

// ── Entity construction ──────────────────────────────────────────────────────

function rawAudioToTrack(raw, username, folder, albumId) {
  const fileName = basename(raw.slsk_filepath ?? raw.name ?? "");
  return {
    type: "track",
    id: `slsk:track:${username}|${raw.slsk_filepath}`,
    title: fileName,
    artist: null,
    albumTitle: albumId ? folder.split("/").pop() || folder : null,
    fileName,
    format: inferFormatFromExt(raw.slsk_filepath),
    bitrate: raw.bitrate ?? null,
    duration: raw.duration ?? null,
    size: raw.size ?? null,
    albumId,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: username, slskFilepath: raw.slsk_filepath },
      // Cover lives on the parent Album when there is one; for orphan
      // singles the adapter picks it up from here.
      raw: { row: raw, cover: null },
    }],
    score: 0,
    mergedFrom: 1,
  };
}

/**
 * Collapse flat SoulSeek rows into a self-contained Entity snapshot.
 *
 * Grouping is **strictly within one peer's folder** (user|folder). An
 * Album is emitted only when a single peer shares ≥2 distinct songs
 * (by normalized title) in that folder — i.e. they actually hold a
 * multi-track release. Cross-user aggregation into synthetic albums
 * was tried and produced broken results ("OK Computer" with 5 copies
 * of "Paranoid Android" from 5 peers who each had only that one song):
 * SoulSeek search returns per-file matches, not full folders, so
 * cross-peer bundling guesses wrong about completeness.
 *
 * Cross-user dedup still happens, but at the TRACK level only: many
 * peers holding the same song collapse into one orphan Track whose
 * `peers` count reflects availability.
 *
 * Completing an album from its neighbours requires fetching the peer's
 * folder contents over the SoulSeek P2P protocol (GetSharedFileList).
 * That path is deferred to a Rust-side enrichment stage.
 *
 * @param {Array} rawRows
 * @returns {import("../../types/entities.js").Entity[]}
 */
function groupSlskRowsToEntities(rawRows) {
  const images = rawRows.filter((r) => r.slsk_is_image);
  const audios = rawRows.filter((r) => !r.slsk_is_image);

  // Images indexed by (user, folder) — cover belongs to whoever owns the folder.
  const imagesByUserFolder = new Map();
  for (const img of images) {
    const key = `${img.slsk_username}|${folderKey(img.slsk_filepath)}`;
    if (!imagesByUserFolder.has(key)) imagesByUserFolder.set(key, []);
    imagesByUserFolder.get(key).push(img);
  }

  /** @type {Map<string, { user: string, folder: string, tracks: Array }>} */
  const byUserFolder = new Map();
  const rootless = [];
  for (const t of audios) {
    const folder = folderKey(t.slsk_filepath);
    if (!folder) { rootless.push(t); continue; }
    const key = `${t.slsk_username}|${folder}`;
    if (!byUserFolder.has(key)) {
      byUserFolder.set(key, { user: t.slsk_username, folder, tracks: [] });
    }
    byUserFolder.get(key).tracks.push(t);
  }

  // Separate multi-track folders (candidate Albums) from singleton tracks.
  const albumFolders = [];
  const singletonTracks = [];
  for (const g of byUserFolder.values()) {
    // Unique songs in this folder by normalized title (ext-aware so FLAC and
    // MP3 copies of the same song stay distinct — user may want to choose).
    const byTitle = new Map();
    for (const t of g.tracks) {
      const title = titleNormKey(t.slsk_filepath ?? t.name ?? "");
      if (!title) continue;
      const ext = (basename(t.slsk_filepath ?? "").split(".").pop() ?? "").toLowerCase();
      const key = `${title}.${ext}`;
      const ex = byTitle.get(key);
      if (!ex || (t.bitrate ?? 0) > (ex.bitrate ?? 0)) byTitle.set(key, t);
    }
    const uniq = Array.from(byTitle.values());
    if (uniq.length === 0) continue;

    const uniqueTitleKeys = new Set();
    for (const k of byTitle.keys()) uniqueTitleKeys.add(k.split(".")[0]);
    if (uniqueTitleKeys.size >= 2) {
      albumFolders.push({ user: g.user, folder: g.folder, tracks: uniq });
    } else {
      // Folder carries only one distinct song → treat as a single track.
      singletonTracks.push(uniq[0]);
    }
  }

  const out = [];

  for (const g of albumFolders) {
    const albumId = `slsk:album:${g.user}|${g.folder}`;
    const cover = pickCover(imagesByUserFolder.get(`${g.user}|${g.folder}`) ?? []);
    const albumTracks = g.tracks.map((t) =>
      rawAudioToTrack(t, g.user, g.folder, albumId),
    );
    const best = bestBitrate(albumTracks) || null;
    const totalSize = albumTracks.reduce((s, t) => s + (t.size ?? 0), 0) || null;

    out.push({
      type: "album",
      id: albumId,
      title: g.folder.split("/").pop() || g.folder,
      artist: null,
      year: null,
      coverUrl: null,
      format: albumTracks[0]?.format ?? null,
      bitrate: best,
      size: totalSize,
      seeders: null,
      leechers: null,
      peers: 1,
      trackIds: albumTracks.map((t) => t.id),
      sources: [{
        kind: "soulseek",
        refs: { slskUsername: g.user, slskFolder: g.folder },
        raw: { tracks: g.tracks, cover, kind: "album" },
      }],
      score: 0,
      mergedFrom: 1,
    });
    out.push(...albumTracks);
  }

  // Cross-user dedup of singletons: one song held by N peers → one Track.
  // Best bitrate wins; `peers` counts how many users carry a matching title.
  const byTitleKey = new Map();
  for (const t of singletonTracks.concat(rootless)) {
    const title = titleNormKey(t.slsk_filepath ?? t.name ?? "");
    if (!title) continue;
    const ext = (basename(t.slsk_filepath ?? "").split(".").pop() ?? "").toLowerCase();
    const key = `${title}.${ext}`;
    if (!byTitleKey.has(key)) byTitleKey.set(key, { row: t, users: new Set() });
    const slot = byTitleKey.get(key);
    slot.users.add(t.slsk_username);
    if ((t.bitrate ?? 0) > (slot.row.bitrate ?? 0)) slot.row = t;
  }

  for (const { row, users } of byTitleKey.values()) {
    const folder = folderKey(row.slsk_filepath);
    const cover = folder
      ? pickCover(imagesByUserFolder.get(`${row.slsk_username}|${folder}`) ?? [])
      : null;
    const track = rawAudioToTrack(row, row.slsk_username, folder, null);
    track.sources[0].raw.cover = cover;
    track.sources[0].raw.peers = users.size;
    out.push(track);
  }

  return out;
}

/**
 * SoulSeek search provider.
 *
 * Wraps `soulseek_search` + the `soulseek-search-batch` event stream.
 * Incremental: yields a fresh full Entity snapshot every time new raw
 * rows arrive. Snapshots are self-contained (every Track that is listed
 * in any Album.trackIds also appears in the snapshot).
 *
 * @type {import("../../types/entities.js").SearchProvider}
 */
export const soulseekProvider = {
  kind: "soulseek",

  async *search(query, ctx) {
    if (ctx.signal.aborted) return;
    const t0 = performance.now();
    ctx.log("soulseek", `search start: "${query}" (req=${ctx.requestId})`);

    const raw = [];
    /** @type {Array<import("../../types/entities.js").Entity[]>} */
    const queue = [];
    let pendingResolve = null;
    let finished = false;
    let finalError = null;

    const nudge = () => { const r = pendingResolve; pendingResolve = null; r?.(); };
    const finish = (err) => {
      if (finished) return;
      finished = true;
      if (err) finalError = err;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      nudge();
    };
    const emitSnapshot = () => {
      if (ctx.signal.aborted) return;
      queue.push(groupSlskRowsToEntities(raw));
      nudge();
    };

    // SoulSeek's server-side timeout for `soulseek_search` is ~12 s so
    // every search hangs for 12 s even when all responsive peers already
    // answered in the first second. Two watchdogs finalize us early:
    //   • BASELINE — if no batch at all arrives within this window,
    //     the query has no takers; stop waiting.
    //   • IDLE — after the first batch arrives, if no new rows land
    //     for this long, the long tail won't deliver anything useful.
    // The server-side `soulseekSearch` promise keeps running in the
    // background and we simply ignore its resolution.
    const BASELINE_MS = 5000;
    const IDLE_MS = 1000;
    let idleTimer = setTimeout(() => {
      ctx.log(
        "soulseek",
        `baseline finish: no batches in ${BASELINE_MS}ms`,
      );
      finish(null);
    }, BASELINE_MS);
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        ctx.log(
          "soulseek",
          `idle finish: no new rows for ${IDLE_MS}ms (have ${raw.length})`,
        );
        finish(null);
      }, IDLE_MS);
    };

    const unlisten = await listen("soulseek-search-batch", (e) => {
      const p = e.payload;
      if (!p || p.requestId !== ctx.requestId) return;
      if (ctx.signal.aborted) return;
      raw.push(...p.rows);
      emitSnapshot();
      armIdleTimer();
    });

    const onAbort = () => finish(null);
    ctx.signal.addEventListener("abort", onAbort);
    // Guard: `addEventListener` on an already-aborted signal does NOT fire
    // the listener synchronously — re-check to avoid hanging.
    if (ctx.signal.aborted) finish(null);

    soulseekSearch(query, ctx.requestId)
      .then((finalRows) => {
        if (ctx.signal.aborted) return;
        raw.length = 0;
        raw.push(...finalRows);
        emitSnapshot();
        ctx.log(
          "soulseek",
          `final rows: ${finalRows.length} (${Math.round(performance.now() - t0)}ms)`,
        );
      })
      .catch((err) => { finalError = err; })
      .finally(() => finish(finalError));

    try {
      while (true) {
        if (queue.length) {
          const snap = queue[queue.length - 1];
          queue.length = 0;
          yield snap;
        }
        if (finished) break;
        if (ctx.signal.aborted) break;
        await new Promise((r) => { pendingResolve = r; });
      }
      if (finalError && !ctx.signal.aborted) throw finalError;
    } finally {
      try { unlisten(); } catch (_) { /* already unlistened */ }
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};
