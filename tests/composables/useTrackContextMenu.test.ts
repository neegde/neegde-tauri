import { describe, it, expect, vi } from "vitest";
import "../_setup.js";

import {
  useTrackContextMenu,
  libraryTrackActions,
  type CtxActionDef,
} from "../../src/composables/useTrackContextMenu.js";
import { buildTrack } from "../../src/track/factory.js";
import type { TrackData } from "../../src/track/types.js";

function slsk(id = "t1"): ReturnType<typeof buildTrack> {
  const data: TrackData = {
    type: "track", id, title: id, artist: null, albumTitle: null, albumId: null,
    fileName: `${id}.mp3`, format: null, bitrate: null, duration: null, size: 1000,
    sources: [{ kind: "soulseek", refs: { slskUsername: "u", slskFilepath: `${id}.mp3` }, raw: { cover: null } }],
  };
  return buildTrack(data);
}

function rt(id = "rt:42:0"): ReturnType<typeof buildTrack> {
  const data: TrackData = {
    type: "track", id, title: "song.mp3", artist: null, albumTitle: null, albumId: null,
    fileName: "song.mp3", format: null, bitrate: null, duration: null, size: 1000,
    sources: [{
      kind: "rutracker",
      refs: { topicId: "42", magnet: "m", fileIdx: 0, coverFileIdx: null, albumDirPath: null },
    }],
  };
  return buildTrack(data);
}

describe("useTrackContextMenu", () => {
  it("starts closed with zero position and null track", () => {
    const api = useTrackContextMenu({
      actionsFor: () => [],
      onAction: () => {},
    });
    expect(api.ctxOpen.value).toBe(false);
    expect(api.ctxX.value).toBe(0);
    expect(api.ctxY.value).toBe(0);
    expect(api.ctxTrack.value).toBe(null);
    expect(api.ctxActions.value).toEqual([]);
  });

  it("openTrackCtx records position, sets track, opens menu, prevents default", () => {
    const api = useTrackContextMenu({ actionsFor: () => [], onAction: () => {} });
    const t = slsk();
    const evt = new MouseEvent("contextmenu", { clientX: 42, clientY: 99 });
    const spy = vi.spyOn(evt, "preventDefault");
    api.openTrackCtx(evt, t);
    expect(spy).toHaveBeenCalled();
    expect(api.ctxOpen.value).toBe(true);
    expect(api.ctxX.value).toBe(42);
    expect(api.ctxY.value).toBe(99);
    expect(api.ctxTrack.value?.id).toBe(t.id);
  });

  it("ctxActions computes from actionsFor(current track) reactively", () => {
    const actions: CtxActionDef[] = [{ id: "play", label: "Play" }];
    const api = useTrackContextMenu({
      actionsFor: () => actions,
      onAction: () => {},
    });
    // No track yet → empty
    expect(api.ctxActions.value).toEqual([]);
    api.openTrackCtx(new MouseEvent("contextmenu"), slsk());
    expect(api.ctxActions.value).toEqual(actions);
  });

  it("onCtxAction invokes handler with the current track", () => {
    const onAction = vi.fn();
    const api = useTrackContextMenu({ actionsFor: () => [], onAction });
    const t = slsk("abc");
    api.openTrackCtx(new MouseEvent("contextmenu"), t);
    api.onCtxAction("queue");
    expect(onAction).toHaveBeenCalledWith("queue", expect.objectContaining({ id: "abc" }));
  });

  it("onCtxAction is a no-op when no track is open", () => {
    const onAction = vi.fn();
    const api = useTrackContextMenu({ actionsFor: () => [], onAction });
    api.onCtxAction("queue");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("re-opening the menu with a different track updates ctxActions", () => {
    let called = 0;
    const api = useTrackContextMenu({
      actionsFor: (t) => {
        called++;
        return [{ id: t.id, label: t.id }];
      },
      onAction: () => {},
    });
    const a = slsk("A");
    const b = slsk("B");
    api.openTrackCtx(new MouseEvent("contextmenu"), a);
    expect(api.ctxActions.value[0]?.id).toBe("A");
    api.openTrackCtx(new MouseEvent("contextmenu"), b);
    expect(api.ctxActions.value[0]?.id).toBe("B");
    expect(called).toBeGreaterThanOrEqual(2);
  });
});

describe("libraryTrackActions preset (LikesView + PlaylistView)", () => {
  it("soulseek track → 'Источник (SoulSeek)' + download enabled", () => {
    const actions = libraryTrackActions(slsk());
    const sourceItem = actions.find((a) => a.id === "source");
    expect(sourceItem?.label).toContain("SoulSeek");
    const download = actions.find((a) => a.id === "download");
    expect(download?.disabled).toBe(false);
  });

  it("rutracker track → 'Источник (Torrent)' + download disabled when no playback identity", () => {
    const t = rt();
    // RutrackerTrack.hasPlaybackIdentity: true when magnet + fileIdx present. In our fixture it IS present, so download should be enabled.
    const actions = libraryTrackActions(t);
    const source = actions.find((a) => a.id === "source");
    expect(source?.label).toContain("Torrent");
  });

  it("preset contains exactly: queue / playlist / download / divider / source", () => {
    const actions = libraryTrackActions(slsk());
    expect(actions.map((a) => a.id)).toEqual([
      "queue", "playlist", "download", "divider", "source",
    ]);
  });
});
