<script setup lang="ts">
import { ref, shallowRef, computed } from "vue";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import TrackCover from "../shared/TrackCover.vue";
import {
  trackDisplayBasename,
  audioFormatLabel,
  parseArtistTitleFromTrackFilename,
} from "../../lib/utils.js";
import { Track } from "../../track/Track.js";
import { useEntityCover } from "../../composables/useEntityCover.js";

const props = defineProps<{
  /** Liked tracks, in recency-desc order — resolved from library store. */
  tracks: Track[];
  /** Id of the currently-playing Track, or null. */
  nowPlayingId: string | null;
  playerPlaying: boolean;
}>();

const emit = defineEmits<{
  "toggle-like": [track: Track];
  "play": [track: Track];
  "open-track-source": [track: Track];
  "download": [track: Track];
  "add-to-queue": [track: Track];
  "add-to-playlist": [track: Track];
}>();

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

function onCtxAction(id: string): void {
  const t = ctxTrack.value;
  if (!t) return;
  if (id === "queue") emit("add-to-queue", t);
  if (id === "playlist") emit("add-to-playlist", t);
  if (id === "download") emit("download", t);
  if (id === "source") emit("open-track-source", t);
}

const likesCtxActions = computed(() => {
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

function trackLines(t: Track): { title: string; subtitle: string } {
  const { artist, title } = parseArtistTitleFromTrackFilename(t.fileName);
  const primary = artist ? title : trackDisplayBasename(t.fileName);
  const subtitle = artist || t.artist || "";
  return { title: primary, subtitle };
}

const tracksWithLines = computed(() =>
  props.tracks.map((track) => ({ track, lines: trackLines(track) })),
);

function tracksLabel(n: number): string {
  return `${n} ${n === 1 ? "трек" : n < 5 ? "трека" : "треков"}`;
}

function isNowPlayingTrack(t: Track): boolean {
  return props.nowPlayingId != null && props.nowPlayingId === t.id;
}

function likesTrackRowClass(t: Track): string[] {
  if (!isNowPlayingTrack(t)) return [];
  return ["playing", props.playerPlaying ? "playing--active" : "playing--paused"];
}

function likeTrackTooltip(t: Track): string {
  const name = trackDisplayBasename(t.fileName);
  const fmt = audioFormatLabel(t.fileName);
  const lines = [name];
  if (fmt && fmt !== "AUDIO") lines.push(`Формат: ${fmt}`);
  lines.push(t.kind === "soulseek" ? "SoulSeek" : "RuTracker");
  if (t.albumTitle) lines.push(t.albumTitle);
  return lines.join("\n");
}
</script>

<template src="./LikesView.html"></template>
