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
  extractTrackArtist,
} from "../../lib/utils.js";
import { getCoverReactive } from "../../rutracker/search.js";

const props = defineProps({
  likes: Array,
  /** { magnet, fileIdx } — текущий трек из очереди или null */
  nowPlaying: { type: Object, default: null },
  playerPlaying: { type: Boolean, default: true },
});

const emit = defineEmits([
  "toggle-like",
  "play",
  "play-album",
  "open-torrent",
  "open-track-source",
  "download",
  "add-to-queue",
  "add-to-playlist",
]);

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
function onCtxAction(id) {
  const like = ctxLike.value;
  if (!like) return;
  if (id === "queue") emit("add-to-queue", like);
  if (id === "playlist") emit("add-to-playlist", like);
  if (id === "download") emit("download", like);
  if (id === "source") emit("open-track-source", like);
}

const likesCtxActions = computed(() => {
  const like = ctxLike.value;
  if (!like) return [];
  const srcLabel =
    like.source === "soulseek" ? "Источник (SoulSeek)" : "Источник (Torrent)";
  const canDownload =
    (like.source === "soulseek"
      ? String(like.slskUsername ?? "").trim().length > 0 && String(like.slskFilepath ?? "").trim().length > 0
      : String(like.magnet ?? "").trim().length > 0 && like.fileIdx != null && Number.isFinite(Number(like.fileIdx)));
  return [
    { id: "queue", label: "В очередь", icon: "queue" },
    { id: "playlist", label: "В плейлист", icon: "playlist" },
    { id: "download", label: "Скачать", icon: "download", disabled: !canDownload },
    { id: "divider" },
    { id: "source", label: srcLabel, icon: "source" },
  ];
});

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
    subtitle =
      extractTrackArtist(
        like.torrentName,
        like.albumDirPath ?? null,
        null,
        like.magnet ?? null,
      ) || "";
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

<template src="./LikesView.html"></template>
