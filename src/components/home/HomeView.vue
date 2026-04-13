<script setup>
import { computed } from "vue";
import CoverThumb from "../shared/CoverThumb.vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";

const props = defineProps({
  nowPlaying:    { type: Object,  default: null },
  playerPlaying: { type: Boolean, default: false },
  recentHistory: { type: Array,   default: () => [] },
  likes:         { type: Array,   default: () => [] },
});

const emit = defineEmits(["open-recent", "open-liked-torrent", "play-liked-album", "go-to-search"]);

const likedAlbums = computed(() =>
  props.likes
    .filter((l) => l.type === "album")
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, 8)
);

const recentSlice = computed(() => props.recentHistory.slice(0, 10));

const isEmpty = computed(
  () => !props.nowPlaying && !recentSlice.value.length && !likedAlbums.value.length
);

function torrentDisplayName(name = "") {
  // Strip leading category like "(Rock) Artist - Album" → "Artist - Album"
  return name.replace(/^\([^)]+\)\s*/, "");
}
</script>

<template>
  <div class="home-view">

    <!-- Empty state -->
    <div v-if="isEmpty" class="home-empty">
      <div class="home-empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
      </div>
      <p class="home-empty-title">Здесь будет ваша музыка</p>
      <p class="home-empty-sub">Найдите что-нибудь и начните слушать</p>
      <button class="home-empty-btn" @click="emit('go-to-search')">Найти музыку</button>
    </div>

    <template v-else>
      <!-- ── Continue Listening ───────────────────────────────────── -->
      <section v-if="nowPlaying" class="home-section">
        <h2 class="home-section-title">Сейчас играет</h2>
        <div class="now-playing-card">
          <div class="now-playing-cover">
            <CoverThumb
              :torrent-id="nowPlaying.torrentId"
              :source="nowPlaying.source"
              :magnet="nowPlaying.magnet || ''"
              :cover-file-idx="nowPlaying.coverFileIdx ?? null"
              :size="72"
              :radius="8"
            />
          </div>
          <div class="now-playing-info">
            <div class="now-playing-track">
              <PlayingIndicator :live="playerPlaying" />
              <span class="now-playing-name">{{ nowPlaying.fileName }}</span>
            </div>
            <div class="now-playing-album">{{ nowPlaying.torrentName }}</div>
          </div>
        </div>
      </section>

      <!-- ── Recently Played ──────────────────────────────────────── -->
      <section v-if="recentSlice.length" class="home-section">
        <h2 class="home-section-title">Недавно слушал</h2>
        <div class="home-grid">
          <button
            v-for="item in recentSlice"
            :key="item.id"
            class="home-card"
            @click="emit('open-recent', item)"
          >
            <div class="home-card-cover">
              <CoverThumb
                :torrent-id="item.id"
                :source="item.source"
                :size="120"
                :radius="6"
                :fill="true"
              />
              <div class="home-card-play-overlay">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="7,4 21,12 7,20"/>
                </svg>
              </div>
            </div>
            <div class="home-card-name">{{ torrentDisplayName(item.name) }}</div>
            <div v-if="item.artist" class="home-card-sub">{{ item.artist }}</div>
          </button>
        </div>
      </section>

      <!-- ── Liked Albums ─────────────────────────────────────────── -->
      <section v-if="likedAlbums.length" class="home-section">
        <h2 class="home-section-title">Понравившиеся альбомы</h2>
        <div class="home-grid">
          <button
            v-for="like in likedAlbums"
            :key="like.id"
            class="home-card"
            @click="emit('open-liked-torrent', like)"
            @dblclick.prevent="emit('play-liked-album', like)"
          >
            <div class="home-card-cover">
              <CoverThumb
                :torrent-id="like.torrentId"
                :source="like.source"
                :magnet="like.magnet || ''"
                :cover-file-idx="like.coverFile?.origIdx ?? null"
                :size="120"
                :radius="6"
                :fill="true"
              />
              <div class="home-card-play-overlay">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="7,4 21,12 7,20"/>
                </svg>
              </div>
            </div>
            <div class="home-card-name">{{ like.albumName || torrentDisplayName(like.torrentName) }}</div>
            <div v-if="like.artist" class="home-card-sub">{{ like.artist }}</div>
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.home-view {
  padding: var(--main-pad-top) var(--main-pad-inline) 40px;
  min-height: 100%;
}

/* ── Empty state ── */
.home-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding-top: 80px;
  color: var(--muted);
  text-align: center;
}
.home-empty-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}
.home-empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.home-empty-sub {
  font-size: 14px;
  margin: 0;
}
.home-empty-btn {
  margin-top: 8px;
  padding: 10px 24px;
  border-radius: 24px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: background 0.15s;
}
.home-empty-btn:hover {
  background: var(--accent-h);
}

/* ── Sections ── */
.home-section {
  margin-bottom: 36px;
}
.home-section-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 16px;
}

/* ── Now Playing card ── */
.now-playing-card {
  display: flex;
  align-items: center;
  gap: 16px;
  background: var(--surface);
  border-radius: 12px;
  padding: 16px 20px;
  max-width: 480px;
}
.now-playing-cover {
  flex-shrink: 0;
}
.now-playing-info {
  min-width: 0;
}
.now-playing-track {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.now-playing-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.now-playing-album {
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Cards grid ── */
.home-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
}
.home-card {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  border-radius: 8px;
  transition: background 0.15s;
}
.home-card:hover {
  background: var(--surface-h);
}
.home-card-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  border-radius: 6px;
  overflow: hidden;
  background: var(--surface);
  margin-bottom: 8px;
}
.home-card-play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  transition: opacity 0.15s;
  color: #fff;
}
.home-card:hover .home-card-play-overlay {
  opacity: 1;
}
.home-card-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  padding: 0 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-card-sub {
  font-size: 12px;
  color: var(--muted);
  padding: 2px 4px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
