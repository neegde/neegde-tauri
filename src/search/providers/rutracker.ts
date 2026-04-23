import { searchMusic, getTorrentDetails } from "../../rutracker/search.js";
import { detectAlbums } from "../../lib/utils.js";
import type { SearchProvider, SearchProviderCtx } from "../session.js";
import type { PipelineEntity } from "../pipeline/index.js";

function formatFromExt(filename: string): string | null {
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

function aggregateFormat(tracks: Array<{ format?: string | null }>): string | null {
  for (const t of tracks) if (t.format) return t.format;
  return null;
}

interface TopicRow {
  id: string | number;
  name?: string;
  seeders?: number | null;
  leechers?: number | null;
  [k: string]: unknown;
}

async function enrichTopic(topicRow: TopicRow, ctx: SearchProviderCtx): Promise<PipelineEntity[]> {
  if (ctx.signal.aborted) return [];
  const details = await getTorrentDetails(String(topicRow.id));
  if (ctx.signal.aborted) return [];

  const rawFiles = (details as { files?: Array<{ path: string[]; size: number }> }).files ?? [];
  const flatFiles = rawFiles.map((f, i) => ({
    path: (f.path ?? []).join("/"),
    size: f.size,
    _origIdx: i,
    _origFile: f,
  }));

  const albums = detectAlbums(flatFiles);
  if (albums.length === 0) return [];

  const entities: PipelineEntity[] = [];
  for (const alb of albums) {
    const albumId = `rt:album:${topicRow.id}:${encodeURIComponent(alb.dirPath)}`;
    const albumTracks: Array<Record<string, unknown>> = [];
    const trackIds: string[] = [];

    for (const f of alb.audioFiles) {
      const fileIdx = (f as { _origIdx?: number })._origIdx;
      if (fileIdx === undefined) continue;
      const fileName = f.path.split("/").pop() ?? "";
      const trackId = `rt:track:${topicRow.id}:${fileIdx}`;
      const track = {
        type: "track",
        id: trackId,
        title: fileName,
        artist: (details as { artist?: string | null }).artist ?? null,
        albumTitle: alb.name || null,
        fileName,
        format: formatFromExt(fileName),
        bitrate: null,
        duration: null,
        size: (f as { size?: number }).size ?? null,
        albumId,
        sources: [{
          kind: "rutracker",
          refs: { topicId: String(topicRow.id), fileIdx },
          raw: { topicRow, details, file: (f as { _origFile?: unknown })._origFile },
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
      artist: (details as { artist?: string | null }).artist ?? null,
      year: null,
      coverUrl: (details as { cover_data_url?: string | null }).cover_data_url ?? null,
      format: aggregateFormat(albumTracks as Array<{ format?: string | null }>),
      bitrate: null,
      size: albumTracks.reduce((s, t) => s + ((t.size as number | null) ?? 0), 0) || null,
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

    entities.push(album as unknown as PipelineEntity, ...(albumTracks as unknown as PipelineEntity[]));
  }

  return entities;
}

/**
 * RuTracker search provider.
 *
 * Flow:
 *   1. `rutracker_search` → list of topic rows
 *   2. For each topic, fetch full details concurrently (proxy latency-bound)
 *      and split into Album + Track entities via `detectAlbums`.
 *   3. Yield progressive snapshots — UI fills in as topics complete.
 *
 * Errors in individual topics are logged and the topic is dropped.
 * The provider only throws when every topic failed (meaningful signal
 * to surface as a network/auth error in the UI).
 */
export const rutrackerProvider: SearchProvider = {
  kind: "rutracker",

  async *search(query: string, ctx: SearchProviderCtx) {
    if (ctx.signal.aborted) return;
    const t0 = performance.now();
    ctx.log("rutracker", `search start: "${query}"`);

    const rows = (await searchMusic(query)) as TopicRow[];
    const tSearch = performance.now();
    if (ctx.signal.aborted) return;
    ctx.log("rutracker", `raw topics: ${rows.length} (search ${Math.round(tSearch - t0)}ms)`);
    if (rows.length === 0) { yield []; return; }

    const all: PipelineEntity[] = [];
    const snapshotQueue: PipelineEntity[][] = [];
    let pendingResolve: (() => void) | null = null;
    const nudge = () => { const r = pendingResolve; pendingResolve = null; r?.(); };

    let settled = 0;
    let errors = 0;
    const total = rows.length;

    const enrichments = rows.map((row) =>
      enrichTopic(row, ctx)
        .then((ents) => {
          if (ctx.signal.aborted) return;
          all.push(...ents);
        })
        .catch((e: unknown) => {
          errors += 1;
          const msg = (e as { message?: string })?.message ?? String(e);
          ctx.log("rutracker", `topic ${row?.id} failed: ${msg}`);
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
          const snap = snapshotQueue[snapshotQueue.length - 1]!;
          snapshotQueue.length = 0;
          yield snap;
        }
        if (settled >= total) break;
        if (ctx.signal.aborted) break;
        await new Promise<void>((r) => { pendingResolve = r; });
      }
    } finally {
      await allDone.catch(() => {});
    }

    const albums = all.filter((e) => (e as { type?: string }).type === "album").length;
    const tracks = all.filter((e) => (e as { type?: string }).type === "track").length;
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
