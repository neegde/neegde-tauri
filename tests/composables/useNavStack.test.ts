import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";
import { ref } from "vue";
import { useNavStack } from "../../src/composables/useNavStack.js";

function setup() {
  const ctx = {
    selected: ref<object | null>(null),
    files: ref<unknown[]>([]),
    torrentMagnet: ref(""),
    torrentCover: ref<string | null>(null),
    torrentFilesBeforeAlbumPreview: ref<unknown[] | null>(null),
    torrentSelectedBeforeAlbumPreview: ref<object | null>(null),
    currentAlbum: ref<object | null>(null),
    view: ref("home"),
    returnView: ref("home"),
    currentPlaylistId: ref<string | null>(null),
    searchQuery: ref(""),
    searchEntities: ref<unknown[]>([]),
    slskPeerBrowseUser: ref<string | null>(null),
    error: ref<string | null>(null),
    mainRef: ref<HTMLElement | null>(null),
  };
  const nav = useNavStack(ctx);
  return { ctx, nav };
}

describe("useNavStack snapshots", () => {
  it("snapshotSearchForBack captures search state", () => {
    const { ctx, nav } = setup();
    ctx.searchQuery.value = "hello";
    ctx.searchEntities.value = [{ id: "x" }];
    ctx.error.value = "boom";
    ctx.slskPeerBrowseUser.value = "u";
    const snap = nav.snapshotSearchForBack();
    expect(snap.type).toBe("search");
    expect(snap.searchQuery).toBe("hello");
    expect(snap.resultsEntities).toEqual([{ id: "x" }]);
    expect(snap.error).toBe("boom");
    expect(snap.slskPeerBrowseUser).toBe("u");
  });

  it("snapshotTorrentForBack captures torrent state + preview", () => {
    const { ctx, nav } = setup();
    ctx.selected.value = { id: "t1" };
    ctx.files.value = [{ path: "a.mp3" }];
    ctx.torrentMagnet.value = "magnet:?x";
    ctx.torrentCover.value = "data:X";
    ctx.torrentFilesBeforeAlbumPreview.value = [{ path: "original.mp3" }];
    ctx.torrentSelectedBeforeAlbumPreview.value = { id: "prev" };
    const snap = nav.snapshotTorrentForBack();
    expect(snap).toMatchObject({
      type: "torrent",
      selected: { id: "t1" },
      magnet: "magnet:?x",
      cover: "data:X",
    });
    expect(snap.torrentFilesBeforeAlbumPreview).toEqual([{ path: "original.mp3" }]);
  });

  it("snapshotAlbumForBack stores currentAlbum", () => {
    const { ctx, nav } = setup();
    const album = { id: "A", type: "album" };
    ctx.currentAlbum.value = album;
    const snap = nav.snapshotAlbumForBack();
    expect(snap.type).toBe("album");
    expect((snap.album as { id: string })?.id).toBe("A");
  });
});

describe("useNavStack — back/forward, search ↔ torrent", () => {
  it("back from search snapshot restores search state", () => {
    const { ctx, nav } = setup();
    nav.backStack.value.push({
      type: "search",
      searchQuery: "old",
      resultsEntities: [{ id: "y" }],
      error: null,
      slskPeerBrowseUser: null,
    });
    // Place something on current so forward gets a push.
    ctx.selected.value = { id: "now" };
    nav.handleBack();
    expect(ctx.searchQuery.value).toBe("old");
    expect(ctx.searchEntities.value).toEqual([{ id: "y" }]);
    expect(ctx.selected.value).toBeNull();
  });

  it("back from torrent entry restores torrent state", () => {
    const { ctx, nav } = setup();
    nav.backStack.value.push({
      type: "torrent",
      selected: { id: "T1" },
      files: [{ path: "1.mp3" }],
      magnet: "m",
      cover: null,
      torrentFilesBeforeAlbumPreview: null,
      torrentSelectedBeforeAlbumPreview: null,
    });
    nav.handleBack();
    expect(ctx.selected.value?.id).toBe("T1");
    expect(ctx.files.value).toEqual([{ path: "1.mp3" }]);
    expect(ctx.torrentMagnet.value).toBe("m");
  });

  it("back from album entry restores album", () => {
    const { ctx, nav } = setup();
    nav.backStack.value.push({ type: "album", album: { id: "A", type: "album" } });
    nav.handleBack();
    expect(ctx.currentAlbum.value?.id).toBe("A");
    expect(ctx.selected.value).toBeNull();
  });

  it("back from likes entry flips to likes view", () => {
    const { ctx, nav } = setup();
    nav.backStack.value.push({ type: "likes" });
    nav.handleBack();
    expect(ctx.view.value).toBe("likes");
  });

  it("back from playlist entry sets currentPlaylistId + view", () => {
    const { ctx, nav } = setup();
    nav.backStack.value.push({ type: "playlist", playlistId: "p1" });
    nav.handleBack();
    expect(ctx.currentPlaylistId.value).toBe("p1");
    expect(ctx.view.value).toBe("playlist");
  });

  it("back no-op when both stacks empty and no selected", () => {
    const { ctx, nav } = setup();
    nav.handleBack();
    expect(ctx.view.value).toBe("home");
  });
});

describe("useNavStack — album-preview mid-step", () => {
  it("first back with torrentFilesBeforeAlbumPreview pops preview, keeps torrent", () => {
    const { ctx, nav } = setup();
    ctx.selected.value = { id: "preview" };
    ctx.files.value = [{ path: "preview.mp3" }];
    ctx.torrentMagnet.value = "m";
    ctx.torrentCover.value = null;
    ctx.torrentFilesBeforeAlbumPreview.value = [{ path: "full.mp3" }];
    ctx.torrentSelectedBeforeAlbumPreview.value = { id: "full" };
    nav.handleBack();
    expect(ctx.files.value).toEqual([{ path: "full.mp3" }]);
    expect(ctx.selected.value?.id).toBe("full");
    expect(nav.forwardStack.value[0]?.type).toBe("album-preview");
  });
});

describe("useNavStack — handleForwardNav", () => {
  it("no-op when forward stack empty", () => {
    const { nav } = setup();
    nav.handleForwardNav();
    expect(nav.forwardStack.value).toEqual([]);
  });
  it("restores torrent snapshot from forward", () => {
    const { ctx, nav } = setup();
    nav.forwardStack.value.push({
      type: "torrent",
      selected: { id: "F1" }, files: [], magnet: "m", cover: null,
      restoreLikesView: true,
      torrentFilesBeforeAlbumPreview: null,
      torrentSelectedBeforeAlbumPreview: null,
    });
    nav.handleForwardNav();
    expect(ctx.selected.value?.id).toBe("F1");
    expect(ctx.returnView.value).toBe("likes");
  });
  it("restores album-preview snapshot", () => {
    const { ctx, nav } = setup();
    nav.forwardStack.value.push({
      type: "album-preview",
      files: [{ path: "pv.mp3" }], selected: { id: "pv" }, magnet: "m", cover: null,
      fullFiles: [{ path: "full.mp3" }],
      fullSelected: { id: "full" },
    });
    nav.handleForwardNav();
    expect(ctx.files.value).toEqual([{ path: "pv.mp3" }]);
    expect(ctx.torrentFilesBeforeAlbumPreview.value).toEqual([{ path: "full.mp3" }]);
  });
  it("restores album snapshot", () => {
    const { ctx, nav } = setup();
    nav.forwardStack.value.push({ type: "album", album: { id: "A1" } });
    nav.handleForwardNav();
    expect(ctx.currentAlbum.value?.id).toBe("A1");
  });
});

describe("useNavStack — handleNavBack alias", () => {
  it("is the same fn as handleBack", () => {
    const { nav } = setup();
    expect(nav.handleNavBack).toBe(nav.handleBack);
  });
});
