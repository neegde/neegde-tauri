<script setup lang="ts">
import { ref, computed } from "vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import TrackCover from "../shared/TrackCover.vue";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import { trackDisplayBasename } from "../../lib/utils.js";
import { Track } from "../../track/Track.js";
import type { Playlist } from "../../playlist/Playlist.js";
import {
  useTrackContextMenu,
  libraryTrackActions,
} from "../../composables/useTrackContextMenu.js";

function trackLines(t: Track): { title: string; subtitle: string } {
  return { title: t.title, subtitle: t.artist ?? t.albumTitle ?? "" };
}

const props = defineProps<{
  playlist: Playlist;
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

const {
  ctxOpen,
  ctxX,
  ctxY,
  ctxActions: playlistCtxActions,
  openTrackCtx,
  onCtxAction,
} = useTrackContextMenu({
  actionsFor: libraryTrackActions,
  onAction: (id, t) => {
    if (id === "queue") emit("add-to-queue", t);
    if (id === "playlist") emit("add-to-playlist", t);
    if (id === "download") emit("download-track", t);
    if (id === "source") emit("open-track-source", t);
  },
});
</script>

<template src="./PlaylistView.html"></template>

<style scoped src="./PlaylistView.scoped.css"></style>
