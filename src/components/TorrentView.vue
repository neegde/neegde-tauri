<script setup>
import { ref, computed } from "vue";
import { isAudio, basename, fmtSize, fmtDate, detectAlbums } from "../utils.js";

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
const totalAudio = computed(() =>
  albums.value.reduce((sum, a) => sum + a.audioFiles.length, 0)
);
const firstCover = computed(() =>
  albums.value.find((a) => a.coverFile)?.coverFile ?? null
);

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

function makeAlbumLike(torrent, magnet, album) {
  const dirPath = album.dirPath || "root";
  return {
    id: albumLikeId(torrent, dirPath),
    type: "album",
    torrentId: torrent.id,
    torrentName: torrent.name,
    source: torrent.source,
    magnet,
    albumName: album.name,
    dirPath,
    audioFiles: album.audioFiles,
    coverFile: album.coverFile ?? null,
  };
}

function trackOffset(idx) {
  return albums.value.slice(0, idx).reduce((s, a) => s + a.audioFiles.length, 0);
}
</script>

<template>
  <div class="torrent-page">

    <!-- Back navigation -->
    <div class="torrent-nav">
      <button class="back-btn" @click="emit('back')">← Назад к результатам</button>
    </div>

    <!-- Header -->
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
          <span>{{ fmtSize(torrent.size) }}</span>
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

    <!-- Actions -->
    <div v-if="!loading && totalAudio > 0" class="album-actions">
      <button class="btn-play-all" @click="emit('play-all')">
        ▶&nbsp; Слушать всё
      </button>
      <button class="btn-dl-all" @click="emit('download-all')">
        ↓&nbsp; Скачать всё ({{ totalAudio }})
      </button>
    </div>

    <!-- Content -->
    <div v-if="loading" class="loading-tracks">
      <span class="spinner" /> Загрузка файлов…
    </div>

    <p v-else-if="albums.length === 0" class="empty-msg">Аудиофайлы не найдены.</p>

    <!-- Single album: flat tracklist -->
    <template v-else-if="albums.length === 1">
      <div class="tracklist-header">
        <span>#</span>
        <span style="padding-left: 12px">Название</span>
        <span style="text-align: right">Размер</span>
        <span />
      </div>
      <div
        v-for="(f, i) in albums[0].audioFiles"
        :key="f.origIdx"
        :class="['track-row', nowPlayingIdx === f.origIdx ? 'playing' : '']"
        @click="emit('play', f.origIdx, f.path)"
      >
        <div class="track-num">
          <span v-if="nowPlayingIdx === f.origIdx" class="playing-anim">♪</span>
          <template v-else>
            <span class="track-num-val">{{ i + 1 }}</span>
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
    </template>

    <!-- Multiple albums -->
    <template v-else>
      <div
        v-for="(album, albumIdx) in albums"
        :key="album.dirPath || String(albumIdx)"
        class="album-section"
      >
        <!-- Album section header -->
        <div class="album-section-header">
          <div class="album-section-cover">
            <span>🎵</span>
          </div>
          <div class="album-section-info">
            <div class="album-section-name">{{ album.name }}</div>
            <div class="album-section-count">{{ countLabel(album.audioFiles.length) }}</div>
          </div>
          <button
            :class="['track-btn', 'like-btn', 'album-like-btn', likes?.[albumLikeId(torrent, album.dirPath)] ? 'liked' : '']"
            :title="likes?.[albumLikeId(torrent, album.dirPath)] ? 'Убрать лайк' : 'Нравится'"
            @click="emit('toggle-like', makeAlbumLike(torrent, magnet, album))"
          >{{ likes?.[albumLikeId(torrent, album.dirPath)] ? "♥" : "♡" }}</button>
          <button class="btn-play-album" title="Слушать альбом" @click="emit('play-album', album.audioFiles)">▶</button>
          <button class="btn-dl-album" title="Скачать альбом" @click="emit('download-album', album.audioFiles)">↓</button>
        </div>

        <!-- Track list for this album -->
        <div class="tracklist-header">
          <span>#</span>
          <span style="padding-left: 12px">Название</span>
          <span style="text-align: right">Размер</span>
          <span />
        </div>
        <div
          v-for="(f, i) in album.audioFiles"
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
