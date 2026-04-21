<script setup>
import { ref, computed } from "vue";
import CoverThumb from "../shared/CoverThumb.vue";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import { trackCoverFileIdxForLike } from "../../library/likesCover.js";
import {
  trackDisplayBasename,
  audioFormatLabel,
  parseArtistTitleFromTrackFilename,
  extractArtist as extractArtistFromTorrentName,
} from "../../lib/utils.js";
import { getCoverReactive } from "../../rutracker/search.js";

const props = defineProps({
  likes: Array,
  /** { magnet, fileIdx } — текущий трек из очереди или null */
  nowPlaying: { type: Object, default: null },
  playerPlaying: { type: Boolean, default: true },
});

const emit = defineEmits(["toggle-like", "play", "play-album", "open-torrent", "download", "add-to-queue"]);

const ctxOpen = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);
/** @type {import('vue').Ref<object | null>} */
const ctxLike = ref(null);

/**
 * @param {MouseEvent} e
 * @param {object} like
 * @returns {void}
 */
function openTrackCtx(e, like) {
  e.preventDefault();
  ctxX.value = e.clientX;
  ctxY.value = e.clientY;
  ctxLike.value = like;
  ctxOpen.value = true;
}

/**
 * @returns {void}
 */
function onCtxAddToQueue() {
  if (ctxLike.value) emit("add-to-queue", ctxLike.value);
}

const tab = ref("tracks");

const albums = computed(() =>
  props.likes.filter((l) => l.type === "album").sort((a, b) => b.addedAt - a.addedAt)
);
const tracks = computed(() =>
  props.likes.filter((l) => l.type === "track").sort((a, b) => b.addedAt - a.addedAt)
);

/**
 * Title and subtitle lines for a liked track row (title first, artist second).
 *
 * Args:
 *     like: Liked track row.
 *
 * Returns:
 *     `{ title, subtitle }`. Subtitle is empty when no second line should show.
 */
function likeTrackLines(like) {
  const { artist, title } = parseArtistTitleFromTrackFilename(like.fileName);
  const primary = artist ? title : trackDisplayBasename(like.fileName);
  let subtitle = "";
  if (artist) subtitle = artist;
  else if (like.source === "rutracker") {
    subtitle = extractArtistFromTorrentName(like.torrentName ?? "") || "";
  }
  return { title: primary, subtitle };
}

/** Each track with precomputed { title, subtitle } for the list row. */
const tracksWithLines = computed(() => tracks.value.map((like) => ({ like, lines: likeTrackLines(like) })));
const torrents = computed(() =>
  props.likes.filter((l) => l.type === "torrent").sort((a, b) => b.addedAt - a.addedAt)
);


function tracksLabel(n) {
  return `${n} ${n === 1 ? "трек" : n < 5 ? "трека" : "треков"}`;
}
function albumsLabel(n) {
  return `${n} ${n === 1 ? "альбом" : n < 5 ? "альбома" : "альбомов"}`;
}
function torrentsLabel(n) {
  return `${n} ${n === 1 ? "раздача" : n < 5 ? "раздачи" : "раздач"}`;
}

function isNowPlayingTrack(like) {
  const np = props.nowPlaying;
  if (!np || !like) return false;
  if (like.source === "soulseek" || np.source === "soulseek") {
    if (like.source !== "soulseek" || np.source !== "soulseek") return false;
    return (
      String(like.slskUsername) === String(np.slskUsername) &&
      String(like.slskFilepath) === String(np.slskFilepath)
    );
  }
  if (!like.magnet) return false;
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

/**
 * Tooltip for the track title: basename, optional format, source-specific line.
 *
 * Args:
 *     like: Liked track row.
 *
 * Returns:
 *     Multiline string for the native `title` attribute.
 */
function likeTrackTooltip(like) {
  const name = trackDisplayBasename(like.fileName);
  const fmt = audioFormatLabel(like.filePath || like.fileName);
  const lines = [name];
  if (fmt && fmt !== "AUDIO") lines.push(`Формат: ${fmt}`);
  if (like.source === "soulseek") {
    lines.push("SoulSeek");
    if (like.slskUsername) lines.push(like.slskUsername);
  } else {
    lines.push("RuTracker");
    if (like.torrentName) lines.push(like.torrentName);
  }
  return lines.join("\n");
}
</script>

<template>
  <div class="likes-view">

    <!-- Hero -->
    <div class="likes-hero">
      <div class="likes-hero-icon">
        <svg width="60" height="60" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
      </div>
      <div class="likes-hero-info">
        <div class="likes-hero-label">Плейлист</div>
        <div class="likes-hero-title">Мне нравится</div>
        <div class="likes-hero-meta">
          <span v-if="tracks.length > 0">{{ tracksLabel(tracks.length) }}</span>
          <span v-if="tracks.length > 0 && albums.length > 0" class="likes-hero-dot">·</span>
          <span v-if="albums.length > 0">{{ albumsLabel(albums.length) }}</span>
          <span v-if="(tracks.length > 0 || albums.length > 0) && torrents.length > 0" class="likes-hero-dot">·</span>
          <span v-if="torrents.length > 0">{{ torrentsLabel(torrents.length) }}</span>
          <span v-if="tracks.length === 0 && albums.length === 0 && torrents.length === 0">Пусто</span>
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
      <button
        :class="['likes-tab', tab === 'torrents' ? 'active' : '']"
        @click="tab = 'torrents'"
      >Раздачи</button>
    </div>

    <!-- Tracks -->
    <div v-if="tab === 'tracks'" class="likes-content">
      <p v-if="tracks.length === 0" class="empty-msg">Нет понравившихся треков.</p>
      <template v-else>
        <div class="tracklist-header likes-tracklist-header">
          <span class="likes-th-num">#</span>
          <div class="likes-th-main">
            <span class="likes-th-name-label">Название</span>
          </div>
          <span class="likes-th-actions-head" aria-hidden="true" />
        </div>
        <div
          v-for="(row, i) in tracksWithLines"
          :key="row.like.id"
          :class="['track-row', 'likes-track-row', ...likesTrackRowClass(row.like)]"
          @click="emit('play', row.like)"
          @contextmenu.prevent="openTrackCtx($event, row.like)"
        >
          <div class="track-num">
            <PlayingIndicator v-if="isNowPlayingTrack(row.like)" :live="playerPlaying" />
            <template v-else>
              <span class="track-num-val">{{ i + 1 }}</span>
              <span class="track-num-icon">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="5,3 19,12 5,21"/>
                </svg>
              </span>
            </template>
          </div>
          <div class="likes-track-main">
            <div
              class="likes-thumb-frame"
              :class="row.like.source === 'soulseek' ? 'likes-thumb-frame--slsk' : 'likes-thumb-frame--rt'"
              :title="row.like.source === 'soulseek' ? 'SoulSeek' : 'RuTracker'"
            >
              <CoverThumb
                :torrent-id="row.like.torrentId"
                :source="row.like.source"
                :magnet="row.like.magnet"
                :cover-file-idx="trackCoverFileIdx(row.like)"
                :size="40"
                :radius="4"
              />
            </div>
            <div class="track-info">
              <div class="track-name-wrap">
                <div class="track-name" :title="likeTrackTooltip(row.like)">{{ row.lines.title }}</div>
              </div>
              <button
                v-if="row.lines.subtitle"
                class="likes-track-sub"
                @click.stop="emit('open-torrent', row.like)"
              >{{ row.lines.subtitle }}</button>
            </div>
          </div>
          <div class="track-actions">
            <button
              class="track-btn like-btn liked"
              title="Убрать лайк"
              @click.stop="emit('toggle-like', row.like)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
            </button>
            <button
              class="track-btn dl"
              title="Скачать"
              @click.stop="emit('download', row.like)"
            >↓</button>
            <button
              class="track-btn"
              title="Перейти к раздаче"
              @click.stop="emit('open-torrent', row.like)"
            >↗</button>
          </div>
        </div>
      </template>
    </div>

    <!-- Torrents -->
    <div v-if="tab === 'torrents'" class="likes-content">
      <p v-if="torrents.length === 0" class="empty-msg">Нет понравившихся раздач.</p>
      <div v-else class="results-grid likes-albums-grid">
        <div
          v-for="like in torrents"
          :key="like.id"
          class="album-card"
          :title="like.torrentName"
          @click="emit('open-torrent', like)"
        >
          <div class="album-art">
            <img
              v-if="like.source === 'rutracker' && getCoverReactive(String(like.torrentId))"
              :src="getCoverReactive(String(like.torrentId))"
              class="album-art-img"
              alt=""
            />
            <svg v-else class="album-art-fallback" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M9 18V5l12-2v13"/>
              <circle cx="6" cy="18" r="3"/>
              <circle cx="18" cy="16" r="3"/>
            </svg>
            <button
              class="album-art-play"
              title="Открыть раздачу"
              @click.stop="emit('open-torrent', like)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
            </button>
          </div>
          <div class="album-name">{{ like.torrentName }}</div>
          <div class="album-meta likes-album-artist">
            <span class="likes-track-sub">{{ extractArtistFromTorrentName(like.torrentName) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Albums -->
    <div v-if="tab === 'albums'" class="likes-content">
      <p v-if="albums.length === 0" class="empty-msg">Нет понравившихся альбомов.</p>
      <div v-else class="results-grid likes-albums-grid">
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
              fill
            />
            <button
              class="album-art-play"
              title="Слушать"
              @click.stop="emit('play-album', like)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
            </button>
          </div>
          <div class="album-name">{{ like.albumName || like.torrentName }}</div>
          <div class="album-meta likes-album-artist">
            <span class="likes-track-sub">{{ extractArtistFromTorrentName(like.torrentName) }}</span>
          </div>
        </div>
      </div>
    </div>

    <TrackContextMenu
      v-model:open="ctxOpen"
      :x="ctxX"
      :y="ctxY"
      @action="onCtxAddToQueue"
    />
  </div>
</template>
