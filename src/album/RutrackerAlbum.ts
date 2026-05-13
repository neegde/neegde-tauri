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
 * Writes catalog/topic cover onto the registry album when still empty.
 *
 * @returns True when a URL was stamped.
 */
function stampAlbumCoverIfEmpty(albumId: string, url: string | null): boolean {
  if (!url) return false;
  const live = getAlbum(albumId);
  if (!live) return false;
  const d = live.toJSON();
  if (d.coverUrl) return false;
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

  override coverUrl(): string | null {
    const stamped = this.data.coverUrl;
    if (stamped) return stamped;
    if (this.rutrackerRaw?.multiAlbumTopic) return null;
    const topicId = this.refs?.topicId;
    if (!topicId) return null;
    return getCoverReactive(topicId);
  }

  override startCoverFetch(signal?: AbortSignal, _opts?: unknown): void {
    if (this.data.coverUrl) return;
    const topicId = this.refs?.topicId;
    if (!topicId) return;

    if (this.rutrackerRaw?.multiAlbumTopic) {
      const artist = (this.data.artist ?? "").trim();
      const albumTitle = (this.data.title ?? "").trim();
      const id = this.id;
      const aborted = () => signal?.aborted === true;

      const chain =
        artist.length < 2 || albumTitle.length < 2
          ? getRutrackerCoverDataUrl(topicId).then((u) => {
              if (aborted()) return;
              stampAlbumCoverIfEmpty(id, u ?? null);
            })
          : fetchDeezerAlbumCoverArt(artist, albumTitle).then((dz) => {
              if (aborted()) return;
              if (stampAlbumCoverIfEmpty(id, dz)) return undefined;
              return fetchAlbumCover(artist, albumTitle).then((it) => {
                if (aborted()) return;
                if (stampAlbumCoverIfEmpty(id, it?.coverUrl ?? null)) return undefined;
                return getRutrackerCoverDataUrl(topicId).then((topicUrl) => {
                  if (aborted()) return;
                  stampAlbumCoverIfEmpty(id, topicUrl ?? null);
                });
              });
            });

      void Promise.resolve(chain).catch(() => {});
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
}
