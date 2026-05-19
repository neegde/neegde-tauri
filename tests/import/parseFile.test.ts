import { describe, it, expect } from "vitest";
import { parseImportText } from "../../src/import/parseFile.js";

describe("parseImportText", () => {
  it("parses artist - title lines", () => {
    const out = parseImportText("Radiohead - Karma Police\nMuse - Starlight");
    expect(out).toEqual([
      { artist: "Radiohead", title: "Karma Police", raw: "Radiohead - Karma Police", lineNum: 1 },
      { artist: "Muse", title: "Starlight", raw: "Muse - Starlight", lineNum: 2 },
    ]);
  });

  it("splits only on first separator", () => {
    const out = parseImportText("A - B - C");
    expect(out[0]?.artist).toBe("A");
    expect(out[0]?.title).toBe("B - C");
  });

  it("skips empty, comment, and invalid lines", () => {
    const text = [
      "",
      "# playlist",
      "// note",
      "no separator here",
      "  ",
      "Valid - Track",
    ].join("\n");
    expect(parseImportText(text)).toEqual([
      { artist: "Valid", title: "Track", raw: "Valid - Track", lineNum: 6 },
    ]);
  });

  it("skips lines with empty artist or title", () => {
    expect(parseImportText(" - Title")).toEqual([]);
    expect(parseImportText("Artist - ")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const out = parseImportText("A - B\r\nC - D");
    expect(out).toHaveLength(2);
    expect(out[1]?.lineNum).toBe(2);
  });
});
