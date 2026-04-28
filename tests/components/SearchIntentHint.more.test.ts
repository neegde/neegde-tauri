import { describe, it, expect } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import SearchIntentHint from "../../src/components/search/SearchIntentHint.vue";

describe("SearchIntentHint — canonical + revert + raw fallback", () => {
  it("resolving=true shows spinner + 'Распознаём запрос…'", () => {
    const w = mount(SearchIntentHint, {
      props: { resolving: true, resolved: null, rawQuery: "" },
    });
    expect(w.find(".sih--resolving").exists()).toBe(true);
    expect(w.text()).toContain("Распознаём запрос");
  });

  it("canonical artist+title renders artist and title on separate elements", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "Artist", title: "Title" },
          intent: "track",
          candidates: [],
        },
        rawQuery: "raw",
      },
    });
    expect(w.find(".sih-artist").text()).toBe("Artist");
    expect(w.find(".sih-title").text()).toBe("Title");
  });

  it("canonical with only artist (Artist intent) renders artist, no title element", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "Artist", title: null },
          intent: "artist",
          candidates: [],
        },
        rawQuery: "raw",
      },
    });
    expect(w.find(".sih-artist").text()).toBe("Artist");
    expect(w.find(".sih-title").exists()).toBe(false);
  });

  it("strips bracketed annotations from canonical before displaying", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "Artist (Translation)", title: "Title [Live]" },
          intent: "track",
          candidates: [],
        },
        rawQuery: "raw",
      },
    });
    expect(w.find(".sih-artist").text()).toBe("Artist");
    expect(w.find(".sih-title").text()).toBe("Title");
  });

  it("revert button shows raw query and emits revert-to-raw on click", async () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "track",
          candidates: [],
        },
        rawQuery: "literal search",
      },
    });
    const btn = w.find(".sih-revert");
    expect(btn.text()).toContain("literal search");
    await btn.trigger("click");
    expect(w.emitted("revert-to-raw")).toBeTruthy();
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

describe("SearchIntentHint — intent label + candidate chips", () => {
  const variants: Array<[string, string]> = [
    ["track", "трек"],
    ["artist", "исполнитель"],
    ["album", "альбом"],
    ["lyric", "по тексту"],
  ];
  for (const [intent, label] of variants) {
    it(`renders the '${label}' chip for intent='${intent}'`, () => {
      const w = mount(SearchIntentHint, {
        props: {
          resolving: false,
          resolved: {
            canonical: { artist: "X", title: "Y" },
            intent,
            candidates: [],
          },
          rawQuery: "raw",
        },
      });
      expect(w.find(".sih-chip").text()).toBe(label);
    });
  }

  it("does not render a chip for intent='raw' / unknown", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "raw",
          candidates: [],
        },
        rawQuery: "raw",
      },
    });
    expect(w.find(".sih-chip").exists()).toBe(false);
  });

  it("hides the 'Также:' row when there are no extra candidates", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "track",
          candidates: [{ artist: "X", title: "Y", sources: ["brave"] }],
        },
        rawQuery: "raw",
      },
    });
    expect(w.find(".sih-alts").exists()).toBe(false);
  });

  it("drops the canonical pair from candidates and caps the rest at 3", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "track",
          candidates: [
            { artist: "X", title: "Y", sources: ["brave"] },
            { artist: "A", title: "1", sources: ["brave"] },
            { artist: "B", title: "2", sources: ["brave"] },
            { artist: "C", title: "3", sources: ["brave"] },
            { artist: "D", title: "4", sources: ["brave"] },
          ],
        },
        rawQuery: "raw",
      },
    });
    const chips = w.findAll(".sih-alt-btn");
    expect(chips).toHaveLength(3);
    const labels = chips.map((c) => c.text());
    expect(labels).toEqual(["A — 1", "B — 2", "C — 3"]);
  });

  it("renders an artist-only candidate without a dash", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "track",
          candidates: [{ artist: "Solo", title: "", sources: ["brave"] }],
        },
        rawQuery: "raw",
      },
    });
    const chip = w.find(".sih-alt-btn");
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toBe("Solo");
  });

  it("emits search-candidate with the chip's pair on click", async () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "track",
          candidates: [{ artist: "Pick", title: "Me", sources: ["brave"] }],
        },
        rawQuery: "raw",
      },
    });
    await w.find(".sih-alt-btn").trigger("click");
    const events = w.emitted("search-candidate");
    expect(events).toBeTruthy();
    expect(events?.[0]?.[0]).toEqual({ artist: "Pick", title: "Me" });
  });

  it("strips brackets from candidate labels too", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          intent: "track",
          candidates: [
            { artist: "Cand (alt)", title: "Tune [remix]", sources: ["brave"] },
          ],
        },
        rawQuery: "raw",
      },
    });
    expect(w.find(".sih-alt-btn").text()).toBe("Cand — Tune");
  });
});
