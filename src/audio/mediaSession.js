import { peekTorrentImage, getTorrentImageDataUrl } from "../torrent/torrentImageCache.js";
import { peekRutrackerCover, getRutrackerCoverDataUrl } from "../rutracker/search.js";
import { trackDisplayBasename, extractTrackArtist } from "../lib/utils.js";

/** Обновляется из плеера — обработчики всегда вызывают актуальные действия. */
let api = {
  play() {},
  pause() {},
  prev() {},
  next() {},
  seek(_time) {},
  seekRelative(_delta) {},
};

function trackKey(track) {
  if (!track?.magnet) return "";
  return `${track.magnet}\0${track.fileIdx}`;
}

let handlersInstalled = false;

export function setMediaSessionApi(next) {
  api = { ...api, ...next };
}

function wrap(fn) {
  return () => {
    try {
      fn();
    } catch (e) {
      console.warn("[mediaSession]", e);
    }
  };
}

function bindTrackSkipHandlers() {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  navigator.mediaSession.setActionHandler("previoustrack", wrap(() => api.prev()));
  navigator.mediaSession.setActionHandler("nexttrack", wrap(() => api.next()));
}

/** На macOS WKWebView часто не активирует именно next/prev track, зато оставляет seek ±N с. */
function isMacDesktopUA() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Mac/.test(ua) && !/iPhone|iPad|iPod/.test(ua);
}

function bindSeekHandlersForPlatform() {
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

/**
 * WKWebView иногда «теряет» обработчики следующего/предыдущего трека до старта звука.
 * Вызывать при переходе в playing.
 */
export function reaffirmTrackSkipHandlers() {
  if (!handlersInstalled) return;
  try {
    bindTrackSkipHandlers();
    bindSeekHandlersForPlatform();
  } catch (e) {
    console.warn("[mediaSession] reaffirm track handlers", e);
  }
}

export function installMediaSessionHandlers() {
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

/** Снять привязку (при размонтировании плеера). */
export function clearMediaSessionHandlers() {
  if (typeof navigator === "undefined" || !navigator.mediaSession || !handlersInstalled) return;
  try {
    for (const a of [
      "play",
      "pause",
      "previoustrack",
      "nexttrack",
      "seekto",
      "seekbackward",
      "seekforward",
    ]) {
      navigator.mediaSession.setActionHandler(a, null);
    }
  } catch {
    /* ignore */
  }
  handlersInstalled = false;
}

async function resolveCoverDataUrl(track) {
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

/**
 * Метаданные для системного «Сейчас играет» (обложка подгружается при необходимости).
 *
 * @param {object} track
 * @param {object|null} enriched - optional enriched metadata from iTunes:
 *   { artist, album, title, coverUrl }
 */
export async function syncMediaSessionMetadata(track, enriched = null) {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  if (!track?.magnet) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const keyAtStart = trackKey(track);
  const title = enriched?.title || trackDisplayBasename(track.fileName) || "Трек";
  const artist = enriched?.artist || extractTrackArtist(track.torrentName, track.albumDirPath, track.artist, track.magnet);
  const album = enriched?.album || artist;
  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist,
    album,
    artwork: [],
  });
  reaffirmTrackSkipHandlers();
  // Prefer iTunes cover URL (direct HTTPS, no Rust round-trip), fall back to torrent/rutracker cover
  let art = enriched?.coverUrl ?? null;
  if (!art) art = await resolveCoverDataUrl(track);
  if (trackKey(track) !== keyAtStart) return;
  if (!art) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork: [{ src: art }],
    });
  } catch {
    /* data: URL может не принять отдельные движки — оставляем без обложки */
  }
  reaffirmTrackSkipHandlers();
}

export function syncMediaSessionPlaybackState(playing) {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  try {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  } catch {
    /* ignore */
  }
  reaffirmTrackSkipHandlers();
}

export function syncMediaSessionPositionState(durationSec, positionSec, playbackRate = 1) {
  if (typeof navigator === "undefined" || !navigator.mediaSession?.setPositionState) return;
  const d = Number(durationSec);
  const p = Number(positionSec);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(p)) return;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  const pos = Math.min(Math.max(0, p), d);
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: rate,
      position: pos,
    });
  } catch {
    /* неверное состояние — пропускаем */
  }
}

export function clearMediaSessionPresentation() {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  } catch {
    /* ignore */
  }
  try {
    if (navigator.mediaSession.setPositionState) {
      navigator.mediaSession.setPositionState(null);
    }
  } catch {
    /* ignore */
  }
}
