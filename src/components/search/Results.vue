<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import AlbumCard from "./AlbumCard.vue";
import SlskTrackRow from "./SlskTrackRow.vue";
import { peerBlacklistVersion } from "../../soulseek/peerBlacklist.js";
import { fetchAlbumCover } from "../../audio/coverFetch.js";
import {
  slskMeta,
  coverGeneration, bumpCoverGeneration,
  coverTimer, setCoverTimer, clearCoverTimer,
  enrichedIds,
} from "../../soulseek/slskMetaStore.js";
import { resolveTrackNames } from "../../track/nameResolver.js";
import { enrichTrackNames } from "../../track/deezerCanonical.js";

/**
 * Search results panel. Takes the engine's Entity stream directly — no
 * legacy row adapters. Albums and Tracks are passed to their respective
 * cards as-is.
 */
const props = defineProps({
  searchEpoch: { type: Number, default: 0 },
  /** @type {import("vue").PropType<Array<import("../../types/entities.js").Track | import("../../types/entities.js").Album>>} */
  entities: { type: Array, default: () => [] },
  loadingAlbums: { type: Boolean, default: false },
  loadingTracks: { type: Boolean, default: false },
  rtLoggedIn: { type: Boolean, default: false },
  slskConnected: { type: Boolean, default: false },
  rtError: { type: String, default: null },
  slskError: { type: String, default: null },
  slskPeerFilter: { type: String, default: null },
  selectedId: { default: null },
  /** Canonical query used for similarity ranking in the Tracks tab. */
  query: { type: String, default: "" },
  /** Full ResolveResult from the resolver (used for empty-state context). */
  resolved: { type: Object, default: null },
  /** True while the resolver is running — suppresses the empty state flash. */
  resolving: { type: Boolean, default: false },
  /** Parent-owned selected tab for back/forward restore. */
  activeTab: { type: String, default: "tracks" },
  /** Id of the currently-playing Track, or null. */
  nowPlayingId: { type: String, default: null },
  playerPlaying: { type: Boolean, default: false },
});

const emit = defineEmits([
  "select",                 // Album entity (RT or SLSK)
  "play-slsk-track",        // Track entity
  "download-slsk-track",
  "like-slsk-track",
  "open-slsk-source",
  "clear-slsk-peer-filter",
  "add-to-playlist-slsk",
  "update:active-tab",
]);

const INITIAL_BATCH = 40;
const BATCH_INCREMENT = 30;

// ── Split entities into Albums / Tracks for the two tabs ─────────────────────

/** All Album entities (both RT and SLSK), in entity-stream order. */
const albumEntities = computed(() =>
  (props.entities ?? []).filter((e) => e.type === "album"),
);

/** Lowercase alnum tokens for ranking. Unicode-aware so CJK / Cyrillic pass. */
function _queryTokens(q) {
  return String(q ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Similarity: how many distinct query tokens appear in the track's text. */
function _similarityScore(queryTokenSet, track) {
  if (!queryTokenSet.size) return 0;
  const hay = [track.artist, track.title, track.fileName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  let hits = 0;
  for (const tok of queryTokenSet) if (hay.includes(tok)) hits += 1;
  return hits;
}

/**
 * SoulSeek Track entities — deduped across entities by normalized title +
 * extension so multi-peer copies of the same song don't clog the feed.
 * Ranked by similarity to the effective provider query.
 */
const trackEntities = computed(() => {
  const src = props.entities ?? [];
  const byKey = new Map();
  const normalize = (s) => String(s ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (const e of src) {
    if (e.type !== "track" || e.sources?.[0]?.kind !== "soulseek") continue;
    // Dedup on resolver-stamped artist + title (not raw filename) so peers
    // with different basenames but the same song collapse into one entry.
    const artistN = normalize(e.artist ?? "");
    const titleN = normalize(e.title ?? "");
    if (!titleN) continue;
    const ext = (e.fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
    const key = `${artistN}|${titleN}.${ext}`;
    const existing = byKey.get(key);
    if (!existing || (e.bitrate ?? 0) > (existing.bitrate ?? 0)) byKey.set(key, e);
  }
  const dedup = Array.from(byKey.values());

  const qTokens = new Set(_queryTokens(props.query));
  return dedup
    .map((e, origIdx) => ({
      e,
      origIdx,
      score: _similarityScore(qTokens, e),
      bitrate: e.bitrate ?? 0,
    }))
    .sort((a, b) =>
      b.score - a.score
      || b.bitrate - a.bitrate
      || a.origIdx - b.origIdx,
    )
    .map((x) => x.e);
});

/** Tracks filtered by the optional SLSK peer filter + session peer blacklist. */
const trackEntitiesFiltered = computed(() => {
  peerBlacklistVersion.value; // reactive dep
  const raw = trackEntities.value;
  const f = props.slskPeerFilter?.trim();
  const fl = f?.toLowerCase() ?? null;
  return raw.filter((t) => {
    if (fl && String(t.sources?.[0]?.refs?.slskUsername ?? "").toLowerCase() !== fl) {
      return false;
    }
    // Drop tracks whose every seeder has already failed us this session.
    if (typeof t.hasLivePeer === "function" && !t.hasLivePeer()) return false;
    return true;
  });
});

const slskFilterEmptyHint = computed(
  () =>
    Boolean(props.slskPeerFilter?.trim()) &&
    !trackEntitiesFiltered.value.length &&
    trackEntities.value.length > 0,
);

const allEmpty = computed(() => {
  if (props.resolving || props.loadingAlbums || props.loadingTracks) return false;
  if (props.rtError || props.slskError) return false;
  if (!props.rtLoggedIn && !props.slskConnected) return false;
  // Don't swallow the peer-filter "show all tracks" affordance — without it the
  // user gets stuck inside a peer browse that returned zero matching files.
  if (slskFilterEmptyHint.value) return false;
  const albumsEmpty = !props.rtLoggedIn || albumEntities.value.length === 0;
  const tracksEmpty = !props.slskConnected || trackEntitiesFiltered.value.length === 0;
  return albumsEmpty && tracksEmpty;
});

const emptyStateQuery = computed(() => props.query || null);

// ── Infinite scroll ──────────────────────────────────────────────────────────
const visibleAlbumCount = ref(INITIAL_BATCH);
const visibleTrackCount = ref(INITIAL_BATCH);

const visibleAlbums = computed(() =>
  albumEntities.value.slice(0, visibleAlbumCount.value),
);
const visibleTracks = computed(() =>
  trackEntitiesFiltered.value.slice(0, visibleTrackCount.value),
);

watch(() => props.searchEpoch, () => {
  visibleAlbumCount.value = INITIAL_BATCH;
  visibleTrackCount.value = INITIAL_BATCH;
});
watch(albumEntities, () => {
  if (visibleAlbumCount.value < INITIAL_BATCH) visibleAlbumCount.value = INITIAL_BATCH;
});
watch(trackEntitiesFiltered, () => {
  if (visibleTrackCount.value < INITIAL_BATCH) visibleTrackCount.value = INITIAL_BATCH;
});

// Background TCP probe used to run here — disabled because it races with
// real prepareStream calls for the shared `pending_peer_addr` oneshot slot
// in the Rust session. Server address lookups were being dropped, which
// made every click fail. If we want a probe-based whitelist again, it needs
// either (a) deduped per-peer lookup cache in Rust, or (b) a separate
// lookup path that doesn't share state with transfer prep.

const sentinelAlbum = ref(null);
const sentinelTrack = ref(null);
let observerAlbum = null;
let observerTrack = null;

function setupObservers() {
  if (sentinelAlbum.value) {
    observerAlbum?.disconnect();
    observerAlbum = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && visibleAlbumCount.value < albumEntities.value.length) {
          visibleAlbumCount.value = Math.min(
            visibleAlbumCount.value + BATCH_INCREMENT,
            albumEntities.value.length,
          );
        }
      },
      { rootMargin: "200px" },
    );
    observerAlbum.observe(sentinelAlbum.value);
  }
  if (sentinelTrack.value) {
    observerTrack?.disconnect();
    observerTrack = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && visibleTrackCount.value < trackEntitiesFiltered.value.length) {
          visibleTrackCount.value = Math.min(
            visibleTrackCount.value + BATCH_INCREMENT,
            trackEntitiesFiltered.value.length,
          );
        }
      },
      { rootMargin: "200px" },
    );
    observerTrack.observe(sentinelTrack.value);
  }
}

onMounted(() => nextTick(setupObservers));
onUnmounted(() => {
  observerAlbum?.disconnect();
  observerTrack?.disconnect();
});

watch(
  () => [albumEntities.value.length, trackEntitiesFiltered.value.length],
  () => nextTick(setupObservers),
);

// ── Active tab ───────────────────────────────────────────────────────────────
function normalizeTab(tab) {
  return tab === "albums" ? "albums" : "tracks";
}

/** Tracks are the priority surface; parent stores current tab for nav restore. */
const activeTab = ref(normalizeTab(props.activeTab));

function pickDefaultSearchTab() {
  const na = albumEntities.value.length;
  const nt = trackEntitiesFiltered.value.length;
  if (nt > 0) return "tracks";
  if (na > 0) return "albums";
  return "tracks";
}

watch(
  () => props.searchEpoch,
  () => nextTick(() => { activeTab.value = pickDefaultSearchTab(); }),
);

watch(
  () => props.activeTab,
  (tab) => {
    const normalized = normalizeTab(tab);
    if (normalized !== activeTab.value) activeTab.value = normalized;
  },
);

watch(
  activeTab,
  (tab) => {
    emit("update:active-tab", normalizeTab(tab));
  },
);

watch(
  () => props.slskPeerFilter,
  (v) => { if (v?.trim()) activeTab.value = "tracks"; },
);

// ── SoulSeek metadata enrichment (filename parsing + iTunes cover lookup) ────

/**
 * Derive an `{artist, title}` display pair for slskMeta enrichment. Delegates
 * to the deterministic resolver so we keep one source of truth — previously
 * this had its own naive splitter that produced bogus "01" artists from
 * "01-01 - Title" paths.
 */
function parseSlskFilename(track) {
  const r = resolveTrackNames(track);
  return { artist: r.artist, title: r.title };
}

function slskBasenameMetaKey(name) {
  return String(name ?? "").trim().toLowerCase();
}

function applyFilenameMetadata(tracks) {
  // Streaming searches grow the row set monotonically — `slskMeta.size <=
  // tracks.length` holds after each settle, so the stale-key sweep would
  // be pure overhead for the common popular-query case. Run it only when
  // there ARE potential orphans (size dropped, or stale meta carried over
  // from a previous query without an epoch bump).
  if (slskMeta.size > tracks.length) {
    const incomingIds = new Set(tracks.map((t) => t.id));
    for (const id of [...slskMeta.keys()]) {
      if (!incomingIds.has(id)) slskMeta.delete(id);
    }
  }
  for (const track of tracks) {
    if (slskMeta.has(track.id)) continue;
    const parsed = parseSlskFilename(track);
    if (parsed.artist && parsed.title) slskMeta.set(track.id, parsed);
  }
  const metaByBasename = new Map();
  for (const track of tracks) {
    const meta = slskMeta.get(track.id);
    if (!meta?.artist || !meta?.title) continue;
    const k = slskBasenameMetaKey(track.fileName);
    if (k && !metaByBasename.has(k)) metaByBasename.set(k, meta);
  }
  for (const track of tracks) {
    if (slskMeta.has(track.id)) continue;
    const donor = metaByBasename.get(slskBasenameMetaKey(track.fileName));
    if (donor?.artist && donor?.title) {
      slskMeta.set(track.id, { artist: donor.artist, title: donor.title });
    }
  }
  // Stage 2 — Deezer canonical names. Dispatch once per id per query so a
  // 30-batch streaming search doesn't re-enter the per-track resolve/cache
  // path 30× for the same track.
  for (const track of tracks) {
    if (enrichedIds.has(track.id)) continue;
    enrichedIds.add(track.id);
    enrichTrackNames(track);
  }
}

function scheduleCoverFetches() {
  clearCoverTimer();
  setCoverTimer(setTimeout(runCoverFetches, 1500));
}

function albumFromFolder(folder) {
  if (!folder) return "";
  const segs = folder.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i].trim()
      .replace(/^(19|20)\d{2}\s*[-–—]\s*/, "")
      .replace(/\s*[\[(](19|20)\d{2}[\])]\s*$/, "")
      .trim();
    if (s.length >= 2 && !/^\d{4}$/.test(s) && !/^(cd|disc|disk|part|диск)\s*\d+$/i.test(s))
      return s;
  }
  return "";
}

function runCoverFetches() {
  const tracks = trackEntities.value;
  if (!tracks.length) return;
  const gen = bumpCoverGeneration();

  const folderMap = new Map();
  for (const track of trackEntitiesFiltered.value) {
    const coverRef = track.getCoverRef?.() ?? null;
    if (coverRef?.slsk_filepath) continue;   // already has folder art
    const meta = slskMeta.get(track.id);
    if (!meta || meta.coverUrl) continue;
    const folder = track.sources?.[0]?.refs?.slskFolder ?? track.id;
    const key = folder;
    if (!folderMap.has(key)) folderMap.set(key, { track, ids: [] });
    folderMap.get(key).ids.push(track.id);
  }

  for (const { track, ids } of folderMap.values()) {
    if (gen !== coverGeneration) break;
    const meta = slskMeta.get(track.id);
    if (!meta) continue;
    const folder = track.sources?.[0]?.refs?.slskFolder ?? "";
    const album = albumFromFolder(folder) || meta.title;
    fetchAlbumCover(meta.artist, album).then((result) => {
      if (gen !== coverGeneration || !result?.coverUrl) return;
      for (const id of ids) {
        const cur = slskMeta.get(id);
        if (!cur || cur.coverUrl) continue;
        const artist = result.artist || cur.artist;
        slskMeta.set(id, { ...cur, artist, coverUrl: result.coverUrl, albumUrl: result.albumUrl });
      }
    });
  }
}

// Once-per-query reset: drop stale meta from the previous search so the
// donor index doesn't pull names from unrelated rows. Cheaper than running
// a cleanup loop on every streaming batch.
watch(() => props.searchEpoch, () => {
  slskMeta.clear();
  enrichedIds.clear();
  bumpCoverGeneration();
  clearCoverTimer();
});

watch(
  trackEntities,
  (rows) => {
    if (!rows?.length) {
      slskMeta.clear();
      enrichedIds.clear();
      bumpCoverGeneration();
      clearCoverTimer();
      return;
    }
    applyFilenameMetadata(rows);
    scheduleCoverFetches();
  },
);

// ── Click routing ────────────────────────────────────────────────────────────

function onAlbumClick(album) {
  emit("select", album);
}
</script>

<template src="./Results.html"></template>

<style scoped src="./Results.scoped.css"></style>

