/**
 * Title / artist / cover computeds for the player strip.
 *
 * Artist resolution priority:
 *   1. SoulSeek search meta (iTunes-enriched from the search flow)
 *   2. MusicBrainz-enriched `enrichedMeta`
 *   3. Filename-parsed "Artist — Title"
 *   4. Fallback to `track.artist`
 *
 * `displayTitle` uses the same priority; `playerCover` prefers enriched /
 * slskMeta cover URL over the raw track cover (enriched often has higher
 * resolution CAA artwork).
 */

import { computed, type ComputedRef, type Ref } from "vue";
import { isYearLike } from "../lib/utils.js";
import { slskMeta } from "../soulseek/slskMetaStore.js";
import { Track } from "../track/Track.js";

interface EnrichedMeta {
  artist?: string;
  title?: string;
  album?: string;
  coverUrl?: string | null;
  albumUrl?: string | null;
}

interface SlskMetaRecord {
  artist?: string;
  title?: string;
  coverUrl?: string | null;
  albumUrl?: string | null;
}

export function usePlayerDisplay(ctx: {
  track: ComputedRef<Track | null>;
  enrichedMeta: Ref<EnrichedMeta | null>;
}) {
  const soulseekSearchMeta = computed<SlskMetaRecord | null>(() => {
    const t = ctx.track.value;
    if (!t || t.kind !== "soulseek") return null;
    return (slskMeta as Map<string, SlskMetaRecord>).get(t.id) ?? null;
  });

  const currentArtist = computed<string>(() => {
    const t = ctx.track.value;
    if (soulseekSearchMeta.value?.artist) return soulseekSearchMeta.value.artist;
    const enrArtist = ctx.enrichedMeta.value?.artist;
    if (enrArtist && !isYearLike(String(enrArtist).trim())) return enrArtist;
    return t?.artist ?? "";
  });

  const displayTitle = computed<string>(() => {
    const t = ctx.track.value;
    if (soulseekSearchMeta.value?.title) return soulseekSearchMeta.value.title;
    if (ctx.enrichedMeta.value?.title) return ctx.enrichedMeta.value.title;
    return t?.title ?? "";
  });

  /** Enriched/slskMeta cover override; empty string = fall through to Track.coverUrl(). */
  const playerCoverOverride = computed<string>(() => {
    const e = ctx.enrichedMeta.value?.coverUrl;
    if (e) return e;
    const sm = soulseekSearchMeta.value;
    if (sm?.coverUrl) return sm.coverUrl;
    return "";
  });

  return { soulseekSearchMeta, currentArtist, displayTitle, playerCoverOverride };
}
