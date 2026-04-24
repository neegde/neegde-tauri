<script setup lang="ts">
import { computed } from "vue";
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
import {
  useTrackContextMenu,
  libraryTrackActions,
} from "../../composables/useTrackContextMenu.js";
import { sourceShortLabel } from "../../track/labels.js";

const props = defineProps<{
  /** Liked tracks, in recency-desc order — resolved from library store. */
  tracks: Track[];
  /** Id of the currently-playing Track, or null. */
  nowPlayingId: string | null;
  playerPlaying: boolean;
}>();

const emit = defineEmits<{
  "toggle-like-track": [track: Track];
  "play-track": [track: Track];
  "open-track-source": [track: Track];
  "download-track": [track: Track];
  "add-to-queue": [track: Track];
  "add-to-playlist": [track: Track];
}>();

const {
  ctxOpen,
  ctxX,
  ctxY,
  ctxActions: likesCtxActions,
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
  lines.push(sourceShortLabel(t));
  if (t.albumTitle) lines.push(t.albumTitle);
  return lines.join("\n");
}
</script>

<template src="./LikesView.html"></template>
