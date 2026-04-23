import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

import SearchBar from "../../src/components/search/SearchBar.vue";

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SearchBar — history dropdown + outside click + keyboard", () => {
  it("focus does not open the dropdown when history is empty", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: [] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("focus");
    expect(w.find(".search-history-dropdown").exists()).toBe(false);
  });

  it("focus opens the dropdown when history is non-empty", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: ["rock", "jazz"] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("focus");
    expect(w.find(".search-history-dropdown").exists()).toBe(true);
    expect(w.findAll(".search-history-item")).toHaveLength(2);
  });

  it("pickQuery emits update:modelValue + search with the chosen query", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: ["rock"] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("focus");
    await w.find(".search-history-run").trigger("mousedown");
    expect(w.emitted("update:modelValue")?.[0]).toEqual(["rock"]);
    expect(w.emitted("search")?.[0]).toEqual(["rock", "100"]);
    // Dropdown closes.
    await w.vm.$nextTick();
    expect(w.find(".search-history-dropdown").exists()).toBe(false);
  });

  it("remove button emits remove-history with the query", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: ["rock"] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("focus");
    await w.find(".search-history-remove").trigger("mousedown");
    expect(w.emitted("remove-history")?.[0]).toEqual(["rock"]);
  });

  it("dropdown closes when history becomes empty", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: ["a"] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("focus");
    await w.setProps({ history: [] });
    expect(w.find(".search-history-dropdown").exists()).toBe(false);
  });

  it("Escape keydown closes the dropdown", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: ["a"] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("focus");
    expect(w.find(".search-history-dropdown").exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
    await w.vm.$nextTick();
    expect(w.find(".search-history-dropdown").exists()).toBe(false);
  });

  it("pointerdown outside the root closes the dropdown", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: ["a"] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("focus");
    // Dispatch outside pointerdown.
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.find(".search-history-dropdown").exists()).toBe(false);
  });

  it("pointerdown inside the root keeps the dropdown open", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: ["a"] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("focus");
    const root = w.find(".search-bar-root").element as HTMLElement;
    root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.find(".search-history-dropdown").exists()).toBe(true);
  });

  it("submit via Enter-in-form emits search, trims the query, and closes dropdown", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "  rock  ", history: ["a"] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("focus");
    await w.find("form").trigger("submit");
    expect(w.emitted("search")?.[0]).toEqual(["rock", "100"]);
    expect(w.find(".search-history-dropdown").exists()).toBe(false);
  });

  it("clear button emits empty modelValue + empty search", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "abc", history: [] },
      attachTo: document.body,
    });
    await w.find(".search-clear-btn").trigger("click");
    expect(w.emitted("update:modelValue")?.[0]).toEqual([""]);
    expect(w.emitted("search")?.[0]).toEqual(["", "100"]);
  });

  it("category tab click switches tab — new submits use the selected category id", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "rock", history: [] },
      attachTo: document.body,
    });
    const tabs = w.findAll(".cat-tab");
    // Pick "FLAC" (id 104) — the 3rd tab.
    await tabs[2]!.trigger("click");
    await w.find("form").trigger("submit");
    expect(w.emitted("search")?.[0]).toEqual(["rock", "104"]);
  });

  it("input typing emits update:modelValue with the new value", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: [] },
      attachTo: document.body,
    });
    const input = w.find<HTMLInputElement>("input.search-input");
    await input.setValue("nirvana");
    expect(w.emitted("update:modelValue")?.[0]).toEqual(["nirvana"]);
  });

  it("showCategories=false hides the category tab bar", () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: [], showCategories: false },
      attachTo: document.body,
    });
    expect(w.findAll(".cat-tab")).toHaveLength(0);
  });

  it("click on input also opens the dropdown when history present", async () => {
    const w = mount(SearchBar, {
      props: { modelValue: "", history: ["a", "b"] },
      attachTo: document.body,
    });
    await w.find("input.search-input").trigger("click");
    expect(w.find(".search-history-dropdown").exists()).toBe(true);
  });
});
