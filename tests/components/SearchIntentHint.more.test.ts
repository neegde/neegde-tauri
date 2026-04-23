import { describe, it, expect } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import SearchIntentHint from "../../src/components/search/SearchIntentHint.vue";

describe("SearchIntentHint — intent labels + alts + fallbacks", () => {
  it.each([
    ["track", "Трек"],
    ["artist", "Исполнитель"],
    ["album", "Альбом"],
    ["lyric", "Текст песни"],
    ["raw", "Как есть"],
  ])("intent %s → chip %s", (intent, expected) => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: null },
          intent,
          candidates: [{ artist: "X", title: null, sources: ["mb"] }],
        },
      },
    });
    expect(w.find(".sih-chip").text()).toBe(expected);
  });

  it("unknown intent → no chip rendered", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: null },
          intent: "bogus",
          candidates: [{ artist: "X", title: null, sources: [] }],
        },
      },
    });
    expect(w.find(".sih-chip").exists()).toBe(false);
  });

  it("sources text shows comma-joined sources of the top candidate", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "track",
          candidates: [{ artist: "X", title: "Y", sources: ["mb", "lfm", "itunes"] }],
        },
      },
    });
    expect(w.find(".sih-sources").text()).toContain("mb, lfm, itunes");
  });

  it("no sources element when candidate.sources is empty", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "track",
          candidates: [{ artist: "X", title: "Y", sources: [] }],
        },
      },
    });
    expect(w.find(".sih-sources").exists()).toBe(false);
  });

  it("revert-to-raw emitted on click of the revert button", async () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "track",
          candidates: [{ artist: "X", title: "Y", sources: [] }],
        },
      },
    });
    await w.find(".sih-revert").trigger("click");
    expect(w.emitted("revert-to-raw")).toBeTruthy();
  });

  it("alternatives: slice(1, 5) — first candidate is hidden as canonical, up to 4 rendered", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      artist: `A${i}`, title: `T${i}`, sources: ["mb"],
    }));
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "A0", title: "T0" },
          intent: "track",
          candidates,
        },
      },
    });
    const alts = w.findAll(".sih-alt");
    expect(alts).toHaveLength(4);
    // Each alt carries its sources.
    expect(alts[0]?.text()).toContain("A1 — T1");
    expect(alts[0]?.find(".sih-alt-sources").text()).toBe("(mb)");
  });

  it("raw intent without canonical shows the muted fallback message", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: { intent: "raw", canonical: null, candidates: [] },
      },
    });
    expect(w.find(".sih--muted").exists()).toBe(true);
    expect(w.text()).toContain("Каталоги ничего не распознали");
  });

  it("no rendering when idle + no resolved data", () => {
    const w = mount(SearchIntentHint, {
      props: { resolving: false, resolved: null },
    });
    expect(w.find(".sih").exists()).toBe(false);
  });
});
