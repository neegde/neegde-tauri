<script setup>
import { ref, computed } from "vue";
import CoverThumb from "./CoverThumb.vue";
import PlayingIndicator from "./PlayingIndicator.vue";
import { trackCoverFileIdxForLike } from "../likesCover.js";

const props = defineProps({
  likes: Array,
  /** { magnet, fileIdx } — текущий трек из очереди или null */
  nowPlaying: { type: Object, default: null },
  playerPlaying: { type: Boolean, default: true },
});

const emit = defineEmits(["toggle-like", "play", "play-album", "open-torrent"]);

const tab = ref("tracks");

const albums = computed(() =>
  props.likes.filter((l) => l.type === "album").sort((a, b) => b.addedAt - a.addedAt)
);
const tracks = computed(() =>
  props.likes.filter((l) => l.type === "track").sort((a, b) => b.addedAt - a.addedAt)
);

const EMOJIS = ["🎵", "🎶", "🎸", "🎹", "🥁", "🎤", "🎼", "🎷", "🎺", "🪗"];
function hashStr(s) {
  let h = 0;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++)
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function getEmoji(id) {
  return EMOJIS[hashStr(id) % EMOJIS.length];
}

function extractArtist(torrentName) {
  const m = torrentName?.match(/^(.+?)\s+[-–—]\s+/);
  return m ? m[1].trim() : torrentName ?? "";
}

function tracksLabel(n) {
  return `${n} ${n === 1 ? "трек" : n < 5 ? "трека" : "треков"}`;
}
function albumsLabel(n) {
  return `${n} ${n === 1 ? "альбом" : n < 5 ? "альбома" : "альбомов"}`;
}

function isNowPlayingTrack(like) {
  const np = props.nowPlaying;
  if (!np || !like?.magnet) return false;
  return (
    String(like.magnet) === String(np.magnet) &&
    Number(like.fileIdx) === Number(np.fileIdx)
  );
}

function likesTrackRowClass(like) {
  if (!isNowPlayingTrack(like)) return [];
  return ["playing", props.playerPlaying ? "playing--active" : "playing--paused"];
}

function trackCoverFileIdx(like) {
  return trackCoverFileIdxForLike(like, props.likes);
}
</script>

<template>
  <div class="likes-view">

    <!-- Hero -->
    <div class="likes-hero">
      <div class="likes-hero-icon">♥</div>
      <div class="likes-hero-info">
        <div class="likes-hero-label">Плейлист</div>
        <div class="likes-hero-title">Мне нравится</div>
        <div class="likes-hero-meta">
          <span v-if="tracks.length > 0">{{ tracksLabel(tracks.length) }}</span>
          <span v-if="tracks.length > 0 && albums.length > 0" class="likes-hero-dot">·</span>
          <span v-if="albums.length > 0">{{ albumsLabel(albums.length) }}</span>
          <span v-if="tracks.length === 0 && albums.length === 0">Пусто</span>
        </div>
      </div>
    </div>

    <!-- Tab toggle -->
    <div class="likes-tabs">
      <button
        :class="['likes-tab', tab === 'tracks' ? 'active' : '']"
        @click="tab = 'tracks'"
      >Треки</button>
      <button
        :class="['likes-tab', tab === 'albums' ? 'active' : '']"
        @click="tab = 'albums'"
      >Альбомы</button>
    </div>

    <!-- Tracks -->
    <div v-if="tab === 'tracks'" class="likes-content">
      <p v-if="tracks.length === 0" class="empty-msg">Нет понравившихся треков.</p>
      <template v-else>
        <div class="tracklist-header likes-tracklist-header">
          <span>#</span>
          <span>Название</span>
          <span></span>
          <span></span>
        </div>
        <div
          v-for="(like, i) in tracks"
          :key="like.id"
          :class="['track-row', 'likes-track-row', ...likesTrackRowClass(like)]"
          @click="emit('play', like)"
        >
          <div class="track-num">
            <PlayingIndicator v-if="isNowPlayingTrack(like)" :live="playerPlaying" />
            <template v-else>
              <span class="track-num-val">{{ i + 1 }}</span>
              <span class="track-num-icon">▶</span>
            </template>
          </div>
          <div class="likes-track-main">
            <CoverThumb
              :torrent-id="like.torrentId"
              :source="like.source"
              :magnet="like.magnet"
              :cover-file-idx="trackCoverFileIdx(like)"
              :size="40"
              :radius="4"
            />
            <div class="track-info">
              <div class="track-name">{{ like.fileName }}</div>
              <button
                class="likes-track-sub"
                @click.stop="emit('open-torrent', like)"
              >{{ like.torrentName }}</button>
            </div>
          </div>
          <div class="track-size"></div>
          <div class="track-actions">
            <button
              class="track-btn"
              title="Перейти к раздаче"
              @click.stop="emit('open-torrent', like)"
            >↗</button>
            <button
              class="track-btn like-btn liked"
              title="Убрать лайк"
              @click.stop="emit('toggle-like', like)"
            >♥</button>
          </div>
        </div>
      </template>
    </div>

    <!-- Albums -->
    <div v-if="tab === 'albums'" class="likes-content">
      <p v-if="albums.length === 0" class="empty-msg">Нет понравившихся альбомов.</p>
      <div v-else class="results-grid" style="margin-top: 8px">
        <div
          v-for="like in albums"
          :key="like.id"
          class="album-card"
          :title="like.albumName || like.torrentName"
          @click="emit('open-torrent', like)"
        >
          <div class="album-art">
            <CoverThumb
              :torrent-id="like.torrentId"
              :source="like.source"
              :magnet="like.magnet"
              :cover-file-idx="like.coverFile?.origIdx ?? null"
              :fallback="getEmoji(like.torrentId)"
              fill
            />
            <button
              class="album-art-play"
              title="Слушать"
              @click.stop="emit('play-album', like)"
            >▶</button>
          </div>
          <div class="album-name">{{ like.albumName || like.torrentName }}</div>
          <div class="album-meta" style="margin-top: 4px">
            <span class="likes-track-sub" style="margin-top: 0">
              {{ extractArtist(like.torrentName) }}
            </span>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>
