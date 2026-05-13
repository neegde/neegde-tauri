import { describe, expect, it } from "vitest";
import {
  pickBestDeezerAlbumCoverUrl,
  preferHighResDeezerCoverUrl,
} from "../../src/lib/deezerCoverUrl.js";

describe("deezerCoverUrl", () => {
  it("pickBestDeezerAlbumCoverUrl prefers xl over big over medium", () => {
    expect(
      pickBestDeezerAlbumCoverUrl({
        cover_small: "https://cdn/s.jpg",
        cover_medium: "https://cdn/m.jpg",
        cover_big: "https://cdn/b.jpg",
        cover_xl: "https://cdn/xl.jpg",
      }),
    ).toBe("https://cdn/xl.jpg");
    expect(
      pickBestDeezerAlbumCoverUrl({
        cover_medium: "https://cdn/m.jpg",
        cover_big: "https://cdn/b.jpg",
      }),
    ).toBe("https://cdn/b.jpg");
    expect(pickBestDeezerAlbumCoverUrl({ cover_medium: "https://cdn/m.jpg" })).toBe(
      "https://cdn/m.jpg",
    );
  });

  it("preferHighResDeezerCoverUrl bumps small dzcdn dimensions", () => {
    const inUrl =
      "https://e-cdns-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg";
    expect(preferHighResDeezerCoverUrl(inUrl)).toBe(
      "https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg",
    );
  });

  it("preferHighResDeezerCoverUrl leaves large dzcdn paths unchanged", () => {
    const u = "https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg";
    expect(preferHighResDeezerCoverUrl(u)).toBe(u);
  });

  it("preferHighResDeezerCoverUrl leaves non-Deezer URLs unchanged", () => {
    expect(preferHighResDeezerCoverUrl("https://img/other.jpg")).toBe("https://img/other.jpg");
  });

  it("preferHighResDeezerCoverUrl returns null for empty input", () => {
    expect(preferHighResDeezerCoverUrl(null)).toBe(null);
    expect(preferHighResDeezerCoverUrl("  ")).toBe(null);
  });
});
