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

let api: MediaSessionApi = {
  play() {}, pause() {}, prev() {}, next() {},
  seek() {}, seekRelative() {},
};

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

function trackKey(track: TrackLike | null | undefined): string {
  if (!track?.magnet) return "";
  return `${track.magnet}\0${track.fileIdx}`;
}

let handlersInstalled = false;

export function setMediaSessionApi(next: Partial<MediaSessionApi>): void {
  api = { ...api, ...next };
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

function bindTrackSkipHandlers(): void {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  navigator.mediaSession.setActionHandler("previoustrack", wrap(() => api.prev()));
  navigator.mediaSession.setActionHandler("nexttrack", wrap(() => api.next()));
}

function isMacDesktopUA(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Mac/.test(ua) && !/iPhone|iPad|iPod/.test(ua);
}

function bindSeekHandlersForPlatform(): void {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  const mac = isMacDesktopUA();
  try {
    if (mac) {
      navigator.mediaSession.setActionHandler("seekbackward", wrap(() => api.prev()));
      navigator.mediaSession.setActionHandler("seekforward", wrap(() => api.next()));
    } else {
      navigator.mediaSession.setActionHandler("seekbackward", (d) => {
        const off = d?.seekOffset != null && Number.isFinite(d.seekOffset) ? d.seekOffset : 10;
        api.seekRelative(-off);
      });
      navigator.mediaSession.setActionHandler("seekforward", (d) => {
        const off = d?.seekOffset != null && Number.isFinite(d.seekOffset) ? d.seekOffset : 10;
        api.seekRelative(off);
      });
    }
  } catch {
    /* ignore */
  }
}

export function reaffirmTrackSkipHandlers(): void {
  if (!handlersInstalled) return;
  try {
    bindTrackSkipHandlers();
    bindSeekHandlersForPlatform();
  } catch (e) {
    console.warn("[mediaSession] reaffirm track handlers", e);
  }
}

export function installMediaSessionHandlers(): void {
  if (typeof navigator === "undefined" || !navigator.mediaSession || handlersInstalled) return;
  handlersInstalled = true;
  try {
    navigator.mediaSession.setActionHandler("play", wrap(() => api.play()));
    navigator.mediaSession.setActionHandler("pause", wrap(() => api.pause()));
    bindTrackSkipHandlers();
    navigator.mediaSession.setActionHandler("seekto", (d) => {
      if (d?.seekTime != null && Number.isFinite(d.seekTime)) api.seek(d.seekTime);
    });
    bindSeekHandlersForPlatform();
  } catch (e) {
    console.warn("[mediaSession] setActionHandler", e);
  }
}

export function clearMediaSessionHandlers(): void {
  if (typeof navigator === "undefined" || !navigator.mediaSession || !handlersInstalled) return;
  try {
    for (const a of [
      "play", "pause", "previoustrack", "nexttrack",
      "seekto", "seekbackward", "seekforward",
    ] as MediaSessionAction[]) {
      navigator.mediaSession.setActionHandler(a, null);
    }
  } catch {
    /* ignore */
  }
  handlersInstalled = false;
}

async function resolveCoverDataUrl(track: TrackLike | null | undefined): Promise<string | null> {
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

export interface EnrichedMeta {
  artist?: string;
  album?: string;
  title?: string;
  coverUrl?: string | null;
}

export async function syncMediaSessionMetadata(
  track: TrackLike | null | undefined,
  enriched: EnrichedMeta | null = null,
): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  const soulseek = String(track?.source || "") === "soulseek";
  if (!track?.magnet && !soulseek) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const keyAtStart = soulseek ? `slsk\0${track!.slskFilepath}` : trackKey(track);
  const title = enriched?.title || trackDisplayBasename(track!.fileName ?? "") || "Трек";
  const artist = enriched?.artist || extractTrackArtist(track!.torrentName, track!.albumDirPath, track!.artist, track!.magnet);
  const album = enriched?.album || artist;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork: [] });
  reaffirmTrackSkipHandlers();
  let art = enriched?.coverUrl ?? null;
  if (!art) art = await resolveCoverDataUrl(track);
  if ((soulseek ? `slsk\0${track!.slskFilepath}` : trackKey(track)) !== keyAtStart) return;
  if (!art) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist, album, artwork: [{ src: art }],
    });
  } catch {
    /* data: URL may be rejected by some engines */
  }
  reaffirmTrackSkipHandlers();
}

export function syncMediaSessionPlaybackState(playing: boolean): void {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  try {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  } catch {
    /* ignore */
  }
  reaffirmTrackSkipHandlers();
}

export function syncMediaSessionPositionState(
  durationSec: number,
  positionSec: number,
  playbackRate = 1,
): void {
  if (typeof navigator === "undefined" || !navigator.mediaSession?.setPositionState) return;
  const d = Number(durationSec);
  const p = Number(positionSec);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(p)) return;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  const pos = Math.min(Math.max(0, p), d);
  try {
    navigator.mediaSession.setPositionState({ duration: d, playbackRate: rate, position: pos });
  } catch {
    /* invalid state — skip */
  }
}

export function clearMediaSessionPresentation(): void {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  } catch {
    /* ignore */
  }
  try {
    if (navigator.mediaSession.setPositionState) {
      navigator.mediaSession.setPositionState(null as unknown as MediaPositionState);
    }
  } catch {
    /* ignore */
  }
}
