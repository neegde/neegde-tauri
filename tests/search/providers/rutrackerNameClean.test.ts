import { describe, it, expect } from "vitest";
import {
  cleanAlbumNameForCatalog,
  leafAlbumName,
  fallbackArtistFromPath,
} from "../../../src/search/providers/rutracker.js";

describe("cleanAlbumNameForCatalog", () => {
  it("strips leading year prefix", () => {
    expect(cleanAlbumNameForCatalog("2005 - Река крови")).toBe("Река крови");
    expect(cleanAlbumNameForCatalog("[2005] Река крови")).toBe("Река крови");
    expect(cleanAlbumNameForCatalog("(2005) Река крови")).toBe("Река крови");
  });

  it("strips trailing parenthetical qualifier", () => {
    expect(cleanAlbumNameForCatalog("Сквозное (EP)")).toBe("Сквозное");
    expect(cleanAlbumNameForCatalog("ЧБ (Deluxe Version)")).toBe("ЧБ");
    expect(cleanAlbumNameForCatalog("Имя (Инструментал)")).toBe("Имя");
    expect(cleanAlbumNameForCatalog("Имя (переизданная версия)")).toBe("Имя");
  });

  it("strips both year prefix and trailing parenthetical", () => {
    expect(cleanAlbumNameForCatalog("2006 - Сквозное (EP)")).toBe("Сквозное");
    expect(cleanAlbumNameForCatalog("2008 - Река крови (переизданная версия)")).toBe(
      "Река крови",
    );
  });

  it("leaves clean titles alone", () => {
    expect(cleanAlbumNameForCatalog("Гантеля")).toBe("Гантеля");
    expect(cleanAlbumNameForCatalog("Ломбард")).toBe("Ломбард");
  });
});

describe("leafAlbumName", () => {
  it("returns leaf folder by default", () => {
    expect(leafAlbumName("Кровосток/2005 - Река крови", "x")).toBe(
      "2005 - Река крови",
    );
  });

  it("climbs to parent when leaf is CD/Disc/Диск + digit", () => {
    expect(leafAlbumName("Кровосток/2008 - Гантеля/CD1", "x")).toBe(
      "2008 - Гантеля",
    );
    expect(
      leafAlbumName("Кровосток/2008 - Гантеля/CD2 (Инструментал)", "x"),
    ).toBe("2008 - Гантеля");
    expect(leafAlbumName("Artist/Album/Disc 1", "x")).toBe("Album");
    expect(leafAlbumName("Artist/Album/Диск 02", "x")).toBe("Album");
    expect(leafAlbumName("Artist/Album/Part 1", "x")).toBe("Album");
  });

  it("falls back to leaf when no parent exists", () => {
    expect(leafAlbumName("CD1", "fallback")).toBe("CD1");
  });

  it("falls back to provided name when path is empty", () => {
    expect(leafAlbumName("", "Fallback")).toBe("Fallback");
  });
});

describe("fallbackArtistFromPath", () => {
  it("returns first segment when path has at least two parts", () => {
    expect(fallbackArtistFromPath("Кровосток/2005 - Река крови")).toBe(
      "Кровосток",
    );
    expect(fallbackArtistFromPath("Кровосток/2008 - Гантеля/CD1")).toBe(
      "Кровосток",
    );
  });

  it("returns null for shallow paths", () => {
    expect(fallbackArtistFromPath("singleFolder")).toBeNull();
    expect(fallbackArtistFromPath("")).toBeNull();
  });
});
