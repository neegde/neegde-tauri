<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import AlbumCard from "./AlbumCard.vue";
import SlskTrackRow from "./SlskTrackRow.vue";
import { stripMetaTags, parseAudioTrackPrefix } from "../../lib/utils.js";
import { fetchAlbumCover } from "../../audio/coverFetch.js";
import {
  slskMeta,
  coverGeneration, bumpCoverGeneration,
  coverTimer, setCoverTimer, clearCoverTimer,
} from "../../soulseek/slskMetaStore.js";

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
});

const emit = defineEmits([
  "select",                 // Album entity (RT or SLSK)
  "play-slsk-track",        // Track entity
  "download-slsk-track",
  "like-slsk-track",
  "open-slsk-source",
  "clear-slsk-peer-filter",
  "add-to-playlist-slsk",
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
  for (const e of src) {
    if (e.type !== "track" || e.sources?.[0]?.kind !== "soulseek") continue;
    const titleBase = (e.fileName ?? "").replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/^\(?\d{1,3}\)?[-.)]?\s+/, "")
      .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
      .trim()
      .replace(/[^\p{L}\p{N}]/gu, "");
    const ext = (e.fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
    const key = `${titleBase}.${ext}`;
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

/** Tracks filtered by the optional SLSK peer filter. */
const trackEntitiesFiltered = computed(() => {
  const raw = trackEntities.value;
  const f = props.slskPeerFilter?.trim();
  if (!f) return raw;
  const fl = f.toLowerCase();
  return raw.filter(
    (t) => String(t.sources?.[0]?.refs?.slskUsername ?? "").toLowerCase() === fl,
  );
});

const slskFilterEmptyHint = computed(
  () =>
    Boolean(props.slskPeerFilter?.trim()) &&
    !trackEntitiesFiltered.value.length &&
    trackEntities.value.length > 0,
);

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
/** Tracks are the priority surface — default tab. */
const activeTab = ref("tracks");

function syncDefaultSearchTab() {
  const na = albumEntities.value.length;
  const nt = trackEntitiesFiltered.value.length;
  if (nt > 0) activeTab.value = "tracks";
  else if (na > 0) activeTab.value = "albums";
  else activeTab.value = "tracks";
}

watch(
  () => [props.searchEpoch, albumEntities.value.length, trackEntitiesFiltered.value.length],
  () => nextTick(syncDefaultSearchTab),
  { immediate: true },
);

watch(
  () => props.slskPeerFilter,
  (v) => { if (v?.trim()) activeTab.value = "tracks"; },
);

// ── SoulSeek metadata enrichment (filename parsing + iTunes cover lookup) ────

function parseSlskFilename(track) {
  const name = track.fileName ?? "";
  const folder = track.sources?.[0]?.refs?.slskFolder ?? "";
  const dot = name.lastIndexOf(".");
  let base = dot > 0 ? name.slice(0, dot) : name;
  base = base
    .replace(/^[\[(]\d{4}[-./]\d{2}[-./]\d{2}[\])]\s*/, "")
    .replace(/^\d{4}[-./]\d{2}[-./]\d{2}\s+/, "");
  const trackParsed = parseAudioTrackPrefix(base);
  if (trackParsed) base = trackParsed.title;
  base = stripMetaTags(base).trim();

  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };

  const segs = folder.split("/").filter(Boolean);
  if (segs.length < 2) return { artist: "", title: base };
  const start = segs.length - 2;
  for (let i = start; i >= 0; i--) {
    const seg = stripMetaTags(segs[i]).trim();
    if (!seg || /^\d{4}$/.test(seg)) continue;
    const fm = seg.match(/^(.+?)\s+[-–—]\s+/);
    const artist = fm ? fm[1].trim() : seg;
    if (artist.length >= 2) return { artist, title: base };
  }
  return { artist: "", title: base };
}

function slskBasenameMetaKey(name) {
  return String(name ?? "").trim().toLowerCase();
}

function applyFilenameMetadata(tracks) {
  const incomingIds = new Set(tracks.map((t) => t.id));
  for (const id of [...slskMeta.keys()]) {
    if (!incomingIds.has(id)) slskMeta.delete(id);
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
    const coverRef = track.sources?.[0]?.raw?.cover;
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

watch(
  trackEntities,
  (rows) => {
    if (!rows?.length) {
      slskMeta.clear();
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

