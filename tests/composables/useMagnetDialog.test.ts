import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { ref } from "vue";

const { magnetListFilesMock, torrentPrepareCancelMock } = vi.hoisted(() => ({
  magnetListFilesMock: vi.fn(),
  torrentPrepareCancelMock: vi.fn(),
}));
vi.mock("../../src/torrent/api.js", async (orig) => {
  const actual = await orig<typeof import("../../src/torrent/api.js")>();
  return { ...actual, magnetListFiles: magnetListFilesMock };
});
vi.mock("../../src/torrent/torrentSession.js", () => ({
  torrentPrepareCancel: torrentPrepareCancelMock,
}));

import { useMagnetDialog } from "../../src/composables/useMagnetDialog.js";

function setupCtx() {
  return {
    selected: ref<object | null>(null),
    files: ref<unknown[]>([]),
    torrentMagnet: ref(""),
    torrentCover: ref<string | null>(null),
    torrentFilesBeforeAlbumPreview: ref<unknown[] | null>(null),
    torrentSelectedBeforeAlbumPreview: ref<object | null>(null),
    loadingFiles: ref(false),
    view: ref("home"),
    error: ref<string | null>(null),
    forwardStack: ref<unknown[]>([]),
    backStack: ref<unknown[]>([]),
    snapshotTorrentForBack: () => ({ type: "torrent" }),
    snapshotSearchForBack: () => ({ type: "search" }),
    mainRef: ref<HTMLElement | null>(null),
  };
}

beforeEach(() => {
  magnetListFilesMock.mockReset();
  torrentPrepareCancelMock.mockReset();
});

describe("useMagnetDialog — submit errors", () => {
  it("empty draft → error about scheme", async () => {
    const ctx = setupCtx();
    const api = useMagnetDialog(ctx);
    api.magnetDraft.value = "not a magnet";
    await api.submitMagnetLink();
    expect(api.magnetError.value).toMatch(/magnet:\?/);
  });

  it("missing btih → explicit error", async () => {
    const ctx = setupCtx();
    const api = useMagnetDialog(ctx);
    api.magnetDraft.value = "magnet:?xt=urn:ed2k:xxx";
    await api.submitMagnetLink();
    expect(api.magnetError.value).toMatch(/info hash/i);
  });

  it("unparseable btih → hash error", async () => {
    const ctx = setupCtx();
    const api = useMagnetDialog(ctx);
    api.magnetDraft.value = "magnet:?xt=urn:btih:notvalid";
    await api.submitMagnetLink();
    expect(api.magnetError.value).toMatch(/hash/i);
  });
});

describe("useMagnetDialog — happy path", () => {
  it("sets synthetic selected + files on success", async () => {
    const ctx = setupCtx();
    const api = useMagnetDialog(ctx);
    const magnet = "magnet:?xt=urn:btih:" + "a".repeat(40);
    api.magnetDraft.value = magnet;
    magnetListFilesMock.mockResolvedValueOnce([
      { path: ["A", "01.mp3"], size: 1000 },
    ]);
    await api.submitMagnetLink();
    expect(ctx.selected.value).toMatchObject({ source: "magnet" });
    expect(ctx.files.value).toHaveLength(1);
    expect(ctx.torrentMagnet.value).toContain("btih");
    expect(api.magnetPanelOpen.value).toBe(false);
    expect(api.magnetDraft.value).toBe("");
  });

  it("rolls back on magnetListFiles error", async () => {
    const ctx = setupCtx();
    const api = useMagnetDialog(ctx);
    api.magnetDraft.value = "magnet:?xt=urn:btih:" + "b".repeat(40);
    magnetListFilesMock.mockRejectedValueOnce(new Error("DHT gone"));
    await api.submitMagnetLink();
    expect(ctx.selected.value).toBeNull();
    expect(api.magnetError.value).toMatch(/DHT gone/);
  });

  it("clicking same btih again closes and clears", async () => {
    const ctx = setupCtx();
    const api = useMagnetDialog(ctx);
    const btih = "c".repeat(40);
    ctx.selected.value = { id: `magnet-${btih}` };
    api.magnetDraft.value = `magnet:?xt=urn:btih:${btih}`;
    await api.submitMagnetLink();
    expect(ctx.selected.value).toBeNull();
    expect(api.magnetPanelOpen.value).toBe(false);
  });
});

describe("useMagnetDialog — close", () => {
  it("cancels in-flight loading + pops back snapshot when still loading magnet", () => {
    const ctx = setupCtx();
    ctx.selected.value = { source: "magnet" };
    ctx.loadingFiles.value = true;
    ctx.backStack.value = [{ type: "search" }];
    const api = useMagnetDialog(ctx);
    api.magnetPanelOpen.value = true;
    api.closeMagnetPanel();
    expect(torrentPrepareCancelMock).toHaveBeenCalled();
    expect(ctx.selected.value).toBeNull();
    expect(ctx.backStack.value).toEqual([]);
    expect(api.magnetPanelOpen.value).toBe(false);
  });
  it("close without loading just closes panel", () => {
    const ctx = setupCtx();
    const api = useMagnetDialog(ctx);
    api.magnetPanelOpen.value = true;
    api.magnetError.value = "prev";
    api.closeMagnetPanel();
    expect(api.magnetPanelOpen.value).toBe(false);
    expect(api.magnetError.value).toBeNull();
    expect(torrentPrepareCancelMock).not.toHaveBeenCalled();
  });
});
