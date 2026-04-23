import { describe, it, expect, vi } from "vitest";
import "../_setup.js";
import { ref } from "vue";
import { useQueueContextMenu } from "../../src/composables/useQueueContextMenu.js";
import type { Track } from "../../src/track/Track.js";

function track(id: string, playable = true): Track {
  return {
    id,
    hasPlaybackIdentity: () => playable,
  } as unknown as Track;
}

describe("useQueueContextMenu", () => {
  it("opens with coords + index", () => {
    const q = ref<Track[]>([track("a")]);
    const { openQueueCtx, queueCtxOpen, queueCtxX, queueCtxY } = useQueueContextMenu({
      playbackQueue: q, onDownload: vi.fn(), onAddToPlaylist: vi.fn(),
    });
    const e = { preventDefault: vi.fn(), clientX: 10, clientY: 20 } as unknown as MouseEvent;
    openQueueCtx(e, 0);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(queueCtxOpen.value).toBe(true);
    expect(queueCtxX.value).toBe(10);
    expect(queueCtxY.value).toBe(20);
  });

  it("actions: download enabled when hasPlaybackIdentity", () => {
    const q = ref<Track[]>([track("a", true)]);
    const { openQueueCtx, queueCtxActions } = useQueueContextMenu({
      playbackQueue: q, onDownload: vi.fn(), onAddToPlaylist: vi.fn(),
    });
    openQueueCtx({ preventDefault: vi.fn(), clientX: 0, clientY: 0 } as unknown as MouseEvent, 0);
    const dl = queueCtxActions.value.find((a) => a.id === "download");
    expect(dl?.disabled).toBe(false);
  });

  it("actions: download disabled when not playable", () => {
    const q = ref<Track[]>([track("a", false)]);
    const { openQueueCtx, queueCtxActions } = useQueueContextMenu({
      playbackQueue: q, onDownload: vi.fn(), onAddToPlaylist: vi.fn(),
    });
    openQueueCtx({ preventDefault: vi.fn(), clientX: 0, clientY: 0 } as unknown as MouseEvent, 0);
    expect(queueCtxActions.value.find((a) => a.id === "download")?.disabled).toBe(true);
  });

  it("actions list is empty-ish before opening (idx null → track null)", () => {
    const q = ref<Track[]>([]);
    const { queueCtxActions } = useQueueContextMenu({
      playbackQueue: q, onDownload: vi.fn(), onAddToPlaylist: vi.fn(),
    });
    // download disabled, playlist entry still present
    const ids = queueCtxActions.value.map((a) => a.id);
    expect(ids).toEqual(["download", "divider", "playlist"]);
  });

  it("onQueueCtxAction 'playlist' delegates", () => {
    const q = ref<Track[]>([track("a")]);
    const onAddToPlaylist = vi.fn();
    const { openQueueCtx, onQueueCtxAction } = useQueueContextMenu({
      playbackQueue: q, onDownload: vi.fn(), onAddToPlaylist,
    });
    openQueueCtx({ preventDefault: vi.fn(), clientX: 0, clientY: 0 } as unknown as MouseEvent, 0);
    onQueueCtxAction("playlist");
    expect(onAddToPlaylist).toHaveBeenCalledWith(q.value[0]);
  });

  it("onQueueCtxAction 'download' skipped when not playable", () => {
    const q = ref<Track[]>([track("a", false)]);
    const onDownload = vi.fn();
    const { openQueueCtx, onQueueCtxAction } = useQueueContextMenu({
      playbackQueue: q, onDownload, onAddToPlaylist: vi.fn(),
    });
    openQueueCtx({ preventDefault: vi.fn(), clientX: 0, clientY: 0 } as unknown as MouseEvent, 0);
    onQueueCtxAction("download");
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("onQueueCtxAction 'download' delegates when playable", () => {
    const q = ref<Track[]>([track("a")]);
    const onDownload = vi.fn();
    const { openQueueCtx, onQueueCtxAction } = useQueueContextMenu({
      playbackQueue: q, onDownload, onAddToPlaylist: vi.fn(),
    });
    openQueueCtx({ preventDefault: vi.fn(), clientX: 0, clientY: 0 } as unknown as MouseEvent, 0);
    onQueueCtxAction("download");
    expect(onDownload).toHaveBeenCalledWith(q.value[0]);
  });

  it("no-op when index is null / stale / out of bounds", () => {
    const q = ref<Track[]>([]);
    const onDownload = vi.fn();
    const onAddToPlaylist = vi.fn();
    const { onQueueCtxAction } = useQueueContextMenu({
      playbackQueue: q, onDownload, onAddToPlaylist,
    });
    onQueueCtxAction("download");
    onQueueCtxAction("playlist");
    expect(onDownload).not.toHaveBeenCalled();
    expect(onAddToPlaylist).not.toHaveBeenCalled();
  });
});
