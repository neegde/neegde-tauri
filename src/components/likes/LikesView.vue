<script setup lang="ts">
import { ref, computed, watch } from "vue";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import TrackCover from "../shared/TrackCover.vue";
import {
  trackDisplayBasename,
  audioFormatLabel,
} from "../../lib/utils.js";
import { Track } from "../../track/Track.js";
import type { Album } from "../../album/Album.js";
import {
  useTrackContextMenu,
  libraryTrackActions,
} from "../../composables/useTrackContextMenu.js";
import { sourceShortLabel } from "../../track/labels.js";

const props = withDefaults(
  defineProps<{
    /** Liked tracks, in recency-desc order — resolved from library store. */
    tracks: Track[];
    /** Liked albums (entity registry); may be empty after restart until re-liked. */
    albums: Album[];
    /** Id of the currently-playing Track, or null. */
    nowPlayingId: string | null;
    playerPlaying: boolean;
  }>(),
  { albums: () => [] },
);

const emit = defineEmits<{
  "toggle-like-track": [track: Track];
  "open-liked-album": [album: Album];
  "play-track": [track: Track];
  "open-track-source": [track: Track];
  "download-track": [track: Track];
  "add-to-queue": [track: Track];
  "add-to-playlist": [track: Track];
}>();

/** Active sub-tab under «Мне нравится». */
const likesTab = ref<"tracks" | "albums">("tracks");

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
  return { title: t.title, subtitle: t.artist ?? "" };
}

const tracksWithLines = computed(() =>
  props.tracks.map((track) => ({ track, lines: trackLines(track) })),
);

function tracksLabel(n: number): string {
  return `${n} ${n === 1 ? "трек" : n < 5 ? "трека" : "треков"}`;
}

function albumsLabel(n: number): string {
  return `${n} ${n === 1 ? "альбом" : n < 5 ? "альбома" : "альбомов"}`;
}

const likesHeroMeta = computed(() => {
  const nt = props.tracks.length;
  const na = props.albums.length;
  if (nt === 0 && na === 0) return "Пусто";
  const parts: string[] = [];
  if (nt > 0) parts.push(tracksLabel(nt));
  if (na > 0) parts.push(albumsLabel(na));
  return parts.join(" · ");
});

watch(
  () => ({ tab: likesTab.value, n: props.albums.length, ids: props.albums.map((x) => x.id).join("\0") }),
  () => {
    if (likesTab.value !== "albums") return;
    for (const a of props.albums) {
      if (typeof a.startCoverFetch === "function") a.startCoverFetch();
    }
  },
);

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
