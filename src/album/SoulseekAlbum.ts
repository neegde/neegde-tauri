import { Album } from "./Album.js";
import type { SoulseekAlbumSource, SlskAlbumCoverRef } from "./types.js";
import {
  getSlskCoverReactive,
  peekSlskCover,
  getSlskCoverDataUrl,
} from "../soulseek/coverCache.js";
import { appDebugLog } from "../appDebugLog.js";

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

  override startCoverFetch(_signal?: AbortSignal, _opts?: unknown): void {
    if (this.data.coverUrl) return;
    const ref = this.coverRef();
    if (!ref?.slsk_username || !ref?.slsk_filepath) {
      void appDebugLog("cover", `slsk album: no cover ref — id=${this.id}`);
      return;
    }
    const peek = peekSlskCover(ref.slsk_username, ref.slsk_filepath);
    if (peek !== undefined) {
      if (peek === null) void appDebugLog("cover", `slsk album: neg-TTL skip — user=${ref.slsk_username} file=${ref.slsk_filepath.slice(-60)}`);
      return;
    }
    void appDebugLog("cover", `slsk album: fetch — user=${ref.slsk_username} file=${ref.slsk_filepath.slice(-60)}`);
    void getSlskCoverDataUrl(ref.slsk_username, ref.slsk_filepath, ref.size ?? 0).catch(() => {});
  }
}
