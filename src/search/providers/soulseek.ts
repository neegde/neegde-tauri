import { listen } from "@tauri-apps/api/event";
import { soulseekSearch } from "../../soulseek/api.js";
import { SearchProvider, type SearchProviderCtx } from "../provider.js";
import type { PipelineEntity } from "../pipeline/index.js";

// ── Path helpers ────────────────────────────────────────────────────────────

function folderKey(filepath: unknown): string {
  const norm = String(filepath ?? "").replace(/\\/g, "/");
  const last = norm.lastIndexOf("/");
  return last > 0 ? norm.slice(0, last) : "";
}

function basename(filepath: unknown): string {
  return String(filepath ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
}

function bestBitrate(rows: Array<{ bitrate?: number | null }>): number {
  return rows.reduce((b, r) => ((r.bitrate ?? 0) > b ? (r.bitrate ?? 0) : b), 0);
}

/** Normalized track title extracted from a file name — dedup key across peers. */
function titleNormKey(filepath: unknown): string {
  let s = basename(filepath ?? "");
  if (!s) return "";
  s = s.replace(/\.[^.]+$/, "");
  s = s
    .replace(/^[\[(]\d{4}[-./]\d{2}[-./]\d{2}[\])]\s*/, "")
    .replace(/^\d{4}[-./]\d{2}[-./]\d{2}\s+/, "");
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, "");
  s = s.replace(/^\(?\d{1,3}\)?[-.)]?\s+/, "");
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// ── Cover selection ─────────────────────────────────────────────────────────

function coverPriority(filename: unknown): number {
  const n = String(filename ?? "").toLowerCase();
  const order = [
    "folder.jpg", "folder.jpeg", "cover.jpg", "cover.jpeg", "front.jpg", "front.jpeg",
    "album.jpg", "artwork.jpg", "cover.png", "folder.png", "front.png", "album.png",
  ];
  for (let i = 0; i < order.length; i++) if (n.endsWith(order[i]!)) return i;
  return 40;
}

interface ImageRow {
  slsk_username?: string;
  slsk_filepath?: string;
  name?: string;
  size?: number;
  [k: string]: unknown;
}

function pickCover(imageRows: ImageRow[] | undefined): ImageRow | null {
  if (!imageRows?.length) return null;
  const scored = imageRows.map((c) => ({
    c,
    pr: coverPriority(basename(c.slsk_filepath ?? c.name ?? "")),
    size: c.size ?? 0,
  }));
  scored.sort((a, b) => a.pr - b.pr || b.size - a.size);
  return scored[0]!.c;
}

function inferFormatFromExt(filepath: unknown): string | null {
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

// ── Entity construction ─────────────────────────────────────────────────────

interface SlskAudioRow {
  slsk_username: string;
  slsk_filepath: string;
  name?: string;
  size?: number;
  bitrate?: number | null;
  duration?: number | null;
  slsk_is_image?: boolean;
  [k: string]: unknown;
}

interface SlskTrackEntity {
  type: "track";
  id: string;
  title: string;
  artist: null;
  albumTitle: string | null;
  fileName: string;
  format: string | null;
  bitrate: number | null;
  duration: number | null;
  size: number | null;
  albumId: string | null;
  sources: Array<{
    kind: "soulseek";
    refs: { slskUsername: string; slskFilepath: string };
    raw: { row: SlskAudioRow; cover: ImageRow | null; peers?: number };
  }>;
  score: number;
  mergedFrom: number;
}

function rawAudioToTrack(
  raw: SlskAudioRow,
  username: string,
  folder: string,
  albumId: string | null,
): SlskTrackEntity {
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
      raw: { row: raw, cover: null },
    }],
    score: 0,
    mergedFrom: 1,
  };
}

function groupSlskRowsToEntities(rawRows: SlskAudioRow[]): PipelineEntity[] {
  const images: ImageRow[] = rawRows.filter((r) => r.slsk_is_image) as unknown as ImageRow[];
  const audios: SlskAudioRow[] = rawRows.filter((r) => !r.slsk_is_image);

  const imagesByUserFolder = new Map<string, ImageRow[]>();
  for (const img of images) {
    const key = `${img.slsk_username}|${folderKey(img.slsk_filepath)}`;
    if (!imagesByUserFolder.has(key)) imagesByUserFolder.set(key, []);
    imagesByUserFolder.get(key)!.push(img);
  }

  interface FolderGroup { user: string; folder: string; tracks: SlskAudioRow[] }
  const byUserFolder = new Map<string, FolderGroup>();
  const rootless: SlskAudioRow[] = [];
  for (const t of audios) {
    const folder = folderKey(t.slsk_filepath);
    if (!folder) { rootless.push(t); continue; }
    const key = `${t.slsk_username}|${folder}`;
    if (!byUserFolder.has(key)) {
      byUserFolder.set(key, { user: t.slsk_username, folder, tracks: [] });
    }
    byUserFolder.get(key)!.tracks.push(t);
  }

  const albumFolders: FolderGroup[] = [];
  const singletonTracks: SlskAudioRow[] = [];
  for (const g of byUserFolder.values()) {
    const byTitle = new Map<string, SlskAudioRow>();
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

    const uniqueTitleKeys = new Set<string>();
    for (const k of byTitle.keys()) uniqueTitleKeys.add(k.split(".")[0]!);
    if (uniqueTitleKeys.size >= 2) {
      albumFolders.push({ user: g.user, folder: g.folder, tracks: uniq });
    } else {
      singletonTracks.push(uniq[0]!);
    }
  }

  const out: PipelineEntity[] = [];

  for (const g of albumFolders) {
    const albumId = `slsk:album:${g.user}|${g.folder}`;
    const cover = pickCover(imagesByUserFolder.get(`${g.user}|${g.folder}`));
    const albumTracks = g.tracks.map((t) => rawAudioToTrack(t, g.user, g.folder, albumId));
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
    } as unknown as PipelineEntity);
    out.push(...(albumTracks as unknown as PipelineEntity[]));
  }

  const byTitleKey = new Map<string, { row: SlskAudioRow; users: Set<string> }>();
  for (const t of singletonTracks.concat(rootless)) {
    const title = titleNormKey(t.slsk_filepath ?? t.name ?? "");
    if (!title) continue;
    const ext = (basename(t.slsk_filepath ?? "").split(".").pop() ?? "").toLowerCase();
    const key = `${title}.${ext}`;
    if (!byTitleKey.has(key)) byTitleKey.set(key, { row: t, users: new Set() });
    const slot = byTitleKey.get(key)!;
    slot.users.add(t.slsk_username);
    if ((t.bitrate ?? 0) > (slot.row.bitrate ?? 0)) slot.row = t;
  }

  for (const { row, users } of byTitleKey.values()) {
    const folder = folderKey(row.slsk_filepath);
    const cover = folder
      ? pickCover(imagesByUserFolder.get(`${row.slsk_username}|${folder}`))
      : null;
    const track = rawAudioToTrack(row, row.slsk_username, folder, null);
    track.sources[0]!.raw.cover = cover;
    track.sources[0]!.raw.peers = users.size;
    out.push(track as unknown as PipelineEntity);
  }

  return out;
}

interface SlskBatchEvent { payload: { requestId: number; rows: SlskAudioRow[] } | null }

/**
 * SoulSeek search provider. Wraps `soulseek_search` + `soulseek-search-batch`
 * event stream. Incremental: yields a full Entity snapshot on each new batch.
 */
class SoulseekProvider extends SearchProvider {
  readonly kind = "soulseek" as const;

  async *search(query: string, ctx: SearchProviderCtx): AsyncGenerator<PipelineEntity[]> {
    if (ctx.signal.aborted) return;
    const t0 = performance.now();
    this.log(ctx, `search start: "${query}" (req=${ctx.requestId})`);

    const raw: SlskAudioRow[] = [];
    const queue: PipelineEntity[][] = [];
    let pendingResolve: (() => void) | null = null;
    let finished = false;
    let finalError: unknown = null;

    const nudge = (): void => { const r = pendingResolve; pendingResolve = null; r?.(); };
    const finish = (err: unknown): void => {
      if (finished) return;
      finished = true;
      if (err) finalError = err;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      nudge();
    };
    const emitSnapshot = (): void => {
      if (ctx.signal.aborted) return;
      queue.push(groupSlskRowsToEntities(raw));
      nudge();
    };

    const BASELINE_MS = 5000;
    const IDLE_MS = 1000;
    let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      this.log(ctx, `baseline finish: no batches in ${BASELINE_MS}ms`);
      finish(null);
    }, BASELINE_MS);
    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        this.log(ctx, `idle finish: no new rows for ${IDLE_MS}ms (have ${raw.length})`);
        finish(null);
      }, IDLE_MS);
    };

    const unlisten = await listen("soulseek-search-batch", (e: SlskBatchEvent) => {
      const p = e.payload;
      if (!p || p.requestId !== ctx.requestId) return;
      if (ctx.signal.aborted) return;
      raw.push(...p.rows);
      emitSnapshot();
      armIdleTimer();
    });

    const onAbort = (): void => finish(null);
    ctx.signal.addEventListener("abort", onAbort);
    if (ctx.signal.aborted) finish(null);

    (soulseekSearch(query, ctx.requestId) as Promise<SlskAudioRow[]>)
      .then((finalRows) => {
        if (ctx.signal.aborted) return;
        raw.length = 0;
        raw.push(...finalRows);
        emitSnapshot();
        this.log(ctx, `final rows: ${finalRows.length} (${Math.round(performance.now() - t0)}ms)`);
      })
      .catch((err: unknown) => { finalError = err; })
      .finally(() => finish(finalError));

    try {
      while (true) {
        if (queue.length) {
          const snap = queue[queue.length - 1]!;
          queue.length = 0;
          yield snap;
        }
        if (finished) break;
        if (ctx.signal.aborted) break;
        await new Promise<void>((r) => { pendingResolve = r; });
      }
      if (finalError && !ctx.signal.aborted) throw finalError;
    } finally {
      try { (unlisten as () => void)(); } catch { /* already unlistened */ }
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }
}

export const soulseekProvider: SearchProvider = new SoulseekProvider();
