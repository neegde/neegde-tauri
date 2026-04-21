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
  /** Incremented in App only when the user starts a new search (not on SoulSeek batches). */
  searchEpoch: { type: Number, default: 0 },
  albumResults: { type: Array, default: () => [] },
  trackResults: { type: Array, default: () => [] },
  loadingAlbums: { type: Boolean, default: false },
  loadingTracks: { type: Boolean, default: false },
  rtLoggedIn: { type: Boolean, default: false },
  slskConnected: { type: Boolean, default: false },
  rtError: { type: String, default: null },
  slskError: { type: String, default: null },
  /** When set, only tracks from this SoulSeek username are listed (search still network-wide). */
  slskPeerFilter: { type: String, default: null },
  selectedId: { default: null },
});

const emit = defineEmits([
  "select",
  "play-slsk-track",
  "download-slsk-track",
  "like-slsk-track",
  "open-slsk-source",
  "clear-slsk-peer-filter",
]);

const INITIAL_BATCH = 40;
const BATCH_INCREMENT = 30;

const albumPlayable = computed(() =>
  (props.albumResults ?? []).filter((r) => isLikelyPlayable(r.name, r.category)),
);
const hiddenAlbumCount = computed(
  () => (props.albumResults?.length ?? 0) - albumPlayable.value.length,
);

const trackResultsRaw = computed(() => props.trackResults ?? []);

 /**
  * SoulSeek rows for the tracks tab; optionally narrowed to one username.
  *
  * Returns:
  *     Filtered track rows.
  */
const trackPlayable = computed(() => {
  const raw = trackResultsRaw.value;
  const f = props.slskPeerFilter?.trim();
  if (!f) return raw;
  const fl = f.toLowerCase();
  return raw.filter((t) => String(t.slsk_username ?? "").toLowerCase() === fl);
});

const slskFilterEmptyHint = computed(
  () =>
    Boolean(props.slskPeerFilter?.trim()) &&
    !trackPlayable.value.length &&
    trackResultsRaw.value.length > 0,
);

const visibleAlbumCount = ref(INITIAL_BATCH);
const visibleTrackCount = ref(INITIAL_BATCH);

const visibleAlbums = computed(() => albumPlayable.value.slice(0, visibleAlbumCount.value));
const visibleTracks = computed(() => trackPlayable.value.slice(0, visibleTrackCount.value));

watch(() => props.albumResults, () => { visibleAlbumCount.value = INITIAL_BATCH; });
watch(albumPlayable, () => { visibleAlbumCount.value = INITIAL_BATCH; });
watch(() => props.trackResults, () => { visibleTrackCount.value = INITIAL_BATCH; });
watch(trackPlayable, () => { visibleTrackCount.value = INITIAL_BATCH; });

const sentinelAlbum = ref(null);
const sentinelTrack = ref(null);
let observerAlbum = null;
let observerTrack = null;

/**
 * Attaches infinite-scroll observers for album and track lists.
 *
 * Returns:
 *     void
 */
function setupObservers() {
  if (sentinelAlbum.value) {
    observerAlbum?.disconnect();
    observerAlbum = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && visibleAlbumCount.value < albumPlayable.value.length) {
          visibleAlbumCount.value = Math.min(
            visibleAlbumCount.value + BATCH_INCREMENT,
            albumPlayable.value.length,
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
        if (entries[0].isIntersecting && visibleTrackCount.value < trackPlayable.value.length) {
          visibleTrackCount.value = Math.min(
            visibleTrackCount.value + BATCH_INCREMENT,
            trackPlayable.value.length,
          );
        }
      },
      { rootMargin: "200px" },
    );
    observerTrack.observe(sentinelTrack.value);
  }
}

onMounted(() => {
  nextTick(setupObservers);
});
onUnmounted(() => {
  observerAlbum?.disconnect();
  observerTrack?.disconnect();
});

watch(
  () => [
    props.albumResults?.length,
    albumPlayable.value.length,
    props.trackResults?.length,
    trackPlayable.value.length,
  ],
  () => nextTick(setupObservers),
);

/** `"tracks"` | `"albums"` — only one panel visible to avoid long vertical scroll. */
const activeTab = ref("tracks");

/**
 * Picks a sensible default tab after new search data (prefer tracks when both exist).
 *
 * Returns:
 *     void
 */
function syncDefaultSearchTab() {
  const na = albumPlayable.value.length;
  const nt = trackPlayable.value.length;
  if (nt > 0 && na === 0) activeTab.value = "tracks";
  else if (na > 0 && nt === 0) activeTab.value = "albums";
  else if (na > 0 && nt > 0) activeTab.value = "tracks";
  else activeTab.value = "albums";
}

watch(
  () => props.searchEpoch,
  () => nextTick(syncDefaultSearchTab),
  { immediate: true },
);

watch(activeTab, () => nextTick(setupObservers));

watch(
  () => props.slskPeerFilter,
  (v) => {
    if (v?.trim()) activeTab.value = "tracks";
  },
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
  if (!props.trackResults?.length) return;
  const gen = bumpCoverGeneration();

  // One iTunes request per unique folder (= album), not per track.
  const folderMap = new Map();
  for (const track of trackPlayable.value) {
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
  () => props.trackResults,
  (newResults) => {
    if (!newResults?.length) {
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
  <div class="search-results-combined">
    <div class="likes-tabs search-results-tabs" role="tablist" aria-label="Тип результатов">
      <button
        type="button"
        role="tab"
        class="likes-tab"
        :class="{ active: activeTab === 'tracks' }"
        :aria-selected="activeTab === 'tracks'"
        @click="activeTab = 'tracks'"
      >
        Треки
        <span v-if="trackPlayable.length" class="search-tab-badge">{{ trackPlayable.length }}</span>
        <span v-else-if="loadingTracks" class="search-tab-badge search-tab-badge--muted">…</span>
      </button>
      <button
        type="button"
        role="tab"
        class="likes-tab"
        :class="{ active: activeTab === 'albums' }"
        :aria-selected="activeTab === 'albums'"
        @click="activeTab = 'albums'"
      >
        Альбомы
        <span v-if="albumPlayable.length" class="search-tab-badge">{{ albumPlayable.length }}</span>
        <span v-else-if="loadingAlbums" class="search-tab-badge search-tab-badge--muted">…</span>
      </button>
    </div>

    <!-- ── SoulSeek (tracks) ──────────────────────────────────────────────── -->
    <section
      v-show="activeTab === 'tracks'"
      class="search-section"
      role="tabpanel"
      aria-label="Треки SoulSeek"
    >
      <p v-if="!slskConnected" class="search-section-hint">
        Подключите <strong>SoulSeek</strong> в настройках — здесь появятся отдельные файлы с сети.
      </p>
      <p v-else-if="slskError" class="search-section-error">{{ slskError }}</p>
      <p
        v-else-if="slskConnected && !loadingTracks && !trackPlayable.length && !slskFilterEmptyHint"
        class="search-section-hint"
      >
        По SoulSeek ничего не найдено.
      </p>
      <p v-else-if="slskFilterEmptyHint" class="search-section-hint">
        В этой выдаче нет файлов от пользователя <strong>{{ slskPeerFilter }}</strong>.
        <button type="button" class="search-peer-filter-clear" @click="emit('clear-slsk-peer-filter')">
          Показать все треки
        </button>
      </p>

      <div
        v-if="slskPeerFilter?.trim() && trackPlayable.length"
        class="search-peer-filter-banner"
      >
        <span>Файлы пользователя {{ slskPeerFilter }}</span>
        <button type="button" class="search-peer-filter-clear" @click="emit('clear-slsk-peer-filter')">
          Все треки выдачи
        </button>
      </div>

      <div v-if="trackPlayable.length" class="slsk-tracklist">
        <SlskTrackRow
          v-for="t in visibleTracks"
          :key="t.id"
          :track="t"
          :enriched="slskMeta.get(t.id) ?? null"
          @play="emit('play-slsk-track', $event)"
          @download="emit('download-slsk-track', $event)"
          @like="emit('like-slsk-track', $event)"
          @open-source="emit('open-slsk-source', $event)"
        />
      </div>
      <div ref="sentinelTrack" />
    </section>

    <!-- ── Rutracker (albums) ─────────────────────────────────────────────── -->
    <section
      v-show="activeTab === 'albums'"
      class="search-section"
      role="tabpanel"
      aria-label="Альбомы Rutracker"
    >
      <p v-if="!rtLoggedIn" class="search-section-hint">
        Войдите в <strong>Rutracker</strong> в настройках — здесь появятся альбомы и полные раздачи.
      </p>
      <p v-else-if="rtError" class="search-section-error">{{ rtError }}</p>
      <p
        v-else-if="rtLoggedIn && !loadingAlbums && !albumPlayable.length"
        class="search-section-hint"
      >
        По Rutracker ничего не найдено.
      </p>
      <p
        v-if="hiddenAlbumCount > 0 && albumPlayable.length"
        class="search-section-meta"
      >
        Скрыто раздач с видео: {{ hiddenAlbumCount }}
      </p>

      <div v-if="albumPlayable.length" class="results-grid">
        <AlbumCard
          v-for="(r, i) in visibleAlbums"
          :key="r.id ?? i"
          :torrent="r"
          :selected="selectedId === r.id"
          @select="emit('select', $event)"
        />
      </div>
      <div ref="sentinelAlbum" />
    </section>
  </div>
</template>

<style scoped>
.search-results-combined {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.search-results-tabs {
  padding-top: 0;
  padding-bottom: 12px;
  flex-wrap: wrap;
}

.search-tab-badge {
  margin-left: 6px;
  opacity: 0.85;
  font-variant-numeric: tabular-nums;
}

.search-tab-badge--muted {
  opacity: 0.55;
  letter-spacing: 0;
}

.search-section-hint {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  color: var(--muted);
  line-height: 1.45;
}

.search-section-error {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  color: var(--accent);
  line-height: 1.45;
}

.search-section-meta {
  margin: -0.25rem 0 0.75rem;
  font-size: 0.8rem;
  color: var(--muted2);
}

.search-peer-filter-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 0 12px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 0.88rem;
  color: var(--text);
  background: rgba(var(--accent-rgb), 0.12);
  border: 1px solid rgba(var(--accent-rgb), 0.28);
}

.search-peer-filter-clear {
  margin: 0;
  padding: 4px 10px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--accent);
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}

.search-peer-filter-clear:hover {
  background: rgba(255, 255, 255, 0.14);
}

[data-theme="light"] .search-peer-filter-clear {
  background: rgba(0, 0, 0, 0.06);
}
</style>
