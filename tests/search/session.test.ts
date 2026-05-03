import { describe, it, expect, beforeEach, vi } from "vitest";
import "../_setup.js";

import { SearchSession, SearchProvider, type SearchProviderCtx } from "../../src/search/session.js";
import type { PipelineEntity } from "../../src/search/pipeline/index.js";

// rAF shim that runs on the next microtask so tests can await a flush deterministically.
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queueMicrotask(() => cb(0));
    return 0 as unknown as number;
  });
});

interface FakeEntity { id: string; mergedFrom?: number; score?: number }

class FakeProvider extends SearchProvider {
  readonly kind: string;
  constructor(
    kind: string,
    private readonly snapshots: FakeEntity[][],
    private readonly opts: { throwAt?: number; sleepMs?: number } = {},
  ) {
    super();
    this.kind = kind;
  }

  async *search(_q: string, ctx: SearchProviderCtx): AsyncGenerator<PipelineEntity[]> {
    for (let i = 0; i < this.snapshots.length; i++) {
      if (ctx.signal.aborted) return;
      if (this.opts.throwAt === i) throw new Error("provider boom");
      if (this.opts.sleepMs) await new Promise((r) => setTimeout(r, this.opts.sleepMs));
      yield this.snapshots[i]! as unknown as PipelineEntity[];
    }
  }
}

function makeProvider(
  kind: string,
  snapshots: FakeEntity[][],
  opts: { throwAt?: number; sleepMs?: number } = {},
): FakeProvider {
  return new FakeProvider(kind, snapshots, opts);
}

describe("SearchSession — zero providers", () => {
  it("completes immediately with empty results", async () => {
    const s = new SearchSession("q", { providers: [] });
    await s.completed;
    expect(s.status.value).toBe("done");
    expect(s.results.value).toEqual([]);
  });
});

describe("SearchSession — single provider", () => {
  it("streams snapshots through pipeline and merges them", async () => {
    const p = makeProvider("p1", [
      [{ id: "a" }],
      [{ id: "a" }, { id: "b" }],
    ]);
    const s = new SearchSession("q", { providers: [p] });
    await s.completed;
    expect(s.status.value).toBe("done");
    expect((s.results.value as unknown as FakeEntity[]).map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(s.providerStatus.value.p1).toBe("done");
  });

  it("passes snapshot shape into `results` after final flush", async () => {
    const p = makeProvider("p1", [[{ id: "x", mergedFrom: 1 }]]);
    const s = new SearchSession("q", { providers: [p] });
    await s.completed;
    expect(s.results.value).toHaveLength(1);
    expect((s.results.value[0] as unknown as FakeEntity).score).toBe(0);
  });
});

describe("SearchSession — multi-provider merge", () => {
  it("concatenates snapshots preserving provider order", async () => {
    const p1 = makeProvider("p1", [[{ id: "a" }, { id: "b" }]]);
    const p2 = makeProvider("p2", [[{ id: "c" }]]);
    const s = new SearchSession("q", { providers: [p1, p2] });
    await s.completed;
    expect(s.results.value.map((e) => (e as unknown as FakeEntity).id)).toEqual(["a", "b", "c"]);
  });
});

describe("SearchSession — provider failure", () => {
  it("captures error and marks provider 'error' without affecting siblings", async () => {
    const ok = makeProvider("ok", [[{ id: "ok-1" }]]);
    const bad = makeProvider("bad", [[{ id: "b1" }]], { throwAt: 0 });
    const s = new SearchSession("q", { providers: [ok, bad] });
    await s.completed;
    expect(s.providerStatus.value.bad).toBe("error");
    expect(s.providerError.value.bad).toMatch(/boom/);
    expect(s.providerStatus.value.ok).toBe("done");
    expect(s.results.value.map((e) => (e as unknown as FakeEntity).id)).toContain("ok-1");
  });
});

describe("SearchSession — cancel", () => {
  it("aborts signal and flips status to cancelled", () => {
    const p = makeProvider("p", [[{ id: "x" }]]);
    const s = new SearchSession("q", { providers: [p] });
    s.cancel();
    expect(s.status.value).toBe("cancelled");
    expect(s.providerStatus.value.p).toBeDefined();
  });

  it("cancel is idempotent — second call is a no-op", () => {
    const s = new SearchSession("q", { providers: [] });
    s.cancel();
    s.cancel();
    // First cancel flipped "done" → "cancelled"; second returns early.
    expect(s.status.value).toBe("cancelled");
  });

  it("prevents further flushes after cancel", async () => {
    const p = makeProvider("p", [[{ id: "x" }]], { sleepMs: 5 });
    const s = new SearchSession("q", { providers: [p] });
    s.cancel();
    await s.completed;
    // Results may be empty (never flushed)
    expect(s.status.value).toBe("cancelled");
  });
});

describe("SearchSession — log + resolver hint", () => {
  it("emits provider-error log line", async () => {
    const spy = vi.fn();
    const bad = makeProvider("bad", [[{ id: "x" }]], { throwAt: 0 });
    const s = new SearchSession("q", { providers: [bad], log: spy });
    await s.completed;
    expect(spy).toHaveBeenCalled();
  });

  it("carries resolved + rawQuery hints", () => {
    const s = new SearchSession("canonical", {
      providers: [],
      resolved: { query: "r", canonical: null, candidates: [], intent: "raw", elapsed_ms: 0 },
      rawQuery: "user typed",
    });
    expect(s.rawQuery).toBe("user typed");
    expect(s.resolved?.intent).toBe("raw");
    expect(s.query).toBe("canonical");
  });

  it("falls back rawQuery to query when not supplied", () => {
    const s = new SearchSession("q", { providers: [] });
    expect(s.rawQuery).toBe("q");
  });
});
