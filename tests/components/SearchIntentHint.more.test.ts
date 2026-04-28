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
