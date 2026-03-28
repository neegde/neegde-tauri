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
  fmtDate,
  detectAlbums,
  sumFileSizes,
  MAX_TORRENT_COVER_BYTES,
  enrichMagnetWithOpenTrackers,
} from "../../lib/utils.js";
import AlbumFolderCover from "./AlbumFolderCover.vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import { torrentFileB64ForTrack } from "../../torrent/api.js";

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
  /** Синхронно с кнопкой play/pause в нижнем плеере. */
  playerPlaying: { type: Boolean, default: true },
  likes: Object,
});

const emit = defineEmits([
  "play", "play-all", "play-album",
  "download", "download-all", "download-album",
  "toggle-like",
  "open-album-preview",
]);

// ── View mode ────────────────────────────────────────────────────────────────
const viewMode = ref(localStorage.getItem("albumViewMode") || "list");

function setViewMode(mode) {
  viewMode.value = mode;
  localStorage.setItem("albumViewMode", mode);
}

/** Gallery → тот же предпросмотр, что при открытии лайкнутого альбома (только файлы альбома). */
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

/** Один альбом в раздаче — экран как превью альбома в Spotify (герой + треклист). */
const isSpotifyAlbumPage = computed(() => {
  if (props.loading) return false;
  if (albums.value.length !== 1) return false;
  return totalAudio.value > 0;
});

const singleAlbumWrap = computed(() => displayAlbums.value[0] ?? null);

const spotifyAlbumTitle = computed(
  () => singleAlbumWrap.value?.displayName?.trim() || props.torrent?.name?.trim() || "Альбом"
);

const spotifyArtist = computed(() => {
  if (props.torrent?.fromLikes && props.torrent?.artist) return props.torrent.artist;
  const m = props.torrent?.name?.match(/^(.+?)\s+[-–—]\s+/);
  if (m) return m[1].trim();
  return "Неизвестный исполнитель";
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

watch(
  () => [props.magnet, props.loading, props.files],
  () => {
    prefetchAlbumCovers();
  },
  { flush: "post" }
);

</script>

<template>
  <div
    :class="['torrent-page', isSpotifyAlbumPage && 'torrent-page--spotify-album']"
  >

    <div v-if="loading" class="loading-tracks">
      <span class="spinner" /> Загрузка файлов…
    </div>

    <p v-else-if="albums.length === 0" class="empty-msg">Аудиофайлы не найдены.</p>

    <!-- ── Spotify-style single album ───────────────────────────────────── -->
    <template v-else-if="isSpotifyAlbumPage && singleAlbumWrap">
      <div class="spotify-hero-bg" aria-hidden="true" />
      <section class="spotify-hero" aria-label="Альбом">
        <div class="spotify-hero-cover">
          <AlbumFolderCover
            :magnet="magnet"
            :cover-file="singleAlbumWrap.raw.coverFile"
            :label="spotifyAlbumTitle"
            :cover="cover"
          />
        </div>
        <div class="spotify-hero-text">
          <span class="spotify-hero-kicker">Альбом</span>
          <h1 class="spotify-hero-title">{{ spotifyAlbumTitle }}</h1>
          <p class="spotify-hero-artist">{{ spotifyArtist }}</p>
          <p class="spotify-hero-meta">
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

      <div class="spotify-toolbar">
        <button
          type="button"
          class="spotify-play-fab"
          title="Слушать"
          @click="emit('play-all')"
        >
          ▶
        </button>
        <button
          type="button"
          :class="['spotify-tool-btn', likes?.[albumLikeId(torrent, singleAlbumWrap.raw.dirPath)] ? 'liked' : '']"
          :title="likes?.[albumLikeId(torrent, singleAlbumWrap.raw.dirPath)] ? 'Убрать из любимых' : 'В любимые'"
          @click="
            emit(
              'toggle-like',
              makeAlbumLike(torrent, magnet, singleAlbumWrap.raw, singleAlbumWrap.displayName)
            )
          "
        >
          {{ likes?.[albumLikeId(torrent, singleAlbumWrap.raw.dirPath)] ? "♥" : "♡" }}
        </button>
        <button
          type="button"
          class="spotify-tool-btn"
          title="Скачать альбом"
          @click="emit('download-album', singleAlbumWrap.raw.audioFiles, singleAlbumWrap.displayName)"
        >
          ↓
        </button>
      </div>

      <div class="spotify-tracklist">
        <div class="spotify-tracklist-head">
          <span class="spotify-col-n">#</span>
          <span class="spotify-col-title">Название</span>
          <span class="spotify-col-time" />
        </div>
        <div
          v-for="(f, i) in singleAlbumWrap.raw.audioFiles"
          :key="f.origIdx"
          :class="['spotify-track-row', ...playingRowClass(f.origIdx)]"
          @click="emit('play', f.origIdx, f.path)"
        >
          <div class="spotify-col-n">
            <PlayingIndicator v-if="nowPlayingIdx === f.origIdx" :live="playerPlaying" />
            <template v-else>
              <span class="spotify-num">{{ i + 1 }}</span>
              <span class="spotify-play-hint">▶</span>
            </template>
          </div>
          <div class="spotify-col-title">
            <div class="track-name-wrap">
              <span class="spotify-track-title" :title="trackDisplayBasename(f.path)">{{ trackDisplayBasename(f.path) }}</span>
              <span class="track-format-chip" :title="`Формат: ${audioFormatLabel(f.path)}`">{{ audioFormatLabel(f.path) }}</span>
            </div>
          </div>
          <div class="spotify-col-time">
            <span class="spotify-dur">{{ f.size > 0 ? fmtSize(f.size) : "—" }}</span>
            <div class="spotify-track-actions">
              <button
                :class="['track-btn', 'like-btn', likes?.[trackLikeId(torrent, f)] ? 'liked' : '']"
                @click.stop="emit('toggle-like', makeTrackLike(torrent, magnet, f))"
              >{{ likes?.[trackLikeId(torrent, f)] ? "♥" : "♡" }}</button>
              <button class="track-btn" title="Слушать" @click.stop="emit('play', f.origIdx, f.path)">▶</button>
              <button class="track-btn dl" title="Скачать" @click.stop="emit('download', f.origIdx, f.path)">↓</button>
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
          >{{ likes?.[albumLikeId(torrent, wrap.raw.dirPath)] ? "♥" : "♡" }}</button>
          <button class="btn-play-album" title="Слушать альбом" @click="emit('play-album', wrap.raw.audioFiles)">▶</button>
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
        >
          <div class="track-num">
            <PlayingIndicator v-if="nowPlayingIdx === f.origIdx" :live="playerPlaying" />
            <template v-else>
              <span class="track-num-val">{{ trackOffset(albumIdx) + i + 1 }}</span>
              <span class="track-num-icon">▶</span>
            </template>
          </div>
          <div class="track-info">
            <div class="track-name-wrap">
              <div class="track-name" :title="trackDisplayBasename(f.path)">{{ trackDisplayBasename(f.path) }}</div>
              <span class="track-format-chip" :title="`Формат: ${audioFormatLabel(f.path)}`">{{ audioFormatLabel(f.path) }}</span>
            </div>
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
              >▶</button>
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
</style>
