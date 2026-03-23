<script setup>
import { ref, computed, watch, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  isAudio,
  isImage,
  basename,
  fmtSize,
  fmtDate,
  detectAlbums,
  sumFileSizes,
  MAX_TORRENT_COVER_BYTES,
} from "../utils.js";
import { disposeTorrentPreview } from "../torrentSession.js";
import AlbumFolderCover from "./AlbumFolderCover.vue";

/** Warm in-memory cover cache + BT `only_files` union before cards scroll into view. */
const PREFETCH_ALBUM_COVERS = 12;

const lastCoverPrefetchKey = ref("");

const props = defineProps({
  torrent: Object,
  files: Array,
  loading: Boolean,
  magnet: String,
  cover: { type: String, default: null },
  nowPlayingIdx: { default: null },
  likes: Object,
});

const emit = defineEmits([
  "play", "play-all", "play-album",
  "download", "download-all", "download-album",
  "toggle-like", "back",
]);

// ── View mode ────────────────────────────────────────────────────────────────
const viewMode = ref(localStorage.getItem("albumViewMode") || "list");

function setViewMode(mode) {
  viewMode.value = mode;
  localStorage.setItem("albumViewMode", mode);
  expandedIdx.value = null;
}

// Gallery: index of the expanded album (shows tracklist below the grid)
const expandedIdx = ref(null);

function toggleExpand(idx) {
  expandedIdx.value = expandedIdx.value === idx ? null : idx;
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
  const n = album.name?.trim();
  if (n) return n;
  if (list.length === 1) return props.torrent?.name?.trim() || "Альбом";
  if (album.dirPath) {
    const seg = album.dirPath.split("/").filter(Boolean).pop();
    if (seg) return seg;
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

function seedsLabel(n) {
  return `${n} сид${n === 1 ? "" : n < 5 ? "а" : "ов"}`;
}

function trackLikeId(torrent, f) {
  return `track:${torrent.source}:${torrent.id}:${f.origIdx}`;
}

function albumLikeId(torrent, dirPath) {
  return `album:${torrent.source}:${torrent.id}:${dirPath || "root"}`;
}

function makeTrackLike(torrent, magnet, f) {
  return {
    id: trackLikeId(torrent, f),
    type: "track",
    torrentId: torrent.id,
    torrentName: torrent.name,
    source: torrent.source,
    magnet,
    fileIdx: f.origIdx,
    fileName: basename(f.path),
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

watch(
  () => props.magnet,
  () => {
    disposeTorrentPreview();
    expandedIdx.value = null;
  }
);

function prefetchAlbumCovers() {
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

  for (const fileIdx of indices) {
    invoke("torrent_fetch_image", { magnet: m, fileIdx }).catch(() => {});
  }
}

watch(
  () => [props.magnet, props.loading, props.files],
  () => {
    prefetchAlbumCovers();
  },
  { flush: "post" }
);

onUnmounted(() => {
  disposeTorrentPreview();
});
</script>

<template>
  <div class="torrent-page">

    <div class="torrent-nav">
      <button class="back-btn" @click="emit('back')">← Назад к результатам</button>
    </div>

    <div class="album-header">
      <div class="album-cover">
        <img v-if="cover" :src="cover" alt="Обложка" class="cover-img" />
        <span v-else>🎵</span>
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
          <span class="dot">·</span>
          <span :class="seeds > 0 ? 'seeds-ok' : 'seeds-dead'">
            {{ seedsLabel(seeds) }}
          </span>
          <template v-if="torrent.added && torrent.added !== '—'">
            <span class="dot">·</span>
            <span>{{ fmtDate(torrent.added) }}</span>
          </template>
        </div>
      </div>
    </div>

    <div v-if="!loading && totalAudio > 0" class="album-actions">
      <button class="btn-play-all" @click="emit('play-all')">
        ▶&nbsp; Слушать всё
      </button>
      <button class="btn-dl-all" @click="emit('download-all')">
        ↓&nbsp; Скачать всё ({{ totalAudio }})
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

    <div v-if="loading" class="loading-tracks">
      <span class="spinner" /> Загрузка файлов…
    </div>

    <p v-else-if="albums.length === 0" class="empty-msg">Аудиофайлы не найдены.</p>

    <!-- ── LIST VIEW ─────────────────────────────────────────────────────── -->
    <template v-else-if="viewMode === 'list'">
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
          >{{ likes?.[albumLikeId(torrent, wrap.raw.dirPath)] ? "♥" : "♡" }}</button>
          <button class="btn-play-album" title="Слушать альбом" @click="emit('play-album', wrap.raw.audioFiles)">▶</button>
          <button class="btn-dl-album" title="Скачать альбом" @click="emit('download-album', wrap.raw.audioFiles)">↓</button>
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
          :class="['track-row', nowPlayingIdx === f.origIdx ? 'playing' : '']"
          @click="emit('play', f.origIdx, f.path)"
        >
          <div class="track-num">
            <span v-if="nowPlayingIdx === f.origIdx" class="playing-anim">♪</span>
            <template v-else>
              <span class="track-num-val">{{ trackOffset(albumIdx) + i + 1 }}</span>
              <span class="track-num-icon">▶</span>
            </template>
          </div>
          <div class="track-info">
            <div class="track-name" :title="basename(f.path)">{{ basename(f.path) }}</div>
          </div>
          <div class="track-size">{{ f.size > 0 ? fmtSize(f.size) : "" }}</div>
          <div class="track-actions">
            <button
              :class="['track-btn', 'like-btn', likes?.[trackLikeId(torrent, f)] ? 'liked' : '']"
              :title="likes?.[trackLikeId(torrent, f)] ? 'Убрать лайк' : 'Нравится'"
              @click.stop="emit('toggle-like', makeTrackLike(torrent, magnet, f))"
            >{{ likes?.[trackLikeId(torrent, f)] ? "♥" : "♡" }}</button>
            <button class="track-btn" title="Слушать" @click.stop="emit('play', f.origIdx, f.path)">▶</button>
            <button class="track-btn dl" title="Скачать" @click.stop="emit('download', f.origIdx, f.path)">↓</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ── GALLERY VIEW ──────────────────────────────────────────────────── -->
    <template v-else>
      <div class="album-gallery">
        <div
          v-for="(wrap, albumIdx) in displayAlbums"
          :key="wrap.raw.dirPath || String(albumIdx)"
          :class="['gallery-card', expandedIdx === albumIdx ? 'gallery-card--active' : '']"
          @click="toggleExpand(albumIdx)"
        >
          <div class="gallery-card-cover">
            <AlbumFolderCover
              :magnet="magnet"
              :cover-file="wrap.raw.coverFile"
              :label="wrap.displayName"
              :cover="cover"
            />
            <div class="gallery-card-overlay">
              <button
                class="gallery-play-btn"
                title="Слушать альбом"
                @click.stop="emit('play-album', wrap.raw.audioFiles)"
              >▶</button>
            </div>
          </div>
          <div class="gallery-card-name" :title="wrap.displayName">{{ wrap.displayName }}</div>
          <div class="gallery-card-count">{{ countLabel(wrap.raw.audioFiles.length) }}</div>
        </div>
      </div>

      <!-- Expanded tracklist for the selected gallery card -->
      <div
        v-if="expandedIdx !== null && displayAlbums[expandedIdx]"
        class="gallery-expanded"
      >
        <div class="gallery-expanded-header">
          <div class="album-section-cover" style="width:48px;height:48px">
            <AlbumFolderCover
              :magnet="magnet"
              :cover-file="displayAlbums[expandedIdx].raw.coverFile"
              :label="displayAlbums[expandedIdx].displayName"
              :cover="cover"
            />
          </div>
          <div class="album-section-info">
            <div class="album-section-kind">Альбом</div>
            <div class="album-section-name">{{ displayAlbums[expandedIdx].displayName }}</div>
            <div class="album-section-count">{{ countLabel(displayAlbums[expandedIdx].raw.audioFiles.length) }}</div>
          </div>
          <button
            :class="['track-btn', 'like-btn', 'album-like-btn', likes?.[albumLikeId(torrent, displayAlbums[expandedIdx].raw.dirPath)] ? 'liked' : '']"
            :title="likes?.[albumLikeId(torrent, displayAlbums[expandedIdx].raw.dirPath)] ? 'Убрать лайк' : 'Нравится'"
            @click="emit('toggle-like', makeAlbumLike(torrent, magnet, displayAlbums[expandedIdx].raw, displayAlbums[expandedIdx].displayName))"
          >{{ likes?.[albumLikeId(torrent, displayAlbums[expandedIdx].raw.dirPath)] ? "♥" : "♡" }}</button>
          <button class="btn-play-album" title="Слушать альбом" @click="emit('play-album', displayAlbums[expandedIdx].raw.audioFiles)">▶</button>
          <button class="btn-dl-album" title="Скачать альбом" @click="emit('download-album', displayAlbums[expandedIdx].raw.audioFiles)">↓</button>
          <button class="gallery-close-btn" title="Закрыть" @click="expandedIdx = null">✕</button>
        </div>

        <div class="tracklist-header">
          <span>#</span>
          <span style="padding-left: 12px">Название</span>
          <span style="text-align: right">Размер</span>
          <span />
        </div>
        <div
          v-for="(f, i) in displayAlbums[expandedIdx].raw.audioFiles"
          :key="f.origIdx"
          :class="['track-row', nowPlayingIdx === f.origIdx ? 'playing' : '']"
          @click="emit('play', f.origIdx, f.path)"
        >
          <div class="track-num">
            <span v-if="nowPlayingIdx === f.origIdx" class="playing-anim">♪</span>
            <template v-else>
              <span class="track-num-val">{{ trackOffset(expandedIdx) + i + 1 }}</span>
              <span class="track-num-icon">▶</span>
            </template>
          </div>
          <div class="track-info">
            <div class="track-name" :title="basename(f.path)">{{ basename(f.path) }}</div>
          </div>
          <div class="track-size">{{ f.size > 0 ? fmtSize(f.size) : "" }}</div>
          <div class="track-actions">
            <button
              :class="['track-btn', 'like-btn', likes?.[trackLikeId(torrent, f)] ? 'liked' : '']"
              :title="likes?.[trackLikeId(torrent, f)] ? 'Убрать лайк' : 'Нравится'"
              @click.stop="emit('toggle-like', makeTrackLike(torrent, magnet, f))"
            >{{ likes?.[trackLikeId(torrent, f)] ? "♥" : "♡" }}</button>
            <button class="track-btn" title="Слушать" @click.stop="emit('play', f.origIdx, f.path)">▶</button>
            <button class="track-btn dl" title="Скачать" @click.stop="emit('download', f.origIdx, f.path)">↓</button>
          </div>
        </div>
      </div>
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
</style>
