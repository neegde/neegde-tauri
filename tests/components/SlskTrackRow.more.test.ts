import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

import SlskTrackRow from "../../src/components/search/SlskTrackRow.vue";
import { buildTrack } from "../../src/track/factory.js";
import { clearEntities, registerEntity, type AlbumData } from "../../src/stores/entities.js";

function slsk(overrides: Record<string, unknown> = {}) {
  return buildTrack({
    type: "track", id: "slsk:t1", title: "song.mp3", artist: null,
    albumTitle: "Album", albumId: null, fileName: "song.flac",
    format: null, bitrate: 1000, duration: 240, size: 42 * 1024 * 1024,
    sources: [{
      kind: "soulseek",
      refs: { slskUsername: "u", slskFilepath: "folder/song.flac" },
      raw: { cover: null, peers: 3 },
    }],
    ...overrides,
  } as Parameters<typeof buildTrack>[0]);
}

beforeEach(() => {
  clearEntities();
});

describe("SlskTrackRow — peers / ext / size / duration branches", () => {
  it("pulls peers from parent album when track.albumId is set", () => {
    const album: AlbumData = {
      type: "album", id: "alb1", title: "A", artist: null, trackIds: ["slsk:t1"],
      peers: 42,
      sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFolder: "F" } }],
    };
    registerEntity(album);
    const track = slsk({ albumId: "alb1" });
    const w = mount(SlskTrackRow, { props: { track, enriched: null } });
    expect(w.text()).toMatch(/42/);
  });

  it("falls back to own raw.peers when no album link or missing album", () => {
    const track = slsk({ albumId: "unknown" });
    const w = mount(SlskTrackRow, { props: { track, enriched: null } });
    // Orphan peers=3 from raw.
    expect(w.text()).toMatch(/3/);
  });

  it("reads raw.peers when albumId is null", () => {
    const track = slsk({ albumId: null });
    const w = mount(SlskTrackRow, { props: { track, enriched: null } });
    expect(w.text()).toMatch(/3/);
  });

  it("trackExt derived from fileName extension when bitrate is missing", () => {
    const w1 = mount(SlskTrackRow, { props: { track: slsk({ bitrate: null, fileName: "a.flac" }), enriched: null } });
    expect(w1.text()).toMatch(/FLAC/i);
    const w2 = mount(SlskTrackRow, { props: { track: slsk({ bitrate: null, fileName: "a.mp3" }), enriched: null } });
    expect(w2.text()).toMatch(/MP3/);
  });

  it("fmtSize renders MB for large files when duration is 0", () => {
    const wMB = mount(SlskTrackRow, {
      props: { track: slsk({ duration: 0, size: 5 * 1024 * 1024 }), enriched: null },
    });
    expect(wMB.text()).toMatch(/5\.0 MB/);
    const wKB = mount(SlskTrackRow, {
      props: { track: slsk({ duration: 0, size: 5 * 1024 }), enriched: null },
    });
    expect(wKB.text()).toMatch(/5 KB/);
  });

  it("fmtDuration renders m:ss for non-empty seconds", () => {
    const w = mount(SlskTrackRow, { props: { track: slsk({ duration: 75 }), enriched: null } });
    expect(w.text()).toMatch(/1:15/);
  });

  it("fmtDuration returns empty string for null/0 duration", () => {
    const w = mount(SlskTrackRow, { props: { track: slsk({ duration: 0 }), enriched: null } });
    expect(w.text()).not.toMatch(/\d:\d\d/);
  });

  it("coverUrl falls back to enriched.coverUrl when entity cover cache empty", () => {
    const track = slsk();
    const w = mount(SlskTrackRow, {
      props: { track, enriched: { artist: "A", title: "B", coverUrl: "data:enriched-cover" } },
    });
    expect(w.html()).toContain("data:enriched-cover");
  });
});

describe("SlskTrackRow — animation lifecycle", () => {
  it("clearAnim runs cleanly on unmount (no throw)", async () => {
    const track = slsk();
    const w = mount(SlskTrackRow, { props: { track, enriched: null } });
    await nextTick();
    // Supply enrichment so animation starts; then unmount mid-animation.
    await w.setProps({ enriched: { artist: "A", title: "New Title" } });
    await nextTick();
    w.unmount();
    // Should not throw. Pass if we reach this line.
    expect(true).toBe(true);
  });

  it("track id change re-runs initAnim (resets display text)", async () => {
    const t1 = slsk();
    const t2 = slsk({ id: "slsk:t2", fileName: "other.mp3" });
    const w = mount(SlskTrackRow, { props: { track: t1, enriched: null } });
    await nextTick();
    await w.setProps({ track: t2 });
    await nextTick();
    // After re-init without enriched, displayText falls back to fileName.
    expect(w.text()).toContain("other.mp3");
  });
});
