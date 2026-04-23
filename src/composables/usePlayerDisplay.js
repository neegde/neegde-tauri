/**
 * Title / artist / cover computeds for the player strip.
 *
 * Resolution order for artist:
 *   1. SoulSeek search meta (filename-parsed + iTunes, matches the tracks list)
 *   2. MusicBrainz-enriched `enrichedMeta`
 *   3. Filename-parsed "Artist — Title"
 *   4. extractTrackArtist fallback (torrent name / album dir / row fields)
 *
 * displayTitle uses the same priority; playerCoverOverride prefers enriched
 * cover, then SoulSeek search meta, then the folder cover from the peer.
 */

import { computed } from "vue";
import {
  isYearLike,
  parseArtistTitleFromTrackFilename,
  extractTrackArtist,
  trackDisplayBasename,
} from "../lib/utils.js";
import { slskMeta } from "../soulseek/slskMetaStore.js";
import { getSlskCoverReactive } from "../soulseek/coverCache.js";

/**
 * @param {{
 *   track: import("vue").ComputedRef<object | null>,
 *   enrichedMeta: import("vue").Ref<object | null>,
 * }} ctx
 */
export function usePlayerDisplay(ctx) {
  const soulseekSearchMeta = computed(() => {
    const t = ctx.track.value;
    if (!t || t.source !== "soulseek" || t.slskMetaTrackId == null || t.slskMetaTrackId === "") {
      return null;
    }
    return slskMeta.get(t.slskMetaTrackId) ?? null;
  });

  const currentArtist = computed(() => {
    const t = ctx.track.value;
    if (soulseekSearchMeta.value?.artist) return soulseekSearchMeta.value.artist;
    if (ctx.enrichedMeta.value?.artist && !isYearLike(String(ctx.enrichedMeta.value.artist).trim())) {
      return ctx.enrichedMeta.value.artist;
    }
    const parsed = parseArtistTitleFromTrackFilename(t?.fileName ?? "");
    if (parsed.artist) return parsed.artist;
    return (
      extractTrackArtist(t?.torrentName, t?.albumDirPath, t?.artist, t?.magnet) || ""
    );
  });

  const displayTitle = computed(() => {
    const t = ctx.track.value;
    if (soulseekSearchMeta.value?.title) return soulseekSearchMeta.value.title;
    if (ctx.enrichedMeta.value?.title) return ctx.enrichedMeta.value.title;
    const path = t?.fileName ?? "";
    const { artist, title } = parseArtistTitleFromTrackFilename(path);
    if (artist) return title;
    return trackDisplayBasename(path);
  });

  const playerCoverOverride = computed(() => {
    const e = ctx.enrichedMeta.value?.coverUrl;
    if (e) return e;
    const t = ctx.track.value;
    if (!t || t.source !== "soulseek") return "";
    const sm = soulseekSearchMeta.value;
    if (sm?.coverUrl) return sm.coverUrl;
    const u = t.slskFolderCoverUsername;
    const p = t.slskFolderCoverFilepath;
    if (u && p) {
      const folder = getSlskCoverReactive(u, p);
      if (folder) return folder;
    }
    return "";
  });

  return { soulseekSearchMeta, currentArtist, displayTitle, playerCoverOverride };
}
