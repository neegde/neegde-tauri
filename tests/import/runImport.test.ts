import { describe, it, expect } from "vitest";
import "../_setup.js";

import {
  resolveImportDestination,
  importDestinationLabel,
} from "../../src/import/runImport.js";
import { createPlaylist, deletePlaylist } from "../../src/stores/library.js";

describe("resolveImportDestination", () => {
  it("passes likes through unchanged", () => {
    expect(resolveImportDestination({ kind: "likes" })).toEqual({ kind: "likes" });
  });

  it("creates playlist for playlist-new", () => {
    const dest = resolveImportDestination({ kind: "playlist-new", title: "  Импорт  " });
    expect(dest.kind).toBe("playlist");
    if (dest.kind !== "playlist") return;
    const label = importDestinationLabel(dest);
    expect(label).toContain("Импорт");
    deletePlaylist(dest.playlistId);
  });

  it("uses default title when playlist-new name is blank", () => {
    const dest = resolveImportDestination({ kind: "playlist-new", title: "   " });
    expect(dest.kind).toBe("playlist");
    if (dest.kind !== "playlist") return;
    expect(importDestinationLabel(dest)).toContain("Импорт");
    deletePlaylist(dest.playlistId);
  });
});

describe("importDestinationLabel", () => {
  it("labels likes", () => {
    expect(importDestinationLabel({ kind: "likes" })).toBe("«Мне нравится»");
  });

  it("labels existing playlist by title", () => {
    const pl = createPlaylist("Test PL");
    expect(importDestinationLabel({ kind: "playlist", playlistId: pl.id })).toBe(
      "плейлист «Test PL»",
    );
    deletePlaylist(pl.id);
  });
});
