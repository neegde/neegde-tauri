import { describe, expect, it } from "vitest";
import "../_setup.js";

import {
  createSearchEngine,
  SearchSession,
  defaultPipeline,
  runPipeline,
} from "../../src/search/index.js";

describe("search index exports", () => {
  it("re-exports runtime search API", () => {
    expect(typeof createSearchEngine).toBe("function");
    expect(typeof SearchSession).toBe("function");
    expect(typeof defaultPipeline).toBe("function");
    expect(typeof runPipeline).toBe("function");
  });
});
