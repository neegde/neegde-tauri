import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";

import {
  rtTrackId,
  buildRtTrackEntity,
  buildSlskTrackEntity,
  registerAndGetId,
} from "../../src/player/trackForQueue.js";
import { clearEntities, getEntity } from "../../src/stores/entities.js";

beforeEach(() => clearEntities());

describe("rtTrackId", () => {
  it("uses topicId when present", () => {
    expect(rtTrackId("100", null, 5)).toBe("rt:track:100:5");
  });
  it("uses btih when no topicId", () => {
    expect(rtTrackId(null, "deadbeef", 3)).toBe("magnet:track:deadbeef:3");
  });
  it("returns null when neither", () => {
    expect(rtTrackId(null, null, 0)).toBeNull();
    expect(rtTrackId("   ", null, 0)).toBeNull();
  });
  it("stringifies numeric topicId", () => {
    expect(rtTrackId(42, null, 1)).toBe("rt:track:42:1");
  });
});

describe("buildRtTrackEntity", () => {
  it("produces well-formed Track for rutracker source", () => {
    const t = buildRtTrackEntity(
      { origIdx: 3, path: "Album/01 - Song.flac", size: 1234 },
      { id: "100", name: "Artist - Album", artist: "Artist", source: "rutracker" },
      "magnet:?xt=X",
      null,
      5, "Album",
    );
    expect(t).not.toBeNull();
    expect(t?.id).toBe("rt:track:100:3");
    expect(t?.title).toBe("Song");
    expect(t?.sources?.[0]?.kind).toBe("rutracker");
    expect(t?.sources?.[0]?.refs?.magnet).toBe("magnet:?xt=X");
  });
  it("uses magnet kind when source='magnet'", () => {
    const t = buildRtTrackEntity(
      { origIdx: 0, path: "f.mp3", size: 0 },
      { id: "1", source: "magnet" },
      "m", null, null, null,
    );
    expect(t?.sources?.[0]?.kind).toBe("magnet");
  });
  it("returns null when no id derivable", () => {
    const t = buildRtTrackEntity(
      { origIdx: 0, path: "f.mp3" },
      { source: "rutracker" },
      "", null, null, null,
    );
    expect(t).toBeNull();
  });
  it("prefers __topicId over id", () => {
    const t = buildRtTrackEntity(
      { origIdx: 0, path: "f.mp3" },
      { id: "id-a", __topicId: "topic-b", source: "rutracker" },
      "", null, null, null,
    );
    expect(t?.id).toBe("rt:track:topic-b:0");
  });
});

describe("buildSlskTrackEntity", () => {
  it("produces well-formed Track", () => {
    const t = buildSlskTrackEntity({
      username: "user",
      filepath: "music/a.mp3",
      size: 1024,
      filename: "a.mp3",
      artist: "A",
      cover: { slsk_username: "u", slsk_filepath: "c.jpg" },
      albumTitle: "A",
    });
    expect(t?.id).toBe("slsk:track:user|music/a.mp3");
    expect(t?.sources?.[0]?.kind).toBe("soulseek");
    expect(t?.sources?.[0]?.raw?.cover?.slsk_username).toBe("u");
  });
  it("null when missing username or filepath", () => {
    expect(buildSlskTrackEntity({ username: "", filepath: "x", filename: "n", size: 0, artist: null, cover: null, albumTitle: "" })).toBeNull();
    expect(buildSlskTrackEntity({ username: "u", filepath: "", filename: "n", size: 0, artist: null, cover: null, albumTitle: "" })).toBeNull();
  });
});

describe("registerAndGetId", () => {
  it("returns null for null entity", () => {
    expect(registerAndGetId(null)).toBeNull();
  });
  it("registers and returns id", () => {
    const t = buildSlskTrackEntity({ username: "u", filepath: "f.mp3", filename: "f.mp3", size: 0, artist: null, cover: null, albumTitle: "" });
    const id = registerAndGetId(t);
    expect(id).toBe(t?.id);
    expect(getEntity(id!)).not.toBeNull();
  });
});
