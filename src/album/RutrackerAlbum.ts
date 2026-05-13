import { Album } from "./Album.js";
import type { RutrackerAlbumSource } from "./types.js";
import {
  getCoverReactive,
  peekRutrackerCover,
  getRutrackerCoverDataUrl,
} from "../rutracker/coverCache.js";
import { appDebugLog } from "../appDebugLog.js";
import { fetchDeezerAlbumCoverArt } from "../track/deezerCanonical.js";
import { fetchAlbumCover } from "../audio/coverFetch.js";
import { getAlbum, bumpEntitiesVersion } from "../stores/entities.js";

/**
 * Writes catalog cover onto the registry album.
 *
 * @param albumId - Target album id in the registry.
 * @param url - Cover URL to stamp; null is a no-op.
 * @param overwrite - When true, replaces existing coverUrl regardless of value.
 * @returns True when a URL was written.
 */
function stampAlbumCover(albumId: string, url: string | null, overwrite: boolean): boolean {
  if (!url) return false;
  const live = getAlbum(albumId);
  if (!live) return false;
  const d = live.toJSON();
  if (!overwrite && d.coverUrl) return false;
  if (d.coverUrl === url) return false;
  d.coverUrl = url;
  bumpEntitiesVersion();
  return true;
}

export class RutrackerAlbum extends Album {
  private get refs(): RutrackerAlbumSource["refs"] {
    return (this.source as RutrackerAlbumSource).refs;
  }

  private get rutrackerRaw(): RutrackerAlbumSource["raw"] {
    return (this.source as RutrackerAlbumSource).raw;
  }

  private get isMultiAlbumTopic(): boolean {
    return this.rutrackerRaw?.multiAlbumTopic === true;
  }

  override coverUrl(): string | null {
    // For one-album topics the forum cover is the album cover.
    // For multi-album topics it's a discography avatar — never use the topic
    // cache; only an explicit stamp (Deezer / iTunes / explicit fallback)
    // counts as a real per-folder cover.
    if (this.isMultiAlbumTopic) {
      return this.data.coverUrl ?? null;
    }
    const stamped = this.data.coverUrl;
    if (stamped) return stamped;
    const topicId = this.refs?.topicId;
    if (!topicId) return null;
    return getCoverReactive(topicId);
  }

  override startCoverFetch(signal?: AbortSignal, _opts?: unknown): void {
    if (this.data.coverUrl) return;
    const topicId = this.refs?.topicId;
    if (!topicId) return;

    if (this.isMultiAlbumTopic) {
      this.fetchMultiAlbumCover(topicId, signal);
      return;
    }

    const peek = peekRutrackerCover(topicId);
    if (peek !== undefined) {
      if (peek === null) void appDebugLog("cover", `rt album: neg-TTL skip — topicId=${topicId}`);
      return;
    }
    void appDebugLog("cover", `rt album: fetch — topicId=${topicId}`);
    void getRutrackerCoverDataUrl(topicId).catch(() => {});
  }

  /**
   * Per-folder cover for a virtual album inside a multi-album RuTracker topic.
   *
   * Tries Deezer → iTunes → topic cover (last-resort discography fallback).
   *
   * @param topicId - RuTracker topic id, used only for the fallback.
   * @param signal - Abort signal from `useEntityCover`.
   */
  private fetchMultiAlbumCover(topicId: string, signal?: AbortSignal): void {
    const artist = (this.data.artist ?? "").trim();
    const albumTitle = (this.data.title ?? "").trim();
    const id = this.id;
    const aborted = () => signal?.aborted === true;

    void appDebugLog(
      "cover",
      `rt album multi: start — id=${id} artist="${artist}" album="${albumTitle}"`,
    );

    if (albumTitle.length < 2) {
      void appDebugLog("cover", `rt album multi: empty title — id=${id} → fallback topic`);
      void getRutrackerCoverDataUrl(topicId)
        .then((u) => {
          if (aborted()) return;
          stampAlbumCover(id, u ?? null, false);
        })
        .catch(() => {});
      return;
    }

    void fetchDeezerAlbumCoverArt(artist, albumTitle)
      .then((dz) => {
        if (aborted()) return;
        if (dz) {
          void appDebugLog("cover", `rt album multi: deezer hit — id=${id}`);
          stampAlbumCover(id, dz, false);
          return;
        }
        if (artist.length < 2) return Promise.resolve(null);
        return fetchAlbumCover(artist, albumTitle).then((it) => {
          if (aborted()) return null;
          if (it?.coverUrl) {
            void appDebugLog("cover", `rt album multi: itunes hit — id=${id}`);
            stampAlbumCover(id, it.coverUrl, false);
          }
          return it?.coverUrl ?? null;
        });
      })
      .then((found) => {
        if (aborted() || found) return;
        // Catalog had nothing — stamp topic cover as last resort so the
        // card isn't a placeholder. All folders of the topic share it,
        // but that's still better than the SVG fallback.
        void appDebugLog("cover", `rt album multi: catalog miss — id=${id} → fallback topic`);
        return getRutrackerCoverDataUrl(topicId).then((u) => {
          if (aborted()) return;
          stampAlbumCover(id, u ?? null, false);
        });
      })
      .catch(() => {});
  }
}
