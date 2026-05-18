import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/soulseek/coverCache.js", () => ({
  peekSlskCover: vi.fn(),
  getSlskCoverDataUrl: vi.fn(),
}));
vi.mock("../../src/appDebugLog.js", () => ({
  appDebugLog: vi.fn(),
}));

import { guessSlskFolderCoverPath } from "../../src/soulseek/slskFolderCoverGuess.js";
import { peekSlskCover, getSlskCoverDataUrl } from "../../src/soulseek/coverCache.js";

describe("guessSlskFolderCoverPath", () => {
  beforeEach(() => {
    vi.mocked(peekSlskCover).mockReset();
    vi.mocked(getSlskCoverDataUrl).mockReset();
  });

  it("returns first path that resolves to a data URL", async () => {
    vi.mocked(peekSlskCover).mockReturnValue(undefined);
    vi.mocked(getSlskCoverDataUrl)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("data:image/jpeg;base64,aa");
    const path = await guessSlskFolderCoverPath("user", "Music/Album/", undefined, false);
    expect(path).toBe("Music/Album/cover.jpg");
  });

  it("dedupes concurrent calls for the same folder", async () => {
    vi.mocked(peekSlskCover).mockReturnValue(undefined);
    let calls = 0;
    vi.mocked(getSlskCoverDataUrl).mockImplementation(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 15));
      return calls === 1 ? null : "data:x";
    });
    const a = guessSlskFolderCoverPath("u", "dir/", undefined, false);
    const b = guessSlskFolderCoverPath("u", "dir/", undefined, false);
    const [pa, pb] = await Promise.all([a, b]);
    expect(pa).toBe(pb);
    expect(pa).toBe("dir/cover.jpg");
    expect(calls).toBe(2);
  });

  it("returns null when aborted before fetch", async () => {
    vi.mocked(peekSlskCover).mockReturnValue(undefined);
    const ac = new AbortController();
    ac.abort();
    const path = await guessSlskFolderCoverPath("u", "dir/", ac.signal, false);
    expect(path).toBeNull();
    expect(getSlskCoverDataUrl).not.toHaveBeenCalled();
  });
});
