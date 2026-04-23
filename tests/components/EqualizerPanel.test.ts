import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";
import { mount } from "@vue/test-utils";

const { setEqBandMock, applyEqPresetMock, resetEqFlatMock, eqBandsDbMock, eqPresetIdMock } = vi.hoisted(() => {
  const { ref } = require("vue") as typeof import("vue");
  return {
    setEqBandMock: vi.fn(),
    applyEqPresetMock: vi.fn(),
    resetEqFlatMock: vi.fn(),
    eqBandsDbMock: ref<number[]>([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    eqPresetIdMock: ref<string>("flat"),
  };
});

vi.mock("../../src/audio/equalizerState.js", () => ({
  eqBandsDb: eqBandsDbMock,
  eqPresetId: eqPresetIdMock,
  setEqBand: setEqBandMock,
  applyEqPreset: applyEqPresetMock,
  resetEqFlat: resetEqFlatMock,
}));

vi.mock("../../src/audio/equalizerConfig.js", () => ({
  EQ_BANDS: [
    { freq: 32,    label: "32"  },
    { freq: 64,    label: "64"  },
    { freq: 125,   label: "125" },
    { freq: 1000,  label: "1k"  },
    { freq: 8000,  label: "8k"  },
  ],
  EQ_PRESETS: [
    { id: "flat", name: "Плоский", hint: "0 dB" },
    { id: "rock", name: "Рок", hint: "bass+treble" },
  ],
  EQ_MIN_DB: -12,
  EQ_MAX_DB: 12,
}));

import EqualizerPanel from "../../src/components/settings/EqualizerPanel.vue";

beforeEach(() => {
  vi.clearAllMocks();
  eqBandsDbMock.value = [0, 0, 0, 0, 0];
  eqPresetIdMock.value = "flat";
});

describe("EqualizerPanel", () => {
  it("renders a slider per EQ band", () => {
    const w = mount(EqualizerPanel);
    expect(w.findAll(".eq-slider")).toHaveLength(5);
  });

  it("preset select reflects current preset id (named preset)", () => {
    eqPresetIdMock.value = "rock";
    const w = mount(EqualizerPanel);
    const sel = w.find<HTMLSelectElement>("select").element;
    expect(sel.value).toBe("rock");
  });

  it("preset select falls back to __custom__ when presetId is 'custom'", () => {
    eqPresetIdMock.value = "custom";
    const w = mount(EqualizerPanel);
    const sel = w.find<HTMLSelectElement>("select").element;
    expect(sel.value).toBe("__custom__");
  });

  it("slider input calls setEqBand with index + numeric value", async () => {
    const w = mount(EqualizerPanel);
    const sliders = w.findAll<HTMLInputElement>(".eq-slider");
    await sliders[2]!.setValue("5.5");
    expect(setEqBandMock).toHaveBeenCalledWith(2, 5.5);
  });

  it("preset change calls applyEqPreset (named preset)", async () => {
    const w = mount(EqualizerPanel);
    const sel = w.find<HTMLSelectElement>("select");
    await sel.setValue("rock");
    expect(applyEqPresetMock).toHaveBeenCalledWith("rock");
  });

  it("__custom__ selection does NOT call applyEqPreset", async () => {
    const w = mount(EqualizerPanel);
    const sel = w.find<HTMLSelectElement>("select");
    await sel.setValue("__custom__");
    expect(applyEqPresetMock).not.toHaveBeenCalled();
  });

  it("Сбросить button calls resetEqFlat", async () => {
    const w = mount(EqualizerPanel);
    await w.find(".eq-reset").trigger("click");
    expect(resetEqFlatMock).toHaveBeenCalled();
  });

  it("fmtDb renders +N / -N / 0 variants", () => {
    eqBandsDbMock.value = [3, -2, 0, 4.25, -0.75];
    const w = mount(EqualizerPanel);
    const cells = w.findAll(".eq-db").map((n) => n.text());
    expect(cells[0]).toBe("+3");
    expect(cells[1]).toBe("-2");
    expect(cells[2]).toBe("0");
    // 4.25 rounds to 4.5 (half-step rounding).
    expect(cells[3]).toBe("+4.5");
    // -0.75 → Math.round(-1.5) = -1 (rounds to +Inf at .5), / 2 = -0.5.
    expect(cells[4]).toBe("-0.5");
  });

  it("fmtDb handles non-finite values as '0'", () => {
    eqBandsDbMock.value = [NaN, 0, 0, 0, 0];
    const w = mount(EqualizerPanel);
    const firstCell = w.find(".eq-db").text();
    expect(firstCell).toBe("0");
  });
});
