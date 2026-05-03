import { describe, it, expect } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";
import PlayingIndicator from "../../src/components/shared/PlayingIndicator.vue";

describe("PlayingIndicator", () => {
  it("renders with default (live=true)", () => {
    const w = mount(PlayingIndicator);
    expect(w.html()).toBeTruthy();
  });
  it("renders with live=false", () => {
    const w = mount(PlayingIndicator, { props: { live: false } });
    expect(w.html()).toBeTruthy();
  });
});
