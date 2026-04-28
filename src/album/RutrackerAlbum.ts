import { Album } from "./Album.js";
import type { RutrackerAlbumSource } from "./types.js";
import {
  getCoverReactive,
  peekRutrackerCover,
  getRutrackerCoverDataUrl,
} from "../rutracker/coverCache.js";

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

  override startCoverFetch(): void {
    if (this.data.coverUrl) return;
    const topicId = this.refs?.topicId;
    if (!topicId) return;
    if (peekRutrackerCover(topicId) !== undefined) return;
    void getRutrackerCoverDataUrl(topicId).catch(() => {});
  }
}
