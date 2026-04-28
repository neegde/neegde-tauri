import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import { PlaybackQueue } from "../../src/stores/queue.js";
import { clearEntities } from "../../src/stores/entities.js";
import { clearTrackCache } from "../../src/persistence/trackCache.js";
import { buildTrack } from "../../src/track/factory.js";
import type { TrackData } from "../../src/track/types.js";

function slsk(id: string): TrackData {
  return {
    type: "track", id, title: id, artist: null, albumTitle: null, albumId: null,
    fileName: `${id}.mp3`, format: null, bitrate: null, duration: null, size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  };
}

function mkQueue() {
  const persist = vi.fn();
  return { q: new PlaybackQueue(persist), persist };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
  clearEntities();
});

describe("PlaybackQueue — replace / enqueue / playTrackNow", () => {
  it("replace seeds ids and pos, then persists a snapshot", () => {
    const { q, persist } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    expect(q.ids.value).toEqual(["a", "b"]);
    expect(q.pos.value).toBe(1);
    expect(q.nowPlaying.value?.id).toBe("b");
    expect(persist).toHaveBeenCalledWith({ trackIds: ["a", "b"], pos: 1 });
  });

  it("replace clamps startIndex into range", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 99);
    expect(q.pos.value).toBe(1);
    q.replace([buildTrack(slsk("a"))], -4);
    expect(q.pos.value).toBe(0);
  });

  it("enqueueTrack appends a single track", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a"))], 0);
    q.enqueueTrack(buildTrack(slsk("b")));
    expect(q.ids.value).toEqual(["a", "b"]);
    // pos unchanged on append
    expect(q.pos.value).toBe(0);
  });

  it("enqueueTrack ignores null/zero-id", () => {
    const { q } = mkQueue();
    q.enqueueTrack(null as unknown as ReturnType<typeof buildTrack>);
    expect(q.ids.value).toEqual([]);
  });

  it("enqueueTracks appends a batch", () => {
    const { q } = mkQueue();
    q.enqueueTracks([buildTrack(slsk("a")), buildTrack(slsk("b"))]);
    q.enqueueTracks([buildTrack(slsk("c"))]);
    expect(q.ids.value).toEqual(["a", "b", "c"]);
  });

  it("enqueueTracks is a noop for empty array", () => {
    const { q, persist } = mkQueue();
    q.enqueueTracks([]);
    expect(q.ids.value).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });

  it("playTrackNow replaces + resets pos to 0", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    q.playTrackNow(buildTrack(slsk("c")));
    expect(q.ids.value).toEqual(["c"]);
    expect(q.pos.value).toBe(0);
  });
});

describe("PlaybackQueue — removeAt", () => {
  it("ignores out-of-range indices", () => {
    const { q, persist } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 0);
    persist.mockClear();
    q.removeAt(-1);
    q.removeAt(99);
    expect(q.ids.value).toEqual(["a", "b"]);
    expect(persist).not.toHaveBeenCalled();
  });

  it("shifts pos down when removing before current", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 2);
    q.removeAt(0);
    expect(q.ids.value).toEqual(["b", "c"]);
    expect(q.pos.value).toBe(1);
  });

  it("keeps pos when removing after current", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 0);
    q.removeAt(2);
    expect(q.pos.value).toBe(0);
  });

  it("clamps pos to new end when removing the current item at tail", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    q.removeAt(1);
    expect(q.ids.value).toEqual(["a"]);
    expect(q.pos.value).toBe(0);
  });

  it("empties pos to 0 when removing the only item", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a"))], 0);
    q.removeAt(0);
    expect(q.ids.value).toEqual([]);
    expect(q.pos.value).toBe(0);
  });
});

describe("PlaybackQueue — moveItem", () => {
  it("ignores noop and out-of-range moves", () => {
    const { q, persist } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 0);
    persist.mockClear();
    q.moveItem(0, 0);
    q.moveItem(-1, 1);
    q.moveItem(0, 99);
    expect(q.ids.value).toEqual(["a", "b"]);
    expect(persist).not.toHaveBeenCalled();
  });

  it("moving the currently-playing item drags pos with it", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 0);
    q.moveItem(0, 2);
    expect(q.ids.value).toEqual(["b", "c", "a"]);
    expect(q.pos.value).toBe(2);
  });

  it("moving before-to-after shifts pos left", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 1);
    q.moveItem(0, 2); // a moves past b → [b, c, a], pos b → 0
    expect(q.ids.value).toEqual(["b", "c", "a"]);
    expect(q.pos.value).toBe(0);
  });

  it("moving after-to-before shifts pos right", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 1);
    q.moveItem(2, 0); // c jumps in front of b → [c, a, b], pos b → 2
    expect(q.ids.value).toEqual(["c", "a", "b"]);
    expect(q.pos.value).toBe(2);
  });
});

describe("PlaybackQueue — navigation", () => {
  it("advance walks to end and stops (repeat=off)", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 0);
    q.advance();
    expect(q.pos.value).toBe(1);
    q.advance();
    expect(q.pos.value).toBe(1); // stops
  });

  it("advance wraps when repeat=all", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    q.setRepeat("all");
    q.advance();
    expect(q.pos.value).toBe(0);
  });

  it("advance is noop on empty queue", () => {
    const { q, persist } = mkQueue();
    persist.mockClear();
    q.advance();
    expect(q.pos.value).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it("rewind walks to start and stops (repeat=off)", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    q.rewind();
    expect(q.pos.value).toBe(0);
    q.rewind();
    expect(q.pos.value).toBe(0);
  });

  it("rewind wraps to end when repeat=all", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 0);
    q.setRepeat("all");
    q.rewind();
    expect(q.pos.value).toBe(1);
  });

  it("rewind is noop on empty queue", () => {
    const { q } = mkQueue();
    q.rewind();
    expect(q.pos.value).toBe(0);
  });

  it("jumpTo moves pos and persists; ignores out-of-range", () => {
    const { q, persist } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 0);
    persist.mockClear();
    q.jumpTo(1);
    expect(q.pos.value).toBe(1);
    expect(persist).toHaveBeenCalled();
    persist.mockClear();
    q.jumpTo(5);
    expect(q.pos.value).toBe(1);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("PlaybackQueue — computed next/secondNext/hasPrev/hasNext", () => {
  it("nextTrack respects repeat=all at end", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    expect(q.next.value).toBe(null);
    q.setRepeat("all");
    expect(q.next.value?.id).toBe("a");
  });

  it("secondNext wraps correctly for all the pos/len/repeat combos", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 0);
    // pos=0, len=3 → secondNext = ids[2] = c
    expect(q.secondNext.value?.id).toBe("c");
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 1);
    // pos=1, len=3 → pos === len-2 → no secondNext without wrap
    expect(q.secondNext.value).toBe(null);
    q.setRepeat("all");
    // pos=1, len=3, repeat=all → ids[0]
    expect(q.secondNext.value?.id).toBe("a");
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 2);
    q.setRepeat("all");
    // pos=2, len=3, repeat=all → len>2 → ids[1]
    expect(q.secondNext.value?.id).toBe("b");
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    q.setRepeat("all");
    // pos=1, len=2 → repeat=all && len === 2 → ids[0]
    expect(q.secondNext.value?.id).toBe("a");
  });

  it("secondNext is null for queue < 2", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a"))], 0);
    expect(q.secondNext.value).toBe(null);
  });

  it("hasPrev/hasNext at boundaries + repeat=all", () => {
    const { q } = mkQueue();
    expect(q.hasPrev.value).toBe(false);
    expect(q.hasNext.value).toBe(false);
    q.replace([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 0);
    expect(q.hasPrev.value).toBe(false);
    expect(q.hasNext.value).toBe(true);
    q.jumpTo(2);
    expect(q.hasPrev.value).toBe(true);
    expect(q.hasNext.value).toBe(false);
    q.setRepeat("all");
    expect(q.hasNext.value).toBe(true);
    q.jumpTo(0);
    expect(q.hasPrev.value).toBe(true); // len>1 + repeat=all
  });
});

describe("PlaybackQueue — repeat + shuffle persistence", () => {
  it("setRepeat writes to localStorage", () => {
    const { q } = mkQueue();
    q.setRepeat("all");
    expect(fakeLocalStorage.get("neegde.player.repeatMode")).toBe("all");
    q.setRepeat("one");
    expect(fakeLocalStorage.get("neegde.player.repeatMode")).toBe("one");
  });

  it("toggleShuffle flips state and writes", () => {
    const { q } = mkQueue();
    expect(q.shuffleOn.value).toBe(false);
    q.toggleShuffle();
    expect(q.shuffleOn.value).toBe(true);
    expect(fakeLocalStorage.get("neegde.player.shuffle")).toBe("1");
    q.toggleShuffle();
    expect(fakeLocalStorage.get("neegde.player.shuffle")).toBe("0");
  });
});

describe("PlaybackQueue — clear + snapshot + seed", () => {
  it("clear empties state and persists", () => {
    const { q, persist } = mkQueue();
    q.replace([buildTrack(slsk("a"))], 0);
    persist.mockClear();
    q.clear();
    expect(q.ids.value).toEqual([]);
    expect(q.pos.value).toBe(0);
    expect(persist).toHaveBeenCalledWith({ trackIds: [], pos: 0 });
  });

  it("snapshot returns a copy (not the live ref)", () => {
    const { q } = mkQueue();
    q.replace([buildTrack(slsk("a"))], 0);
    const snap = q.snapshot();
    expect(snap).toEqual({ trackIds: ["a"], pos: 0 });
    snap.trackIds.push("x");
    expect(q.ids.value).toEqual(["a"]);
  });

  it("seedFromSnapshot clamps pos to actual length", () => {
    const { q } = mkQueue();
    q.seedFromSnapshot({ trackIds: ["a", "b"], pos: 99 });
    expect(q.pos.value).toBe(1);
    q.seedFromSnapshot({ trackIds: [], pos: 42 });
    expect(q.pos.value).toBe(0);
  });
});
