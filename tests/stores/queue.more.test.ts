import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  queueIds, queuePos, nowPlayingTrack, nextTrack, secondNextTrack,
  hasPrev, hasNext, replaceQueue, enqueueTrack, enqueueTracks, playTrackNow,
  removeAt, moveItem, clear, jumpTo, next, prev, setRepeat,
  toggleShuffle, shuffleOn, repeatMode, seedQueueFromSnapshot,
} from "../../src/stores/queue.js";
import { clearEntities, registerEntity } from "../../src/stores/entities.js";
import { buildTrack } from "../../src/track/factory.js";

function track(id: string) {
  return buildTrack({
    type: "track", id, title: id, artist: null, albumId: null, albumTitle: null,
    fileName: `${id}.mp3`, format: null, bitrate: null, duration: null, size: 1,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  });
}

beforeEach(() => {
  fakeLocalStorage.clear();
  clearEntities();
  seedQueueFromSnapshot({ trackIds: [], pos: 0 });
  setRepeat("off");
  if (shuffleOn.value) toggleShuffle();
});

describe("queue — mutators", () => {
  it("replaceQueue sets ids and pos", () => {
    replaceQueue([track("a"), track("b"), track("c")], 1);
    expect(queueIds.value).toEqual(["a", "b", "c"]);
    expect(queuePos.value).toBe(1);
    expect(nowPlayingTrack.value?.id).toBe("b");
  });
  it("replaceQueue clamps pos to bounds", () => {
    replaceQueue([track("a"), track("b")], 99);
    expect(queuePos.value).toBe(1);
    replaceQueue([track("a")], -5);
    expect(queuePos.value).toBe(0);
  });
  it("playTrackNow = replaceQueue([t], 0)", () => {
    playTrackNow(track("a"));
    expect(queueIds.value).toEqual(["a"]);
    expect(queuePos.value).toBe(0);
  });
  it("enqueueTrack appends", () => {
    replaceQueue([track("a")], 0);
    enqueueTrack(track("b"));
    expect(queueIds.value).toEqual(["a", "b"]);
  });
  it("enqueueTracks empty noop", () => {
    enqueueTracks([]);
    expect(queueIds.value).toEqual([]);
  });
  it("removeAt below pos shifts pos", () => {
    replaceQueue([track("a"), track("b"), track("c")], 2);
    removeAt(0);
    expect(queueIds.value).toEqual(["b", "c"]);
    expect(queuePos.value).toBe(1);
  });
  it("removeAt at pos clamps pos", () => {
    replaceQueue([track("a"), track("b")], 1);
    removeAt(1);
    expect(queueIds.value).toEqual(["a"]);
    expect(queuePos.value).toBe(0);
  });
  it("removeAt out of range no-op", () => {
    replaceQueue([track("a")], 0);
    removeAt(99);
    expect(queueIds.value).toEqual(["a"]);
  });
  it("moveItem reorders", () => {
    replaceQueue([track("a"), track("b"), track("c")], 0);
    moveItem(0, 2);
    expect(queueIds.value).toEqual(["b", "c", "a"]);
  });
  it("moveItem out of range no-op", () => {
    replaceQueue([track("a")], 0);
    moveItem(5, 0);
    expect(queueIds.value).toEqual(["a"]);
  });
  it("clear empties", () => {
    replaceQueue([track("a"), track("b")], 1);
    clear();
    expect(queueIds.value).toEqual([]);
    expect(queuePos.value).toBe(0);
  });
  it("jumpTo valid index", () => {
    replaceQueue([track("a"), track("b")], 0);
    jumpTo(1);
    expect(queuePos.value).toBe(1);
  });
  it("jumpTo out of range no-op", () => {
    replaceQueue([track("a")], 0);
    jumpTo(99);
    expect(queuePos.value).toBe(0);
  });
});

describe("queue — navigation with repeat", () => {
  it("next advances within queue", () => {
    replaceQueue([track("a"), track("b"), track("c")], 0);
    next();
    expect(queuePos.value).toBe(1);
  });
  it("next at end stays when repeat=off", () => {
    replaceQueue([track("a"), track("b")], 1);
    next();
    expect(queuePos.value).toBe(1);
  });
  it("next wraps when repeat=all", () => {
    replaceQueue([track("a"), track("b")], 1);
    setRepeat("all");
    next();
    expect(queuePos.value).toBe(0);
  });
  it("prev goes back; at 0 stays when repeat=off", () => {
    replaceQueue([track("a"), track("b")], 1);
    prev();
    expect(queuePos.value).toBe(0);
    prev();
    expect(queuePos.value).toBe(0);
  });
  it("prev wraps at 0 when repeat=all", () => {
    replaceQueue([track("a"), track("b")], 0);
    setRepeat("all");
    prev();
    expect(queuePos.value).toBe(1);
  });
  it("hasPrev / hasNext flags", () => {
    replaceQueue([track("a"), track("b")], 0);
    expect(hasPrev.value).toBe(false);
    expect(hasNext.value).toBe(true);
    setRepeat("all");
    expect(hasPrev.value).toBe(true);
  });
});

describe("queue — nextTrack + secondNextTrack", () => {
  it("nextTrack follows queue", () => {
    replaceQueue([track("a"), track("b")], 0);
    expect(nextTrack.value?.id).toBe("b");
  });
  it("secondNextTrack wraps with repeat=all", () => {
    replaceQueue([track("a"), track("b")], 0);
    expect(secondNextTrack.value).toBeNull(); // only 2 items
    setRepeat("all");
    expect(secondNextTrack.value?.id).toBe("a"); // wraps to index 0 through "all" repeat
  });
});

describe("queue — shuffle", () => {
  it("toggleShuffle flips ref + persists", () => {
    expect(shuffleOn.value).toBe(false);
    toggleShuffle();
    expect(shuffleOn.value).toBe(true);
    toggleShuffle();
    expect(shuffleOn.value).toBe(false);
  });
});

describe("queue — repeat persistence", () => {
  it("setRepeat writes to localStorage", () => {
    setRepeat("one");
    expect(repeatMode.value).toBe("one");
    expect(fakeLocalStorage.get("neegde.player.repeatMode")).toBe("one");
  });
});

describe("queue — seed from snapshot", () => {
  beforeEach(() => {
    // Need track "a" in entity registry so hydrateTrack has a shot too.
    registerEntity(track("a"));
  });
  it("seedQueueFromSnapshot hydrates ids + clamps pos", () => {
    seedQueueFromSnapshot({ trackIds: ["a"], pos: 0 });
    expect(queueIds.value).toEqual(["a"]);
    expect(nowPlayingTrack.value?.id).toBe("a");
  });
});
