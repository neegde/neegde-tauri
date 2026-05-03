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
    searchResultsTab: ref<"tracks" | "albums">("tracks"),
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
    ctx.searchResultsTab.value = "albums";
    const snap = nav.snapshotSearchForBack();
    expect(snap.type).toBe("search");
    expect(snap.searchQuery).toBe("hello");
    expect(snap.resultsEntities).toEqual([{ id: "x" }]);
    expect(snap.error).toBe("boom");
    expect(snap.slskPeerBrowseUser).toBe("u");
    expect(snap.searchResultsTab).toBe("albums");
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
      searchResultsTab: "albums",
    });
    // Place something on current so forward gets a push.
    ctx.selected.value = { id: "now" };
    nav.handleBack();
    expect(ctx.searchQuery.value).toBe("old");
    expect(ctx.searchEntities.value).toEqual([{ id: "y" }]);
    expect(ctx.searchResultsTab.value).toBe("albums");
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
      torrentFilesBeforeAlbumPreview: null,
      torrentSelectedBeforeAlbumPreview: null,
    });
    nav.handleForwardNav();
    expect(ctx.selected.value?.id).toBe("F1");
    expect(ctx.view.value).toBe("home");
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
  it("restores likes snapshot from forward", () => {
    const { ctx, nav } = setup();
    nav.forwardStack.value.push({ type: "likes" });
    nav.handleForwardNav();
    expect(ctx.view.value).toBe("likes");
  });
  it("restores settings snapshot from forward", () => {
    const { ctx, nav } = setup();
    nav.forwardStack.value.push({ type: "settings" });
    nav.handleForwardNav();
    expect(ctx.view.value).toBe("settings");
  });
  it("restores playlist snapshot from forward", () => {
    const { ctx, nav } = setup();
    nav.forwardStack.value.push({ type: "playlist", playlistId: "p7" });
    nav.handleForwardNav();
    expect(ctx.view.value).toBe("playlist");
    expect(ctx.currentPlaylistId.value).toBe("p7");
  });
  it("restores search snapshot from forward", () => {
    const { ctx, nav } = setup();
    nav.forwardStack.value.push({
      type: "search", searchQuery: "q1",
      resultsEntities: [{ id: "r" }],
      error: null, slskPeerBrowseUser: null, searchResultsTab: "albums",
    });
    nav.handleForwardNav();
    expect(ctx.view.value).toBe("home");
    expect(ctx.searchQuery.value).toBe("q1");
    expect(ctx.searchEntities.value).toEqual([{ id: "r" }]);
    expect(ctx.searchResultsTab.value).toBe("albums");
  });
  it("pushes current screen onto backStack symmetrically", () => {
    const { ctx, nav } = setup();
    ctx.selected.value = { id: "current" };
    ctx.files.value = [{ path: "x.mp3" }];
    nav.forwardStack.value.push({ type: "likes" });
    nav.handleForwardNav();
    expect(nav.backStack.value).toHaveLength(1);
    expect(nav.backStack.value[0]?.type).toBe("torrent");
  });
});

describe("useNavStack — navigateToTopLevelView", () => {
  it("home → likes pushes home onto backStack and applies likes", () => {
    const { ctx, nav } = setup();
    nav.navigateToTopLevelView("likes");
    expect(ctx.view.value).toBe("likes");
    expect(nav.backStack.value).toHaveLength(1);
    expect(nav.backStack.value[0]?.type).toBe("search");
  });
  it("clears forwardStack on a fresh navigation", () => {
    const { nav } = setup();
    nav.forwardStack.value.push({ type: "settings" });
    nav.navigateToTopLevelView("likes");
    expect(nav.forwardStack.value).toEqual([]);
  });
  it("clicking the same view again is a no-op", () => {
    const { ctx, nav } = setup();
    ctx.view.value = "likes";
    nav.navigateToTopLevelView("likes");
    expect(nav.backStack.value).toEqual([]);
  });
  it("home keeps existing search/torrent state, only flips view", () => {
    const { ctx, nav } = setup();
    ctx.view.value = "settings";
    ctx.searchQuery.value = "kept";
    ctx.searchEntities.value = [{ id: "row" }];
    nav.navigateToTopLevelView("home");
    expect(ctx.view.value).toBe("home");
    expect(ctx.searchQuery.value).toBe("kept");
    expect(ctx.searchEntities.value).toEqual([{ id: "row" }]);
  });
  it("playlist requires playlistId and applies it", () => {
    const { ctx, nav } = setup();
    nav.navigateToTopLevelView("playlist", "pl-99");
    expect(ctx.view.value).toBe("playlist");
    expect(ctx.currentPlaylistId.value).toBe("pl-99");
  });
});

describe("useNavStack — snapshotCurrentScreen", () => {
  it("returns 'likes' entry when on Likes view (regression: back from album in Likes used to land on home)", () => {
    const { ctx, nav } = setup();
    ctx.view.value = "likes";
    expect(nav.snapshotCurrentScreen()).toEqual({ type: "likes" });
  });
  it("returns 'settings' entry on Settings view", () => {
    const { ctx, nav } = setup();
    ctx.view.value = "settings";
    expect(nav.snapshotCurrentScreen()).toEqual({ type: "settings" });
  });
  it("returns 'playlist' with id when on a playlist view", () => {
    const { ctx, nav } = setup();
    ctx.view.value = "playlist";
    ctx.currentPlaylistId.value = "pl-7";
    expect(nav.snapshotCurrentScreen()).toMatchObject({ type: "playlist", playlistId: "pl-7" });
  });
  it("on Home with currentAlbum returns 'album' entry", () => {
    const { ctx, nav } = setup();
    ctx.currentAlbum.value = { id: "A1" };
    expect(nav.snapshotCurrentScreen()).toMatchObject({ type: "album" });
  });
  it("on Home with selected torrent returns 'torrent' entry", () => {
    const { ctx, nav } = setup();
    ctx.selected.value = { id: "T1" };
    expect(nav.snapshotCurrentScreen()).toMatchObject({ type: "torrent" });
  });
  it("on Home with no selection returns 'search' entry", () => {
    const { nav } = setup();
    expect(nav.snapshotCurrentScreen()).toMatchObject({ type: "search" });
  });
});

describe("useNavStack — Likes → album → Back regression", () => {
  it("opening an album from Likes records Likes on backStack so Back returns there", () => {
    const { ctx, nav } = setup();
    // User clicks Likes in the sidebar.
    nav.navigateToTopLevelView("likes");
    expect(ctx.view.value).toBe("likes");

    // User clicks an album. App.vue's handleOpenTorrentFromPlayer pushes
    // snapshotCurrentScreen() (which now correctly captures Likes), then
    // applies torrent state.
    nav.backStack.value.push(nav.snapshotCurrentScreen());
    nav.forwardStack.value = [];
    ctx.view.value = "home";
    ctx.selected.value = { id: "T-from-album" };

    // User presses Back. Previously this landed on home (empty search);
    // with the fix, it flips the view back to Likes. The dormant torrent
    // state intentionally persists in memory so a subsequent sidebar-Home
    // click restores the open torrent — but it's not visible because
    // `view === "likes"` selects the Likes panel.
    nav.handleBack();
    expect(ctx.view.value).toBe("likes");
  });

  it("Likes → torrent → Back → Forward symmetric round trip", () => {
    const { ctx, nav } = setup();
    nav.navigateToTopLevelView("likes");
    nav.backStack.value.push(nav.snapshotCurrentScreen());
    nav.forwardStack.value = [];
    ctx.view.value = "home";
    ctx.selected.value = { id: "T1" };

    nav.handleBack();
    expect(ctx.view.value).toBe("likes");

    nav.handleForwardNav();
    expect(ctx.view.value).toBe("home");
    expect(ctx.selected.value?.id).toBe("T1");
  });
});

describe("useNavStack — back↔forward symmetry", () => {
  it("home → likes → back → forward returns to likes", () => {
    const { ctx, nav } = setup();
    nav.navigateToTopLevelView("likes");
    nav.handleBack();
    expect(ctx.view.value).toBe("home");
    nav.handleForwardNav();
    expect(ctx.view.value).toBe("likes");
  });
  it("three-step nav: home → likes → settings → back twice → forward twice", () => {
    const { ctx, nav } = setup();
    nav.navigateToTopLevelView("likes");
    nav.navigateToTopLevelView("settings");
    expect(ctx.view.value).toBe("settings");
    nav.handleBack();
    expect(ctx.view.value).toBe("likes");
    nav.handleBack();
    expect(ctx.view.value).toBe("home");
    nav.handleForwardNav();
    expect(ctx.view.value).toBe("likes");
    nav.handleForwardNav();
    expect(ctx.view.value).toBe("settings");
  });
  it("new nav after Back clears forwardStack (browser semantics)", () => {
    const { nav } = setup();
    nav.navigateToTopLevelView("likes");
    nav.navigateToTopLevelView("settings");
    nav.handleBack(); // settings → likes; forward = [settings]
    expect(nav.forwardStack.value).toHaveLength(1);
    nav.navigateToTopLevelView("likes"); // already on likes — no-op
    expect(nav.forwardStack.value).toHaveLength(1);
    nav.navigateToTopLevelView("settings"); // re-fork
    expect(nav.forwardStack.value).toEqual([]);
  });
});

describe("useNavStack — handleNavBack alias", () => {
  it("is the same fn as handleBack", () => {
    const { nav } = setup();
    expect(nav.handleNavBack).toBe(nav.handleBack);
  });
});
