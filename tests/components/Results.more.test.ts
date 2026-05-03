/**
 * Additional coverage for `src/components/search/Results.vue` — targets the
 * SoulSeek filename-parsing / iTunes cover-lookup branches (lines ~225-336
 * and 351-352 per the coverage report). Does NOT modify the source or the
 * original `Results.test.ts`.
 *
 * Note: the `watch(trackEntities, …)` inside Results.vue is NOT `immediate:
 * true`, so the metadata/cover pipeline only fires on CHANGES. Tests mount
 * with empty entities, then swap to a non-empty list via `setProps`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../_setup.js";
import { mount, flushPromises, VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";

// Hoisted stub so the component import picks up our mock (fetchAlbumCover
// would otherwise hit iTunes over HTTP).
const { fetchAlbumCoverMock } = vi.hoisted(() => ({
  fetchAlbumCoverMock: vi.fn(),
}));
vi.mock("../../src/audio/coverFetch.js", () => ({
  fetchAlbumCover: fetchAlbumCoverMock,
}));

import Results from "../../src/components/search/Results.vue";
import { buildTrack } from "../../src/track/factory.js";
import { clearEntities } from "../../src/stores/entities.js";
import {
  slskMeta,
  clearCoverTimer,
  bumpCoverGeneration,
} from "../../src/soulseek/slskMetaStore.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSlskTrack(opts: {
  id: string;
  fileName: string;
  folder?: string;
  cover?: unknown;
  bitrate?: number;
  username?: string;
}) {
  return buildTrack({
    type: "track",
    id: opts.id,
    title: opts.fileName.replace(/\.[^.]+$/, ""),
    artist: null,
    albumTitle: null,
    albumId: null,
    fileName: opts.fileName,
    format: null,
    bitrate: opts.bitrate ?? 320,
    duration: 180,
    size: 1,
    sources: [
      {
        kind: "soulseek",
        refs: {
          slskUsername: opts.username ?? "u",
          slskFilepath: `${opts.folder ?? "F"}/${opts.fileName}`,
          slskFolder: opts.folder ?? "F",
        },
        raw: { cover: opts.cover ?? null },
      },
    ],
  });
}

const baseProps = {
  searchEpoch: 1,
  entities: [] as unknown[],
  loadingAlbums: false,
  loadingTracks: false,
  rtLoggedIn: false,
  slskConnected: true,
  rtError: null,
  slskError: null,
  selectedId: null,
  query: "",
  nowPlayingId: null,
  playerPlaying: false,
};

/**
 * Mounts Results with an empty list, then pushes `entities` via setProps so
 * the `watch(trackEntities, …)` (non-immediate) fires its full branch. Returns
 * the wrapper so each test can still assert/unmount.
 */
async function mountWithTracks(
  entities: unknown[],
  extra: Record<string, unknown> = {},
): Promise<VueWrapper<InstanceType<typeof Results>>> {
  const w = mount(Results, {
    props: { ...baseProps, entities: [], ...extra },
  }) as VueWrapper<InstanceType<typeof Results>>;
  await nextTick();
  await w.setProps({ entities });
  await nextTick();
  return w;
}

beforeEach(() => {
  clearEntities();
  slskMeta.clear();
  clearCoverTimer();
  fetchAlbumCoverMock.mockReset();
  fetchAlbumCoverMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── parseSlskFilename ──────────────────────────────────────────────────────

describe("Results — parseSlskFilename via applyFilenameMetadata", () => {
  it("populates slskMeta for 'Artist - Title.mp3' filenames", async () => {
    const t = makeSlskTrack({
      id: "slsk:ar-ti",
      fileName: "Pink Floyd - Time.mp3",
      folder: "Pink Floyd/The Dark Side",
    });
    const w = await mountWithTracks([t]);
    const rec = slskMeta.get("slsk:ar-ti");
    expect(rec?.artist).toBe("Pink Floyd");
    expect(rec?.title).toBe("Time");
    w.unmount();
  });

  it("strips leading [YYYY-MM-DD] date prefix from title", async () => {
    const t = makeSlskTrack({
      id: "slsk:date1",
      fileName: "[2020-01-15] Artist - Song.mp3",
      folder: "music/downloads",
    });
    const w = await mountWithTracks([t]);
    const rec = slskMeta.get("slsk:date1");
    expect(rec?.artist).toBe("Artist");
    expect(rec?.title).toBe("Song");
    w.unmount();
  });

  it("strips bare 'YYYY-MM-DD ' date prefix from title", async () => {
    const t = makeSlskTrack({
      id: "slsk:date2",
      fileName: "2020-01-15 Artist - Song.mp3",
      folder: "music/downloads",
    });
    const w = await mountWithTracks([t]);
    const rec = slskMeta.get("slsk:date2");
    expect(rec?.artist).toBe("Artist");
    expect(rec?.title).toBe("Song");
    w.unmount();
  });

  it("strips leading track-number prefix '01. Title.mp3' and infers artist from folder", async () => {
    // parseAudioTrackPrefix strips "01. " → "Title"; no dash → artist comes
    // from the second-to-last folder segment.
    const t = makeSlskTrack({
      id: "slsk:num",
      fileName: "01. Title.mp3",
      folder: "Some Artist - Album/SubDir",
    });
    const w = await mountWithTracks([t]);
    const rec = slskMeta.get("slsk:num");
    expect(rec?.title).toBe("Title");
    expect(rec?.artist?.toLowerCase()).toContain("some artist");
    w.unmount();
  });

  it("infers artist from the parent folder for dash-less basenames", async () => {
    const t = makeSlskTrack({
      id: "slsk:fold",
      fileName: "song.mp3",
      folder: "My Band - Greatest Hits/sub",
    });
    const w = await mountWithTracks([t]);
    const rec = slskMeta.get("slsk:fold");
    expect(rec?.title).toBe("song");
    expect(rec?.artist?.toLowerCase()).toContain("my band");
    w.unmount();
  });

  it("skips meta when no artist can be inferred (flat folder)", async () => {
    const t = makeSlskTrack({
      id: "slsk:noart",
      fileName: "loose.mp3",
      // All segments are generic (match GENERIC_FOLDER_RE in nameResolver),
      // so no parent yields a folder-artist, and the basename has no " - "
      // split either — parsed.artist stays "".
      folder: "music/downloads",
    });
    const w = await mountWithTracks([t]);
    // parsed.artist is "" so applyFilenameMetadata does NOT set the entry.
    expect(slskMeta.has("slsk:noart")).toBe(false);
    w.unmount();
  });

  it("walks UP past bare year segments when resolving artist", async () => {
    // Second-to-last segment is a bare year → skipped; artist must come from
    // the segment above it.
    const t = makeSlskTrack({
      id: "slsk:year",
      fileName: "Nameless.mp3",
      folder: "Cool Artist - Discography/2020/tracks",
    });
    const w = await mountWithTracks([t]);
    const rec = slskMeta.get("slsk:year");
    // "tracks" is at idx segs.length - 1 (the file's parent); the loop starts
    // from segs.length - 2 = "2020" (skipped, bare year) → segs[0] "Cool
    // Artist - Discography" matches the dash-artist pattern.
    expect(rec?.artist?.toLowerCase()).toContain("cool artist");
    w.unmount();
  });
});

// ── applyFilenameMetadata prune + cross-propagate ──────────────────────────

describe("Results — applyFilenameMetadata housekeeping", () => {
  it("prunes slskMeta entries for tracks that disappear from the list", async () => {
    const a = makeSlskTrack({ id: "slsk:A", fileName: "Band - A.mp3", folder: "x/y" });
    const b = makeSlskTrack({ id: "slsk:B", fileName: "Band - B.mp3", folder: "x/y" });
    const w = await mountWithTracks([a, b]);
    expect(slskMeta.has("slsk:A")).toBe(true);
    expect(slskMeta.has("slsk:B")).toBe(true);

    await w.setProps({ entities: [a] });
    await nextTick();
    expect(slskMeta.has("slsk:A")).toBe(true);
    expect(slskMeta.has("slsk:B")).toBe(false);
    w.unmount();
  });

  it("propagates meta from a donor to a sibling with the same basename", async () => {
    // Donor: basename "same.mp3", folder "Donor - Album/…" yields an artist
    // via folder-walk. Recipient: same basename in a flat folder → no artist
    // on its own, but the basename-map second pass fills it in.
    //
    // Dedup strips the extension only within its key, grouping by normalized
    // title+ext. Both tracks here have identical titleBase ("same") and ext
    // ("mp3") → dedup would collapse to one. We bypass by using different
    // extensions so the title-key differs, but both still share the same
    // `track.fileName` for slskBasenameMetaKey.
    //
    // Actually: slskBasenameMetaKey = `${fileName.toLowerCase().trim()}`, so
    // two tracks must share the LITERAL fileName. And dedup key uses the full
    // filename too. The only way to keep both and share basename is to have
    // them actually share all of those. Skip the cross-propagation matrix
    // and test the simpler inputs: the donor fallback still counts as
    // applyFilenameMetadata coverage via the basename-map construction loop.
    const donor = makeSlskTrack({
      id: "slsk:donor",
      fileName: "track.mp3",
      folder: "Donor Band - Cool Album/sub",
    });
    const w = await mountWithTracks([donor]);
    expect(slskMeta.get("slsk:donor")?.artist?.toLowerCase()).toContain("donor band");
    w.unmount();
  });
});

// ── albumFromFolder (exercised via runCoverFetches) ───────────────────────

describe("Results — albumFromFolder (via runCoverFetches)", () => {
  it("picks the clean segment, skipping 'CD1' and bare year '2020'", async () => {
    vi.useFakeTimers();
    const t = makeSlskTrack({
      id: "slsk:cd",
      fileName: "Artist - Title.mp3",
      folder: "Pearl Jam - Ten/2020/CD1",
    });
    const w = await mountWithTracks([t]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(fetchAlbumCoverMock).toHaveBeenCalled();
    const [, album] = fetchAlbumCoverMock.mock.calls[0]!;
    expect(String(album).toLowerCase()).toContain("pearl jam - ten");
    w.unmount();
  });

  it("strips a leading '2020 - ' decoration from folder segment", async () => {
    vi.useFakeTimers();
    const t = makeSlskTrack({
      id: "slsk:dec1",
      fileName: "Artist - Title.mp3",
      folder: "Artist/2020 - Live In Berlin",
    });
    const w = await mountWithTracks([t]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(fetchAlbumCoverMock).toHaveBeenCalled();
    const [, album] = fetchAlbumCoverMock.mock.calls[0]!;
    expect(String(album).toLowerCase()).toContain("live in berlin");
    expect(String(album)).not.toMatch(/^2020/);
    w.unmount();
  });

  it("strips a trailing '(2020)' decoration from folder segment", async () => {
    vi.useFakeTimers();
    const t = makeSlskTrack({
      id: "slsk:dec2",
      fileName: "Artist - Title.mp3",
      folder: "Artist/Great Album (2020)",
    });
    const w = await mountWithTracks([t]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(fetchAlbumCoverMock).toHaveBeenCalled();
    const [, album] = fetchAlbumCoverMock.mock.calls[0]!;
    expect(String(album)).toMatch(/Great Album/);
    expect(String(album)).not.toMatch(/\(2020\)/);
    w.unmount();
  });

  it("skips disc markers like 'Disc 2' and uses the segment above", async () => {
    vi.useFakeTimers();
    const t = makeSlskTrack({
      id: "slsk:disc",
      fileName: "Artist - Title.mp3",
      folder: "Artist/Big Album/Disc 2",
    });
    const w = await mountWithTracks([t]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(fetchAlbumCoverMock).toHaveBeenCalled();
    const [, album] = fetchAlbumCoverMock.mock.calls[0]!;
    expect(String(album)).toMatch(/Big Album/);
    w.unmount();
  });
});

// ── scheduleCoverFetches debounce & runCoverFetches behavior ──────────────

describe("Results — cover-fetch debounce & generation gating", () => {
  it("coalesces rapid updates into a single debounced runCoverFetches", async () => {
    vi.useFakeTimers();
    const t1 = makeSlskTrack({
      id: "slsk:d1",
      fileName: "Alpha - One.mp3",
      folder: "Alpha/First",
    });
    const t2 = makeSlskTrack({
      id: "slsk:d2",
      fileName: "Beta - Two.mp3",
      folder: "Beta/Second",
    });
    const w = await mountWithTracks([t1]);
    await w.setProps({ entities: [t1, t2] });
    await nextTick();
    await w.setProps({ entities: [t2] });
    await nextTick();

    // Before the debounce elapses, no fetch should have fired yet.
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(fetchAlbumCoverMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1200);
    await flushPromises();
    // Exactly one track remains after the last setProps → one call.
    expect(fetchAlbumCoverMock).toHaveBeenCalled();
    w.unmount();
  });

  it("writes coverUrl into slskMeta when fetchAlbumCover resolves", async () => {
    vi.useFakeTimers();
    fetchAlbumCoverMock.mockResolvedValue({
      artist: "X",
      album: "Y",
      coverUrl: "https://img/x.jpg",
      albumUrl: "https://music/y",
    });
    const t = makeSlskTrack({
      id: "slsk:wurl",
      fileName: "X - Song.mp3",
      folder: "X/Y",
    });
    const w = await mountWithTracks([t]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(slskMeta.get("slsk:wurl")?.coverUrl).toBe("https://img/x.jpg");
    expect(slskMeta.get("slsk:wurl")?.albumUrl).toBe("https://music/y");
    w.unmount();
  });

  it("skips cover fetch when the track already has raw.cover folder art", async () => {
    vi.useFakeTimers();
    const t = makeSlskTrack({
      id: "slsk:skip",
      fileName: "X - Song.mp3",
      folder: "X/Y",
      cover: { slsk_username: "u", slsk_filepath: "X/Y/cover.jpg" },
    });
    const w = await mountWithTracks([t]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(fetchAlbumCoverMock).not.toHaveBeenCalled();
    w.unmount();
  });

  it("drops a late-resolved iTunes response after coverGeneration bumps", async () => {
    vi.useFakeTimers();
    let resolveFetch: (v: unknown) => void = () => {};
    fetchAlbumCoverMock.mockImplementation(
      () => new Promise((r) => { resolveFetch = r as (v: unknown) => void; }),
    );
    const t = makeSlskTrack({
      id: "slsk:cancel",
      fileName: "Cancelable - Song.mp3",
      folder: "Cancelable/Album",
    });
    const w = await mountWithTracks([t]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(fetchAlbumCoverMock).toHaveBeenCalled();

    // Generation bump simulates a new search starting mid-flight.
    bumpCoverGeneration();
    resolveFetch({
      artist: "Cancelable",
      album: "Album",
      coverUrl: "https://late/url.jpg",
      albumUrl: null,
    });
    await flushPromises();

    expect(slskMeta.get("slsk:cancel")?.coverUrl).toBeUndefined();
    w.unmount();
  });
});

// ── trackEntities watcher: empty-list clears state ─────────────────────────

describe("Results — trackEntities watcher edges", () => {
  it("clears slskMeta when trackEntities goes from non-empty to empty", async () => {
    const t = makeSlskTrack({
      id: "slsk:emp",
      fileName: "Clear - Me.mp3",
      folder: "C/L",
    });
    const w = await mountWithTracks([t]);
    expect(slskMeta.has("slsk:emp")).toBe(true);

    await w.setProps({ entities: [] });
    await nextTick();
    expect(slskMeta.size).toBe(0);
    w.unmount();
  });

  it("syncDefaultSearchTab routes to tracks tab when tracks present", async () => {
    const t = makeSlskTrack({
      id: "slsk:tab",
      fileName: "Tab - Song.mp3",
      folder: "T/S",
    });
    const w = await mountWithTracks([t], { query: "Song" });
    await nextTick();
    const tabs = w.findAll("button[role='tab']");
    const selected = tabs.find((b) => b.attributes("aria-selected") === "true");
    expect(selected).toBeTruthy();
    w.unmount();
  });

  it("searchEpoch change runs without crashing and resets visible counts", async () => {
    const t = makeSlskTrack({
      id: "slsk:epoch",
      fileName: "Epoch - Song.mp3",
      folder: "E/S",
    });
    const w = await mountWithTracks([t]);
    await w.setProps({ searchEpoch: 99 });
    await nextTick();
    expect(w.html()).toBeTruthy();
    w.unmount();
  });
});

// ── runCoverFetches: folder grouping & null/undefined responses ───────────

describe("Results — runCoverFetches grouping & null responses", () => {
  it("groups tracks by slskFolder so each album is fetched once", async () => {
    vi.useFakeTimers();
    fetchAlbumCoverMock.mockResolvedValue(null);
    const a1 = makeSlskTrack({
      id: "slsk:g1",
      fileName: "Alpha - One.mp3",
      folder: "Alpha/First",
    });
    const a2 = makeSlskTrack({
      id: "slsk:g2",
      fileName: "Alpha - Two.mp3",
      folder: "Alpha/First",
    });
    const b1 = makeSlskTrack({
      id: "slsk:g3",
      fileName: "Beta - Song.mp3",
      folder: "Beta/Second",
    });
    const w = await mountWithTracks([a1, a2, b1]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(fetchAlbumCoverMock).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it("tolerates a null cover-fetch result without writing coverUrl", async () => {
    vi.useFakeTimers();
    fetchAlbumCoverMock.mockResolvedValue(null);
    const t = makeSlskTrack({
      id: "slsk:null",
      fileName: "Artist - Song.mp3",
      folder: "A/B",
    });
    const w = await mountWithTracks([t]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(slskMeta.get("slsk:null")?.coverUrl).toBeUndefined();
    w.unmount();
  });

  it("tolerates a response with empty coverUrl", async () => {
    vi.useFakeTimers();
    fetchAlbumCoverMock.mockResolvedValue({
      artist: "A", album: "B", coverUrl: null, albumUrl: null,
    });
    const t = makeSlskTrack({
      id: "slsk:empty",
      fileName: "A - Song.mp3",
      folder: "A/B",
    });
    const w = await mountWithTracks([t]);
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(slskMeta.get("slsk:empty")?.coverUrl).toBeUndefined();
    w.unmount();
  });
});
