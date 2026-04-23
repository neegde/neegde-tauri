import { describe, it, expect } from "vitest";
import "../../_setup.js";

import { normalizeStage } from "../../../src/search/pipeline/normalize.js";
import { scoreStage } from "../../../src/search/pipeline/score.js";
import { dedupStage } from "../../../src/search/pipeline/dedup.js";
import { filterStage } from "../../../src/search/pipeline/filter.js";
import { defaultPipeline, runPipeline } from "../../../src/search/pipeline/index.js";

describe("normalizeStage", () => {
  it("passes entities through unchanged", () => {
    const arr = [{ id: "a" }, { id: "b" }];
    expect(normalizeStage(arr)).toBe(arr);
  });
  it("empty array", () => {
    expect(normalizeStage([])).toEqual([]);
  });
});

describe("scoreStage", () => {
  it("sets score=0 on every entity (mutates)", () => {
    const arr = [{ id: "a", score: 42 }, { id: "b" }];
    scoreStage(arr);
    expect(arr[0]?.score).toBe(0);
    expect(arr[1]?.score).toBe(0);
  });
  it("returns the same array", () => {
    const arr: Array<{ id: string; score?: number }> = [{ id: "a" }];
    expect(scoreStage(arr)).toBe(arr);
  });
});

describe("dedupStage", () => {
  it("keeps unique ids in first-seen order", () => {
    const arr = [{ id: "a" }, { id: "b" }, { id: "a" }];
    const out = dedupStage(arr);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });
  it("prefers higher mergedFrom", () => {
    const a1 = { id: "a", mergedFrom: 1 };
    const a2 = { id: "a", mergedFrom: 3 };
    const b1 = { id: "b", mergedFrom: 1 };
    const out = dedupStage([a1, b1, a2]);
    expect(out.find((e) => e.id === "a")).toBe(a2);
  });
  it("ties on mergedFrom → keep first", () => {
    const a1 = { id: "a", mergedFrom: 1 };
    const a2 = { id: "a", mergedFrom: 1 };
    const out = dedupStage([a1, a2]);
    expect(out).toContain(a1);
    expect(out).not.toContain(a2);
  });
  it("undefined mergedFrom treated as 0", () => {
    const a1 = { id: "a" }; // undefined
    const a2 = { id: "a", mergedFrom: 2 };
    expect(dedupStage([a1, a2])).toContain(a2);
  });
  it("empty input", () => {
    expect(dedupStage([])).toEqual([]);
  });
});

describe("filterStage", () => {
  it("pass-through", () => {
    const arr = [{ id: "a" }, { id: "b" }];
    expect(filterStage(arr)).toBe(arr);
  });
  it("ignores opts", () => {
    const arr = [{ id: "a" }];
    expect(filterStage(arr, { anything: 1 })).toBe(arr);
  });
});

describe("defaultPipeline + runPipeline", () => {
  it("default order: normalize → dedup → score → filter", () => {
    const stages = defaultPipeline();
    expect(stages).toHaveLength(4);
  });
  it("runPipeline dedupes ids, zeroes scores", () => {
    const input = [
      { id: "a", score: 99 },
      { id: "b", score: 50 },
      { id: "a", score: 10 },
    ];
    const out = runPipeline(input, defaultPipeline());
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
    expect(out.every((e) => e.score === 0)).toBe(true);
  });
  it("empty stages → identity", () => {
    const input = [{ id: "a" }];
    expect(runPipeline(input, [])).toBe(input);
  });
  it("opts forwarded to each stage", () => {
    const seen: Record<string, unknown>[] = [];
    const capture = ((e: { id: string }[], opts?: Record<string, unknown>) => {
      if (opts) seen.push(opts);
      return e;
    }) as Parameters<typeof runPipeline>[1][number];
    runPipeline([{ id: "x" }], [capture, capture], { flag: true });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ flag: true });
  });
});
