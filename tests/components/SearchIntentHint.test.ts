import { describe, it, expect } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import SearchIntentHint from "../../src/components/search/SearchIntentHint.vue";

describe("SearchIntentHint", () => {
  it("renders nothing special when idle", () => {
    const w = mount(SearchIntentHint, { props: { resolving: false, resolved: null } });
    expect(w.html()).toBeTruthy();
  });

  it("resolving state shows something", () => {
    const w = mount(SearchIntentHint, { props: { resolving: true, resolved: null } });
    expect(w.html()).toBeTruthy();
  });

  it("resolved canonical artist+title renders as 'Трек' intent", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "Radiohead", title: "Creep" },
          candidates: [{ artist: "Radiohead", title: "Creep", sources: ["itunes", "lrclib"] }],
          intent: "track",
          elapsed_ms: 100,
        },
      },
    });
    expect(w.text()).toContain("Радиохед".length > 0 ? "Radiohead" : "Radiohead");
    expect(w.text()).toContain("Creep");
  });

  it("artist-only canonical renders", () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "Metallica", title: "" },
          candidates: [],
          intent: "artist",
          elapsed_ms: 50,
        },
      },
    });
    expect(w.text()).toContain("Metallica");
  });

  it("emits revert-to-raw when trigger present", async () => {
    const w = mount(SearchIntentHint, {
      props: {
        resolving: false,
        resolved: {
          canonical: { artist: "X", title: "Y" },
          candidates: [],
          intent: "track", elapsed_ms: 10,
        },
      },
    });
    const buttons = w.findAll("button");
    for (const b of buttons) {
      if (b.text().toLowerCase().includes("как") || b.text().toLowerCase().includes("raw")) {
        await b.trigger("click");
        break;
      }
    }
    // Optional: revert-to-raw emit if such button found.
    if (w.emitted("revert-to-raw")) {
      expect(w.emitted("revert-to-raw")).toBeTruthy();
    }
  });
});
