<script setup>
import { ref, computed } from "vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import CoverThumb from "../shared/CoverThumb.vue";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import { trackDisplayBasename } from "../../lib/utils.js";

const props = defineProps({
  playlist:      { type: Object,  required: true },
  nowPlaying:    { type: Object,  default: null },
  playerPlaying: { type: Boolean, default: false },
});

const emit = defineEmits([
  "play",           // startIdx
  "remove-track",   // { magnet, fileIdx }
  "delete",
  "rename",         // newName
  "add-to-queue",
  "open-track-source",
]);

// ── Rename ────────────────────────────────────────────────────────────────────
const renaming = ref(false);
const renameVal = ref("");
const renameInputRef = ref(null);

function startRename() {
  renameVal.value = props.playlist.name;
  renaming.value = true;
  setTimeout(() => renameInputRef.value?.focus(), 0);
}

function commitRename() {
  renaming.value = false;
  const v = renameVal.value.trim();
  if (v && v !== props.playlist.name) emit("rename", v);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isPlaying(track) {
  const np = props.nowPlaying;
  return np && np.magnet === track.magnet && np.fileIdx === track.fileIdx;
}

const trackCount = computed(() => props.playlist.tracks.length);

const ctxOpen = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);
/** @type {import('vue').Ref<object | null>} */
const ctxTrack = ref(null);

/**
 * @param {MouseEvent} e
 * @param {object} track
 * @returns {void}
 */
function openTrackCtx(e, track) {
  e.preventDefault();
  ctxX.value = e.clientX;
  ctxY.value = e.clientY;
  ctxTrack.value = track;
  ctxOpen.value = true;
}

const playlistCtxActions = computed(() => {
  if (!ctxTrack.value) return [];
  const t = ctxTrack.value;
  const srcLabel =
    t.source === "soulseek" ? "Источник (SoulSeek)" : "Источник (Torrent)";
  return [
    { id: "queue", label: "В очередь", icon: "queue" },
    { id: "divider" },
    { id: "source", label: srcLabel, icon: "source" },
  ];
});

/**
 * @returns {void}
 */
function onCtxAction(id) {
  const t = ctxTrack.value;
  if (!t) return;
  if (id === "queue") emit("add-to-queue", t);
  if (id === "source") emit("open-track-source", t);
}
</script>

<template>
  <div class="playlist-view">

    <!-- Header -->
    <div class="pl-header">
      <div class="pl-cover">
        <template v-if="playlist.tracks.length">
          <CoverThumb
            :torrent-id="playlist.tracks[0].torrentId"
            :source="playlist.tracks[0].source"
            :cover-file-idx="playlist.tracks[0].coverFileIdx ?? null"
            :magnet="playlist.tracks[0].magnet"
            :size="120"
            :radius="12"
            :fill="true"
          />
        </template>
        <div v-else class="pl-cover-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"/>
            <line x1="8" y1="12" x2="21" y2="12"/>
            <line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/>
            <line x1="3" y1="12" x2="3.01" y2="12"/>
            <line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
        </div>
      </div>

      <div class="pl-header-info">
        <div class="pl-type">Плейлист</div>

        <template v-if="renaming">
          <input
            ref="renameInputRef"
            v-model="renameVal"
            class="pl-rename-input"
            @keydown.enter="commitRename"
            @keydown.escape="renaming = false"
            @blur="commitRename"
          />
        </template>
        <h1 v-else class="pl-name" @dblclick="startRename" title="Дважды кликните для переименования">
          {{ playlist.name }}
        </h1>

        <div class="pl-meta">{{ trackCount }} {{ trackCount === 1 ? 'трек' : trackCount < 5 ? 'трека' : 'треков' }}</div>

        <div class="pl-actions">
          <button
            v-if="trackCount"
            class="pl-play-btn"
            @click="emit('play', 0)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
            Слушать
          </button>
          <button class="pl-rename-btn" @click="startRename" title="Переименовать">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="pl-delete-btn" @click="emit('delete')" title="Удалить плейлист">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/>
              <path d="M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Empty -->
    <div v-if="!trackCount" class="pl-empty">
      <p>Плейлист пустой</p>
      <p class="pl-empty-hint">Добавляйте треки через кнопку ⊕ в списке раздачи</p>
    </div>

    <!-- Track list -->
    <div v-else class="pl-tracklist">
      <div class="pl-tracklist-head">
        <span class="pl-col-n">#</span>
        <span class="pl-col-info">Название</span>
        <span class="pl-col-actions" />
      </div>

      <div
        v-for="(track, i) in playlist.tracks"
        :key="`${track.magnet}-${track.fileIdx}`"
        :class="['pl-track-row', isPlaying(track) ? 'pl-track-row--playing' : '']"
        @click="emit('play', i)"
        @contextmenu.prevent="openTrackCtx($event, track)"
      >
        <div class="pl-col-n">
          <PlayingIndicator v-if="isPlaying(track)" :live="playerPlaying" />
          <template v-else>
            <span class="pl-track-num">{{ i + 1 }}</span>
            <span class="pl-track-play-hint">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
            </span>
          </template>
        </div>

        <div class="pl-col-info">
          <div class="pl-track-name" :title="trackDisplayBasename(track.fileName)">
            {{ trackDisplayBasename(track.fileName) }}
          </div>
          <div class="pl-track-sub">{{ track.artist || track.torrentName }}</div>
        </div>

        <div class="pl-col-actions">
          <button
            class="pl-track-remove"
            title="Убрать из плейлиста"
            @click.stop="emit('remove-track', { magnet: track.magnet, fileIdx: track.fileIdx })"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <TrackContextMenu
      v-model:open="ctxOpen"
      :x="ctxX"
      :y="ctxY"
      :actions="playlistCtxActions"
      @action="onCtxAction"
    />
  </div>
</template>

<style scoped>
.playlist-view {
  padding: var(--main-pad-top) var(--main-pad-inline) 40px;
  min-height: 100%;
}

/* ── Header ── */
.pl-header {
  display: flex;
  gap: 28px;
  align-items: flex-end;
  margin-bottom: 36px;
}
.pl-cover {
  position: relative;
  width: 140px;
  height: 140px;
  flex-shrink: 0;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
}
.pl-cover-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  opacity: 0.4;
}
.pl-header-info {
  min-width: 0;
  flex: 1;
}
.pl-type {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  margin-bottom: 6px;
}
.pl-name {
  font-size: 32px;
  font-weight: 800;
  color: var(--text);
  margin: 0 0 8px;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-rename-input {
  font-size: 32px;
  font-weight: 800;
  color: var(--text);
  background: transparent;
  border: none;
  border-bottom: 2px solid var(--accent);
  outline: none;
  width: 100%;
  margin: 0 0 8px;
  padding: 0;
  font-family: inherit;
}
.pl-meta {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 16px;
}
.pl-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pl-play-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 500px;
  padding: 10px 24px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s;
}
.pl-play-btn:hover { background: var(--accent-h); }
.pl-rename-btn,
.pl-delete-btn {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  transition: color 0.15s, background 0.15s;
}
.pl-rename-btn:hover { color: var(--text); background: var(--surface-h); }
.pl-delete-btn:hover { color: #e05555; background: rgba(224,85,85,0.1); }

/* ── Empty ── */
.pl-empty {
  text-align: center;
  padding: 60px 0;
  color: var(--muted);
}
.pl-empty p { margin: 0; }
.pl-empty-hint { font-size: 13px; margin-top: 8px !important; }

/* ── Track list ── */
.pl-tracklist-head {
  display: grid;
  grid-template-columns: 36px 1fr 48px;
  padding: 0 8px 8px;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
  margin-bottom: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.pl-track-row {
  display: grid;
  grid-template-columns: 36px 1fr 48px;
  align-items: center;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
  gap: 0;
}
.pl-track-row:hover { background: var(--surface); }
.pl-track-row--playing { color: var(--accent); }

.pl-col-n {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
}
.pl-track-num {
  font-size: 13px;
  color: var(--muted);
}
.pl-track-play-hint {
  display: none;
  color: var(--text);
}
.pl-track-row:hover .pl-track-num { display: none; }
.pl-track-row:hover .pl-track-play-hint { display: flex; }

.pl-col-info {
  min-width: 0;
  padding: 0 12px;
}
.pl-track-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-track-row--playing .pl-track-name { color: var(--accent); }
.pl-track-sub {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.pl-col-actions {
  display: flex;
  justify-content: flex-end;
}
.pl-track-remove {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.pl-track-row:hover .pl-track-remove { opacity: 1; }
.pl-track-remove:hover { color: #e05555; }
</style>
