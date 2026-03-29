<script setup>
import { ref, shallowRef, computed, watch, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { appDebugLog, appDebugClickDetail } from "./appDebugLog.js";
import { APP_DEBUG_WINDOW_LABEL } from "./appDebugWindow.js";
import { isAudio, detectAlbums, orderedAudioFiles, trackDisplayBasename } from "./lib/utils.js";
import { trackCoverFileIdxForLike } from "./library/likesCover.js";
import { loadLikes, saveLikes } from "./library/libraryStorage.js";
import {
  loadPlayerSession,
  savePlayerSession,
  clearPlayerSession,
} from "./player/playerSessionStorage.js";
import { restoreSession } from "./rutracker/auth.js";
import { markRutrackerHadAccount, clearRutrackerHadAccount } from "./rutracker/accountHint.js";
import { resolveMirrorIfNeeded } from "./rutracker/config.js";
import { normalizeLoginStatus } from "./rutracker/sessionStatus.js";
import { searchMusic, getTorrentDetails } from "./rutracker/search.js";
import { exportTorrentFiles } from "./torrent/torrentExport.js";
import { torrentFileB64ForTrack } from "./torrent/api.js";

import SearchBar    from "./components/search/SearchBar.vue";
import Results      from "./components/search/Results.vue";
import TorrentView  from "./components/torrent/TorrentView.vue";
import LikesView    from "./components/likes/LikesView.vue";
import SettingsView from "./components/settings/SettingsView.vue";
import Player       from "./components/player/Player.vue";
import AppAuthPanel from "./components/shell/AppAuthPanel.vue";
import NavArrows    from "./components/shell/NavArrows.vue";
import DownloadProgressOverlay from "./components/shell/DownloadProgressOverlay.vue";
import { openAppDebugWindow } from "./appDebugWindow.js";

// ── Search result LRU cache ───────────────────────────────────────────────────
const _searchCache = new Map(); // normalized query → results[]
const SEARCH_CACHE_MAX = 30;
function _searchCacheGet(q) {
  const v = _searchCache.get(q);
  if (v === undefined) return undefined;
  _searchCache.delete(q);
  _searchCache.set(q, v); // LRU touch
  return v;
}
function _searchCacheSet(q, r) {
  if (_searchCache.has(q)) _searchCache.delete(q);
  if (_searchCache.size >= SEARCH_CACHE_MAX) {
    _searchCache.delete(_searchCache.keys().next().value);
  }
  _searchCache.set(q, r);
}

// ── Queue (восстановление последней сессии из localStorage) ──────────────────
const _savedPlayer = loadPlayerSession();
const queue = shallowRef(_savedPlayer?.queue ?? []);
const queuePos = ref(
  _savedPlayer && _savedPlayer.queue.length
    ? _savedPlayer.queuePos
    : 0
);
const nowPlaying = computed(() => queue.value[queuePos.value] ?? null);
const nextInQueue = computed(() => {
  if (queuePos.value >= queue.value.length - 1) return null;
  return queue.value[queuePos.value + 1];
});

watch(
  [queue, queuePos],
  () => {
    savePlayerSession(queue.value, queuePos.value);
  }
);

function flushPlayerSessionToStorage() {
  savePlayerSession(queue.value, queuePos.value);
}

/** После cold start с восстановленной очередью не запускать трек через HTML autoplay — только по клику ▶ / явной смене трека. */
const suppressAutoplayAfterSessionRestore = ref(Boolean(_savedPlayer?.queue?.length));

function allowPlayerAutoplay() {
  suppressAutoplayAfterSessionRestore.value = false;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
const theme = ref(localStorage.getItem("theme") || "dark");

const restoringSession = ref(true);

/** If restore hangs (сеть/DNS), не оставляем UI в вечном «подключении». */
const RESTORE_UI_MAX_MS = 5_000;

onMounted(async () => {
  window.addEventListener("beforeunload", flushPlayerSessionToStorage);
  document.documentElement.setAttribute("data-theme", theme.value);
  authPanelOpen.value = false;

  const unblockTimer = window.setTimeout(() => {
    restoringSession.value = false;
  }, RESTORE_UI_MAX_MS);

  try {
    await resolveMirrorIfNeeded();
    const raw = await restoreSession();
    const s = normalizeLoginStatus(raw);
    if (s.loggedIn) handleLogin(s.username, s.avatarUrl);
  } catch (_) { /* offline or no saved session — stay logged out */ }
  try {
    appDebugEnabled.value = await invoke("get_app_debug_enabled");
  } catch (_) { /* web preview or old backend */ }
  setupAppDebugInstrumentation();
  window.clearTimeout(unblockTimer);
  restoringSession.value = false;
});

onUnmounted(() => {
  window.removeEventListener("beforeunload", flushPlayerSessionToStorage);
  appDebugUnlistenClick?.();
  if (appDebugVisibilityHandler) {
    document.removeEventListener("visibilitychange", appDebugVisibilityHandler);
    appDebugVisibilityHandler = null;
  }
});

function handleThemeChange(newTheme) {
  theme.value = newTheme;
  localStorage.setItem("theme", newTheme);
  document.documentElement.setAttribute("data-theme", newTheme);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const rtLoggedIn  = ref(false);
const rtUsername  = ref(null);
const rtAvatarUrl = ref(null);
const appUser     = ref(null);
const authPanelOpen = ref(false);

// ── View ──────────────────────────────────────────────────────────────────────
const view       = ref("search");  // "search" | "likes" | "settings"
const returnView = ref("search");

/** Журнал отладки: UI, плеер, торренты — только в отдельном окне (настройки → чекбокс). */
const appDebugEnabled = ref(false);

let appDebugUnlistenClick = null;
let appDebugVisibilityHandler = null;

function setupAppDebugInstrumentation() {
  watch(
    appDebugEnabled,
    async (on) => {
      appDebugUnlistenClick?.();
      appDebugUnlistenClick = null;
      if (on) {
        const onClick = (e) => {
          appDebugLog("ui", "click", appDebugClickDetail(e.target));
        };
        document.addEventListener("click", onClick, true);
        appDebugUnlistenClick = () =>
          document.removeEventListener("click", onClick, true);
        void openAppDebugWindow().catch(() => {});
      } else {
        const w = await WebviewWindow.getByLabel(APP_DEBUG_WINDOW_LABEL);
        if (w) await w.close().catch(() => {});
      }
    },
    { immediate: true },
  );

  watch(view, (v, prev) => {
    if (!appDebugEnabled.value) return;
    appDebugLog("ui", "view", { view: v, from: prev });
  });

  watch(queuePos, (pos) => {
    if (!appDebugEnabled.value) return;
    const t = nowPlaying.value;
    appDebugLog("player", "queuePos", {
      pos,
      fileIdx: t?.fileIdx,
      fileName: t?.fileName?.slice?.(0, 80),
    });
  });

  watch(nowPlaying, (t) => {
    if (!appDebugEnabled.value) return;
    appDebugLog("player", "nowPlaying", {
      fileIdx: t?.fileIdx,
      fileName: t?.fileName?.slice?.(0, 80),
      torrentId: t?.torrentId,
    });
  });

  appDebugVisibilityHandler = () => {
    if (!appDebugEnabled.value) return;
    appDebugLog("ui", "visibility", { state: document.visibilityState });
  };
  document.addEventListener("visibilitychange", appDebugVisibilityHandler);
}

// ── Search ────────────────────────────────────────────────────────────────────
const searchQuery = ref("");
const results = shallowRef([]);
const loading = ref(false);
const error   = ref(null);

// ── Torrent ───────────────────────────────────────────────────────────────────
const selected      = ref(null);
const torrentMagnet = ref("");
const torrentCover  = ref(null);   // base64 data URL or null
const files         = shallowRef([]);
const loadingFiles  = ref(false);

/** Полный список файлов раздачи до предпросмотра одного альбома (как из лайков). */
const torrentFilesBeforeAlbumPreview = ref(null);
const torrentSelectedBeforeAlbumPreview = ref(null);

/** Стек для кнопки «вперёд» (как в Spotify): снимки экранов при «назад». */
const forwardStack = ref([]);
/** История «назад» по поиску: результаты → раздача A → раздача B → … */
const backStack = ref([]);

function snapshotSearchForBack() {
  return {
    type: "search",
    searchQuery: searchQuery.value,
    results: [...results.value],
    error: error.value,
  };
}

function snapshotTorrentForBack() {
  return {
    type: "torrent",
    selected: { ...selected.value },
    files: [...files.value],
    magnet: torrentMagnet.value,
    cover: torrentCover.value,
    torrentFilesBeforeAlbumPreview: torrentFilesBeforeAlbumPreview.value
      ? [...torrentFilesBeforeAlbumPreview.value]
      : null,
    torrentSelectedBeforeAlbumPreview: torrentSelectedBeforeAlbumPreview.value
      ? { ...torrentSelectedBeforeAlbumPreview.value }
      : null,
  };
}

function pushCurrentScreenToForwardStack() {
  forwardStack.value.push({
    type: "torrent",
    selected: { ...selected.value },
    files: [...files.value],
    magnet: torrentMagnet.value,
    cover: torrentCover.value,
    restoreLikesView: returnView.value === "likes",
    torrentFilesBeforeAlbumPreview: torrentFilesBeforeAlbumPreview.value
      ? [...torrentFilesBeforeAlbumPreview.value]
      : null,
    torrentSelectedBeforeAlbumPreview: torrentSelectedBeforeAlbumPreview.value
      ? { ...torrentSelectedBeforeAlbumPreview.value }
      : null,
  });
}

/** Оверлей прогресса экспорта на диск (BitTorrent → копирование). */
const downloadProgress = ref(null);
/** false — компактная кнопка «Скачивание» в углу. */
const downloadOverlayExpanded = ref(true);

watch(downloadProgress, (v) => {
  if (v == null) downloadOverlayExpanded.value = true;
});

// ── Likes (persisted locally) ────────────────────────────────────────────────
const likes = ref(loadLikes());
watch(likes, (v) => saveLikes(v), { deep: true });

/** Состояние воспроизведения из плеера — подсветка и анимация в списках. */
const playerPlaying = ref(true);

const nowPlayingMatchForLikes = computed(() => {
  const np = nowPlaying.value;
  if (!np) return null;
  return { magnet: np.magnet, fileIdx: np.fileIdx };
});

/** Подсветка «сейчас играет» только среди файлов текущего экрана (раздача / предпросмотр альбома). */
const nowPlayingIdxForTorrentView = computed(() => {
  const np = nowPlaying.value;
  if (!np || np.magnet !== torrentMagnet.value) return null;
  const fi = np.fileIdx;
  if (fi == null || fi === "") return null;
  const n = Number(fi);
  if (!Number.isFinite(n)) return null;
  const visible = files.value;
  if (!visible?.length) return null;
  const inVisible = visible.some(
    (f) => Number(f.origIdx) === n && isAudio(f.path)
  );
  return inVisible ? n : null;
});

// ── Computed ──────────────────────────────────────────────────────────────────
const mainRef = ref(null);

const navCanGoBack = computed(() => {
  if (view.value !== "search") return false;
  if (torrentFilesBeforeAlbumPreview.value) return true;
  if (backStack.value.length > 0) return true;
  return !!selected.value;
});

watch(
  () => selected.value?.id,
  (newId) => { if (newId && mainRef.value) mainRef.value.scrollTo(0, 0); }
);

// ── Handlers ──────────────────────────────────────────────────────────────────
function handleLogin(username, avatarUrl) {
  markRutrackerHadAccount();
  rtLoggedIn.value  = true;
  rtUsername.value  = username || null;
  rtAvatarUrl.value = avatarUrl || null;
}

/** @param {{ forgetAccount?: boolean } | void} evt — forgetAccount: явный выход (настройки), сбрасываем «раньше входили». */
function handleLogout(evt) {
  const forgetAccount = Boolean(evt && typeof evt === "object" && evt.forgetAccount);
  if (forgetAccount) clearRutrackerHadAccount();
  rtLoggedIn.value   = false;
  rtUsername.value   = null;
  rtAvatarUrl.value  = null;
  results.value      = [];
  selected.value     = null;
  files.value        = [];
  torrentMagnet.value = "";
  torrentCover.value  = null;
  queue.value        = [];
  forwardStack.value = [];
  backStack.value    = [];
}

function handleAppLogin(username) {
  appUser.value       = { username };
  authPanelOpen.value = false;
}

function handleAppRegister() { /* stub */ }

function handleAppLogout() {
  appUser.value = null;
  likes.value   = {};
}

async function handleSearch(query) {
  if (!query?.trim()) return;
  const q = query.trim();
  forwardStack.value = [];
  backStack.value    = [];
  error.value        = null;
  selected.value     = null;
  files.value        = [];
  torrentCover.value = null;
  view.value         = "search";

  const cached = _searchCacheGet(q.toLowerCase());
  if (cached) {
    results.value = cached;
    if (!results.value.length) error.value = "Ничего не найдено.";
    return;
  }

  loading.value = true;
  results.value = [];
  try {
    results.value = await searchMusic(q);
    if (!results.value.length) error.value = "Ничего не найдено.";
    else _searchCacheSet(q.toLowerCase(), results.value);
  } catch (e) {
    error.value = e?.toString?.() ?? "Ошибка поиска";
  } finally {
    loading.value = false;
  }
}

async function handleSelect(torrent) {
  if (selected.value?.id === torrent.id) {
    forwardStack.value = [];
    backStack.value = [];
    selected.value = null; files.value = []; torrentMagnet.value = ""; torrentCover.value = null;
    torrentFilesBeforeAlbumPreview.value = null;
    torrentSelectedBeforeAlbumPreview.value = null;
    return;
  }
  if (selected.value) {
    backStack.value.push(snapshotTorrentForBack());
  } else {
    backStack.value.push(snapshotSearchForBack());
  }
  forwardStack.value = [];
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;
  selected.value      = torrent;
  files.value         = [];
  torrentMagnet.value = "";
  torrentCover.value  = null;
  loadingFiles.value  = true;
  try {
    const details = await getTorrentDetails(torrent.id);
    torrentMagnet.value = details.magnet ?? "";
    torrentCover.value  = details.cover_data_url ?? null;
    files.value = details.files.map((f, i) => ({
      name:     f.path[f.path.length - 1] ?? "",
      path:     f.path.join("/"),
      size:     f.size,
      idx:      i,
      origIdx:  i,
    }));
    // Warm .torrent file cache while user browses the track list.
    // By the time they click play it'll already be resolved → streamUrl skips the fetch.
    void torrentFileB64ForTrack({ source: torrent.source, torrentId: torrent.id });
  } catch (e) {
    console.error("handleSelect:", e);
    // Leave files empty — TorrentView shows "Аудиофайлы не найдены."
  } finally {
    loadingFiles.value = false;
  }
}

function makeQueueItem(f, torrent, magnet, fileList, explicitCoverFileIdx) {
  let coverFileIdx = explicitCoverFileIdx ?? null;
  if (coverFileIdx == null && fileList?.length) {
    const albs = detectAlbums(fileList);
    for (const a of albs) {
      if (a.audioFiles.some((af) => af.origIdx === f.origIdx)) {
        coverFileIdx = a.coverFile?.origIdx ?? null;
        break;
      }
    }
  }
  const rawSeeds = torrent?.seeders;
  const seeders =
    rawSeeds != null && rawSeeds !== "?" && Number.isFinite(Number(rawSeeds))
      ? Number(rawSeeds)
      : null;
  return {
    magnet,
    fileIdx:     f.origIdx,
    fileName:    trackDisplayBasename(f.path),
    torrentName: torrent?.name    ?? "",
    torrentId:   torrent?.id      ?? "",
    source:      torrent?.source  ?? "rutracker",
    coverFileIdx,
    seeders,
  };
}

function handlePlay(fileIdx) {
  allowPlayerAutoplay();
  const audioFiles = orderedAudioFiles(files.value);
  const startIdx = Math.max(0, audioFiles.findIndex((f) => f.origIdx === fileIdx));
  const fullQueue = audioFiles.map((f) =>
    makeQueueItem(f, selected.value, torrentMagnet.value, files.value)
  );
  const existing = queue.value.findIndex(
    (q) => q.fileIdx === fileIdx && q.magnet === torrentMagnet.value
  );
  if (existing !== -1 && queue.value.length === fullQueue.length) {
    queuePos.value = existing;
    return;
  }
  queue.value = fullQueue;
  queuePos.value = startIdx;
}

function handlePlayAll() {
  allowPlayerAutoplay();
  const audioFiles = orderedAudioFiles(files.value);
  if (!audioFiles.length) return;
  queue.value = audioFiles.map((f) => makeQueueItem(f, selected.value, torrentMagnet.value, files.value));
  queuePos.value = 0;
}

function handlePlayAlbum(albumFiles) {
  if (!albumFiles.length) return;
  allowPlayerAutoplay();
  const albs = detectAlbums(files.value);
  const first = albumFiles[0];
  let coverIdx = null;
  for (const a of albs) {
    if (a.audioFiles.some((af) => af.origIdx === first.origIdx)) {
      coverIdx = a.coverFile?.origIdx ?? null;
      break;
    }
  }
  queue.value = albumFiles.map((f) =>
    makeQueueItem(f, selected.value, torrentMagnet.value, files.value, coverIdx)
  );
  queuePos.value = 0;
}

function handleToggleLike(like) {
  const next = { ...likes.value };
  if (next[like.id]) delete next[like.id];
  else next[like.id] = { ...like, addedAt: Date.now() };
  likes.value = next;
}

/** Предпросмотр одного альбома из галереи — как handleOpenTorrentFromLike для type === "album". */
function handleOpenAlbumPreview({ album, displayName }) {
  if (!selected.value || !album?.audioFiles?.length) return;
  if (torrentFilesBeforeAlbumPreview.value) return;

  torrentFilesBeforeAlbumPreview.value = files.value;
  torrentSelectedBeforeAlbumPreview.value = { ...selected.value };

  const list = album.coverFile
    ? [...album.audioFiles, album.coverFile]
    : [...album.audioFiles];
  files.value = list;

  const base = torrentSelectedBeforeAlbumPreview.value;
  const m = base?.name?.match(/^(.+?)\s+[-–—]\s+/);
  selected.value = {
    ...base,
    name: displayName,
    fromLikes: true,
    artist: m ? m[1].trim() : "",
  };
  if (mainRef.value) mainRef.value.scrollTo(0, 0);
}

async function handleOpenTorrentFromLike(like) {
  forwardStack.value = [];
  if (selected.value) {
    backStack.value.push(snapshotTorrentForBack());
  } else {
    backStack.value.push({ type: "likes" });
  }
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;
  const m = like.torrentName?.match(/^(.+?)\s+[-–—]\s+/);
  const torrent = {
    id: like.torrentId,
    name: like.type === "album" ? (like.albumName || like.torrentName) : like.torrentName,
    source: like.source, seeders: "?", size: 0, category: "—", added: "—",
    fromLikes: true, artist: m ? m[1].trim() : "",
  };
  returnView.value    = "likes";
  view.value          = "search";
  selected.value      = torrent;
  torrentCover.value  = null;

  // If the like already carries the file list (saved album like), use it directly
  if (like.type === "album" && like.audioFiles?.length) {
    torrentMagnet.value = like.magnet ?? "";
    files.value        = like.coverFile ? [...like.audioFiles, like.coverFile] : like.audioFiles;
    loadingFiles.value = false;
    return;
  }

  // Otherwise fetch from Rutracker
  loadingFiles.value  = true;
  torrentMagnet.value = like.magnet ?? "";
  try {
    const details = await getTorrentDetails(like.torrentId);
    torrentMagnet.value = details.magnet ?? like.magnet ?? "";
    torrentCover.value  = details.cover_data_url ?? null;
    files.value = details.files.map((f, i) => ({
      name: f.path[f.path.length - 1] ?? "",
      path: f.path.join("/"),
      size: f.size,
      idx: i,
      origIdx: i,
    }));
  } catch (e) {
    console.error("handleOpenTorrentFromLike:", e);
  } finally {
    loadingFiles.value = false;
  }
}

function handlePlayFromLike(like) {
  allowPlayerAutoplay();
  const likedTracks = Object.values(likes.value)
    .filter((l) => l.type === "track").sort((a, b) => b.addedAt - a.addedAt);
  const startIdx = Math.max(0, likedTracks.findIndex((l) => l.id === like.id));
  const fullQueue = likedTracks.map((l) => ({
    magnet: l.magnet, fileIdx: l.fileIdx, fileName: l.fileName,
    torrentName: l.torrentName, torrentId: l.torrentId, source: l.source,
    coverFileIdx: trackCoverFileIdxForLike(l, likes.value),
  }));
  const existing = queue.value.findIndex(
    (q) => q.fileIdx === like.fileIdx && q.magnet === like.magnet && q.torrentId === like.torrentId
  );
  if (existing !== -1 && queue.value.length === fullQueue.length) {
    queuePos.value = existing;
    return;
  }
  queue.value = fullQueue;
  queuePos.value = startIdx;
}

function handlePlayAlbumFromLike(like) {
  if (!like.audioFiles?.length) return;
  allowPlayerAutoplay();
  queue.value = like.audioFiles.map((f) => ({
    magnet: like.magnet, fileIdx: f.origIdx, fileName: trackDisplayBasename(f.path),
    torrentName: like.torrentName, torrentId: like.torrentId, source: like.source,
    coverFileIdx: like.coverFile?.origIdx ?? null,
  }));
  queuePos.value = 0;
}

function handleDownloadTrack(origIdx) {
  downloadOverlayExpanded.value = true;
  const f = files.value.find((x) => x.origIdx === origIdx);
  const label = f ? trackDisplayBasename(f.path) : `Файл ${origIdx}`;
  exportTorrentFiles(torrentMagnet.value, [origIdx], [label], null, (p) => {
    downloadProgress.value = p;
  });
}

function handleDownloadAll() {
  downloadOverlayExpanded.value = true;
  const audio = files.value.filter((f) => isAudio(f.path));
  const idxs = audio.map((f) => f.origIdx);
  const labels = audio.map((f) => trackDisplayBasename(f.path));
  exportTorrentFiles(torrentMagnet.value, idxs, labels, null, (p) => {
    downloadProgress.value = p;
  });
}

function handleDownloadAlbum(albumFiles, albumName = "") {
  downloadOverlayExpanded.value = true;
  const audio = (albumFiles ?? []).filter((f) => isAudio(f.path));
  const idxs = audio.map((f) => f.origIdx);
  const labels = audio.map((f) => trackDisplayBasename(f.path));
  exportTorrentFiles(
    torrentMagnet.value,
    idxs,
    labels,
    { albumDirName: albumName || selected.value?.name || "Альбом" },
    (p) => {
      downloadProgress.value = p;
    }
  );
}

function handleNext() {
  allowPlayerAutoplay();
  if (queuePos.value < queue.value.length - 1) queuePos.value++;
  else { queue.value = []; queuePos.value = 0; }
}
function handlePrev() {
  allowPlayerAutoplay();
  queuePos.value = Math.max(0, queuePos.value - 1);
}

function navToSearch() {
  forwardStack.value = [];
  backStack.value = [];
  view.value          = "search";
  selected.value      = null;
  files.value         = [];
  torrentMagnet.value = "";
  torrentCover.value  = null;
  error.value         = null;
}

function handleBack() {
  if (torrentFilesBeforeAlbumPreview.value) {
    forwardStack.value.push({
      type: "album-preview",
      files: [...files.value],
      selected: { ...selected.value },
      magnet: torrentMagnet.value,
      cover: torrentCover.value,
      fullFiles: torrentFilesBeforeAlbumPreview.value,
      fullSelected: torrentSelectedBeforeAlbumPreview.value,
    });
    files.value = torrentFilesBeforeAlbumPreview.value;
    selected.value = torrentSelectedBeforeAlbumPreview.value;
    torrentFilesBeforeAlbumPreview.value = null;
    torrentSelectedBeforeAlbumPreview.value = null;
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
    return;
  }

  if (backStack.value.length > 0) {
    pushCurrentScreenToForwardStack();
    const entry = backStack.value.pop();
    if (entry.type === "search") {
      searchQuery.value = entry.searchQuery;
      results.value = [...entry.results];
      error.value = entry.error;
      selected.value = null;
      files.value = [];
      torrentMagnet.value = "";
      torrentCover.value = null;
      torrentFilesBeforeAlbumPreview.value = null;
      torrentSelectedBeforeAlbumPreview.value = null;
    } else if (entry.type === "torrent") {
      selected.value = { ...entry.selected };
      files.value = [...entry.files];
      torrentMagnet.value = entry.magnet;
      torrentCover.value = entry.cover;
      torrentFilesBeforeAlbumPreview.value = entry.torrentFilesBeforeAlbumPreview;
      torrentSelectedBeforeAlbumPreview.value = entry.torrentSelectedBeforeAlbumPreview;
      view.value = "search";
    } else if (entry.type === "likes") {
      view.value = "likes";
      returnView.value = "search";
      selected.value = null;
      files.value = [];
      torrentMagnet.value = "";
      torrentCover.value = null;
      torrentFilesBeforeAlbumPreview.value = null;
      torrentSelectedBeforeAlbumPreview.value = null;
    }
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
    return;
  }

  if (selected.value) {
    forwardStack.value.push({
      type: "torrent",
      selected: { ...selected.value },
      files: [...files.value],
      magnet: torrentMagnet.value,
      cover: torrentCover.value,
      restoreLikesView: returnView.value === "likes",
      torrentFilesBeforeAlbumPreview: torrentFilesBeforeAlbumPreview.value
        ? [...torrentFilesBeforeAlbumPreview.value]
        : null,
      torrentSelectedBeforeAlbumPreview: torrentSelectedBeforeAlbumPreview.value
        ? { ...torrentSelectedBeforeAlbumPreview.value }
        : null,
    });
  }
  selected.value = null;
  files.value = [];
  torrentMagnet.value = "";
  torrentCover.value = null;
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;
  if (returnView.value === "likes") {
    view.value = "likes";
    returnView.value = "search";
  }
}

function handleForwardNav() {
  const snap = forwardStack.value.pop();
  if (!snap) return;
  if (snap.type === "album-preview") {
    files.value = snap.files;
    selected.value = snap.selected;
    torrentMagnet.value = snap.magnet;
    torrentCover.value = snap.cover;
    torrentFilesBeforeAlbumPreview.value = snap.fullFiles;
    torrentSelectedBeforeAlbumPreview.value = snap.fullSelected;
  } else if (snap.type === "torrent") {
    view.value = "search";
    if (snap.restoreLikesView) {
      returnView.value = "likes";
    }
    selected.value = snap.selected;
    files.value = snap.files;
    torrentMagnet.value = snap.magnet;
    torrentCover.value = snap.cover;
    torrentFilesBeforeAlbumPreview.value = snap.torrentFilesBeforeAlbumPreview ?? null;
    torrentSelectedBeforeAlbumPreview.value = snap.torrentSelectedBeforeAlbumPreview ?? null;
  }
  if (mainRef.value) mainRef.value.scrollTo(0, 0);
}

function handleNavBack() {
  handleBack();
}
</script>

<template>
  <div class="app has-player">

    <!-- ── Sidebar ─────────────────────────────────────────────────── -->
    <aside class="sidebar">
      <header class="sidebar-header">
        <div class="sidebar-logo">
          <div class="logo-text">Где слушаешь? <span class="logo-nigde">Нигде.</span></div>
        </div>
        <NavArrows
          class="sidebar-nav-arrows"
          :can-go-back="navCanGoBack"
          :can-go-forward="forwardStack.length > 0"
          @back="handleNavBack"
          @forward="handleForwardNav"
        />
      </header>

      <nav class="sidebar-nav">
        <!-- Search -->
        <button
          :class="['source-btn search-nav-btn', view === 'search' ? 'active' : '']"
          @click="navToSearch"
        >
          <span class="source-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2.5"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </span>
          Поиск
          <span :class="['rt-dot', restoringSession ? 'rt-dot-loading' : rtLoggedIn ? 'rt-dot-on' : 'rt-dot-off']" />
        </button>

        <!-- Library -->
        <div class="nav-label" style="margin-top: 16px">Библиотека</div>
        <button
          :class="['source-btn', view === 'likes' ? 'active' : '']"
          @click="view = view === 'likes' ? 'search' : 'likes'"
        >
          <span class="source-icon">♥</span>
          Мне нравится
        </button>

        <!-- Settings (bottom of nav) -->
        <div style="flex: 1" />
        <button
          :class="['source-btn', view === 'settings' ? 'active' : '']"
          @click="view = 'settings'"
        >
          <span class="source-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </span>
          Настройки
          <!-- Orange dot when Rutracker is not connected -->
          <span v-if="!rtLoggedIn" class="settings-warn-dot" />
        </button>
      </nav>

      <div
        v-if="restoringSession && !rtLoggedIn"
        class="sidebar-rt-connecting"
        aria-live="polite"
        title="Проверяем доступность Rutracker"
      >
        <span class="spinner sidebar-rt-connecting-spinner" />
        <span class="sidebar-rt-connecting-label">Проверяем доступность…</span>
      </div>

      <!-- App account block -->
      <div class="sidebar-account">
        <button class="account-login-btn account-login-btn--wip" disabled title="В разработке">
          Войти в аккаунт
          <span class="account-wip-badge">скоро</span>
        </button>
      </div>
    </aside>

    <!-- ── Main ────────────────────────────────────────────────────── -->
    <div class="main-wrap" ref="mainRef">
      <div class="main-content">
        <div v-if="view === 'search'" class="main-toolbar">
          <div class="main-toolbar-search">
            <SearchBar
              v-model="searchQuery"
              :loading="loading"
              :show-categories="false"
              @search="handleSearch"
            />
          </div>
        </div>

        <!-- Likes view -->
        <KeepAlive>
          <LikesView
            v-if="view === 'likes'"
            :likes="Object.values(likes)"
            :now-playing="nowPlayingMatchForLikes"
            :player-playing="playerPlaying"
            @toggle-like="handleToggleLike"
            @play="handlePlayFromLike"
            @play-album="handlePlayAlbumFromLike"
            @open-torrent="handleOpenTorrentFromLike"
          />
        </KeepAlive>

        <!-- Settings view -->
        <KeepAlive>
          <SettingsView
            v-if="view === 'settings'"
            :rt-logged-in="rtLoggedIn"
            :rt-username="rtUsername"
            :rt-avatar-url="rtAvatarUrl"
            :restoring-session="restoringSession"
            :app-user="appUser"
            :theme="theme"
            :app-debug-enabled="appDebugEnabled"
            @login="handleLogin"
            @logout="handleLogout"
            @app-logout="handleAppLogout"
            @open-auth="authPanelOpen = true"
            @theme-change="handleThemeChange"
            @update:app-debug-enabled="appDebugEnabled = $event"
          />
        </KeepAlive>

        <!-- Search view -->
        <template v-if="view !== 'likes' && view !== 'settings'">
          <p v-if="error && !loading" class="error-msg">{{ error }}</p>

          <!-- Onboarding: nudge to settings if not connected -->
          <div v-if="!restoringSession && !rtLoggedIn && !appUser && !results.length && !selected && !loading" class="onboarding">
            <div class="onboarding-card" style="cursor:pointer" @click="view = 'settings'">
              <div class="onboarding-icon">🔗</div>
              <div class="onboarding-body">
                <div class="onboarding-title">Подключите Rutracker</div>
                <div class="onboarding-desc">
                  Зайдите в <strong style="color:var(--text)">Настройки</strong> и введите логин — поиск заработает сразу.
                </div>
              </div>
            </div>
            <div class="onboarding-card onboarding-card--dim" style="cursor:pointer" @click="authPanelOpen = true">
              <div class="onboarding-icon">♥</div>
              <div class="onboarding-body">
                <div class="onboarding-title">Аккаунт — для библиотеки</div>
                <div class="onboarding-desc">
                  Лайки уже сохраняются на этом компьютере. Аккаунт — для синхронизации между устройствами (скоро).
                </div>
              </div>
            </div>
          </div>

          <Results
            v-if="!selected && results.length > 0"
            :results="results"
            :selected-id="null"
            @select="handleSelect"
          />

          <TorrentView
            v-if="selected"
            :torrent="selected"
            :files="files"
            :loading="loadingFiles"
            :magnet="torrentMagnet"
            :cover="torrentCover"
            :now-playing-idx="nowPlayingIdxForTorrentView"
            :player-playing="playerPlaying"
            :likes="likes"
            @play="handlePlay"
            @play-all="handlePlayAll"
            @play-album="handlePlayAlbum"
            @download-album="handleDownloadAlbum"
            @download="handleDownloadTrack"
            @download-all="handleDownloadAll"
            @toggle-like="handleToggleLike"
            @open-album-preview="handleOpenAlbumPreview"
          />
        </template>

      </div>
    </div>

    <!-- ── Player ──────────────────────────────────────────────────── -->
    <Player
      :track="nowPlaying"
      :next-track="nextInQueue"
      :suppress-autoplay="suppressAutoplayAfterSessionRestore"
      :has-prev="queuePos > 0"
      :has-next="queuePos < queue.length - 1"
      @prev="handlePrev"
      @next="handleNext"
      @ended="handleNext"
      @request-stream="allowPlayerAutoplay"
      @playing-change="playerPlaying = $event"
    />

    <!-- ── App auth modal ──────────────────────────────────────────── -->
    <AppAuthPanel
      v-if="authPanelOpen"
      @login="handleAppLogin"
      @register="handleAppRegister"
      @close="authPanelOpen = false"
    />

    <DownloadProgressOverlay
      v-model:expanded="downloadOverlayExpanded"
      :progress="downloadProgress"
    />

  </div>
</template>
