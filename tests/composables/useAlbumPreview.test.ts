import { describe, it, expect } from "vitest";
import "../_setup.js";
import { ref } from "vue";

import { useAlbumPreview } from "../../src/composables/useAlbumPreview.js";

function setupCtx() {
  return {
    selected: ref<object | null>(null),
    files: ref<unknown[]>([]),
    torrentFilesBeforeAlbumPreview: ref<unknown[] | null>(null),
    torrentSelectedBeforeAlbumPreview: ref<object | null>(null),
    mainRef: ref<HTMLElement | null>(null),
  };
}

describe("useAlbumPreview — handleOpenAlbumPreview", () => {
  it("no-op when no selected", () => {
    const ctx = setupCtx();
    const api = useAlbumPreview(ctx);
    api.handleOpenAlbumPreview({ album: { audioFiles: [{ path: "a.mp3" }] }, displayName: "X" });
    expect(ctx.files.value).toEqual([]);
  });

  it("no-op when album has no audioFiles", () => {
    const ctx = setupCtx();
    ctx.selected.value = { id: "t" };
    const api = useAlbumPreview(ctx);
    api.handleOpenAlbumPreview({ album: { audioFiles: [] }, displayName: "X" });
    expect(ctx.files.value).toEqual([]);
  });

  it("narrows files to album + stashes full list", () => {
    const ctx = setupCtx();
    const FULL = [{ path: "a.mp3" }, { path: "b.mp3" }, { path: "c.mp3" }];
    ctx.selected.value = { id: "t", name: "Artist - Full" };
    ctx.files.value = FULL;
    const api = useAlbumPreview(ctx);
    const alb = {
      audioFiles: [{ path: "a.mp3" }],
      coverFile: { path: "cover.jpg" },
    };
    api.handleOpenAlbumPreview({ album: alb, displayName: "Only A" });
    expect(ctx.files.value).toHaveLength(2); // audioFile + cover
    expect(ctx.torrentFilesBeforeAlbumPreview.value).toStrictEqual(FULL);
    expect(ctx.selected.value).toMatchObject({ name: "Only A", fromLikes: true, artist: "Artist" });
  });

  it("handles album without coverFile", () => {
    const ctx = setupCtx();
    ctx.selected.value = { id: "t", name: "N" };
    ctx.files.value = [{ path: "x.mp3" }];
    const api = useAlbumPreview(ctx);
    api.handleOpenAlbumPreview({ album: { audioFiles: [{ path: "y.mp3" }] }, displayName: "Y" });
    expect(ctx.files.value).toEqual([{ path: "y.mp3" }]);
  });
});

describe("useAlbumPreview — applyAlbumScopeForTrack", () => {
  it("no-op when only one album", () => {
    const ctx = setupCtx();
    ctx.files.value = [{ path: "A/01.mp3", origIdx: 0 }];
    ctx.selected.value = { name: "t" };
    const api = useAlbumPreview(ctx);
    api.applyAlbumScopeForTrack(0, null);
    expect(ctx.files.value).toHaveLength(1);
  });

  it("narrows when fileIdx matches", () => {
    const ctx = setupCtx();
    ctx.files.value = [
      { path: "A/01.mp3", origIdx: 0 },
      { path: "A/02.mp3", origIdx: 1 },
      { path: "B/01.mp3", origIdx: 2 },
    ];
    ctx.selected.value = { name: "Artist - Original" };
    const api = useAlbumPreview(ctx);
    api.applyAlbumScopeForTrack(2, null);
    expect(ctx.files.value.map((f: { path: string }) => f.path))
      .toEqual(["B/01.mp3"]);
    expect(ctx.torrentFilesBeforeAlbumPreview.value).not.toBeNull();
  });

  it("narrows by albumDirPath when fileIdx absent", () => {
    const ctx = setupCtx();
    ctx.files.value = [
      { path: "A/01.mp3", origIdx: 0 },
      { path: "B/01.mp3", origIdx: 1 },
    ];
    ctx.selected.value = { name: "Release" };
    const api = useAlbumPreview(ctx);
    api.applyAlbumScopeForTrack(null, "B");
    expect(ctx.files.value.map((f: { path: string }) => f.path)).toEqual(["B/01.mp3"]);
  });

  it("no-op when match not found", () => {
    const ctx = setupCtx();
    ctx.files.value = [
      { path: "A/01.mp3", origIdx: 0 },
      { path: "B/01.mp3", origIdx: 1 },
    ];
    ctx.selected.value = { name: "x" };
    const api = useAlbumPreview(ctx);
    api.applyAlbumScopeForTrack(99, null);
    expect(ctx.files.value).toHaveLength(2);
  });
});
