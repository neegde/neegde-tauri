<script setup lang="ts">
/**
 * Detail view for an Album entity — cover, metadata, tracklist.
 *
 * Reads directly from the Album + Track hierarchy. No legacy row shapes,
 * no per-file index plumbing: every action emits the Track instance or the
 * Album itself. Replaces TorrentView for the search-album-click path.
 */

import { computed } from "vue";
import type { Track } from "../../track/Track.js";
import type { AlbumData } from "../../stores/entities.js";
import { getTrack, entitiesVersion } from "../../stores/entities.js";
import TrackCover from "../shared/TrackCover.vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import {
  useTrackContextMenu,
  type CtxActionDef,
} from "../../composables/useTrackContextMenu.js";
import { sourceContextLabel, canDownload } from "../../track/labels.js";
import {
  trackDisplayBasename,
  audioFormatLabel,
  fmtSize,
  fmtSizeParts,
} from "../../lib/utils.js";

const props = defineProps<{
  album: AlbumData;
  nowPlayingId: string | null;
  playerPlaying: boolean;
  likedTrackIds: Set<string>;
  albumLiked: boolean;
}>();

const emit = defineEmits<{
  "play-track":        [track: Track];
  "play-all":          [];
  "toggle-like-track": [track: Track];
  "toggle-like-album": [album: AlbumData];
  "download-track":    [track: Track];
  "download-album":    [];
  "add-to-playlist":   [track: Track];
  "open-track-source": [track: Track];
  "add-to-queue":      [track: Track];
}>();

// Resolve trackIds → live Track instances. Reactive via entitiesVersion.
const tracks = computed<Track[]>(() => {
  entitiesVersion.value;
  const out: Track[] = [];
  for (const id of props.album.trackIds ?? []) {
    const t = getTrack(id);
    if (t) out.push(t);
  }
  return out;
});

const totalSize = computed<number>(() => {
  let s = 0;
  for (const t of tracks.value) s += t.size ?? 0;
  return s || (props.album.size ?? 0);
});

const countLabel = computed<string>(() => {
  const n = tracks.value.length;
  const w = n === 1 ? "трек" : n < 5 ? "трека" : "треков";
  return `${n} ${w}`;
});

const seedsLabel = computed<string | null>(() => {
  const s = props.album.seeders;
  if (!s || s <= 0) return null;
  const w = s === 1 ? "сид" : s < 5 ? "сида" : "сидов";
  return `${s} ${w}`;
});

const artistLabel = computed<string>(() => {
  return props.album.artist?.trim() || "Неизвестный исполнитель";
});

// ── Context menu ───────────────────────────────────────────────────────────

function albumTrackActions(t: Track): CtxActionDef[] {
  const isLiked = props.likedTrackIds.has(t.id);
  return [
    { id: "play",     label: "Слушать",    icon: "play" },
    { id: "queue",    label: "В очередь",  icon: "queue" },
    { id: "divider" },
    { id: "like",     label: isLiked ? "Убрать из любимых" : "В избранное", icon: "heart" },
    { id: "playlist", label: "В плейлист", icon: "playlist" },
    { id: "divider" },
    { id: "download", label: "Скачать",    icon: "download", disabled: !canDownload(t) },
    { id: "source",   label: sourceContextLabel(t), icon: "source" },
  ];
}

const {
  ctxOpen,
  ctxX,
  ctxY,
  ctxActions,
  openTrackCtx,
  onCtxAction,
} = useTrackContextMenu({
  actionsFor: albumTrackActions,
  onAction: (id, t) => {
    if (id === "play")     emit("play-track", t);
    if (id === "queue")    emit("add-to-queue", t);
    if (id === "like")     emit("toggle-like-track", t);
    if (id === "playlist") emit("add-to-playlist", t);
    if (id === "download") emit("download-track", t);
    if (id === "source")   emit("open-track-source", t);
  },
});

// ── Row helpers ────────────────────────────────────────────────────────────
function isNowPlaying(t: Track): boolean {
  return props.nowPlayingId != null && props.nowPlayingId === t.id;
}

function rowClass(t: Track): string[] {
  if (!isNowPlaying(t)) return [];
  return ["playing", props.playerPlaying ? "playing--active" : "playing--paused"];
}

function displayTitle(t: Track): string {
  return t.title;
}
</script>

<template src="./AlbumView.html"></template>
