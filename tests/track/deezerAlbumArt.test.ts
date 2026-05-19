import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke } from "../_setup.js";

describe("fetchDeezerAlbumCoverArt", () => {
  beforeEach(async () => {
    mockInvoke.mockReset();
    const mod = await import("../../src/track/deezerCanonical.js");
    mod.resetDeezerAlbumArtCache();
  });

  it("returns album cover_medium when Deezer album title matches", async () => {
    const body = JSON.stringify({
      data: [
        {
          title: "Бакланы",
          artist: { name: "Кровосток" },
          album: {
            title: "Река крови",
            cover_medium: "https://cdn.example/cover.jpg",
          },
        },
      ],
    });
    mockInvoke.mockResolvedValueOnce(body);
    const { fetchDeezerAlbumCoverArt } = await import("../../src/track/deezerCanonical.js");
    const url = await fetchDeezerAlbumCoverArt("Кровосток", "2005 - Река крови");
    expect(url).toBe("https://cdn.example/cover.jpg");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent calls via cache", async () => {
    const body = JSON.stringify({
      data: [
        {
          title: "x",
          artist: { name: "A" },
          album: { title: "My Album", cover_medium: "https://u/z.png" },
        },
      ],
    });
    mockInvoke.mockResolvedValue(body);
    const { fetchDeezerAlbumCoverArt } = await import("../../src/track/deezerCanonical.js");
    const [a, b] = await Promise.all([
      fetchDeezerAlbumCoverArt("A", "My Album"),
      fetchDeezerAlbumCoverArt("A", "My Album"),
    ]);
    expect(a).toBe("https://u/z.png");
    expect(b).toBe("https://u/z.png");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
