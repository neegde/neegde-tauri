import { listen } from "@tauri-apps/api/event";
import { soulseekSearch } from "../../soulseek/api.js";
import { SearchProvider, type SearchProviderCtx } from "../provider.js";
import type { PipelineEntity } from "../pipeline/index.js";
import { resolveTrackNames } from "../../track/nameResolver.js";

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

/** Normalize for case/punctuation-insensitive comparison. */
function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Dedup key across peers: resolved artist + title. Same song from different
 *  peers with differing basenames (e.g. `Пошлая Молли - Нон стоп.flac` vs
 *  `02 - Нон стоп.flac` in an artist folder) still collapse into one entry
 *  because both resolve to `{artist: "Пошлая Молли", title: "Нон стоп"}`. */
function trackDedupKey(row: SlskAudioRow): string {
  const fp = row.slsk_filepath ?? row.name ?? "";
  const fileName = basename(fp);
  const resolved = resolveTrackNames({
    fileName,
    artist: null,
    albumTitle: null,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: row.slsk_username, slskFilepath: row.slsk_filepath },
    }],
  });
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const artistN = normalizeKey(resolved.artist);
  const titleN = normalizeKey(resolved.title);
  // Title alone still required — a missing title means we couldn't parse
  // anything meaningful and the row should be dropped upstream.
  if (!titleN) return "";
  return `${artistN}|${titleN}.${ext}`;
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
  /** Per-peer availability stats from FileSearchResponse tail. */
  slotsFree?: boolean;
  avgSpeed?: number;
  queueLength?: number;
  [k: string]: unknown;
}

/**
 * Score a peer for failover ranking: higher = better.
 *   +2   has free upload slot
 *   +1   non-zero advertised speed
 *   +1   queue length < 10
 *   -1   queue length > 50 (peer is busy / slow)
 *   -2   no free slot AND queue > 20 (effectively offline to new uploads)
 */
function peerRank(row: SlskAudioRow): number {
  let r = 0;
  if (row.slotsFree) r += 2;
  if ((row.avgSpeed ?? 0) > 0) r += 1;
  const q = row.queueLength ?? 0;
  if (q < 10) r += 1;
  if (q > 50) r -= 1;
  if (!row.slotsFree && q > 20) r -= 2;
  return r;
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

/**
 * Aggressive upstream filter: drop peers whose upload queue is already deep.
 * Empirically, peers with queue ≤ ~200 mostly deliver on a real transfer
 * attempt, but anything above is a coin flip. For a music-player UX where
 * the user expects instant playback, we'd rather hide a borderline peer
 * than waste a click on one that times out. Threshold deliberately strict:
 * queue > 25 is "already has a backlog" — drop.
 *
 * Peers that omit stats (no `queueLength` stamped) get a pass — many of
 * those are alternative-peer entries whose tail wasn't parsed yet.
 */
const PEER_QUEUE_MAX = 25;
function peerIsLive(r: SlskAudioRow): boolean {
  return (r.queueLength ?? 0) <= PEER_QUEUE_MAX;
}

function groupSlskRowsToEntities(rawRows: SlskAudioRow[]): PipelineEntity[] {
  const images: ImageRow[] = rawRows.filter((r) => r.slsk_is_image) as unknown as ImageRow[];
  // Drop audio rows whose peer has a deep upload queue up-front: primary
  // and alternative selection both work off this clean set.
  const audios: SlskAudioRow[] = rawRows.filter((r) => !r.slsk_is_image && peerIsLive(r));

  const imagesByUserFolder = new Map<string, ImageRow[]>();
  for (const img of images) {
    const key = `${img.slsk_username}|${folderKey(img.slsk_filepath)}`;
    if (!imagesByUserFolder.has(key)) imagesByUserFolder.set(key, []);
    imagesByUserFolder.get(key)!.push(img);
  }

  // Group every audio row by (normalized title + ext). The best-ranked peer
  // becomes primary; the rest are failover alternatives. No more separate
  // "album track" vs "singleton" code path — SoulSeek doesn't actually have
  // albums, just peers with files, and unifying the entity shape means the
  // failover logic applies uniformly.
  const byTitleKey = new Map<string, SlskAudioRow[]>();
  for (const t of audios) {
    const key = trackDedupKey(t);
    if (!key) continue;
    if (!byTitleKey.has(key)) byTitleKey.set(key, []);
    byTitleKey.get(key)!.push(t);
  }

  const ALT_PEER_LIMIT = 5;
  /** Primary = best-ranked peer, with bitrate as tiebreak. */
  function pickPrimary(rows: SlskAudioRow[]): SlskAudioRow {
    return [...rows].sort((a, b) => {
      const rr = peerRank(b) - peerRank(a);
      return rr !== 0 ? rr : (b.bitrate ?? 0) - (a.bitrate ?? 0);
    })[0]!;
  }
  /** Alternatives = distinct users after primary, ranked by peerRank then bitrate. */
  function buildAlternatives(rows: SlskAudioRow[], primary: SlskAudioRow): Array<{ slskUsername: string; slskFilepath: string; size: number }> {
    const sorted = [...rows].sort((a, b) => {
      const rr = peerRank(b) - peerRank(a);
      return rr !== 0 ? rr : (b.bitrate ?? 0) - (a.bitrate ?? 0);
    });
    const seen = new Set<string>([primary.slsk_username]);
    const out: Array<{ slskUsername: string; slskFilepath: string; size: number }> = [];
    for (const r of sorted) {
      if (seen.has(r.slsk_username)) continue;
      seen.add(r.slsk_username);
      out.push({
        slskUsername: r.slsk_username,
        slskFilepath: r.slsk_filepath,
        size: r.size ?? 0,
      });
      if (out.length >= ALT_PEER_LIMIT) break;
    }
    return out;
  }

  // Rows were pre-filtered by `peerIsLive` upstream, so every grouping is
  // guaranteed to have at least one live peer. Just pick primary + alts.
  interface Entry { primary: SlskAudioRow; alternatives: ReturnType<typeof buildAlternatives> }
  const entries: Entry[] = [];
  for (const rows of byTitleKey.values()) {
    const primary = pickPrimary(rows);
    const alternatives = buildAlternatives(rows, primary);
    entries.push({ primary, alternatives });
  }

  // Live peers first — the most-likely-to-play tracks appear at the top.
  entries.sort((a, b) => peerRank(b.primary) - peerRank(a.primary));

  const out: PipelineEntity[] = [];
  for (const { primary, alternatives } of entries) {
    const folder = folderKey(primary.slsk_filepath);
    const cover = folder
      ? pickCover(imagesByUserFolder.get(`${primary.slsk_username}|${folder}`))
      : null;
    const track = rawAudioToTrack(primary, primary.slsk_username, folder, null);
    track.sources[0]!.raw.cover = cover;
    track.sources[0]!.raw.peers = 1 + alternatives.length;
    (track.sources[0]!.raw as { alternativePeers?: unknown }).alternativePeers = alternatives;
    out.push(track as unknown as PipelineEntity);
  }

  return out;
}

interface SlskBatchEvent { payload: { requestId: number; rows: SlskAudioRow[] } | null }

/** Yield to the next animation frame; falls back to setTimeout when rAF
 *  is unavailable (e.g. some test environments). */
function _nextFrame(): Promise<void> {
  return new Promise<void>((r) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => r());
    } else {
      setTimeout(() => r(), 0);
    }
  });
}

/**
 * SoulSeek search provider. Wraps `soulseek_search` + `soulseek-search-batch`
 * event stream. Incremental: yields a full Entity snapshot on each new batch.
 *
 * Performance: the listener only appends rows and marks `dirty` — the actual
 * O(N) regrouping happens once per generator wake on the consumer side and
 * is rAF-throttled, so a burst of peer responses (popular query) collapses
 * into one regrouping pass per frame instead of one per peer event.
 */
class SoulseekProvider extends SearchProvider {
  readonly kind = "soulseek" as const;

  async *search(query: string, ctx: SearchProviderCtx): AsyncGenerator<PipelineEntity[]> {
    if (ctx.signal.aborted) return;
    const t0 = performance.now();
    this.log(ctx, `search start: "${query}" (req=${ctx.requestId})`);

    const raw: SlskAudioRow[] = [];
    let dirty = false;
    let pendingResolve: (() => void) | null = null;
    let finished = false;
    let finalError: unknown = null;

    const nudge = (): void => { const r = pendingResolve; pendingResolve = null; r?.(); };
    const markDirty = (): void => {
      if (ctx.signal.aborted) return;
      dirty = true;
      nudge();
    };
    const finish = (err: unknown): void => {
      if (finished) return;
      finished = true;
      if (err) finalError = err;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
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
      markDirty();
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
        markDirty();
        this.log(ctx, `final rows: ${finalRows.length} (${Math.round(performance.now() - t0)}ms)`);
      })
      .catch((err: unknown) => { finalError = err; })
      .finally(() => finish(finalError));

    try {
      while (true) {
        if (dirty) {
          dirty = false;
          yield groupSlskRowsToEntities(raw);
          // rAF gate: peer responses to a popular query arrive in dense
          // bursts. Awaiting a frame here lets multiple in-flight events
          // coalesce into a single regroup on the next loop iteration,
          // keeping the main thread responsive.
          if (!finished && !ctx.signal.aborted) await _nextFrame();
          continue;
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
