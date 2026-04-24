<script setup>
import { ref, computed, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  isAudio,
  isImage,
  basename,
  trackDisplayBasename,
  audioFormatLabel,
  fmtSize,
  fmtSizeParts,
  fmtDate,
  detectAlbums,
  sumFileSizes,
  MAX_TORRENT_COVER_BYTES,
  enrichMagnetWithOpenTrackers,
  extractTrackArtist,
  isYearLike,
  stripMetaTags,
  parseAudioTrackPrefix,
  isDiscMarker,
  extractAlbumFromTorrentName,
} from "../../lib/utils.js";
import { enrichAlbumTracklist } from "../../audio/metadataEnrich.js";
import AlbumFolderCover from "./AlbumFolderCover.vue";
import PlayingIndicator from "../shared/PlayingIndicator.vue";
import TrackContextMenu from "../shared/TrackContextMenu.vue";
import { torrentFileB64ForTrack } from "../../torrent/api.js";
import { parseBtihFromMagnet } from "../../lib/magnet.js";
import { rtTrackId } from "../../player/trackForQueue.js";

/** Warm in-memory cover cache + BT `only_files` union before cards scroll into view. */
const PREFETCH_ALBUM_COVERS = 12;

const lastCoverPrefetchKey = ref("");

/**
 * iTunes-enriched data for albums keyed by album dirPath.
 * { artist, album, coverUrl, tracksByNumber: Map<number, string> }
 */
const enrichedAlbumData = ref(/** @type {Map<string, object>} */ (new Map()));

const props = defineProps({
  torrent: Object,
  files: Array,
  loading: Boolean,
  magnet: String,
  cover: { type: String, default: null },
  nowPlayingIdx: { default: null },
  /** Синхронно с кнопкой play/pause в нижнем плеере. */
  playerPlaying: { type: Boolean, default: true },
  likes: Object,
});

const emit = defineEmits([
  "play", "play-all", "play-album",
  "download", "download-all", "download-album",
  "toggle-like-track",
  "open-album-preview",
  "add-to-playlist",
  "add-to-queue",
  "open-torrent-source",
]);

const ctxOpen = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);
const ctxOrigIdx = ref(null);

/**
 * @param {MouseEvent} e
 * @param {number} origIdx
 * @returns {void}
 */
function openTrackCtx(e, origIdx) {
  e.preventDefault();
  ctxX.value = e.clientX;
  ctxY.value = e.clientY;
  ctxOrigIdx.value = origIdx;
  ctxOpen.value = true;
}

/**
 * @returns {void}
 */
const torrentCtxActions = computed(() => {
  const srcLabel =
    props.torrent?.source === "soulseek"
      ? "Источник (SoulSeek)"
      : "Источник (Torrent)";
  return [
    { id: "source", label: srcLabel, icon: "source" },
    { id: "divider" },
    { id: "play", label: "Слушать", icon: "play" },
    { id: "download", label: "Скачать", icon: "download" },
    { id: "divider" },
    { id: "like", label: "В избранное", icon: "heart" },
    { id: "queue", label: "В очередь", icon: "queue" },
    { id: "playlist", label: "В плейлист", icon: "playlist" },
  ];
});

function onCtxAction(id) {
  if (id === "source") {
    emit("open-torrent-source", ctxOrigIdx.value);
    return;
  }
  const origIdx = ctxOrigIdx.value;
  if (origIdx == null) return;
  if (id === "play")     emit("play", origIdx);
  if (id === "download") emit("download", origIdx);
  if (id === "queue")    emit("add-to-queue", origIdx);
  const f = (props.files ?? []).find((f) => f.origIdx === origIdx);
  if (id === "playlist" && f) emit("add-to-playlist", makePlaylistTrack(props.torrent, props.magnet, f));
  if (id === "like"     && f) emit("toggle-like-track", makeTrackLike(props.torrent, props.magnet, f));
}

// ── View mode ────────────────────────────────────────────────────────────────
const viewMode = ref(localStorage.getItem("albumViewMode") || "list");

function setViewMode(mode) {
  viewMode.value = mode;
  localStorage.setItem("albumViewMode", mode);
}

/** Gallery card: open album preview. Play starts only on explicit ▶ button press. */
function openAlbumFromGallery(wrap) {
  emit("open-album-preview", {
    album: wrap.raw,
    displayName: wrap.displayName,
  });
}

// ── Albums ───────────────────────────────────────────────────────────────────
const albums = computed(() => detectAlbums(props.files));

const displayAlbums = computed(() => {
  const list = albums.value;
  return list.map((a) => ({
    raw: a,
    displayName: albumDisplayName(a, list),
  }));
});

function albumDisplayName(album, list) {
  // Prefer iTunes-enriched album name
  const enriched = enrichedAlbumData.value.get(album.dirPath ?? "");
  if (enriched?.album) return enriched.album;

  const n = album.name?.trim();
  // Skip disc-marker dirs (CD1, Disc 2, etc.) and derive name from a better source
  if (n && !isDiscMarker(n)) return stripMetaTags(n) || n;

  // Single album: extract "Album" from "Artist - Album" torrent title
  if (list.length === 1) {
    const fromTorrent = extractAlbumFromTorrentName(props.torrent?.name?.trim() ?? "");
    return fromTorrent || props.torrent?.name?.trim() || "Альбом";
  }
  // Multi-album: walk dirPath upward to find a non-disc folder name
  if (album.dirPath) {
    const parts = album.dirPath.split("/").filter(Boolean);
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!isDiscMarker(parts[i])) {
        return extractAlbumFromTorrentName(parts[i]) || stripMetaTags(parts[i]) || parts[i];
      }
    }
    const seg = parts[parts.length - 1];
    if (seg) return stripMetaTags(seg) || seg;
  }
  return "Альбом";
}

const totalAudio = computed(() =>
  albums.value.reduce((sum, a) => sum + a.audioFiles.length, 0)
);

const totalBytes = computed(() => {
  const fromFiles = sumFileSizes(props.files);
  if (fromFiles > 0) return fromFiles;
  const t = Number(props.torrent?.size);
  return Number.isFinite(t) ? t : 0;
});

const seeds = computed(() => Number(props.torrent.seeders) || 0);
const source = computed(() => {
  if (props.torrent.source === "rutracker") return "Rutracker";
  if (props.torrent.source === "soulseek")  return "SoulSeek";
  return "The Pirate Bay";
});

function countLabel(n) {
  return `${n} ${n === 1 ? "трек" : n < 5 ? "трека" : "треков"}`;
}

function playingRowClass(origIdx) {
  if (props.nowPlayingIdx !== origIdx) return [];
  return ["playing", props.playerPlaying ? "playing--active" : "playing--paused"];
}

function seedsLabel(n) {
  return `${n} сид${n === 1 ? "" : n < 5 ? "а" : "ов"}`;
}

/**
 * Stable Track id — MUST match the scheme used by the Track class hierarchy
 * (see `src/player/trackForQueue.js` + search providers). Lookup into the
 * `likes` dict keyed by Track id depends on this equality.
 */
function trackLikeId(torrent, f) {
  if (torrent?.source === "soulseek") {
    const u = f.slskUsername ?? torrent.slsk_username ?? "";
    const p = f.slskFilepath ?? f.path ?? "";
    return `slsk:track:${u}|${p}`;
  }
  const topicId = torrent?.__topicId ?? torrent?.id ?? null;
  const btih = torrent?.source === "magnet" ? parseBtihFromMagnet(props.magnet ?? "") : null;
  return rtTrackId(topicId, btih, f.origIdx) ?? `rt:track:unknown:${f.origIdx}`;
}

function albumLikeId(torrent, dirPath) {
  return `album:${torrent.source}:${torrent.id}:${dirPath || "root"}`;
}

function torrentLikeId(torrent) {
  return `torrent:${torrent.source}:${torrent.id}`;
}

/**
 * Builds a torrent-level like payload.
 * @param {object} torrent
 * @param {string} magnet
 * @returns {object}
 */
function makeTorrentLike(torrent, magnet) {
  return {
    id: torrentLikeId(torrent),
    type: "torrent",
    torrentId: torrent.id,
    torrentName: torrent.name,
    source: torrent.source,
    magnet: magnet || null,
    seeders: torrent.seeders,
  };
}

function makeTrackLike(torrent, magnet, f) {
  let coverFileIdx = null;
  /** Как у лайка альбома — чтобы во вкладке «Треки» брать тот же origIdx, что и для coverFile в торренте. */
  let coverFile = null;
  let albumDirPath = null;
  for (const a of albums.value) {
    if (a.audioFiles.some((af) => af.origIdx === f.origIdx)) {
      albumDirPath = a.dirPath ?? null;
      const cf = a.coverFile;
      if (cf) {
        coverFileIdx = cf.origIdx ?? null;
        coverFile = {
          origIdx: cf.origIdx,
          path: cf.path,
          size: cf.size,
        };
      }
      break;
    }
  }
  return {
    id: trackLikeId(torrent, f),
    type: "track",
    torrentId: torrent.id,
    torrentName: torrent.name,
    source: torrent.source,
    magnet,
    fileIdx: f.origIdx,
    fileName: f.path,
    albumDirPath,
    coverFileIdx,
    coverFile,
  };
}

function makePlaylistTrack(torrent, magnet, f) {
  let coverFileIdx = null;
  for (const a of albums.value) {
    if (a.audioFiles.some((af) => af.origIdx === f.origIdx)) {
      coverFileIdx = a.coverFile?.origIdx ?? null;
      break;
    }
  }
  const row = {
    magnet,
    fileIdx: f.origIdx,
    fileName: f.path,
    torrentName: torrent?.name ?? "",
    torrentId: torrent?.id ?? "",
    source: torrent?.source ?? "rutracker",
    artist: torrent?.artist ?? null,
    coverFileIdx,
  };
  if (torrent?.source === "soulseek") {
    row.slskUsername = f.slskUsername ?? torrent.slsk_username ?? null;
    row.slskFilepath = f.slskFilepath ?? f.path ?? null;
    row.slskFilesize = f.slskFilesize ?? f.size ?? 0;
  }
  return row;
}

function makeAlbumLike(torrent, magnet, album, displayName) {
  const dirPath = album.dirPath || "root";
  return {
    id: albumLikeId(torrent, dirPath),
    type: "album",
    torrentId: torrent.id,
    torrentName: torrent.name,
    source: torrent.source,
    magnet,
    albumName: displayName,
    dirPath,
    audioFiles: album.audioFiles,
    coverFile: album.coverFile ?? null,
  };
}

function trackOffset(idx) {
  return albums.value.slice(0, idx).reduce((s, a) => s + a.audioFiles.length, 0);
}

// ── Share ─────────────────────────────────────────────────────────────────────
const shareCopied = ref(false);
let _shareCopiedTimer = null;

/**
 * Builds a neegde:// deep link for the current torrent and copies it to clipboard.
 * @param {object} torrent
 */
function shareLink(torrent) {
  const url = `neegde://torrent/${torrent.source}/${torrent.id}`;
  navigator.clipboard.writeText(url).then(() => {
    shareCopied.value = true;
    clearTimeout(_shareCopiedTimer);
    _shareCopiedTimer = setTimeout(() => { shareCopied.value = false; }, 2000);
  });
}

/** Один альбом в раздаче — полноэкранный герой с обложкой и треклистом. */
const isAlbumHeroPage = computed(() => {
  if (props.loading) return false;
  if (albums.value.length !== 1) return false;
  return totalAudio.value > 0;
});

const singleAlbumWrap = computed(() => displayAlbums.value[0] ?? null);

const albumHeroTitle = computed(
  () => singleAlbumWrap.value?.displayName?.trim() || props.torrent?.name?.trim() || "Альбом"
);

const albumHeroArtist = computed(() => {
  const album0 = albums.value[0];
  const enriched = enrichedAlbumData.value.get(album0?.dirPath ?? "");
  if (enriched?.artist && !isYearLike(String(enriched.artist).trim())) {
    return enriched.artist;
  }
  const artist = extractTrackArtist(props.torrent?.name, album0?.dirPath ?? null, props.torrent?.artist ?? null, props.magnet);
  return artist || "Неизвестный исполнитель";
});

async function prefetchAlbumCovers() {
  const m = props.magnet?.trim();
  if (!m || props.loading || !props.files?.length) return;

  const list = detectAlbums(props.files);
  const indices = [];
  const n = Math.min(list.length, PREFETCH_ALBUM_COVERS);
  for (let i = 0; i < n; i++) {
    const cf = list[i].coverFile;
    if (
      !cf ||
      !isImage(cf.path) ||
      cf.size <= 0 ||
      cf.size > MAX_TORRENT_COVER_BYTES
    ) {
      continue;
    }
    indices.push(cf.origIdx);
  }
  const key = `${m}:${indices.join(",")}`;
  if (key === lastCoverPrefetchKey.value) return;
  lastCoverPrefetchKey.value = key;

  const magnetEnriched = enrichMagnetWithOpenTrackers(m);
  // Await cached .torrent bytes to skip DHT metadata wait in image session.
  // By this point handleSelect already warmed the cache, so this usually resolves instantly.
  const torrentFileB64 = await torrentFileB64ForTrack({
    source: props.torrent?.source,
    torrentId: props.torrent?.id,
  }).catch(() => null);
  for (const fileIdx of indices) {
    invoke("torrent_fetch_image", {
      magnet: magnetEnriched,
      fileIdx,
      torrentFileB64: torrentFileB64 ?? null,
    }).catch(() => {});
  }
}

/** Enrich up to N albums with iTunes metadata (artist, album name, per-track titles). */
async function enrichAlbums() {
  if (props.loading || !props.files?.length) return;
  const list = albums.value;
  if (!list.length) return;

  const MAX_ALBUMS = 6;
  const toEnrich = list.slice(0, MAX_ALBUMS);

  for (const album of toEnrich) {
    const dirKey = album.dirPath ?? "";
    if (enrichedAlbumData.value.has(dirKey)) continue;

    const firstFile = album.audioFiles[0];
    if (!firstFile) continue;

    const artistRaw = extractTrackArtist(
      props.torrent?.name,
      album.dirPath ?? null,
      props.torrent?.artist ?? null,
      props.magnet
    );
    const albumIdx = list.indexOf(album);
    const albumNameRaw = displayAlbums.value[albumIdx]?.displayName || stripMetaTags(album.name?.trim() || "");

    if (!artistRaw || !albumNameRaw) continue;

    // Fire in background — don't await sequentially
    enrichAlbumTracklist(artistRaw, albumNameRaw).then((result) => {
      if (!result) return;
      const next = new Map(enrichedAlbumData.value);
      next.set(dirKey, result);
      enrichedAlbumData.value = next;
    });
  }
}

watch(
  () => [props.magnet, props.loading, props.files],
  () => {
    enrichedAlbumData.value = new Map(); // reset on new torrent
    prefetchAlbumCovers();
    void enrichAlbums();
  },
  { flush: "post" }
);

</script>

<template src="./TorrentView.html"></template>

<style scoped src="./TorrentView.scoped.css"></style>

