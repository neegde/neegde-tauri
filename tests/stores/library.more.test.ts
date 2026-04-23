import { describe, it, expect, beforeEach } from "vitest";
import "../_setup.js";

import {
  likedTrackIds, likedAlbumIds, likedAt,
  toggleLikeTrack, toggleLikeAlbum, isTrackLiked, isAlbumLiked,
  playlists, createPlaylist, deletePlaylist, renamePlaylist,
  addTrackToPlaylist, removeTrackFromPlaylist, movePlaylistTrack,
  getPlaylist, getPlaylistTracks,
  seedLikesFromSnapshot, seedPlaylistsFromSnapshot,
  likedAlbums,
} from "../../src/stores/library.js";
import { clearEntities, registerEntity, type AlbumData } from "../../src/stores/entities.js";
import { buildTrack } from "../../src/track/factory.js";

const track = buildTrack({
  type: "track", id: "t1", title: "A", artist: null, albumId: null, albumTitle: null,
  fileName: "a.mp3", format: null, bitrate: null, duration: null, size: 1,
  sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "a.mp3" }, raw: { cover: null } }],
});

const album: AlbumData = {
  type: "album", id: "a1", title: "T", artist: null, trackIds: [],
  sources: [{ kind: "rutracker", refs: {} }],
};

beforeEach(() => {
  seedLikesFromSnapshot({ trackIds: [], albumIds: [], likedAt: {} });
  seedPlaylistsFromSnapshot([]);
  clearEntities();
});

describe("library — toggleLikeTrack", () => {
  it("toggles on/off and updates likedAt", () => {
    expect(isTrackLiked("t1")).toBe(false);
    expect(toggleLikeTrack(track)).toBe(true);
    expect(isTrackLiked("t1")).toBe(true);
    expect(likedAt.value.get("t1")).toBeGreaterThan(0);
    expect(toggleLikeTrack(track)).toBe(false);
    expect(isTrackLiked("t1")).toBe(false);
  });
  it("ignores null-id", () => {
    expect(toggleLikeTrack({} as unknown as never)).toBe(false);
  });
});

describe("library — toggleLikeAlbum", () => {
  it("toggles on/off + registers entity", () => {
    expect(isAlbumLiked("a1")).toBe(false);
    expect(toggleLikeAlbum(album)).toBe(true);
    expect(likedAlbumIds.value.has("a1")).toBe(true);
    expect(likedAlbums.value.map((a) => a.id)).toEqual(["a1"]);
    expect(toggleLikeAlbum(album)).toBe(false);
    expect(likedAlbums.value).toEqual([]);
  });
  it("ignores null", () => {
    expect(toggleLikeAlbum(null as unknown as AlbumData)).toBe(false);
  });
});

describe("library — playlists", () => {
  it("create → rename → delete", () => {
    const p = createPlaylist("My");
    expect(playlists.value).toHaveLength(1);
    expect(getPlaylist(p.id)?.title).toBe("My");
    renamePlaylist(p.id, "Renamed");
    expect(getPlaylist(p.id)?.title).toBe("Renamed");
    renamePlaylist(p.id, ""); // ignored
    expect(getPlaylist(p.id)?.title).toBe("Renamed");
    deletePlaylist(p.id);
    expect(playlists.value).toEqual([]);
  });
  it("addTrack + removeTrack idempotent", () => {
    registerEntity(track);
    const p = createPlaylist("A");
    addTrackToPlaylist(p.id, track);
    addTrackToPlaylist(p.id, track); // dedup
    expect(getPlaylist(p.id)?.trackIds).toEqual(["t1"]);
    expect(getPlaylistTracks(p.id)).toHaveLength(1);
    removeTrackFromPlaylist(p.id, "t1");
    removeTrackFromPlaylist(p.id, "nonexistent");
    expect(getPlaylist(p.id)?.trackIds).toEqual([]);
  });
  it("addTrackToPlaylist noop for null", () => {
    const p = createPlaylist("A");
    addTrackToPlaylist(p.id, null as unknown as never);
    expect(getPlaylist(p.id)?.trackIds).toEqual([]);
  });

  it("movePlaylistTrack", () => {
    const p = createPlaylist("A");
    registerEntity(track);
    const t2 = buildTrack({
      type: "track", id: "t2", title: "B", artist: null, albumId: null, albumTitle: null,
      fileName: "b.mp3", format: null, bitrate: null, duration: null, size: 1,
      sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: "b.mp3" }, raw: { cover: null } }],
    });
    registerEntity(t2);
    addTrackToPlaylist(p.id, track);
    addTrackToPlaylist(p.id, t2);
    movePlaylistTrack(p.id, 0, 1);
    expect(getPlaylist(p.id)?.trackIds).toEqual(["t2", "t1"]);
    // no-op cases
    movePlaylistTrack(p.id, 0, 0);
    movePlaylistTrack(p.id, -1, 0);
    movePlaylistTrack(p.id, 10, 0);
    movePlaylistTrack("unknown", 0, 1);
    expect(getPlaylist(p.id)?.trackIds).toEqual(["t2", "t1"]);
  });

  it("getPlaylistTracks with bogus id → []", () => {
    expect(getPlaylistTracks("nope")).toEqual([]);
  });
});

describe("library — seed snapshots", () => {
  it("seedLikesFromSnapshot / seedPlaylistsFromSnapshot applied", () => {
    seedLikesFromSnapshot({ trackIds: ["a"], albumIds: ["x"], likedAt: { a: 100, x: 200 } });
    seedPlaylistsFromSnapshot([{
      id: "p", title: "P", coverUrl: null, createdAt: 0, updatedAt: 0, trackIds: [],
    }]);
    expect(likedTrackIds.value.has("a")).toBe(true);
    expect(likedAlbumIds.value.has("x")).toBe(true);
    expect(playlists.value[0]?.id).toBe("p");
  });
});
