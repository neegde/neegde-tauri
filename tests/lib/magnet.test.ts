import { describe, it, expect } from "vitest";
import "../_setup.js";

import {
  extractMagnetUri,
  parseBtihFromMagnet,
  magnetTitleFromMagnet,
} from "../../src/lib/magnet.js";

describe("extractMagnetUri", () => {
  it("extracts bare magnet", () => {
    expect(extractMagnetUri("magnet:?xt=urn:btih:ABC")).toBe("magnet:?xt=urn:btih:ABC");
  });
  it("extracts magnet wrapped in text (stops at whitespace)", () => {
    // Note: closing `"` is not in the trim set; only `),.;>` are trimmed.
    expect(extractMagnetUri('see <magnet:?xt=urn:btih:DEADBEEF>.'))
      .toBe("magnet:?xt=urn:btih:DEADBEEF");
  });
  it("trims trailing punctuation", () => {
    expect(extractMagnetUri("see magnet:?xt=urn:btih:X,")).toBe("magnet:?xt=urn:btih:X");
  });
  it("stops at whitespace", () => {
    expect(extractMagnetUri("magnet:?xt=urn:btih:A rest")).toBe("magnet:?xt=urn:btih:A");
  });
  it("returns null when no magnet found", () => {
    expect(extractMagnetUri("hello")).toBeNull();
    expect(extractMagnetUri("")).toBeNull();
    expect(extractMagnetUri(null)).toBeNull();
    expect(extractMagnetUri(undefined)).toBeNull();
  });
  it("is case-insensitive on the scheme", () => {
    expect(extractMagnetUri("MAGNET:?xt=urn:btih:X")).toBe("MAGNET:?xt=urn:btih:X");
  });
});

describe("parseBtihFromMagnet", () => {
  it("parses 40-char hex hash", () => {
    const h = "a".repeat(40);
    expect(parseBtihFromMagnet(`magnet:?xt=urn:btih:${h.toUpperCase()}`)).toBe(h);
  });
  it("parses 32-char base32 hash (lowercased)", () => {
    const h = "abcdefghijklmnopqrstuvwxyz234567"; // 32 base32
    expect(parseBtihFromMagnet(`magnet:?xt=urn:btih:${h.toUpperCase()}`)).toBe(h);
  });
  it("returns null for malformed magnets", () => {
    expect(parseBtihFromMagnet("magnet:?xt=urn:btih:short")).toBeNull();
    expect(parseBtihFromMagnet("hello")).toBeNull();
    expect(parseBtihFromMagnet(null)).toBeNull();
    expect(parseBtihFromMagnet(undefined)).toBeNull();
    expect(parseBtihFromMagnet(42)).toBeNull();
  });
  it("prefers hex when both patterns theoretically match", () => {
    const hex = "f".repeat(40);
    expect(parseBtihFromMagnet(`magnet:?xt=urn:btih:${hex}`)).toBe(hex);
  });
});

describe("magnetTitleFromMagnet", () => {
  it("decodes dn= plus-encoded name", () => {
    expect(magnetTitleFromMagnet("magnet:?xt=urn:btih:X&dn=Hello+World")).toBe("Hello World");
  });
  it("decodes percent-encoded unicode", () => {
    const encoded = encodeURIComponent("Альбом");
    expect(magnetTitleFromMagnet(`magnet:?xt=urn:btih:X&dn=${encoded}`)).toBe("Альбом");
  });
  it("tolerates broken percent sequences", () => {
    expect(magnetTitleFromMagnet("magnet:?xt=urn:btih:X&dn=100%+OK")).toBe("100%+OK".replace("+", " "));
  });
  it("falls back to btih short hash when dn absent", () => {
    const hex = "a".repeat(40);
    expect(magnetTitleFromMagnet(`magnet:?xt=urn:btih:${hex}`)).toBe(`Раздача ${hex.slice(0, 8)}…`);
  });
  it("falls back to generic when nothing recognisable", () => {
    expect(magnetTitleFromMagnet("hello")).toBe("Раздача по ссылке");
    expect(magnetTitleFromMagnet(null)).toBe("Раздача по ссылке");
  });
  it("falls back to hash when dn is empty after trim", () => {
    const hex = "b".repeat(40);
    expect(magnetTitleFromMagnet(`magnet:?xt=urn:btih:${hex}&dn=`))
      .toBe(`Раздача ${hex.slice(0, 8)}…`);
  });
});
