<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import AlbumCard from "./AlbumCard.vue";
import SlskTrackRow from "./SlskTrackRow.vue";
import { isLikelyPlayable, stripMetaTags, parseAudioTrackPrefix } from "../../lib/utils.js";
import { fetchAlbumCover } from "../../audio/coverFetch.js";
import {
  slskMeta,
  coverGeneration, bumpCoverGeneration,
  coverTimer, setCoverTimer, clearCoverTimer,
} from "../../soulseek/slskMetaStore.js";

const props = defineProps({
  results: Array,
  selectedId: { default: null },
});

const emit = defineEmits(["select", "play-slsk-track", "download-slsk-track", "like-slsk-track"]);

const INITIAL_BATCH = 40;
const BATCH_INCREMENT = 30;

const isSoulseek = computed(() => props.results[0]?.source === "soulseek");

const playableResults = computed(() =>
  isSoulseek.value
    ? props.results
    : props.results.filter((r) => isLikelyPlayable(r.name, r.category))
);
const hiddenCount = computed(() => props.results.length - playableResults.value.length);

const visibleCount = ref(INITIAL_BATCH);
const visibleResults = computed(() => playableResults.value.slice(0, visibleCount.value));

watch(() => props.results, () => { visibleCount.value = INITIAL_BATCH; });
watch(playableResults, () => { visibleCount.value = INITIAL_BATCH; });

const sentinel = ref(null);
let observer = null;

function setupObserver() {
  if (!sentinel.value) return;
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && visibleCount.value < playableResults.value.length) {
        visibleCount.value = Math.min(visibleCount.value + BATCH_INCREMENT, playableResults.value.length);
      }
    },
    { rootMargin: "200px" },
  );
  observer.observe(sentinel.value);
}

onMounted(() => {
  nextTick(setupObserver);
});
onUnmounted(() => {
  observer?.disconnect();
});

watch(
  () => [props.results?.length, isSoulseek.value],
  () => nextTick(setupObserver),
);

// ── SoulSeek metadata enrichment ─────────────────────────────────────────────
// slskMeta / coverGeneration / coverTimer live in slskMetaStore.js (module-level)
// so they survive navigation and component remounts.

/**
 * Parse artist/title from a SoulSeek track's filename + folder path.
 * Handles patterns like:
 *   "[2024-05-05] Пошлая молли - супермаркет.flac"
 *   "01 - Artist - Track Title.mp3"
 *   "Artist\Album\03. Track Name.flac"
 */
function parseSlskFilename(track) {
  const name   = track.name ?? "";
  const folder = track.slsk_folder ?? "";

  // Remove file extension
  const dot  = name.lastIndexOf(".");
  let base   = dot > 0 ? name.slice(0, dot) : name;

  // Strip date-stamp prefix: [2024-05-05], (2024.05.05), 2024-05-05
  base = base
    .replace(/^[\[(]\d{4}[-./]\d{2}[-./]\d{2}[\])]\s*/, "")
    .replace(/^\d{4}[-./]\d{2}[-./]\d{2}\s+/, "");

  // Strip leading track number: "01 -", "02. ", "03 "
  const trackParsed = parseAudioTrackPrefix(base);
  if (trackParsed) base = trackParsed.title;

  // Strip common meta tags ([FLAC], [320kbps], (Deluxe Edition), …)
  base = stripMetaTags(base).trim();

  // Try "Artist - Title" pattern in the cleaned filename
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };

  // Fallback: derive artist from folder hierarchy.
  // slsk_folder is the directory containing the file, e.g. "UserShare/Artist/Album".
  // The last segment is typically the album — skip it. Require at least 2 segments
  // so we don't mistake the album folder itself for the artist.
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

/**
 * Normalized file name for matching duplicate peers (same `track.name`, different folders).
 *
 * Args:
 *     name: Row `name` (basename with extension).
 *
 * Returns:
 *     Lowercase trimmed string, or "".
 */
function slskBasenameMetaKey(name) {
  return String(name ?? "").trim().toLowerCase();
}

/**
 * Parse filenames and populate slskMeta synchronously — no API, no VPN needed.
 * Drops slskMeta entries not in this result set (avoids stale rows from a prior search).
 * Second pass copies artist/title from another row with the same basename when folder-based
 * parse failed for a peer (same file name, different `slsk_folder` layout).
 *
 * Args:
 *     tracks: Current SoulSeek result rows after grouping.
 *
 * Returns:
 *     void
 */
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
    const k = slskBasenameMetaKey(track.name);
    if (k && !metaByBasename.has(k)) metaByBasename.set(k, meta);
  }
  for (const track of tracks) {
    if (slskMeta.has(track.id)) continue;
    const donor = metaByBasename.get(slskBasenameMetaKey(track.name));
    if (donor?.artist && donor?.title) {
      slskMeta.set(track.id, { artist: donor.artist, title: donor.title });
    }
  }
}

/**
 * iTunes cover fetch for tracks that don't have a folder cover image.
 * Debounced 1.5 s so it only fires once after results settle.
 */
function scheduleCoverFetches() {
  clearCoverTimer();
  setCoverTimer(setTimeout(runCoverFetches, 1500));
}

/**
 * Extract album name from a SoulSeek folder path.
 * Last segment is the immediate parent dir (usually the album).
 * Skip year-only and disc-marker segments.
 */
function albumFromFolder(folder) {
  if (!folder) return "";
  const segs = folder.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    // Strip leading year (e.g. "2013 - Album Name" → "Album Name")
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
  if (!isSoulseek.value) return;
  const gen = bumpCoverGeneration();

  // One iTunes request per unique folder (= album), not per track.
  const folderMap = new Map();
  for (const track of playableResults.value) {
    if (track.slsk_cover_filepath) continue;   // already has folder art
    const meta = slskMeta.get(track.id);
    if (!meta || meta.coverUrl) continue;
    const key = track.slsk_folder ?? track.id;
    if (!folderMap.has(key)) folderMap.set(key, { track, ids: [] });
    folderMap.get(key).ids.push(track.id);
  }

  for (const { track, ids } of folderMap.values()) {
    if (gen !== coverGeneration) break;
    const meta = slskMeta.get(track.id);
    if (!meta) continue;
    const album = albumFromFolder(track.slsk_folder) || meta.title;

    fetchAlbumCover(meta.artist, album).then((result) => {
      if (gen !== coverGeneration || !result?.coverUrl) return;
      for (const id of ids) {
        const cur = slskMeta.get(id);
        if (!cur || cur.coverUrl) continue;
        // iTunes returns the canonical artist name — use it to correct filename-parsed guesses
        // (e.g. "Pablo Honey - Creep.mp3" gets parsed as artist="Pablo Honey", but iTunes
        // knows the real artist is "Radiohead").
        const artist = result.artist || cur.artist;
        slskMeta.set(id, { ...cur, artist, coverUrl: result.coverUrl, albumUrl: result.albumUrl });
      }
    });
  }
}

watch(
  () => props.results,
  (newResults) => {
    if (!newResults?.length || newResults[0]?.source !== "soulseek") {
      slskMeta.clear();
      bumpCoverGeneration();
      clearCoverTimer();
      return;
    }
    applyFilenameMetadata(newResults);
    scheduleCoverFetches();
  },
);
</script>

<template>
  <div v-if="results.length">

    <!-- ── SoulSeek: flat track list + covers ─────────────────────────────── -->
    <template v-if="isSoulseek">
      <div class="section-header">
        <h2 class="section-title">Результаты</h2>
        <span class="section-count">{{ playableResults.length }} треков</span>
      </div>
      <div class="slsk-tracklist">
        <SlskTrackRow
          v-for="t in visibleResults"
          :key="t.id"
          :track="t"
          :enriched="slskMeta.get(t.id) ?? null"
          @play="emit('play-slsk-track', $event)"
          @download="emit('download-slsk-track', $event)"
          @like="emit('like-slsk-track', $event)"
        />
      </div>
      <div ref="sentinel" />
    </template>

    <!-- ── Rutracker ─────────────────────────────────────────────────────── -->
    <template v-else>
      <div class="section-header">
        <h2 class="section-title">Результаты</h2>
        <span class="section-count">
          {{ playableResults.length }} раздач
          <span v-if="hiddenCount > 0" class="section-count-hidden">(скрыто {{ hiddenCount }} видео)</span>
        </span>
      </div>
      <div class="results-grid">
        <AlbumCard
          v-for="(r, i) in visibleResults"
          :key="r.id ?? i"
          :torrent="r"
          :selected="selectedId === r.id"
          @select="emit('select', $event)"
        />
      </div>
      <div ref="sentinel" />
    </template>

  </div>
</template>
