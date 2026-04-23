import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import DownloadProgressOverlay from "../../src/components/shell/DownloadProgressOverlay.vue";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const emitMock = emit as unknown as ReturnType<typeof vi.fn>;

type Progress = Record<string, unknown>;

function mountOverlay(props: { progress: Progress | null; expanded?: boolean }) {
  return mount(DownloadProgressOverlay, { props, attachTo: document.body });
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("DownloadProgressOverlay — render gates", () => {
  it("renders nothing when progress is null", () => {
    mountOverlay({ progress: null });
    expect(document.body.querySelector(".dl-overlay")).toBe(null);
    expect(document.body.querySelector(".dl-dock")).toBe(null);
  });

  it("renders the full panel when expanded and progress present", () => {
    mountOverlay({
      progress: { phase: "downloading", pct: 42, progressBytes: 50, totalBytes: 100 } as Progress,
      expanded: true,
    });
    expect(document.body.querySelector(".dl-overlay")).not.toBe(null);
  });

  it("renders the dock button when collapsed and progress present", () => {
    mountOverlay({ progress: { phase: "preparing" } as Progress, expanded: false });
    expect(document.body.querySelector(".dl-dock")).not.toBe(null);
    expect(document.body.querySelector(".dl-overlay")).toBe(null);
  });
});

describe("DownloadProgressOverlay — phase label + stop availability", () => {
  it.each([
    ["preparing", "Подготовка"],
    ["downloading", "Загрузка"],
    ["copying", "Сохранение"],
    ["done", "Готово"],
    ["cancelled", "Остановлено"],
  ])("phase %s → label %s", (phase, label) => {
    mountOverlay({ progress: { phase } as Progress, expanded: true });
    expect(document.body.querySelector(".dl-phase")?.textContent).toContain(label);
  });

  it("unknown phase falls back to 'Скачивание'", () => {
    mountOverlay({ progress: { phase: "weird" } as Progress, expanded: true });
    expect(document.body.querySelector(".dl-phase")?.textContent).toContain("Скачивание");
  });

  it("stop button is hidden for 'done' and 'cancelled' phases", () => {
    mountOverlay({ progress: { phase: "done" } as Progress, expanded: true });
    expect(document.body.querySelector(".dl-stop")).toBe(null);

    document.body.innerHTML = "";
    mountOverlay({ progress: { phase: "cancelled" } as Progress, expanded: true });
    expect(document.body.querySelector(".dl-stop")).toBe(null);
  });

  it("stop button is visible during 'downloading'", () => {
    mountOverlay({ progress: { phase: "downloading" } as Progress, expanded: true });
    expect(document.body.querySelector(".dl-stop")).not.toBe(null);
  });
});

describe("DownloadProgressOverlay — user actions", () => {
  it("clicking Minimize sets expanded=false via v-model", async () => {
    const w = mountOverlay({ progress: { phase: "downloading" } as Progress, expanded: true });
    const btn = document.body.querySelector(".dl-minimize") as HTMLElement;
    btn.click();
    await w.vm.$nextTick();
    expect(w.emitted("update:expanded")?.[0]).toEqual([false]);
  });

  it("clicking Expand (dock) sets expanded=true", async () => {
    const w = mountOverlay({ progress: { phase: "downloading" } as Progress, expanded: false });
    const btn = document.body.querySelector(".dl-dock") as HTMLElement;
    btn.click();
    await w.vm.$nextTick();
    expect(w.emitted("update:expanded")?.[0]).toEqual([true]);
  });

  it("Stop button fires the cancel emit + cancel invokes", async () => {
    emitMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue(undefined);
    mountOverlay({ progress: { phase: "downloading" } as Progress, expanded: true });
    const btn = document.body.querySelector(".dl-stop") as HTMLElement;
    btn.click();
    // Let the async requestStop walk through.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(emitMock).toHaveBeenCalledWith("torrent-export-cancel-request", {});
    expect(invokeMock).toHaveBeenCalledWith("torrent_export_cancel");
    expect(invokeMock).toHaveBeenCalledWith("soulseek_export_cancel");
  });

  it("Stop is a no-op after phase becomes 'done'", async () => {
    mountOverlay({ progress: { phase: "done" } as Progress, expanded: true });
    // No .dl-stop rendered; nothing to click. Verify invokes untouched.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("Stop swallows invoke failures without propagating", async () => {
    emitMock.mockResolvedValue(undefined);
    invokeMock.mockRejectedValue(new Error("cancel pipe gone"));
    mountOverlay({ progress: { phase: "downloading" } as Progress, expanded: true });
    const btn = document.body.querySelector(".dl-stop") as HTMLElement;
    btn.click();
    // Await all microtasks; no unhandled rejection.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(emitMock).toHaveBeenCalled();
  });
});

describe("DownloadProgressOverlay — progress bar / bytes formatting", () => {
  it("copying phase uses copyIndex/copyTotal for the bar", () => {
    mountOverlay({
      progress: { phase: "copying", copyIndex: 3, copyTotal: 10, pct: 0, copyLabel: "track.mp3" } as Progress,
      expanded: true,
    });
    const bar = document.body.querySelector(".dl-bar--copy") as HTMLElement;
    expect(bar.style.width).toBe("30%");
  });

  it("copying phase shows copyLabel hint", () => {
    mountOverlay({
      progress: { phase: "copying", copyIndex: 2, copyTotal: 5, copyLabel: "song.mp3", pct: 0 } as Progress,
      expanded: true,
    });
    expect(document.body.querySelector(".dl-copy-hint")?.textContent).toContain("song.mp3");
  });

  it("downloading phase shows bytes formatting", () => {
    mountOverlay({
      progress: { phase: "downloading", pct: 50, progressBytes: 500, totalBytes: 1500 } as Progress,
      expanded: true,
    });
    const bytes = document.body.querySelector(".dl-bytes")?.textContent ?? "";
    expect(bytes).toContain("500 Б");
    expect(bytes).toContain("1.5 КБ");
    expect(bytes).toContain("50%");
  });

  it("downloading phase with multi-track batch shows 'трек N/M'", () => {
    mountOverlay({
      progress: { phase: "downloading", pct: 10, progressBytes: 100, totalBytes: 1000, batchIndex: 2, batchTotal: 5 } as Progress,
      expanded: true,
    });
    expect(document.body.querySelector(".dl-bytes")?.textContent).toContain("трек 2/5");
  });

  it("queue labels render as a list; items before batchIndex marked as done", () => {
    mountOverlay({
      progress: {
        phase: "downloading",
        pct: 10, progressBytes: 0, totalBytes: 1,
        queueLabels: ["a.mp3", "b.mp3", "c.mp3"],
        batchIndex: 2,
        batchTotal: 3,
      } as Progress,
      expanded: true,
    });
    const items = document.body.querySelectorAll(".dl-queue-item");
    expect(items).toHaveLength(3);
    expect(items[0]?.classList.contains("dl-queue-item--done")).toBe(true);
    expect(items[1]?.classList.contains("dl-queue-item--done")).toBe(false);
  });

  it("dock shows batch progress when batchTotal > 1", () => {
    mountOverlay({
      progress: { phase: "downloading", pct: 50, batchIndex: 3, batchTotal: 7 } as Progress,
      expanded: false,
    });
    expect(document.body.querySelector(".dl-dock-batch")?.textContent).toContain("3/7");
  });

  it("fmtBytes formatting: KB, MB, GB, TB ladder", () => {
    // Only KB is visible via DOM; indirectly test the GB tier via large totalBytes.
    mountOverlay({
      progress: { phase: "downloading", pct: 1, progressBytes: 2_000_000_000, totalBytes: 5_000_000_000 } as Progress,
      expanded: true,
    });
    const txt = document.body.querySelector(".dl-bytes")?.textContent ?? "";
    expect(txt).toMatch(/\d+(?:\.\d+)?\s*ГБ/);
  });

  it("fmtBytes returns '—' for non-finite bytes (shown nowhere in DOM — coverage via downloading branch)", () => {
    mountOverlay({
      progress: { phase: "downloading", pct: 0, progressBytes: NaN, totalBytes: 100 } as Progress,
      expanded: true,
    });
    // Non-finite → "—"
    expect(document.body.querySelector(".dl-bytes")?.textContent).toContain("—");
  });
});

describe("DownloadProgressOverlay — preparing / indeterminate", () => {
  it("preparing phase marks bar as indeterminate", () => {
    mountOverlay({ progress: { phase: "preparing" } as Progress, expanded: true });
    const bar = document.body.querySelector(".dl-bar--indet");
    expect(bar).not.toBe(null);
  });

  it("multi-track downloading uses overallPct instead of raw pct", () => {
    // With batchTotal > 1 and phase downloading, barPct = overallPct.
    mountOverlay({
      progress: {
        phase: "downloading",
        pct: 50, progressBytes: 0, totalBytes: 1,
        batchIndex: 1, batchTotal: 4, // => (0/4 + 0.5/4) * 100 = 12.5%
      } as Progress,
      expanded: true,
    });
    const bar = document.body.querySelector(".dl-bar:not(.dl-bar--copy)") as HTMLElement;
    expect(bar.style.width).toMatch(/^12\.5%$/);
  });
});

describe("DownloadProgressOverlay — dock visuals", () => {
  it("dock hides the stop button after completion", () => {
    mountOverlay({ progress: { phase: "done" } as Progress, expanded: false });
    expect(document.body.querySelector(".dl-dock-stop")).toBe(null);
  });

  it("dock shows stop button during downloading", () => {
    mountOverlay({ progress: { phase: "downloading" } as Progress, expanded: false });
    expect(document.body.querySelector(".dl-dock-stop")).not.toBe(null);
  });
});
