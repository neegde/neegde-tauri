/**
 * Import pipeline: search each track on RuTracker + SoulSeek, pick the best
 * match, add to likes or a playlist.
 *
 * Reliability features:
 *   - RT session expiry → poll for re-login, retry once per track.
 *   - SLSK disconnected → auto-reconnect with saved credentials, retry once.
 *   - SLSK searches serialized (1 at a time) — concurrent searches cause
 *     rate-limit disconnects on the SoulSeek network.
 *   - Bounded track concurrency (CONCURRENT_TRACKS) — avoids hammering RT.
 *   - RT details semaphore already enforced by Rust (DETAILS_CONCURRENCY = 4).
 *   - AbortSignal support — safely stops mid-import.
 *   - Per-track error isolation: a failed track becomes "unmatched", not a crash.
 */

import { listen } from "@tauri-apps/api/event";
import { searchMusic, getTorrentDetails } from "../rutracker/search.js";
import { getStatus as getRtStatus } from "../rutracker/auth.js";
import { soulseekSearch, soulseekStatus, soulseekLogin, soulseekLoadCredentials } from "../soulseek/api.js";
import { detectAlbums } from "../lib/utils.js";
import { buildTrack } from "../track/factory.js";
import { registerEntity } from "../stores/entities.js";
import {
  addTrackToPlaylist,
  createPlaylist,
  getPlaylist,
  isTrackLiked,
  toggleLikeTrack,
} from "../stores/library.js";
import { findBestMatch, formatQualityScore } from "./matchTrack.js";
import type { ParsedTrack } from "./parseFile.js";
import type { TrackData, TrackSource } from "../track/types.js";

// ── Tunables ────────────────────────────────────────────────────────────────

/** Max tracks processed simultaneously. RT has its own Rust-side semaphore. */
const CONCURRENT_TRACKS = 3;

/** How many RT topic details to fetch per track search. More = better coverage,
 *  slower and more load on RT. */
const RT_TOPICS_PER_TRACK = 8;

/** Seconds to wait for SLSK search batch results before giving up. */
const SLSK_TIMEOUT_MS = 9_000;

/** Max seconds to wait for RT re-login after session expiry. */
const RT_SESSION_WAIT_MS = 90_000;
const RT_SESSION_POLL_MS = 3_000;

/** Retry count per track when RT reports session_expired. */
const RT_MAX_RETRIES = 2;

/** How long to wait for SLSK reconnect before giving up on it for this track. */
const SLSK_RECONNECT_WAIT_MS = 60_000;
const SLSK_RECONNECT_POLL_MS = 4_000;

/** Minimum gap between consecutive SLSK searches.
 *  SoulSeek network rate-limits aggressive searchers and terminates the session. */
const SLSK_SEARCH_INTERVAL_MS = 1_500;

// ── SLSK session state (module-level, shared across all concurrent workers) ──

/**
 * Serialization mutex for SLSK searches. Only one search runs at a time to
 * prevent concurrent searches from triggering SoulSeek rate-limit disconnects.
 *
 * Implemented as a promise chain: each new search appends to the tail so
 * searches execute in FIFO order without busy-waiting.
 */
let _slskSearchTail: Promise<void> = Promise.resolve();
let _slskLastSearchAt = 0;

/** Whether a reconnect attempt is currently in progress (avoids pile-ups). */
let _slskReconnecting = false;

/**
 * Set to true after the first failed reconnect so remaining tracks skip SLSK
 * immediately rather than each waiting 60 s for a session that won't come.
 * Reset to false at the start of every runImport() call.
 */
let _slskUnavailable = false;

function acquireSlskSearchSlot(): Promise<() => void> {
  let release!: () => void;
  const acquired = new Promise<void>((r) => { release = r; });
  // Capture prev BEFORE reassigning — the caller must proceed when the
  // *previous* holder finishes, not after acquired resolves (which would
  // create a circular wait: we only get release after acquired resolves,
  // but acquired only resolves when we call release).
  const prev = _slskSearchTail;
  _slskSearchTail = prev.then(() => acquired);
  return prev.then(() => release);
}

/**
 * Attempt to reconnect to SoulSeek using persisted credentials.
 * Only one attempt runs at a time — concurrent callers wait for the same attempt.
 */
async function attemptSlskReconnect(): Promise<boolean> {
  if (_slskReconnecting) {
    // Another worker is already reconnecting — wait for it to finish, then check status
    const deadline = Date.now() + SLSK_RECONNECT_WAIT_MS;
    while (_slskReconnecting && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, SLSK_RECONNECT_POLL_MS));
    }
    const s = await soulseekStatus().catch(() => null);
    return s?.connected ?? false;
  }

  _slskReconnecting = true;
  try {
    const creds = await soulseekLoadCredentials().catch(() => null);
    if (!creds) return false;
    const [username, password] = creds;
    const result = await soulseekLogin(username, password).catch(() => null);
    return result?.success ?? false;
  } finally {
    _slskReconnecting = false;
  }
}

/**
 * Ensure SLSK is connected. If not, attempt reconnect with saved credentials
 * and poll until online or deadline.
 *
 * Returns true when connected (including after successful reconnect).
 */
async function waitForSlskSession(signal: AbortSignal): Promise<boolean> {
  const status = await soulseekStatus().catch(() => null);
  if (status?.connected) return true;
  if (signal.aborted) return false;

  // Try reconnecting once
  const ok = await attemptSlskReconnect();
  if (ok) return true;
  if (signal.aborted) return false;

  // Poll for a while in case another part of the app is also reconnecting
  const deadline = Date.now() + SLSK_RECONNECT_WAIT_MS;
  while (Date.now() < deadline && !signal.aborted) {
    await new Promise<void>((r) => setTimeout(r, SLSK_RECONNECT_POLL_MS));
    const s = await soulseekStatus().catch(() => null);
    if (s?.connected) return true;
  }
  return false;
}

// ── Public types ────────────────────────────────────────────────────────────

export type EntryStatus = "pending" | "searching" | "matched" | "unmatched" | "error";

export interface ImportEntry {
  raw: string;
  artist: string;
  title: string;
  lineNum: number;
  status: EntryStatus;
  matchSource?: "rutracker" | "soulseek";
  /** Resolved title of the matched track (may differ from target). */
  matchTitle?: string;
  /** Resolved artist of the matched track. */
  matchArtist?: string;
  /** Match quality 0..1. */
  matchScore?: number;
  trackId?: string;
  error?: string;
}

export type ImportStatus = "idle" | "running" | "done" | "cancelled";

/** Where matched tracks are saved. */
export type ImportDestination =
  | { kind: "likes" }
  | { kind: "playlist"; playlistId: string };

export interface ImportState {
  status: ImportStatus;
  total: number;
  done: number;
  matched: number;
  unmatched: number;
  /** Human-readable destination for progress UI (e.g. «Мне нравится»). */
  destinationLabel: string;
  /** Shallow copy — safe to spread/assign to reactive ref. */
  entries: ImportEntry[];
}

/**
 * Resolve destination to a concrete playlist id when needed.
 * Creates a new playlist for `playlist-new` before import starts.
 */
export function resolveImportDestination(
  destination: ImportDestination | { kind: "playlist-new"; title: string },
): ImportDestination {
  if (destination.kind === "playlist-new") {
    const title = destination.title.trim() || "Импорт";
    const pl = createPlaylist(title);
    return { kind: "playlist", playlistId: pl.id };
  }
  return destination;
}

export function importDestinationLabel(destination: ImportDestination): string {
  if (destination.kind === "likes") return "«Мне нравится»";
  const pl = getPlaylist(destination.playlistId);
  return pl ? `плейлист «${pl.title}»` : "плейлист";
}

// ── SLSK request ID counter ─────────────────────────────────────────────────

let _slskReqId = 1;
function nextSlskRequestId(): number {
  return _slskReqId++;
}

// ── Audio file extensions ───────────────────────────────────────────────────

const AUDIO_EXTS = new Set([
  "flac", "mp3", "ogg", "oga", "wav", "ape", "m4a", "alac",
  "aac", "opus", "dsf", "dff", "wma",
]);

function isAudioFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTS.has(ext);
}

function formatFromExt(filename: string): string | null {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (ext === "flac") return "FLAC";
  if (ext === "mp3")  return "MP3";
  if (ext === "ape")  return "APE";
  if (ext === "wav")  return "WAV";
  if (ext === "ogg" || ext === "oga") return "OGG";
  if (ext === "m4a" || ext === "alac") return "ALAC";
  if (ext === "aac")  return "AAC";
  if (ext === "opus") return "OPUS";
  if (ext === "dsf" || ext === "dff") return "DSD";
  return null;
}

// ── Session wait ────────────────────────────────────────────────────────────

/** Poll rutracker_status until logged_in = true or deadline. */
async function waitForRtSession(signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + RT_SESSION_WAIT_MS;
  while (Date.now() < deadline && !signal.aborted) {
    const s = await getRtStatus().catch(() => null);
    if (s?.logged_in) return true;
    await new Promise<void>((r) => {
      const t = setTimeout(r, RT_SESSION_POLL_MS);
      signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
    });
  }
  return false;
}

function isSessionError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("rt:session_expired") ||
    msg.includes("session_expired") ||
    msg.includes("Необходимо войти")
  );
}

// ── RuTracker search ────────────────────────────────────────────────────────

async function searchRutracker(
  artist: string,
  signal: AbortSignal,
): Promise<TrackData[]> {
  if (signal.aborted) return [];

  let rows: Awaited<ReturnType<typeof searchMusic>>;
  let retries = 0;

  // Retry loop for session expiry
  while (true) {
    try {
      rows = await searchMusic(artist);
      break;
    } catch (err) {
      if (isSessionError(err) && retries < RT_MAX_RETRIES) {
        retries++;
        const ok = await waitForRtSession(signal);
        if (!ok || signal.aborted) return [];
        continue;
      }
      throw err;
    }
  }

  if (signal.aborted || !rows.length) return [];

  const topTopics = rows.slice(0, RT_TOPICS_PER_TRACK);
  const allTracks: TrackData[] = [];

  await Promise.all(
    topTopics.map(async (row) => {
      if (signal.aborted) return;
      try {
        const details = await getTorrentDetails(String(row.id));
        if (signal.aborted) return;

        // Flatten torrent files, tagging each with its original index
        const flatFiles = (details.files ?? []).map((f, i) => ({
          path: f.path.join("/"),
          size: f.size,
          origIdx: i,
          _origFile: f,
        }));

        const albums = detectAlbums(flatFiles);
        for (const alb of albums) {
          for (const f of alb.audioFiles) {
            const fileIdx = (f as { origIdx?: number }).origIdx;
            if (fileIdx === undefined) continue;
            const fileName = f.path.split("/").pop() ?? "";
            if (!fileName || !isAudioFile(fileName)) continue;

            const trackData: TrackData = {
              type: "track",
              id: `rt:track:${row.id}:${fileIdx}`,
              title: fileName,
              artist: details.artist ?? null,
              albumTitle: alb.name || null,
              albumId: `rt:album:${row.id}:${encodeURIComponent(alb.dirPath)}`,
              fileName,
              format: formatFromExt(fileName),
              bitrate: null,
              duration: null,
              size: (f as { size?: number }).size ?? null,
              sources: [
                {
                  kind: "rutracker",
                  refs: {
                    topicId: String(row.id),
                    magnet: (details.magnet as string | null | undefined) ?? "",
                    fileIdx,
                    coverFileIdx: null,
                    albumDirPath: alb.dirPath || null,
                  },
                  raw: {
                    topicRow: row,
                    details,
                    file: (f as { _origFile?: unknown })._origFile,
                  },
                },
              ] as [TrackSource, ...TrackSource[]],
            };
            allTracks.push(trackData);
          }
        }
      } catch {
        // Skip failed topics — they shouldn't block the whole track search
      }
    }),
  );

  return allTracks;
}

// ── SoulSeek search ─────────────────────────────────────────────────────────

function rawRowsToTrackData(rows: unknown[]): TrackData[] {
  const out: TrackData[] = [];
  for (const row of rows) {
    const r = row as {
      slsk_username?: string;
      slsk_filepath?: string;
      size?: number;
      bitrate?: number | null;
      duration?: number | null;
      slsk_is_image?: boolean;
    };
    if (!r.slsk_username || !r.slsk_filepath || r.slsk_is_image) continue;
    const fileName = r.slsk_filepath.replace(/\\/g, "/").split("/").pop() ?? "";
    if (!isAudioFile(fileName)) continue;

    out.push({
      type: "track",
      id: `slsk:track:${r.slsk_username}|${r.slsk_filepath}`,
      title: fileName,
      artist: null,
      albumTitle: null,
      albumId: null,
      fileName,
      format: formatFromExt(fileName),
      bitrate: r.bitrate ?? null,
      duration: r.duration ?? null,
      size: r.size ?? null,
      sources: [
        {
          kind: "soulseek",
          refs: {
            slskUsername: r.slsk_username,
            slskFilepath: r.slsk_filepath,
          },
          raw: { row },
        },
      ] as [TrackSource, ...TrackSource[]],
    });
  }
  return out;
}

/**
 * Run one SLSK search query and return raw rows. Must be called while already
 * holding the search slot (i.e., from within `searchSoulseek`).
 */
async function runSlskQuery(query: string, signal: AbortSignal): Promise<unknown[]> {
  const requestId = nextSlskRequestId();
  const batchRows: unknown[] = [];
  let finalRows: unknown[] | null = null;

  type BatchEvent = { payload: { requestId: number; rows: unknown[] } | null };
  const unlisten = await listen("soulseek-search-batch", (e: BatchEvent) => {
    const p = e.payload;
    if (!p || p.requestId !== requestId) return;
    batchRows.push(...p.rows);
  });

  const cleanup = { removeAbortListener: (() => {}) as () => void };
  const abortPromise = new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const fn = (): void => resolve();
    signal.addEventListener("abort", fn, { once: true });
    cleanup.removeAbortListener = () => signal.removeEventListener("abort", fn);
  });

  try {
    await Promise.race([
      soulseekSearch(query, requestId)
        .then((rows) => { finalRows = rows as unknown[]; })
        .catch(() => {}),
      new Promise<void>((r) => setTimeout(r, SLSK_TIMEOUT_MS)),
      abortPromise,
    ]);
  } finally {
    (unlisten as () => void)();
    cleanup.removeAbortListener();
  }

  return finalRows ?? batchRows;
}

/**
 * Search SoulSeek for a track.
 *
 * Reliability:
 *   - Serialized: only 1 SLSK search runs at a time to prevent rate-limit disconnects.
 *   - Reconnect: if SLSK is disconnected (session killed by network/rate-limit),
 *     attempt reconnect with saved credentials and retry the search once.
 *   - Minimum gap between searches (SLSK_SEARCH_INTERVAL_MS).
 */
async function searchSoulseek(
  artist: string,
  title: string,
  signal: AbortSignal,
): Promise<TrackData[]> {
  if (signal.aborted || _slskUnavailable) return [];

  const query = `${artist} ${title}`;

  // Acquire the serialization slot — waits for any running search to finish
  const releaseSlot = await acquireSlskSearchSlot();

  try {
    if (signal.aborted || _slskUnavailable) return [];

    // Enforce minimum gap between searches
    const sinceLastMs = Date.now() - _slskLastSearchAt;
    if (sinceLastMs < SLSK_SEARCH_INTERVAL_MS) {
      await new Promise<void>((r) => setTimeout(r, SLSK_SEARCH_INTERVAL_MS - sinceLastMs));
    }
    if (signal.aborted) return [];

    // Check connection — reconnect if needed
    let connected = await soulseekStatus().then((s) => s.connected).catch(() => false);
    if (!connected) {
      connected = await waitForSlskSession(signal);
      if (!connected || signal.aborted) {
        _slskUnavailable = true;
        return [];
      }
    }

    _slskLastSearchAt = Date.now();
    let rows = await runSlskQuery(query, signal);

    // If we got nothing and SLSK is now disconnected, try one reconnect + retry
    if (rows.length === 0 && !signal.aborted) {
      const stillConnected = await soulseekStatus().then((s) => s.connected).catch(() => false);
      if (!stillConnected) {
        const ok = await waitForSlskSession(signal);
        if (ok && !signal.aborted) {
          _slskLastSearchAt = Date.now();
          rows = await runSlskQuery(query, signal);
        }
      }
    }

    return rawRowsToTrackData(rows);
  } finally {
    releaseSlot();
  }
}

// ── Quality scoring (tie-breakers for findBestMatch) ───────────────────────

function rtQuality(t: TrackData): number {
  const fmtScore = formatQualityScore(t.format, null);
  const raw = (t.sources[0] as { raw?: { topicRow?: { seeders?: unknown } } } | undefined)
    ?.raw?.topicRow;
  const seeders = Math.min(Number(raw?.seeders ?? 0) / 80, 1);
  return fmtScore * 0.85 + seeders * 0.15;
}

function slskQuality(t: TrackData): number {
  return formatQualityScore(t.format, t.bitrate);
}

// ── Per-track processing ────────────────────────────────────────────────────

async function processTrack(
  entry: ImportEntry,
  signal: AbortSignal,
  destination: ImportDestination,
): Promise<void> {
  entry.status = "searching";

  try {
    // Both providers searched concurrently — failing one never blocks the other
    const [rtTracks, slskTracks] = await Promise.all([
      searchRutracker(entry.artist, signal).catch((): TrackData[] => []),
      searchSoulseek(entry.artist, entry.title, signal).catch((): TrackData[] => []),
    ]);

    if (signal.aborted) return;

    const rtBest  = findBestMatch(rtTracks,   entry.artist, entry.title, 0.50, rtQuality);
    const slskBest = findBestMatch(slskTracks, entry.artist, entry.title, 0.50, slskQuality);

    // RuTracker preferred; fall back to SoulSeek
    const picked = rtBest ?? slskBest;
    if (!picked) {
      entry.status = "unmatched";
      return;
    }

    const source: "rutracker" | "soulseek" =
      picked === rtBest ? "rutracker" : "soulseek";

    const track = buildTrack(picked.track);

    entry.matchSource = source;
    entry.matchTitle  = track.title;
    entry.matchArtist = track.artist ?? entry.artist;
    entry.matchScore  = picked.score;
    entry.trackId     = track.id;

    registerEntity(track);
    if (destination.kind === "likes") {
      if (!isTrackLiked(track.id)) toggleLikeTrack(track);
    } else {
      addTrackToPlaylist(destination.playlistId, track);
    }

    entry.status = "matched";
  } catch (err) {
    if (signal.aborted) return;
    entry.status = "error";
    entry.error  = String(err);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the full import pipeline.
 *
 * Processes tracks in parallel (up to CONCURRENT_TRACKS at once). Each
 * track's result is communicated via `onProgress` as soon as it settles.
 *
 * @param parsedTracks  - Output of parseImportText().
 * @param onProgress    - Called after every track completes (shallow-cloned state).
 * @param signal        - AbortSignal; stops after current batch finishes.
 * @returns             Final import state.
 */
export async function runImport(
  parsedTracks: ParsedTrack[],
  destination: ImportDestination,
  onProgress: (state: ImportState) => void,
  signal: AbortSignal,
): Promise<ImportState> {
  // Reset module-level SLSK state so a new import starts clean.
  _slskUnavailable = false;
  _slskSearchTail = Promise.resolve();
  _slskLastSearchAt = 0;
  _slskReconnecting = false;

  const entries: ImportEntry[] = parsedTracks.map((t) => ({
    ...t,
    status: "pending" as EntryStatus,
  }));

  const destinationLabel = importDestinationLabel(destination);

  const state: ImportState = {
    status: "running",
    total: entries.length,
    done: 0,
    matched: 0,
    unmatched: 0,
    destinationLabel,
    entries,
  };

  onProgress({ ...state, entries: entries.slice() });

  // Worker pool: each worker claims the next pending entry by index
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= entries.length || signal.aborted) return;

      const entry = entries[idx]!;
      await processTrack(entry, signal, destination);

      state.done++;
      if (entry.status === "matched")                    state.matched++;
      else if (entry.status === "unmatched" || entry.status === "error") state.unmatched++;

      onProgress({ ...state, entries: entries.slice() });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENT_TRACKS }, worker));

  state.status = signal.aborted ? "cancelled" : "done";
  onProgress({ ...state, entries: entries.slice() });
  return state;
}
