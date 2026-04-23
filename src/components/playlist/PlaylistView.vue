<script setup lang="ts">
import { ref, shallowRef, computed } from "vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import TrackCover from "../shared/TrackCover.vue";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import { trackDisplayBasename } from "../../lib/utils.js";
import { Track } from "../../track/Track.js";
import type { PlaylistSnapshot } from "../../persistence/playlists.js";

const props = defineProps<{
  playlist: PlaylistSnapshot;
  tracks: Track[];
  nowPlayingId: string | null;
  playerPlaying: boolean;
}>();

const emit = defineEmits<{
  "play": [startIdx: number];
  "remove-track": [trackId: string];
  "delete": [];
  "rename": [newName: string];
  "add-to-queue": [track: Track];
  "add-to-playlist": [track: Track];
  "open-track-source": [track: Track];
  "download-track": [track: Track];
  "download-playlist": [];
}>();

// ── Rename ───────────────────────────────────────────────────────────────────

const renaming = ref(false);
const renameVal = ref("");
const renameInputRef = ref<HTMLInputElement | null>(null);

function startRename(): void {
  renameVal.value = props.playlist.title;
  renaming.value = true;
  setTimeout(() => renameInputRef.value?.focus(), 0);
}

function commitRename(): void {
  renaming.value = false;
  const v = renameVal.value.trim();
  if (v && v !== props.playlist.title) emit("rename", v);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPlaying(track: Track): boolean {
  return props.nowPlayingId != null && props.nowPlayingId === track.id;
}

const trackCount = computed(() => props.tracks.length);
const firstTrack = computed<Track | null>(() => props.tracks[0] ?? null);

// ── Context menu ─────────────────────────────────────────────────────────────

const ctxOpen = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);
const ctxTrack = shallowRef<Track | null>(null);

function openTrackCtx(e: MouseEvent, track: Track): void {
  e.preventDefault();
  ctxX.value = e.clientX;
  ctxY.value = e.clientY;
  ctxTrack.value = track;
  ctxOpen.value = true;
}

const playlistCtxActions = computed(() => {
  const t = ctxTrack.value;
  if (!t) return [];
  const srcLabel = t.kind === "soulseek" ? "Источник (SoulSeek)" : "Источник (Torrent)";
  const canDownload = t.hasPlaybackIdentity();
  return [
    { id: "queue", label: "В очередь", icon: "queue" },
    { id: "playlist", label: "В плейлист", icon: "playlist" },
    { id: "download", label: "Скачать", icon: "download", disabled: !canDownload },
    { id: "divider" },
    { id: "source", label: srcLabel, icon: "source" },
  ];
});

function onCtxAction(id: string): void {
  const t = ctxTrack.value;
  if (!t) return;
  if (id === "queue") emit("add-to-queue", t);
  if (id === "playlist") emit("add-to-playlist", t);
  if (id === "download") emit("download-track", t);
  if (id === "source") emit("open-track-source", t);
}
</script>

<template src="./PlaylistView.html"></template>

<style scoped src="./PlaylistView.scoped.css"></style>
