import { describe, it, expect, beforeEach } from "vitest";
import { fakeLocalStorage } from "../_setup.js";

import {
  queueIds,
  queuePos,
  nowPlayingTrack,
  nextTrack,
  hasPrev,
  hasNext,
  replaceQueue,
  enqueueTrack,
  removeAt,
  clear as clearQueue,
  repeatMode,
  setRepeat,
  seedQueueFromSnapshot,
} from "../../src/stores/queue.js";
import { clearEntities, registerEntity } from "../../src/stores/entities.js";
import { clearTrackCache } from "../../src/persistence/trackCache.js";
import { loadQueueSnapshot } from "../../src/persistence/queue.js";
import { buildTrack } from "../../src/track/factory.js";
import type { TrackData } from "../../src/track/types.js";

function slsk(id: string): TrackData {
  return {
    type: "track", id, title: id, artist: null, albumTitle: null, albumId: null,
    fileName: `${id}.mp3`, format: null, bitrate: null, duration: null, size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  };
}

beforeEach(() => {
  fakeLocalStorage.clear();
  clearTrackCache();
  clearEntities();
  queueIds.value = [];
  queuePos.value = 0;
  repeatMode.value = "off";
});

describe("queue store", () => {
  it("replaceQueue + nowPlayingTrack", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    expect(queueIds.value).toEqual(["a", "b"]);
    expect(queuePos.value).toBe(1);
    expect(nowPlayingTrack.value?.id).toBe("b");
  });

  it("nextTrack respects repeat=all at end", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    expect(nextTrack.value).toBe(null);
    setRepeat("all");
    expect(nextTrack.value?.id).toBe("a");
  });

  it("hasPrev / hasNext at boundaries", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 1);
    expect(hasPrev.value).toBe(true);
    expect(hasNext.value).toBe(true);
    queuePos.value = 2;
    expect(hasNext.value).toBe(false);
  });

  it("removeAt before current shifts pos down", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b")), buildTrack(slsk("c"))], 1);
    removeAt(0);
    expect(queueIds.value).toEqual(["b", "c"]);
    expect(queuePos.value).toBe(0);
  });

  it("removeAt current clamps pos to last", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    removeAt(1);
    expect(queueIds.value).toEqual(["a"]);
    expect(queuePos.value).toBe(0);
  });

  it("enqueueTrack appends", () => {
    replaceQueue([buildTrack(slsk("a"))], 0);
    enqueueTrack(buildTrack(slsk("b")));
    expect(queueIds.value).toEqual(["a", "b"]);
  });

  it("clear wipes queue", () => {
    replaceQueue([buildTrack(slsk("a"))], 0);
    clearQueue();
    expect(queueIds.value).toEqual([]);
    expect(queuePos.value).toBe(0);
  });

  it("persists across restart via snapshot", () => {
    replaceQueue([buildTrack(slsk("a")), buildTrack(slsk("b"))], 1);
    const snap = loadQueueSnapshot();
    expect(snap.trackIds).toEqual(["a", "b"]);
    expect(snap.pos).toBe(1);
  });

  it("seedQueueFromSnapshot clamps out-of-range pos", () => {
    seedQueueFromSnapshot({ trackIds: ["a", "b"], pos: 99 });
    expect(queuePos.value).toBe(1);
  });

  it("nowPlayingTrack hydrates from trackCache when registry lacks the id", () => {
    const data = slsk("cached");
    registerEntity(data);
    clearEntities();
    seedQueueFromSnapshot({ trackIds: ["cached"], pos: 0 });
    expect(nowPlayingTrack.value?.id).toBe("cached");
  });
});
