import { describe, it, expect, vi, beforeEach } from "vitest";
import "../_setup.js";
import { defineComponent, h } from "vue";
import { mount, flushPromises } from "@vue/test-utils";

import { useAppUpdate, simpleMarkdown } from "../../src/composables/useAppUpdate.js";

// ── Updater plugin mock ────────────────────────────────────────────────────────

const mockCheck = vi.fn();
const mockRelaunch = vi.fn();
const mockDownloadAndInstall = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mockCheck,
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));

// ── Mount helper ──────────────────────────────────────────────────────────────

function mountUpdate() {
  let api!: ReturnType<typeof useAppUpdate>;
  const Wrapper = defineComponent({
    setup() {
      api = useAppUpdate();
      return () => h("div");
    },
  });
  mount(Wrapper);
  return api;
}

// ── simpleMarkdown ─────────────────────────────────────────────────────────────

describe("simpleMarkdown", () => {
  it("empty → empty", () => {
    expect(simpleMarkdown("")).toBe("");
  });

  it("## heading → <h3>", () => {
    expect(simpleMarkdown("## Что нового")).toBe("<h3>Что нового</h3>");
  });

  it("### heading → <h4>", () => {
    expect(simpleMarkdown("### Детали")).toBe("<h4>Детали</h4>");
  });

  it("# heading → <h2>", () => {
    expect(simpleMarkdown("# Заголовок")).toBe("<h2>Заголовок</h2>");
  });

  it("- list item → <ul><li>", () => {
    const out = simpleMarkdown("- foo\n- bar");
    expect(out).toBe("<ul><li>foo</li><li>bar</li></ul>");
  });

  it("* list item treated same as -", () => {
    const out = simpleMarkdown("* foo");
    expect(out).toBe("<ul><li>foo</li></ul>");
  });

  it("blank line closes list and emits gap div", () => {
    const out = simpleMarkdown("- foo\n\n- bar");
    expect(out).toContain("</ul>");
    expect(out).toContain('<div class="update-notes-gap"></div>');
    expect(out).toContain("<ul><li>bar</li></ul>");
  });

  it("**bold** → <strong>", () => {
    expect(simpleMarkdown("**Важно**")).toContain("<strong>Важно</strong>");
  });

  it("`code` → <code>", () => {
    expect(simpleMarkdown("`crash`")).toContain("<code>crash</code>");
  });

  it("plain text → <p>", () => {
    expect(simpleMarkdown("Hello world")).toBe("<p>Hello world</p>");
  });

  it("XSS: < > escaped", () => {
    const out = simpleMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("XSS: & escaped", () => {
    const out = simpleMarkdown("foo & bar");
    expect(out).toContain("&amp;");
    expect(out).not.toContain(" & ");
  });

  it("& in heading escaped", () => {
    const out = simpleMarkdown("## A & B");
    expect(out).toContain("&amp;");
    expect(out).not.toContain(" & ");
  });

  it("sections with heading + list", () => {
    const md = "## Что нового\n\n- Фича А\n- Фича Б";
    const out = simpleMarkdown(md);
    expect(out).toContain("<h3>Что нового</h3>");
    expect(out).toContain("<ul><li>Фича А</li><li>Фича Б</li></ul>");
  });
});

// ── useAppUpdate — initial state ───────────────────────────────────────────────

describe("useAppUpdate — initial state", () => {
  beforeEach(() => {
    mockCheck.mockResolvedValue(null);
  });

  it("updateAvailable is false before check completes", () => {
    const api = mountUpdate();
    expect(api.updateAvailable.value).toBe(false);
  });

  it("dialogOpen is false before check completes", () => {
    const api = mountUpdate();
    expect(api.dialogOpen.value).toBe(false);
  });
});

// ── useAppUpdate — no update available ────────────────────────────────────────

describe("useAppUpdate — check() returns null", () => {
  beforeEach(() => {
    mockCheck.mockResolvedValue(null);
  });

  it("updateAvailable stays false", async () => {
    const api = mountUpdate();
    await flushPromises();
    expect(api.updateAvailable.value).toBe(false);
    expect(api.dialogOpen.value).toBe(false);
  });
});

// ── useAppUpdate — update available ───────────────────────────────────────────

describe("useAppUpdate — check() returns update", () => {
  const fakeUpdate = {
    available: true,
    version: "0.2.0",
    date: "2026-04-26T00:00:00Z",
    body: "## Что нового\n\n- Фича",
    downloadAndInstall: mockDownloadAndInstall,
  };

  beforeEach(() => {
    mockCheck.mockResolvedValue(fakeUpdate);
    mockDownloadAndInstall.mockResolvedValue(undefined);
    mockRelaunch.mockResolvedValue(undefined);
  });

  it("sets updateAvailable and opens dialog", async () => {
    const api = mountUpdate();
    await flushPromises();
    expect(api.updateAvailable.value).toBe(true);
    expect(api.dialogOpen.value).toBe(true);
  });

  it("populates version", async () => {
    const api = mountUpdate();
    await flushPromises();
    expect(api.updateVersion.value).toBe("0.2.0");
  });

  it("populates notesHtml via simpleMarkdown", async () => {
    const api = mountUpdate();
    await flushPromises();
    expect(api.updateNotesHtml.value).toContain("<h3>Что нового</h3>");
    expect(api.updateNotesHtml.value).toContain("<li>Фича</li>");
  });

  it("populates date as localised string", async () => {
    const api = mountUpdate();
    await flushPromises();
    expect(api.updateDate.value).toMatch(/\d{4}/);
  });
});

// ── dismissUpdate / showUpdateDialog ──────────────────────────────────────────

describe("useAppUpdate — dismissUpdate", () => {
  beforeEach(() => {
    mockCheck.mockResolvedValue({
      available: true,
      version: "0.2.0",
      date: null,
      body: "",
      downloadAndInstall: mockDownloadAndInstall,
    });
    mockDownloadAndInstall.mockResolvedValue(undefined);
  });

  it("closes the dialog", async () => {
    const api = mountUpdate();
    await flushPromises();
    expect(api.dialogOpen.value).toBe(true);
    api.dismissUpdate();
    expect(api.dialogOpen.value).toBe(false);
  });

  it("showUpdateDialog re-opens after dismiss", async () => {
    const api = mountUpdate();
    await flushPromises();
    api.dismissUpdate();
    api.showUpdateDialog();
    expect(api.dialogOpen.value).toBe(true);
  });
});

describe("useAppUpdate — showUpdateDialog when no update", () => {
  beforeEach(() => {
    mockCheck.mockResolvedValue(null);
  });

  it("does nothing if no update available", async () => {
    const api = mountUpdate();
    await flushPromises();
    api.showUpdateDialog();
    expect(api.dialogOpen.value).toBe(false);
  });
});

// ── installUpdate ─────────────────────────────────────────────────────────────

describe("useAppUpdate — installUpdate", () => {
  beforeEach(() => {
    mockRelaunch.mockResolvedValue(undefined);
  });

  it("does nothing if no pendingUpdate (check returned null)", async () => {
    mockCheck.mockResolvedValue(null);
    const api = mountUpdate();
    await flushPromises();
    await api.installUpdate();
    expect(mockDownloadAndInstall).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it("calls downloadAndInstall then relaunch on success", async () => {
    mockDownloadAndInstall.mockResolvedValue(undefined);
    mockCheck.mockResolvedValue({
      available: true, version: "0.2.0", date: null, body: "",
      downloadAndInstall: mockDownloadAndInstall,
    });
    const api = mountUpdate();
    await flushPromises();
    await api.installUpdate();
    expect(mockDownloadAndInstall).toHaveBeenCalledOnce();
    expect(mockRelaunch).toHaveBeenCalledOnce();
  });

  it("sets installError on download failure", async () => {
    mockDownloadAndInstall.mockRejectedValue(new Error("net fail"));
    mockCheck.mockResolvedValue({
      available: true, version: "0.2.0", date: null, body: "",
      downloadAndInstall: mockDownloadAndInstall,
    });
    const api = mountUpdate();
    await flushPromises();
    await api.installUpdate();
    expect(api.installError.value).toContain("net fail");
    expect(api.installing.value).toBe(false);
  });

  it("tracks progress events", async () => {
    let progressCallback!: (e: { event: string; data: Record<string, number> }) => void;
    mockDownloadAndInstall.mockImplementation(async (cb: typeof progressCallback) => {
      progressCallback = cb;
    });
    mockCheck.mockResolvedValue({
      available: true, version: "0.2.0", date: null, body: "",
      downloadAndInstall: mockDownloadAndInstall,
    });
    const api = mountUpdate();
    await flushPromises();
    const installPromise = api.installUpdate();

    progressCallback({ event: "Started", data: { contentLength: 1000 } });
    progressCallback({ event: "Progress", data: { chunkLength: 500 } });
    expect(api.installProgress.value).toBe(50);

    progressCallback({ event: "Finished", data: {} });
    expect(api.installProgress.value).toBe(100);

    await installPromise;
  });
});
