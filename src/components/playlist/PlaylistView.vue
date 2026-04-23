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
  "play",              // startIdx
  "remove-track",      // { magnet, fileIdx }
  "delete",
  "rename",            // newName
  "add-to-queue",
  "add-to-playlist",
  "open-track-source",
  "download-track",
  "download-playlist", // all downloadable tracks
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
  const canDownload =
    (t.source === "soulseek"
      ? String(t.slskUsername ?? "").trim().length > 0 && String(t.slskFilepath ?? "").trim().length > 0
      : String(t.magnet ?? "").trim().length > 0 && t.fileIdx != null && Number.isFinite(Number(t.fileIdx)));
  return [
    { id: "queue", label: "В очередь", icon: "queue" },
    { id: "playlist", label: "В плейлист", icon: "playlist" },
    { id: "download", label: "Скачать", icon: "download", disabled: !canDownload },
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
  if (id === "playlist") emit("add-to-playlist", { ...t });
  if (id === "download") emit("download-track", t);
  if (id === "source") emit("open-track-source", t);
}
</script>

<template src="./PlaylistView.html"></template>

<style scoped src="./PlaylistView.scoped.css"></style>

