/**
 * OS MediaSession wiring (lock-screen controls, taskbar buttons, etc).
 *
 * The manager owns:
 *   - the `MediaSessionApi` that the Player wires up (play/pause/prev/...);
 *   - the install / clear lifecycle of the browser's `navigator.mediaSession`
 *     action handlers;
 *   - reactive metadata + playback-state + position-state sync;
 *   - cover URL resolution from the three provider-specific caches.
 *
 * A module-level singleton (`manager`) backs the named back-compat exports
 * so existing `import { syncMediaSessionMetadata, ... }` lines in Player.vue
 * keep working verbatim. New code is encouraged to call `mediaSessionManager`
 * methods directly.
 */

import { peekTorrentImage, getTorrentImageDataUrl } from "../torrent/torrentImageCache.js";
import { peekRutrackerCover, getRutrackerCoverDataUrl } from "../rutracker/search.js";
import { trackDisplayBasename, extractTrackArtist } from "../lib/utils.js";
import { getSlskCoverReactive, getSlskCoverDataUrl } from "../soulseek/coverCache.js";

export interface MediaSessionApi {
  play: () => void;
  pause: () => void;
  prev: () => void;
  next: () => void;
  seek: (time: number) => void;
  seekRelative: (delta: number) => void;
}

interface TrackLike {
  magnet?: string | null;
  fileIdx?: number | string;
  source?: string;
  slskFilepath?: string;
  slskFolderCoverUsername?: string;
  slskFolderCoverFilepath?: string;
  slskFolderCoverSize?: number;
  fileName?: string;
  torrentName?: string;
  albumDirPath?: string | null;
  artist?: string | null;
  coverFileIdx?: number | string | null;
  torrentId?: string | number | null;
  [k: string]: unknown;
}

export interface EnrichedMeta {
  artist?: string;
  album?: string;
  title?: string;
  coverUrl?: string | null;
}

const NO_OP_API: MediaSessionApi = {
  play() {}, pause() {}, prev() {}, next() {},
  seek() {}, seekRelative() {},
};

function trackKey(track: TrackLike | null | undefined): string {
  if (!track?.magnet) return "";
  return `${track.magnet}\0${track.fileIdx}`;
}

function sessionKey(track: TrackLike | null | undefined): string {
  if (!track) return "";
  if (String(track.source || "") === "soulseek") return `slsk\0${track.slskFilepath ?? ""}`;
  return trackKey(track);
}

function wrap(fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (e) {
      console.warn("[mediaSession]", e);
    }
  };
}

function isMacDesktopUA(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Mac/.test(ua) && !/iPhone|iPad|iPod/.test(ua);
}

function msSession(): MediaSession | null {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return null;
  return navigator.mediaSession;
}

// ── Manager class ──────────────────────────────────────────────────────────

export class MediaSessionManager {
  private api: MediaSessionApi = { ...NO_OP_API };
  private installed = false;

  setApi(next: Partial<MediaSessionApi>): void {
    this.api = { ...this.api, ...next };
  }

  private bindTrackSkipHandlers(): void {
    const ms = msSession();
    if (!ms) return;
    ms.setActionHandler("previoustrack", wrap(() => this.api.prev()));
    ms.setActionHandler("nexttrack", wrap(() => this.api.next()));
  }

  private bindSeekHandlersForPlatform(): void {
    const ms = msSession();
    if (!ms) return;
    const mac = isMacDesktopUA();
    try {
      if (mac) {
        ms.setActionHandler("seekbackward", wrap(() => this.api.prev()));
        ms.setActionHandler("seekforward", wrap(() => this.api.next()));
      } else {
        ms.setActionHandler("seekbackward", (d) => {
          const off = d?.seekOffset != null && Number.isFinite(d.seekOffset) ? d.seekOffset : 10;
          this.api.seekRelative(-off);
        });
        ms.setActionHandler("seekforward", (d) => {
          const off = d?.seekOffset != null && Number.isFinite(d.seekOffset) ? d.seekOffset : 10;
          this.api.seekRelative(off);
        });
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Re-affirm skip handlers. Some browsers drop them when `metadata` or
   * `playbackState` changes — calling this after each mutation keeps the
   * lock-screen buttons live.
   */
  reaffirmSkipHandlers(): void {
    if (!this.installed) return;
    try {
      this.bindTrackSkipHandlers();
      this.bindSeekHandlersForPlatform();
    } catch (e) {
      console.warn("[mediaSession] reaffirm track handlers", e);
    }
  }

  install(): void {
    const ms = msSession();
    if (!ms || this.installed) return;
    try {
      ms.setActionHandler("play", wrap(() => this.api.play()));
      ms.setActionHandler("pause", wrap(() => this.api.pause()));
      this.bindTrackSkipHandlers();
      ms.setActionHandler("seekto", (d) => {
        if (d?.seekTime != null && Number.isFinite(d.seekTime)) this.api.seek(d.seekTime);
      });
      this.bindSeekHandlersForPlatform();
      // Atomicity: only set installed after ALL handlers bound successfully.
      this.installed = true;
    } catch (e) {
      console.warn("[mediaSession] setActionHandler", e);
      // Best-effort rollback so `clear()` knows nothing's live.
      try {
        for (const a of ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"] as MediaSessionAction[]) {
          ms.setActionHandler(a, null);
        }
      } catch { /* ignore */ }
    }
  }

  clear(): void {
    const ms = msSession();
    if (!ms || !this.installed) return;
    try {
      for (const a of [
        "play", "pause", "previoustrack", "nexttrack",
        "seekto", "seekbackward", "seekforward",
      ] as MediaSessionAction[]) {
        ms.setActionHandler(a, null);
      }
    } catch {
      /* ignore */
    }
    this.installed = false;
  }

  private async resolveCoverDataUrl(track: TrackLike | null | undefined): Promise<string | null> {
    if (track?.source === "soulseek") {
      const u = track.slskFolderCoverUsername;
      const p = track.slskFolderCoverFilepath;
      if (u && p) {
        const hit = getSlskCoverReactive(u, p);
        if (hit) return hit;
        return await getSlskCoverDataUrl(u, p, track.slskFolderCoverSize ?? 0);
      }
      return null;
    }
    if (!track?.magnet) return null;
    const idx = track.coverFileIdx;
    if (idx != null && Number.isFinite(Number(idx))) {
      const n = Number(idx);
      const hit = peekTorrentImage(track.magnet, n);
      if (hit) return hit;
      try {
        return await getTorrentImageDataUrl(track.magnet, n);
      } catch {
        return null;
      }
    }
    if (String(track.source || "") === "rutracker" && track.torrentId != null && track.torrentId !== "") {
      const tid = String(track.torrentId);
      const hit = peekRutrackerCover(tid);
      if (hit) return hit;
      try {
        return await getRutrackerCoverDataUrl(tid);
      } catch {
        return null;
      }
    }
    return null;
  }

  async syncMetadata(
    track: TrackLike | null | undefined,
    enriched: EnrichedMeta | null = null,
  ): Promise<void> {
    const ms = msSession();
    if (!ms) return;
    const soulseek = String(track?.source || "") === "soulseek";
    if (!track?.magnet && !soulseek) {
      ms.metadata = null;
      return;
    }
    const keyAtStart = sessionKey(track);
    const title = enriched?.title || trackDisplayBasename(track!.fileName ?? "") || "Трек";
    const artist = enriched?.artist
      || extractTrackArtist(track!.torrentName, track!.albumDirPath, track!.artist, track!.magnet);
    const album = enriched?.album || artist;
    ms.metadata = new MediaMetadata({ title, artist, album, artwork: [] });
    this.reaffirmSkipHandlers();
    let art = enriched?.coverUrl ?? null;
    if (!art) art = await this.resolveCoverDataUrl(track);
    // Track may have changed while we awaited cover resolution.
    if (sessionKey(track) !== keyAtStart) return;
    if (!art) return;
    try {
      ms.metadata = new MediaMetadata({
        title, artist, album, artwork: [{ src: art }],
      });
    } catch {
      /* data: URL may be rejected by some engines */
    }
    this.reaffirmSkipHandlers();
  }

  syncPlaybackState(playing: boolean): void {
    const ms = msSession();
    if (!ms) return;
    try {
      ms.playbackState = playing ? "playing" : "paused";
    } catch {
      /* ignore */
    }
    this.reaffirmSkipHandlers();
  }

  syncPositionState(durationSec: number, positionSec: number, playbackRate = 1): void {
    const ms = msSession();
    if (!ms?.setPositionState) return;
    const d = Number(durationSec);
    const p = Number(positionSec);
    if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(p)) return;
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
    const pos = Math.min(Math.max(0, p), d);
    try {
      ms.setPositionState({ duration: d, playbackRate: rate, position: pos });
    } catch {
      /* invalid state — skip */
    }
  }

  clearPresentation(): void {
    const ms = msSession();
    if (!ms) return;
    try {
      ms.metadata = null;
      ms.playbackState = "none";
    } catch {
      /* ignore */
    }
    try {
      if (ms.setPositionState) {
        ms.setPositionState(null as unknown as MediaPositionState);
      }
    } catch {
      /* ignore */
    }
  }
}

// ── Singleton + back-compat named exports ────────────────────────────────────

export const mediaSessionManager = new MediaSessionManager();

export const setMediaSessionApi = (next: Partial<MediaSessionApi>): void =>
  mediaSessionManager.setApi(next);
export const installMediaSessionHandlers = (): void =>
  mediaSessionManager.install();
export const clearMediaSessionHandlers = (): void =>
  mediaSessionManager.clear();
export const reaffirmTrackSkipHandlers = (): void =>
  mediaSessionManager.reaffirmSkipHandlers();
export const syncMediaSessionMetadata = (
  track: TrackLike | null | undefined,
  enriched: EnrichedMeta | null = null,
): Promise<void> => mediaSessionManager.syncMetadata(track, enriched);
export const syncMediaSessionPlaybackState = (playing: boolean): void =>
  mediaSessionManager.syncPlaybackState(playing);
export const syncMediaSessionPositionState = (
  durationSec: number,
  positionSec: number,
  playbackRate = 1,
): void => mediaSessionManager.syncPositionState(durationSec, positionSec, playbackRate);
export const clearMediaSessionPresentation = (): void =>
  mediaSessionManager.clearPresentation();
