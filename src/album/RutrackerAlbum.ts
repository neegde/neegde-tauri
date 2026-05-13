import { Album } from "./Album.js";
import type { RutrackerAlbumSource } from "./types.js";
import {
  getCoverReactive,
  peekRutrackerCover,
  getRutrackerCoverDataUrl,
} from "../rutracker/coverCache.js";
import { appDebugLog } from "../appDebugLog.js";

export class RutrackerAlbum extends Album {
  private get refs(): RutrackerAlbumSource["refs"] {
    return (this.source as RutrackerAlbumSource).refs;
  }

  override coverUrl(): string | null {
    // Static resolver-provided cover (e.g. MusicBrainz via search pipeline)
    // wins over the topic-page cover cache.
    const stamped = this.data.coverUrl;
    if (stamped) return stamped;
    const topicId = this.refs?.topicId;
    if (!topicId) return null;
    return getCoverReactive(topicId);
  }

  override startCoverFetch(_signal?: AbortSignal, _opts?: unknown): void {
    if (this.data.coverUrl) return;
    const topicId = this.refs?.topicId;
    if (!topicId) return;
    const peek = peekRutrackerCover(topicId);
    if (peek !== undefined) {
      if (peek === null) void appDebugLog("cover", `rt album: neg-TTL skip — topicId=${topicId}`);
      return;
    }
    void appDebugLog("cover", `rt album: fetch — topicId=${topicId}`);
    void getRutrackerCoverDataUrl(topicId).catch(() => {});
  }
}
