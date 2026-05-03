import { beforeEach, describe, expect, it } from "vitest";
import "../_setup.js";

import { computed, ref } from "vue";
import { usePlayerDisplay } from "../../src/composables/usePlayerDisplay.js";
import { slskMeta } from "../../src/soulseek/slskMetaStore.js";

function makeTrack(overrides: Partial<{ id: string; kind: string; artist: string; title: string }> = {}) {
  return {
    id: overrides.id ?? "t1",
    kind: overrides.kind ?? "soulseek",
    artist: overrides.artist ?? "Track Artist",
    title: overrides.title ?? "Track Title",
  };
}

beforeEach(() => {
  slskMeta.clear();
});

describe("usePlayerDisplay", () => {
  it("prefers SoulSeek meta over enriched and raw track fields", () => {
    const trackRef = ref(makeTrack({ id: "slsk-1", kind: "soulseek" }));
    const enrichedMeta = ref({
      artist: "Enriched Artist",
      title: "Enriched Title",
      coverUrl: "https://enriched/cover.jpg",
    });
    slskMeta.set("slsk-1", {
      artist: "SLSK Artist",
      title: "SLSK Title",
      coverUrl: "https://slsk/cover.jpg",
    });

    const d = usePlayerDisplay({
      track: computed(() => trackRef.value as never),
      enrichedMeta,
    });

    expect(d.soulseekSearchMeta.value?.artist).toBe("SLSK Artist");
    expect(d.currentArtist.value).toBe("SLSK Artist");
    expect(d.displayTitle.value).toBe("SLSK Title");
    expect(d.playerCoverOverride.value).toBe("https://enriched/cover.jpg");
  });

  it("falls back to enriched fields and ignores year-like enriched artist", () => {
    const trackRef = ref(makeTrack({
      id: "slsk-2",
      kind: "soulseek",
      artist: "Track Artist",
      title: "Track Title",
    }));
    const enrichedMeta = ref({
      artist: "1998",
      title: "Enriched Title",
      coverUrl: null,
    });

    const d = usePlayerDisplay({
      track: computed(() => trackRef.value as never),
      enrichedMeta,
    });

    expect(d.currentArtist.value).toBe("Track Artist");
    expect(d.displayTitle.value).toBe("Enriched Title");
    expect(d.playerCoverOverride.value).toBe("");

    enrichedMeta.value = {
      artist: "Real Enriched Artist",
      title: "Another Enriched Title",
      coverUrl: "https://enriched/cover2.jpg",
    };
    expect(d.currentArtist.value).toBe("Real Enriched Artist");
    expect(d.playerCoverOverride.value).toBe("https://enriched/cover2.jpg");
  });

  it("returns no SoulSeek meta for non-soulseek track", () => {
    const trackRef = ref(makeTrack({ id: "rt-1", kind: "rutracker", artist: "RT Artist", title: "RT Title" }));
    const enrichedMeta = ref<{
      artist?: string;
      title?: string;
      coverUrl?: string | null;
      albumUrl?: string | null;
    } | null>(null);

    const d = usePlayerDisplay({
      track: computed(() => trackRef.value as never),
      enrichedMeta,
    });

    expect(d.soulseekSearchMeta.value).toBeNull();
    expect(d.currentArtist.value).toBe("RT Artist");
    expect(d.displayTitle.value).toBe("RT Title");
    expect(d.playerCoverOverride.value).toBe("");
  });

  it("uses SoulSeek cover fallback and raw title when enriched/slsk title missing", () => {
    const trackRef = ref(makeTrack({ id: "slsk-3", kind: "soulseek", title: "Raw Title" }));
    const enrichedMeta = ref({
      artist: "Enriched Artist",
      coverUrl: null,
    });
    slskMeta.set("slsk-3", {
      artist: "SLSK Artist",
      coverUrl: "https://slsk/fallback-cover.jpg",
    });

    const d = usePlayerDisplay({
      track: computed(() => trackRef.value as never),
      enrichedMeta: enrichedMeta as never,
    });

    expect(d.displayTitle.value).toBe("Raw Title");
    expect(d.playerCoverOverride.value).toBe("https://slsk/fallback-cover.jpg");
  });
});
