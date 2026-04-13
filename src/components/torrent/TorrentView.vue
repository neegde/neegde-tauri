<script setup>
import { ref, computed, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  isAudio,
  isImage,
  basename,
  trackDisplayBasename,
  audioFormatLabel,
  fmtSize,
  fmtSizeParts,
  fmtDate,
  detectAlbums,
  sumFileSizes,
  MAX_TORRENT_COVER_BYTES,
  enrichMagnetWithOpenTrackers,
  extractTrackArtist,
  stripMetaTags,
  parseAudioTrackPrefix,
  isDiscMarker,
  extractAlbumFromTorrentName,
} from "../../lib/utils.js";
import { enrichAlbumTracklist } from "../../audio/metadataEnrich.js";
import AlbumFolderCover from "./AlbumFolderCover.vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import { torrentFileB64ForTrack } from "../../torrent/api.js";

/** Warm in-memory cover cache + BT `only_files` union before cards scroll into view. */
const PREFETCH_ALBUM_COVERS = 12;

const lastCoverPrefetchKey = ref("");

/**
 * iTunes-enriched data for albums keyed by album dirPath.
 * { artist, album, coverUrl, tracksByNumber: Map<number, string> }
 */
const enrichedAlbumData = ref(/** @type {Map<string, object>} */ (new Map()));

const props = defineProps({
  torrent: Object,
  files: Array,
  loading: Boolean,
  magnet: String,
  cover: { type: String, default: null },
  nowPlayingIdx: { default: null },
  /** Синхронно с кнопкой play/pause в нижнем плеере. */
  playerPlaying: { type: Boolean, default: true },
  likes: Object,
});

const emit = defineEmits([
  "play", "play-all", "play-album",
  "download", "download-all", "download-album",
  "toggle-like",
  "open-album-preview",
  "hover-track",
  "add-to-playlist",
]);

// ── Hover prefetch ────────────────────────────────────────────────────────────
let _hoverTimer = null;
let _lastHoveredIdx = null;

function onTrackHover(origIdx) {
  if (origIdx === props.nowPlayingIdx) return;
  if (origIdx === _lastHoveredIdx) return;
  clearTimeout(_hoverTimer);
  _hoverTimer = setTimeout(() => {
    _lastHoveredIdx = origIdx;
    emit("hover-track", origIdx);
  }, 280);
}

function onTrackLeave() {
  clearTimeout(_hoverTimer);
}

// ── View mode ────────────────────────────────────────────────────────────────
const viewMode = ref(localStorage.getItem("albumViewMode") || "list");

function setViewMode(mode) {
  viewMode.value = mode;
  localStorage.setItem("albumViewMode", mode);
}

/** Gallery card: open album preview. Play starts only on explicit ▶ button press. */
function openAlbumFromGallery(wrap) {
  emit("open-album-preview", {
    album: wrap.raw,
    displayName: wrap.displayName,
  });
}

// ── Albums ───────────────────────────────────────────────────────────────────
const albums = computed(() => detectAlbums(props.files));

const displayAlbums = computed(() => {
  const list = albums.value;
  return list.map((a) => ({
    raw: a,
    displayName: albumDisplayName(a, list),
  }));
});

function albumDisplayName(album, list) {
  // Prefer iTunes-enriched album name
  const enriched = enrichedAlbumData.value.get(album.dirPath ?? "");
  if (enriched?.album) return enriched.album;

  const n = album.name?.trim();
  // Skip disc-marker dirs (CD1, Disc 2, etc.) and derive name from a better source
  if (n && !isDiscMarker(n)) return stripMetaTags(n) || n;

  // Single album: extract "Album" from "Artist - Album" torrent title
  if (list.length === 1) {
    const fromTorrent = extractAlbumFromTorrentName(props.torrent?.name?.trim() ?? "");
    return fromTorrent || props.torrent?.name?.trim() || "Альбом";
  }
  // Multi-album: walk dirPath upward to find a non-disc folder name
  if (album.dirPath) {
    const parts = album.dirPath.split("/").filter(Boolean);
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!isDiscMarker(parts[i])) {
        return extractAlbumFromTorrentName(parts[i]) || stripMetaTags(parts[i]) || parts[i];
      }
    }
    const seg = parts[parts.length - 1];
    if (seg) return stripMetaTags(seg) || seg;
  }
  return "Альбом";
}

const totalAudio = computed(() =>
  albums.value.reduce((sum, a) => sum + a.audioFiles.length, 0)
);

const totalBytes = computed(() => {
  const fromFiles = sumFileSizes(props.files);
  if (fromFiles > 0) return fromFiles;
  const t = Number(props.torrent?.size);
  return Number.isFinite(t) ? t : 0;
});

const seeds = computed(() => Number(props.torrent.seeders) || 0);
const source = computed(() =>
  props.torrent.source === "rutracker" ? "Rutracker" : "The Pirate Bay"
);

function countLabel(n) {
  return `${n} ${n === 1 ? "трек" : n < 5 ? "трека" : "треков"}`;
}

function playingRowClass(origIdx) {
  if (props.nowPlayingIdx !== origIdx) return [];
  return ["playing", props.playerPlaying ? "playing--active" : "playing--paused"];
}

function seedsLabel(n) {
  return `${n} сид${n === 1 ? "" : n < 5 ? "а" : "ов"}`;
}

function trackLikeId(torrent, f) {
  return `track:${torrent.source}:${torrent.id}:${f.origIdx}`;
}

function albumLikeId(torrent, dirPath) {
  return `album:${torrent.source}:${torrent.id}:${dirPath || "root"}`;
}

function torrentLikeId(torrent) {
  return `torrent:${torrent.source}:${torrent.id}`;
}

/**
 * Builds a torrent-level like payload.
 * @param {object} torrent
 * @param {string} magnet
 * @returns {object}
 */
function makeTorrentLike(torrent, magnet) {
  return {
    id: torrentLikeId(torrent),
    type: "torrent",
    torrentId: torrent.id,
    torrentName: torrent.name,
    source: torrent.source,
    magnet: magnet || null,
    seeders: torrent.seeders,
  };
}

function makeTrackLike(torrent, magnet, f) {
  let coverFileIdx = null;
  /** Как у лайка альбома — чтобы во вкладке «Треки» брать тот же origIdx, что и для coverFile в торренте. */
  let coverFile = null;
  for (const a of albums.value) {
    if (a.audioFiles.some((af) => af.origIdx === f.origIdx)) {
      const cf = a.coverFile;
      if (cf) {
        coverFileIdx = cf.origIdx ?? null;
        coverFile = {
          origIdx: cf.origIdx,
          path: cf.path,
          size: cf.size,
        };
      }
      break;
    }
  }
  return {
    id: trackLikeId(torrent, f),
    type: "track",
    torrentId: torrent.id,
    torrentName: torrent.name,
    source: torrent.source,
    magnet,
    fileIdx: f.origIdx,
    fileName: f.path,
    coverFileIdx,
    coverFile,
  };
}

function makePlaylistTrack(torrent, magnet, f) {
  let coverFileIdx = null;
  for (const a of albums.value) {
    if (a.audioFiles.some((af) => af.origIdx === f.origIdx)) {
      coverFileIdx = a.coverFile?.origIdx ?? null;
      break;
    }
  }
  return {
    magnet,
    fileIdx: f.origIdx,
    fileName: f.path,
    torrentName: torrent?.name ?? "",
    torrentId: torrent?.id ?? "",
    source: torrent?.source ?? "rutracker",
    artist: torrent?.artist ?? null,
    coverFileIdx,
  };
}

function makeAlbumLike(torrent, magnet, album, displayName) {
  const dirPath = album.dirPath || "root";
  return {
    id: albumLikeId(torrent, dirPath),
    type: "album",
    torrentId: torrent.id,
    torrentName: torrent.name,
    source: torrent.source,
    magnet,
    albumName: displayName,
    dirPath,
    audioFiles: album.audioFiles,
    coverFile: album.coverFile ?? null,
  };
}

function trackOffset(idx) {
  return albums.value.slice(0, idx).reduce((s, a) => s + a.audioFiles.length, 0);
}

// ── Share ─────────────────────────────────────────────────────────────────────
const shareCopied = ref(false);
let _shareCopiedTimer = null;

/**
 * Builds a neegde:// deep link for the current torrent and copies it to clipboard.
 * @param {object} torrent
 */
function shareLink(torrent) {
  const url = `neegde://torrent/${torrent.source}/${torrent.id}`;
  navigator.clipboard.writeText(url).then(() => {
    shareCopied.value = true;
    clearTimeout(_shareCopiedTimer);
    _shareCopiedTimer = setTimeout(() => { shareCopied.value = false; }, 2000);
  });
}

/** Один альбом в раздаче — полноэкранный герой с обложкой и треклистом. */
const isAlbumHeroPage = computed(() => {
  if (props.loading) return false;
  if (albums.value.length !== 1) return false;
  return totalAudio.value > 0;
});

const singleAlbumWrap = computed(() => displayAlbums.value[0] ?? null);

const albumHeroTitle = computed(
  () => singleAlbumWrap.value?.displayName?.trim() || props.torrent?.name?.trim() || "Альбом"
);

const albumHeroArtist = computed(() => {
  const album0 = albums.value[0];
  const enriched = enrichedAlbumData.value.get(album0?.dirPath ?? "");
  if (enriched?.artist) return enriched.artist;
  const artist = extractTrackArtist(props.torrent?.name, album0?.dirPath ?? null, props.torrent?.artist ?? null, props.magnet);
  return artist || "Неизвестный исполнитель";
});

async function prefetchAlbumCovers() {
  const m = props.magnet?.trim();
  if (!m || props.loading || !props.files?.length) return;

  const list = detectAlbums(props.files);
  const indices = [];
  const n = Math.min(list.length, PREFETCH_ALBUM_COVERS);
  for (let i = 0; i < n; i++) {
    const cf = list[i].coverFile;
    if (
      !cf ||
      !isImage(cf.path) ||
      cf.size <= 0 ||
      cf.size > MAX_TORRENT_COVER_BYTES
    ) {
      continue;
    }
    indices.push(cf.origIdx);
  }
  const key = `${m}:${indices.join(",")}`;
  if (key === lastCoverPrefetchKey.value) return;
  lastCoverPrefetchKey.value = key;

  const magnetEnriched = enrichMagnetWithOpenTrackers(m);
  // Await cached .torrent bytes to skip DHT metadata wait in image session.
  // By this point handleSelect already warmed the cache, so this usually resolves instantly.
  const torrentFileB64 = await torrentFileB64ForTrack({
    source: props.torrent?.source,
    torrentId: props.torrent?.id,
  }).catch(() => null);
  for (const fileIdx of indices) {
    invoke("torrent_fetch_image", {
      magnet: magnetEnriched,
      fileIdx,
      torrentFileB64: torrentFileB64 ?? null,
    }).catch(() => {});
  }
}

/** Enrich up to N albums with iTunes metadata (artist, album name, per-track titles). */
async function enrichAlbums() {
  if (props.loading || !props.files?.length) return;
  const list = albums.value;
  if (!list.length) return;

  const MAX_ALBUMS = 6;
  const toEnrich = list.slice(0, MAX_ALBUMS);

  for (const album of toEnrich) {
    const dirKey = album.dirPath ?? "";
    if (enrichedAlbumData.value.has(dirKey)) continue;

    const firstFile = album.audioFiles[0];
    if (!firstFile) continue;

    const artistRaw = extractTrackArtist(
      props.torrent?.name,
      album.dirPath ?? null,
      props.torrent?.artist ?? null,
      props.magnet
    );
    const albumIdx = list.indexOf(album);
    const albumNameRaw = displayAlbums.value[albumIdx]?.displayName || stripMetaTags(album.name?.trim() || "");

    if (!artistRaw || !albumNameRaw) continue;

    // Fire in background — don't await sequentially
    enrichAlbumTracklist(artistRaw, albumNameRaw).then((result) => {
      if (!result) return;
      const next = new Map(enrichedAlbumData.value);
      next.set(dirKey, result);
      enrichedAlbumData.value = next;
    });
  }
}

watch(
  () => [props.magnet, props.loading, props.files],
  () => {
    enrichedAlbumData.value = new Map(); // reset on new torrent
    prefetchAlbumCovers();
    void enrichAlbums();
  },
  { flush: "post" }
);

</script>

<template>
  <div
    :class="['torrent-page', isAlbumHeroPage && 'torrent-page--album-hero']"
  >

    <div v-if="loading" class="loading-tracks">
      <span class="spinner" /> Загрузка файлов…
    </div>

    <p v-else-if="albums.length === 0" class="empty-msg">Аудиофайлы не найдены.</p>

    <!-- ── Один альбом: герой + треклист ───────────────────────────────── -->
    <template v-else-if="isAlbumHeroPage && singleAlbumWrap">
      <div class="album-hero-bg" aria-hidden="true" />
      <section class="album-hero" aria-label="Альбом">
        <div class="album-hero-cover">
          <AlbumFolderCover
            :magnet="magnet"
            :cover-file="singleAlbumWrap.raw.coverFile"
            :label="albumHeroTitle"
            :cover="cover"
          />
        </div>
        <div class="album-hero-text">
          <span class="album-hero-kicker">Альбом</span>
          <h1 class="album-hero-title">{{ albumHeroTitle }}</h1>
          <p class="album-hero-artist">{{ albumHeroArtist }}</p>
          <p class="album-hero-meta">
            {{ countLabel(singleAlbumWrap.raw.audioFiles.length) }}
            <span class="dot">·</span>
            {{ fmtSize(totalBytes) }}
            <template v-if="!torrent.fromLikes">
              <span class="dot">·</span>
              <span :class="seeds > 0 ? 'seeds-ok' : 'seeds-dead'">{{ seedsLabel(seeds) }}</span>
            </template>
            <template v-if="torrent.category && torrent.category !== '—'">
              <span class="dot">·</span>
              {{ torrent.category }}
            </template>
          </p>
        </div>
      </section>

      <div class="album-hero-toolbar">
        <button
          type="button"
          class="album-play-fab"
          title="Слушать"
          @click="emit('play-all')"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="5,3 19,12 5,21"/>
          </svg>
        </button>
        <button
          type="button"
          :class="['album-tool-btn', likes?.[albumLikeId(torrent, singleAlbumWrap.raw.dirPath)] ? 'liked' : '']"
          :title="likes?.[albumLikeId(torrent, singleAlbumWrap.raw.dirPath)] ? 'Убрать из любимых' : 'В любимые'"
          @click="
            emit(
              'toggle-like',
              makeAlbumLike(torrent, magnet, singleAlbumWrap.raw, singleAlbumWrap.displayName)
            )
          "
        >
          <svg v-if="likes?.[albumLikeId(torrent, singleAlbumWrap.raw.dirPath)]" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
          <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
          </svg>
        </button>
        <button
          type="button"
          class="album-tool-btn"
          title="Скачать альбом"
          @click="emit('download-album', singleAlbumWrap.raw.audioFiles, singleAlbumWrap.displayName)"
        >
          ↓
        </button>
        <button
          type="button"
          :class="['album-tool-btn', shareCopied ? 'share-copied' : '']"
          :title="shareCopied ? 'Ссылка скопирована' : 'Поделиться'"
          @click="shareLink(torrent)"
        >
          <svg v-if="!shareCopied" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </button>
      </div>

      <div class="album-tracklist">
        <div class="album-tracklist-head">
          <span class="album-col-n">#</span>
          <span class="album-col-title">Название</span>
          <span class="album-col-time" />
        </div>
        <div
          v-for="(f, i) in singleAlbumWrap.raw.audioFiles"
          :key="f.origIdx"
          :class="['album-track-row', ...playingRowClass(f.origIdx)]"
          @click="emit('play', f.origIdx, f.path)"
          @mouseenter="onTrackHover(f.origIdx)"
          @mouseleave="onTrackLeave"
        >
          <div class="album-col-n">
            <PlayingIndicator v-if="nowPlayingIdx === f.origIdx" :live="playerPlaying" />
            <template v-else>
              <span class="album-num">{{ i + 1 }}</span>
              <span class="album-play-hint">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="5,3 19,12 5,21"/>
                </svg>
              </span>
            </template>
          </div>
          <div class="album-col-title">
            <div class="track-name-wrap">
              <span class="album-track-title" :title="trackDisplayBasename(f.path)">{{
                enrichedAlbumData.get(singleAlbumWrap.raw.dirPath ?? '')?.tracksByNumber?.get(parseAudioTrackPrefix(basename(f.path))?.order)
                || trackDisplayBasename(f.path)
              }}</span>
              <span class="track-format-chip" :title="`Формат: ${audioFormatLabel(f.path)}`">{{ audioFormatLabel(f.path) }}</span>
            </div>
          </div>
          <div class="album-col-time">
            <div v-if="f.size > 0" class="file-size-stack album-file-size-stack">
              <template v-for="p in [fmtSizeParts(f.size)]" :key="'sp-sz-' + f.origIdx">
                <span class="file-size-stack__value">{{ p.value }}</span>
                <span class="file-size-stack__unit">{{ p.unit }}</span>
              </template>
            </div>
            <span v-else class="album-dur album-dur--empty">—</span>
            <div class="album-track-actions">
              <button
                :class="['track-btn', 'like-btn', likes?.[trackLikeId(torrent, f)] ? 'liked' : '']"
                @click.stop="emit('toggle-like', makeTrackLike(torrent, magnet, f))"
              >
                <svg v-if="likes?.[trackLikeId(torrent, f)]" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
              </button>
              <button class="track-btn dl" title="Скачать" @click.stop="emit('download', f.origIdx, f.path)">↓</button>
              <button class="track-btn add-to-pl" title="В плейлист" @click.stop="emit('add-to-playlist', makePlaylistTrack(torrent, magnet, f))">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Multi-album: classic torrent header + list / gallery ─────────── -->
    <template v-else>
    <div class="album-header">
      <div class="album-cover">
        <img v-if="cover" :src="cover" alt="Обложка" class="cover-img" />
        <svg v-else width="64" height="64" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.4" aria-hidden="true">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
      </div>
      <div class="album-info">
        <div class="album-type">
          {{ torrent.fromLikes && torrent.artist ? torrent.artist : `Раздача · ${source}` }}
        </div>
        <h1 class="album-title">{{ torrent.name }}</h1>
        <div class="album-details">
          <template v-if="torrent.category && torrent.category !== '—'">
            <span>{{ torrent.category }}</span>
            <span class="dot">·</span>
          </template>
          <span>{{ fmtSize(totalBytes) }}</span>
          <template v-if="!torrent.fromLikes">
            <span class="dot">·</span>
            <span :class="seeds > 0 ? 'seeds-ok' : 'seeds-dead'">
              {{ seedsLabel(seeds) }}
            </span>
          </template>
          <template v-if="torrent.added && torrent.added !== '—'">
            <span class="dot">·</span>
            <span>{{ fmtDate(torrent.added) }}</span>
          </template>
        </div>
      </div>
    </div>

    <div v-if="!loading && totalAudio > 0" class="album-actions">
      <button class="btn-dl-all" @click="emit('download-all')">
        ↓&nbsp; Скачать всё ({{ totalAudio }})
      </button>
      <button
        :class="['track-btn', 'like-btn', likes?.[torrentLikeId(torrent)] ? 'liked' : '']"
        :title="likes?.[torrentLikeId(torrent)] ? 'Убрать раздачу из любимых' : 'Раздача в любимые'"
        @click="emit('toggle-like', makeTorrentLike(torrent, magnet))"
      >
        <svg v-if="likes?.[torrentLikeId(torrent)]" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
      </button>

      <button
        :class="['track-btn', shareCopied ? 'share-copied' : '']"
        :title="shareCopied ? 'Ссылка скопирована' : 'Поделиться'"
        @click="shareLink(torrent)"
      >
        <svg v-if="!shareCopied" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </button>

      <!-- View-mode toggle -->
      <div class="view-toggle">
        <button
          :class="['view-toggle-btn', viewMode === 'list' ? 'active' : '']"
          title="Список"
          @click="setViewMode('list')"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect x="0" y="2"  width="16" height="2" rx="1"/>
            <rect x="0" y="7"  width="16" height="2" rx="1"/>
            <rect x="0" y="12" width="16" height="2" rx="1"/>
          </svg>
        </button>
        <button
          :class="['view-toggle-btn', viewMode === 'gallery' ? 'active' : '']"
          title="Галерея"
          @click="setViewMode('gallery')"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect x="0"  y="0"  width="7" height="7" rx="1"/>
            <rect x="9"  y="0"  width="7" height="7" rx="1"/>
            <rect x="0"  y="9"  width="7" height="7" rx="1"/>
            <rect x="9"  y="9"  width="7" height="7" rx="1"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- ── LIST VIEW ─────────────────────────────────────────────────────── -->
    <template v-if="viewMode === 'list'">
      <div
        v-for="(wrap, albumIdx) in displayAlbums"
        :key="wrap.raw.dirPath || String(albumIdx)"
        class="album-section"
      >
        <div class="album-section-header">
          <div class="album-section-cover">
            <AlbumFolderCover
              :magnet="magnet"
              :cover-file="wrap.raw.coverFile"
              :label="wrap.displayName"
              :cover="cover"
              :enlargeable="false"
            />
          </div>
          <div class="album-section-info">
            <div class="album-section-kind">Альбом</div>
            <div class="album-section-name">{{ wrap.displayName }}</div>
            <div class="album-section-count">{{ countLabel(wrap.raw.audioFiles.length) }}</div>
          </div>
          <button
            :class="['track-btn', 'like-btn', 'album-like-btn', likes?.[albumLikeId(torrent, wrap.raw.dirPath)] ? 'liked' : '']"
            :title="likes?.[albumLikeId(torrent, wrap.raw.dirPath)] ? 'Убрать лайк' : 'Нравится'"
            @click="emit('toggle-like', makeAlbumLike(torrent, magnet, wrap.raw, wrap.displayName))"
          >
            <svg v-if="likes?.[albumLikeId(torrent, wrap.raw.dirPath)]" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </button>
          <button class="btn-play-album" title="Слушать альбом" @click="emit('play-album', wrap.raw.audioFiles)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
          </button>
          <button class="btn-dl-album" title="Скачать альбом" @click="emit('download-album', wrap.raw.audioFiles, wrap.displayName)">↓</button>
        </div>

        <div class="tracklist-header">
          <span>#</span>
          <span style="padding-left: 12px">Название</span>
          <span style="text-align: right">Размер</span>
          <span />
        </div>
        <div
          v-for="(f, i) in wrap.raw.audioFiles"
          :key="f.origIdx"
          :class="['track-row', ...playingRowClass(f.origIdx)]"
          @click="emit('play', f.origIdx, f.path)"
          @mouseenter="onTrackHover(f.origIdx)"
          @mouseleave="onTrackLeave"
        >
          <div class="track-num">
            <PlayingIndicator v-if="nowPlayingIdx === f.origIdx" :live="playerPlaying" />
            <template v-else>
              <span class="track-num-val">{{ trackOffset(albumIdx) + i + 1 }}</span>
              <span class="track-num-icon">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="5,3 19,12 5,21"/>
                </svg>
              </span>
            </template>
          </div>
          <div class="track-info">
            <div class="track-name-wrap">
              <div class="track-name" :title="trackDisplayBasename(f.path)">{{
                enrichedAlbumData.get(wrap.raw.dirPath ?? '')?.tracksByNumber?.get(parseAudioTrackPrefix(basename(f.path))?.order)
                || trackDisplayBasename(f.path)
              }}</div>
              <span class="track-format-chip" :title="`Формат: ${audioFormatLabel(f.path)}`">{{ audioFormatLabel(f.path) }}</span>
            </div>
          </div>
          <div class="track-size file-size-stack">
            <template v-for="p in f.size > 0 ? [fmtSizeParts(f.size)] : []" :key="'sz-' + f.origIdx">
              <span class="file-size-stack__value">{{ p.value }}</span>
              <span class="file-size-stack__unit">{{ p.unit }}</span>
            </template>
          </div>
          <div class="track-actions">
            <button
              :class="['track-btn', 'like-btn', likes?.[trackLikeId(torrent, f)] ? 'liked' : '']"
              :title="likes?.[trackLikeId(torrent, f)] ? 'Убрать лайк' : 'Нравится'"
              @click.stop="emit('toggle-like', makeTrackLike(torrent, magnet, f))"
            >
              <svg v-if="likes?.[trackLikeId(torrent, f)]" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
            </button>
            <button class="track-btn dl" title="Скачать" @click.stop="emit('download', f.origIdx, f.path)">↓</button>
            <button class="track-btn add-to-pl" title="В плейлист" @click.stop="emit('add-to-playlist', makePlaylistTrack(torrent, magnet, f))">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ── GALLERY VIEW ──────────────────────────────────────────────────── -->
    <template v-else-if="viewMode === 'gallery'">
      <div class="album-gallery">
        <div
          v-for="(wrap, albumIdx) in displayAlbums"
          :key="wrap.raw.dirPath || String(albumIdx)"
          class="gallery-card"
          @click="openAlbumFromGallery(wrap)"
        >
          <div class="gallery-card-cover">
            <AlbumFolderCover
              :magnet="magnet"
              :cover-file="wrap.raw.coverFile"
              :label="wrap.displayName"
              :cover="cover"
              :enlargeable="false"
            />
            <div class="gallery-card-overlay">
              <button
                class="gallery-play-btn"
                title="Слушать альбом"
                @click.stop="emit('play-album', wrap.raw.audioFiles)"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="5,3 19,12 5,21"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="gallery-card-name" :title="wrap.displayName">{{ wrap.displayName }}</div>
          <div class="gallery-card-count">{{ countLabel(wrap.raw.audioFiles.length) }}</div>
        </div>
      </div>
    </template>
    </template>

  </div>
</template>

<style scoped>
.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
  display: block;
}

.share-copied {
  color: var(--accent);
}
</style>
