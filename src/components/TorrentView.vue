<script setup>
import { computed, watch, onUnmounted } from "vue";
import { isAudio, basename, fmtSize, fmtDate, detectAlbums, sumFileSizes } from "../utils.js";
import { disposeTorrentPreview } from "../torrentSession.js";
import AlbumFolderCover from "./AlbumFolderCover.vue";

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
  }
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
    </div>

    <div v-if="loading" class="loading-tracks">
      <span class="spinner" /> Загрузка файлов…
    </div>

    <p v-else-if="albums.length === 0" class="empty-msg">Аудиофайлы не найдены.</p>

    <template v-else>
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
