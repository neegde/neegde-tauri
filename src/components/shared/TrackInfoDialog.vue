<script setup>
import { computed } from "vue";
import { useTrackInfo } from "../../composables/useTrackInfo.js";

const { open, entry, close } = useTrackInfo();

const track = computed(() => entry.value?.track ?? null);
const meta = computed(() => entry.value?.meta ?? null);
const cacheKeys = computed(() => entry.value?.cacheKeys ?? null);
const cache = computed(() => entry.value?.cache ?? null);

function fmtDate(ts) {
  return new Date(ts).toLocaleString("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function fmtDuration(secs) {
  if (!secs) return "";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function truncPath(s, maxLen = 55) {
  if (!s || s.length <= maxLen) return s ?? "";
  return `…${s.slice(-(maxLen - 1))}`;
}

function fmtKey(s, maxLen = 50) {
  if (!s) return "—";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

function stateLabel(state) {
  if (state === "hit") return "есть";
  if (state === "miss") return "нет";
  return "?";
}

const cacheRows = computed(() => {
  const c = cache.value;
  if (!c) return [];
  const rows = [];

  rows.push({
    label: "Трек-кэш",
    state: c.trackCache.state,
    hint: c.trackCache.layer ?? c.trackCache.storage ?? "",
  });

  const inlined = c.covers?.inlinedOnTrack;
  if (inlined !== undefined) {
    rows.push({
      label: "Обложка (URL)",
      state: inlined.present ? "hit" : "miss",
      hint: inlined.present ? inlined.kind : "",
    });
  }

  const rtCover = c.covers?.rutrackerTopic;
  if (rtCover) {
    rows.push({
      label: "Обложка (Rutracker)",
      state: rtCover.state,
      hint: rtCover.layer ?? "",
    });
  }

  const slskCover = c.covers?.soulseekFile;
  if (slskCover) {
    rows.push({
      label: "Обложка (SoulSeek)",
      state: slskCover.state,
      hint: slskCover.layer ?? "",
    });
  }

  const dzCanon = c.enrichment?.deezerCanonical;
  if (dzCanon) {
    rows.push({
      label: "Deezer (трек)",
      state: dzCanon.state,
      hint: dzCanon.layer ?? "",
    });
  }

  const dzAlbum = c.enrichment?.deezerAlbumArt;
  if (dzAlbum) {
    rows.push({
      label: "Deezer (альбом)",
      state: dzAlbum.state,
      hint: dzAlbum.layer ?? "",
    });
  }

  const torrentB64 = c.torrent?.fileListB64;
  if (torrentB64) {
    rows.push({
      label: "Список файлов",
      state: torrentB64.state,
      hint: torrentB64.layer ?? "",
    });
  }

  if (c.streaming) {
    const bdc = c.streaming.backendDiskCache;
    const s = bdc === "hit" ? "hit" : (bdc === "unknown" || bdc == null) ? "unknown" : "miss";
    rows.push({
      label: "Стриминг (диск)",
      state: s,
      hint: c.streaming.note ?? bdc ?? "",
    });
  }

  return rows;
});

const keyRows = computed(() => {
  const k = cacheKeys.value;
  if (!k) return [];
  const rows = [];
  if (k.trackCacheId) rows.push({ label: "ID", value: fmtKey(k.trackCacheId) });
  if (k.deezerCanonical) rows.push({ label: "Deezer трек", value: fmtKey(k.deezerCanonical) });
  if (k.deezerAlbumArt) rows.push({ label: "Deezer арт", value: fmtKey(k.deezerAlbumArt) });
  if (k.rutrackerTopicCover) rows.push({ label: "RT обложка", value: fmtKey(k.rutrackerTopicCover) });
  if (k.torrentFileB64) rows.push({ label: "торрент B64", value: fmtKey(k.torrentFileB64) });
  if (k.soulseekCover) rows.push({ label: "SLSK обложка", value: fmtKey(k.soulseekCover) });
  const si = k.streamIdentity;
  if (si) {
    if (si.slskUsername) {
      rows.push({ label: "SLSK пир", value: fmtKey(si.slskUsername) });
    } else if (si.magnet) {
      rows.push({ label: "магнет", value: fmtKey(si.magnet) });
    }
  }
  return rows;
});

const sourceDisplay = computed(() => {
  const t = track.value;
  if (!t?.sources?.length) return null;
  const src = t.sources[0];
  if (src.kind === "soulseek") {
    return {
      kind: "SoulSeek",
      peer: src.refs.slskUsername ?? "",
      path: truncPath(src.refs.slskFilepath ?? ""),
    };
  }
  if (src.kind === "rutracker") {
    const topicId = src.refs.topicId;
    return {
      kind: "Rutracker",
      peer: topicId ? `topic #${topicId}` : "",
      path: "",
    };
  }
  if (src.kind === "magnet") {
    return {
      kind: "Magnet",
      peer: "",
      path: truncPath(src.refs.magnet ?? ""),
    };
  }
  return null;
});
</script>

<template src="./TrackInfoDialog.html"></template>

<style scoped src="./TrackInfoDialog.scoped.css"></style>
