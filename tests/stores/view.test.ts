import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";

import {
  view, currentPlaylistId, selectedAlbumId, returnView,
  backStack, forwardStack,
  navigateTo, goBack, goForward, clearHistory,
} from "../../src/stores/view.js";

beforeEach(() => {
  view.value = "home";
  currentPlaylistId.value = null;
  selectedAlbumId.value = null;
  returnView.value = "home";
  clearHistory();
});

describe("navigateTo", () => {
  it("ignores null / malformed", () => {
    navigateTo(null as unknown as { kind: "home" });
    navigateTo(undefined as unknown as { kind: "home" });
    navigateTo({} as unknown as { kind: "home" });
    expect(view.value).toBe("home");
  });
  it("album → selectedAlbumId, view=home, clears playlist", () => {
    currentPlaylistId.value = "pl-x";
    navigateTo({ kind: "album", albumId: "A1" });
    expect(selectedAlbumId.value).toBe("A1");
    expect(view.value).toBe("home");
    expect(currentPlaylistId.value).toBe(null);
  });
  it("playlist → currentPlaylistId, view=playlist, clears album", () => {
    selectedAlbumId.value = "A1";
    navigateTo({ kind: "playlist", playlistId: "pl-1" });
    expect(currentPlaylistId.value).toBe("pl-1");
    expect(view.value).toBe("playlist");
    expect(selectedAlbumId.value).toBe(null);
  });
  it("likes / settings / home set view", () => {
    navigateTo({ kind: "likes" });
    expect(view.value).toBe("likes");
    navigateTo({ kind: "settings" });
    expect(view.value).toBe("settings");
    navigateTo({ kind: "home" });
    expect(view.value).toBe("home");
  });
  it("pushes previous screen to backStack, resets forwardStack", () => {
    navigateTo({ kind: "likes" });          // home → likes
    navigateTo({ kind: "settings" });       // likes → settings
    expect(backStack.value.map((s) => s.kind)).toEqual(["home", "likes"]);
    expect(forwardStack.value).toEqual([]);
  });
  it("skips dedup on same descriptor (same kind / same id)", () => {
    navigateTo({ kind: "album", albumId: "A1" });
    navigateTo({ kind: "album", albumId: "A1" });
    expect(backStack.value).toHaveLength(1); // home → album, no dup push
  });
  it("different album id is distinct — push", () => {
    navigateTo({ kind: "album", albumId: "A1" });
    navigateTo({ kind: "album", albumId: "A2" });
    expect(backStack.value).toHaveLength(2);
  });
  it("different playlist id is distinct — push", () => {
    navigateTo({ kind: "playlist", playlistId: "P1" });
    navigateTo({ kind: "playlist", playlistId: "P2" });
    expect(backStack.value).toHaveLength(2);
  });
});

describe("goBack / goForward", () => {
  it("goBack returns false when nothing on stack", () => {
    expect(goBack()).toBe(false);
  });
  it("goForward returns false when nothing on stack", () => {
    expect(goForward()).toBe(false);
  });
  it("one step back", () => {
    navigateTo({ kind: "likes" });
    expect(goBack()).toBe(true);
    expect(view.value).toBe("home");
    expect(forwardStack.value[0]?.kind).toBe("likes");
  });
  it("back / forward round-trip", () => {
    navigateTo({ kind: "likes" });
    navigateTo({ kind: "settings" });
    goBack(); // -> likes
    goBack(); // -> home
    expect(view.value).toBe("home");
    goForward();
    expect(view.value).toBe("likes");
    goForward();
    expect(view.value).toBe("settings");
  });
  it("back from playlist", () => {
    navigateTo({ kind: "playlist", playlistId: "p1" });
    expect(goBack()).toBe(true);
    expect(view.value).toBe("home");
    expect(currentPlaylistId.value).toBe(null);
  });
  it("back from album", () => {
    navigateTo({ kind: "album", albumId: "A1" });
    expect(goBack()).toBe(true);
    expect(selectedAlbumId.value).toBe(null);
  });
});

describe("clearHistory", () => {
  it("wipes both stacks", () => {
    navigateTo({ kind: "likes" });
    navigateTo({ kind: "settings" });
    clearHistory();
    expect(backStack.value).toEqual([]);
    expect(forwardStack.value).toEqual([]);
  });
});
