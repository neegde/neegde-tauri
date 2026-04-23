import { Album } from "./Album.js";
import type { SoulseekAlbumSource, SlskAlbumCoverRef } from "./types.js";
import {
  getSlskCoverReactive,
  peekSlskCover,
  getSlskCoverDataUrl,
} from "../soulseek/coverCache.js";

export class SoulseekAlbum extends Album {
  private get slskSource(): SoulseekAlbumSource {
    return this.source as SoulseekAlbumSource;
  }

  private coverRef(): SlskAlbumCoverRef | null {
    const stampedExternal = this.data.coverUrl ? null : this.slskSource.raw?.cover ?? null;
    return stampedExternal;
  }

  override coverUrl(): string | null {
    // An externally-stamped URL (enrich pipeline) wins over the peer cache.
    const stamped = this.data.coverUrl;
    if (stamped) return stamped;
    const ref = this.coverRef();
    if (!ref?.slsk_username || !ref?.slsk_filepath) return null;
    return getSlskCoverReactive(ref.slsk_username, ref.slsk_filepath);
  }

  override startCoverFetch(): void {
    if (this.data.coverUrl) return;
    const ref = this.coverRef();
    if (!ref?.slsk_username || !ref?.slsk_filepath) return;
    if (peekSlskCover(ref.slsk_username, ref.slsk_filepath) !== undefined) return;
    void getSlskCoverDataUrl(ref.slsk_username, ref.slsk_filepath, ref.size ?? 0).catch(() => {});
  }
}
