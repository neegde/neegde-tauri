<script setup>
import { ref, shallowRef, computed, watch, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { appDebugLog, appDebugClickDetail } from "./appDebugLog.js";
import {
  isAudio,
  detectAlbums,
  orderedAudioFiles,
  trackDisplayBasename,
  enrichMagnetWithOpenTrackers,
} from "./lib/utils.js";
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
import { syncRtHttpProxyCacheFromBackend } from "./rutracker/proxyConfig.js";
import { normalizeLoginStatus } from "./rutracker/sessionStatus.js";
import {
  searchMusic,
  getTorrentDetails,
  filterRutrackerRowsWithPlayableAudio,
  prefetchTorrentDetails,
} from "./rutracker/search.js";
import {
  soulseekLogin,
  soulseekLogout,
  soulseekStatus,
  soulseekSearch,
  soulseekSaveCredentials,
  soulseekLoadCredentials,
  soulseekClearSavedCredentials,
  clearSlskCoverCache,
} from "./soulseek/api.js";
import { exportTorrentFiles } from "./torrent/torrentExport.js";
import { torrentFileB64ForTrack, streamUrl, magnetListFiles } from "./torrent/api.js";
import { releaseTorrentStreamUrl, torrentPrepareCancel } from "./torrent/torrentSession.js";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";

import SearchBar    from "./components/search/SearchBar.vue";
import Results      from "./components/search/Results.vue";
import TorrentView  from "./components/torrent/TorrentView.vue";
import LikesView    from "./components/likes/LikesView.vue";
import SettingsView from "./components/settings/SettingsView.vue";
import Player       from "./components/player/Player.vue";
import NavArrows       from "./components/shell/NavArrows.vue";
import MagnetLinkDialog from "./components/shell/MagnetLinkDialog.vue";
import DownloadProgressOverlay from "./components/shell/DownloadProgressOverlay.vue";
import AppSplash from "./components/shell/AppSplash.vue";
import HomeView from "./components/home/HomeView.vue";
import { openAppDebugWindow, closeAppDebugWindow } from "./appDebugWindow.js";
import { loadRecentHistory, addToRecentHistory } from "./lib/recentHistory.js";
import { loadSearchHistory, addToSearchHistory } from "./lib/searchHistory.js";
import {
  loadPlaylists, createPlaylist, deletePlaylist, renamePlaylist,
  addTrackToPlaylist, removeTrackFromPlaylist,
} from "./lib/playlistStorage.js";
import PlaylistView from "./components/playlist/PlaylistView.vue";
import {
  loadAchievementsOptIn,
  saveAchievementsOptIn,
  loadAchievementsState,
  saveAchievementsState,
  emptyAchievementsProgress,
} from "./achievements/achievementsStorage.js";
import {
  achievementMeta,
  applyPlaybackStarted,
  applyRetroactiveOptIn,
  applyLikeChange,
} from "./achievements/achievementsCore.js";
import AchievementToast from "./components/shell/AchievementToast.vue";

// ── SoulSeek result grouping ──────────────────────────────────────────────────

function _slskFolderKey(filepath) {
  const norm = (filepath ?? "").replace(/\\/g, "/");
  const last = norm.lastIndexOf("/");
  return last > 0 ? norm.slice(0, last) : "";
}

function _slskAlbumNormKey(folderPath) {
  const parts = folderPath.split("/").filter(Boolean);
  // Use last 2 segments, strip spaces/punctuation for dedup
  return parts.slice(-2).join("/").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function _slskBestBitrate(tracks) {
  return tracks.reduce((b, t) => (t.bitrate ?? 0) > b ? (t.bitrate ?? 0) : b, 0);
}

/** Lower is better — matches common release folder art names. */
function _slskCoverPriority(filename) {
  const n = (filename ?? "").toLowerCase();
  const order = [
    "folder.jpg", "folder.jpeg", "cover.jpg", "cover.jpeg", "front.jpg", "front.jpeg",
    "album.jpg", "artwork.jpg", "cover.png", "folder.png", "front.png", "album.png",
  ];
  for (let i = 0; i < order.length; i++) {
    if (n.endsWith(order[i])) return i;
  }
  return 40;
}

/**
 * Picks one image file to use as folder cover (same SoulSeek user + directory as tracks).
 *
 * Args:
 *     candidates: Rows with slsk_is_image from search.
 *
 * Returns:
 *     Best candidate row or null.
 */
function _slskPickCover(candidates) {
  if (!candidates?.length) return null;
  const scored = candidates.map((c) => {
    const base = (c.slsk_filepath ?? c.name ?? "").split(/[\\/]/).pop() ?? "";
    return { c, pr: _slskCoverPriority(base), size: c.size ?? 0 };
  });
  scored.sort((a, b) => a.pr - b.pr || b.size - a.size);
  return scored[0].c;
}

/**
 * Builds a flat list of playable SoulSeek rows (one per audio file).
 *
 * Multi-track folders are deduplicated by normalized folder name (best peer wins),
 * then expanded into one row per file with that folder's cover image.
 * Single-file folders are deduplicated by normalized filename (best bitrate wins).
 *
 * Args:
 *     rawTracks: Parsed search rows (audio + image sidecars).
 *
 * Returns:
 *     Array of track-shaped results with slsk_cover_* when an image exists in-folder.
 *     `seeders` is the number of distinct SoulSeek peers that matched the same dedup key
 *     (proxy for availability). Row order is not re-sorted — grouping preserves arrival order
 *     as much as the data structures allow.
 */
function groupSlskResults(rawTracks) {
  const images = rawTracks.filter((r) => r.slsk_is_image);
  const audios = rawTracks.filter((r) => !r.slsk_is_image);

  const imagesByKey = new Map();
  for (const img of images) {
    const folder = _slskFolderKey(img.slsk_filepath);
    const key = `${img.slsk_username}|${folder}`;
    if (!imagesByKey.has(key)) imagesByKey.set(key, []);
    imagesByKey.get(key).push(img);
  }

  const byUserFolder = new Map();
  for (const t of audios) {
    const folder = _slskFolderKey(t.slsk_filepath);
    const key = `${t.slsk_username}|${folder}`;
    if (!byUserFolder.has(key)) byUserFolder.set(key, { folder, user: t.slsk_username, tracks: [] });
    byUserFolder.get(key).tracks.push(t);
  }

  const albumCandidates = [];
  const singleCandidates = [];
  for (const [, g] of byUserFolder) {
    if (g.tracks.length >= 2) albumCandidates.push(g);
    else if (g.tracks.length === 1) singleCandidates.push(g.tracks[0]);
  }

  /** How many multi-track folders collapsed into each normalized album key (peer availability). */
  const albumKeyPeers = new Map();
  for (const g of albumCandidates) {
    const k = _slskAlbumNormKey(g.folder);
    albumKeyPeers.set(k, (albumKeyPeers.get(k) ?? 0) + 1);
  }

  const albumsByKey = new Map();
  for (const g of albumCandidates) {
    const key = _slskAlbumNormKey(g.folder);
    const ex = albumsByKey.get(key);
    if (!ex || g.tracks.length > ex.tracks.length ||
        (g.tracks.length === ex.tracks.length && _slskBestBitrate(g.tracks) > _slskBestBitrate(ex.tracks))) {
      albumsByKey.set(key, g);
    }
  }

  /** How many lone files matched each normalized filename (peer availability). */
  const singleKeyPeers = new Map();
  for (const t of singleCandidates) {
    const filename = (t.slsk_filepath ?? t.name ?? "").split(/[\\/]/).pop() ?? "";
    const k = filename.toLowerCase().replace(/[^a-z0-9]/g, "");
    singleKeyPeers.set(k, (singleKeyPeers.get(k) ?? 0) + 1);
  }

  const singlesByKey = new Map();
  for (const t of singleCandidates) {
    const filename = (t.slsk_filepath ?? t.name ?? "").split(/[\\/]/).pop() ?? "";
    const key = filename.toLowerCase().replace(/[^a-z0-9]/g, "");
    const ex = singlesByKey.get(key);
    if (!ex || (t.bitrate ?? 0) > (ex.bitrate ?? 0)) singlesByKey.set(key, t);
  }

  const tracksOut = [];

  for (const g of albumsByKey.values()) {
    const coverKey = `${g.user}|${g.folder}`;
    const cover = _slskPickCover(imagesByKey.get(coverKey) ?? []);
    const bestBitrate = _slskBestBitrate(g.tracks) || null;
    const category = bestBitrate ? `MP3 ${bestBitrate} kbps` : "SoulSeek";
    const normAlbumKey = _slskAlbumNormKey(g.folder);
    const peerCount = Math.max(1, albumKeyPeers.get(normAlbumKey) ?? 1);
    for (const t of g.tracks) {
      const filename = (t.slsk_filepath ?? t.name ?? "").split(/[\\/]/).pop() ?? "";
      tracksOut.push({
        id: t.id ?? `slsk_track_${g.user}_${t.slsk_filepath}`,
        name: filename,
        source: "soulseek",
        slsk_type: "track",
        category,
        size: t.size ?? 0,
        seeders: peerCount, leechers: 0, added: "—",
        slsk_username: g.user,
        slsk_filepath: t.slsk_filepath,
        slsk_folder: g.folder,
        slsk_tracks: [t],
        bitrate: t.bitrate ?? null,
        duration: t.duration ?? null,
        slsk_cover_username: cover?.slsk_username ?? null,
        slsk_cover_filepath: cover?.slsk_filepath ?? null,
        slsk_cover_size: cover?.size ?? 0,
      });
    }
  }

  for (const t of singlesByKey.values()) {
    const filename = (t.slsk_filepath ?? t.name ?? "").split(/[\\/]/).pop() ?? "";
    const ck = `${t.slsk_username}|${_slskFolderKey(t.slsk_filepath)}`;
    const cover = _slskPickCover(imagesByKey.get(ck) ?? []);
    const singleNormKey = filename.toLowerCase().replace(/[^a-z0-9]/g, "");
    const peerCount = Math.max(1, singleKeyPeers.get(singleNormKey) ?? 1);
    tracksOut.push({
      id: t.id ?? `slsk_track_${t.slsk_username}_${t.slsk_filepath}`,
      name: filename,
      source: "soulseek",
      slsk_type: "track",
      category: t.category ?? "SoulSeek",
      size: t.size ?? 0,
      seeders: peerCount, leechers: 0, added: "—",
      slsk_username: t.slsk_username,
      slsk_filepath: t.slsk_filepath,
      slsk_folder: _slskFolderKey(t.slsk_filepath),
      slsk_tracks: [t],
      bitrate: t.bitrate ?? null,
      duration: t.duration ?? null,
      slsk_cover_username: cover?.slsk_username ?? null,
      slsk_cover_filepath: cover?.slsk_filepath ?? null,
      slsk_cover_size: cover?.size ?? 0,
    });
  }

  return tracksOut;
}

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

function loadRepeatMode() {
  const v = localStorage.getItem("neegde.player.repeatMode");
  if (v === "all" || v === "one" || v === "off") return v;
  return "off";
}

function loadShuffleOn() {
  return localStorage.getItem("neegde.player.shuffle") === "1";
}

/** `off` → no wrap; `all` → loop queue; `one` → current track restarts (handled in Player). */
const repeatMode = ref(loadRepeatMode());
const shuffleOn = ref(loadShuffleOn());

watch(repeatMode, (v) => {
  localStorage.setItem("neegde.player.repeatMode", v);
});

const nowPlaying = computed(() => queue.value[queuePos.value] ?? null);
const nextInQueue = computed(() => {
  const q = queue.value;
  const len = q.length;
  if (len === 0) return null;
  const pos = queuePos.value;
  if (pos < len - 1) return q[pos + 1];
  if (repeatMode.value === "all") return q[0];
  return null;
});
const secondNextInQueue = computed(() => {
  const q = queue.value;
  const len = q.length;
  if (len < 2) return null;
  const pos = queuePos.value;
  if (pos < len - 2) return q[pos + 2];
  if (pos === len - 2) {
    return repeatMode.value === "all" ? q[0] : null;
  }
  if (repeatMode.value !== "all") return null;
  return len > 2 ? q[1] : q[0];
});

const playerHasNext = computed(() => {
  const len = queue.value.length;
  if (len === 0) return false;
  if (queuePos.value < len - 1) return true;
  return repeatMode.value === "all";
});

const playerHasPrev = computed(() => {
  const len = queue.value.length;
  if (len === 0) return false;
  if (queuePos.value > 0) return true;
  return repeatMode.value === "all" && len > 1;
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

function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyEffectiveTheme(mode) {
  const effective = mode === "system" ? getSystemTheme() : mode;
  document.documentElement.setAttribute("data-theme", effective);
}

const restoringSession = ref(true);

/**
 * When true, splash stays on screen for layout review (app still boots underneath).
 * Set to false for normal startup.
 */
const holdSplashForReview = false;

/** If restore hangs (сеть/DNS), не оставляем UI в вечном «подключении». */
const RESTORE_UI_MAX_MS = 5_000;

onMounted(async () => {
  window.addEventListener("beforeunload", flushPlayerSessionToStorage);
  /* mousedown/mouseup: Wry на macOS шлёт только MouseEvent для кнопок 3/4; на mouseup без preventDefault — history.back/forward (см. wry synthetic_mouse_events). */
  window.addEventListener("mousedown", onMouseSideButtonDown, MOUSE_NAV_CAPTURE);
  window.addEventListener("mouseup", onMouseSideButtonUp, MOUSE_NAV_CAPTURE);
  applyEffectiveTheme(theme.value);
  const _sysMQ = window.matchMedia("(prefers-color-scheme: dark)");
  _sysMQ.addEventListener("change", () => {
    if (theme.value === "system") applyEffectiveTheme("system");
  });
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
    await syncRtHttpProxyCacheFromBackend();
  } catch (_) { /* нет Tauri API (превью в браузере) */ }
  try {
    appDebugEnabled.value = await invoke("get_app_debug_enabled");
  } catch (_) { /* нет Tauri API (превью в браузере) */ }
  setupAppDebugInstrumentation();
  // In development builds (`npm run tauri dev`) always open the debug window so
  // errors are immediately visible without manually enabling debug mode in settings.
  if (import.meta.env.DEV) {
    void openAppDebugWindow().catch(() => {});
  }
  window.clearTimeout(unblockTimer);
  restoringSession.value = false;

  // Deep link: app already running (neegde://torrent/...)
  onOpenUrl((urls) => { if (urls?.[0]) void handleDeepLink(urls[0]); });
  // Deep link: cold start — URL passed at launch
  getCurrent().then((urls) => { if (urls?.[0]) void handleDeepLink(urls[0]); }).catch(() => {});
});

onUnmounted(() => {
  window.removeEventListener("beforeunload", flushPlayerSessionToStorage);
  window.removeEventListener("mousedown", onMouseSideButtonDown, MOUSE_NAV_CAPTURE);
  window.removeEventListener("mouseup", onMouseSideButtonUp, MOUSE_NAV_CAPTURE);
  appDebugUnlistenClick?.();
  if (appDebugVisibilityHandler) {
    document.removeEventListener("visibilitychange", appDebugVisibilityHandler);
    appDebugVisibilityHandler = null;
  }
});

function handleThemeChange(newTheme) {
  theme.value = newTheme;
  localStorage.setItem("theme", newTheme);
  applyEffectiveTheme(newTheme);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const rtLoggedIn  = ref(false);
const rtUsername  = ref(null);
const rtAvatarUrl = ref(null);
// ── SoulSeek ──────────────────────────────────────────────────────────────────
const slskConnected = ref(false);
const slskUsername  = ref(null);
const slskLoggingIn = ref(false);
const slskLoginError = ref(null);
// Restore SoulSeek session on app start (auto-login with saved credentials)
onMounted(async () => {
  try {
    const status = await soulseekStatus();
    if (status?.connected) {
      slskConnected.value = true;
      slskUsername.value = status.username;
      return;
    }
    // Try auto-login with saved credentials
    const creds = await soulseekLoadCredentials();
    if (creds) {
      const [username, password] = creds;
      const result = await soulseekLogin(username, password);
      if (result?.success) {
        slskConnected.value = true;
        slskUsername.value = result.username;
      }
    }
  } catch { /* no Tauri API */ }
});
// ── View ──────────────────────────────────────────────────────────────────────
const view       = ref("home");  // "home" | "search" | "likes" | "settings" | "playlist"
const returnView = ref("search");

// ── Recent History ────────────────────────────────────────────────────────────
const recentHistory = ref(loadRecentHistory());

/**
 * Fetches RuTracker torrent details for recent home cards so topic covers sit in cache
 * during splash (overlap with restoringSession) instead of after HomeView mounts.
 */
function prefetchRecentRutrackerCoversForHome() {
  if (!rtLoggedIn.value) return;
  for (const item of recentHistory.value.slice(0, 10)) {
    if (item.source === "rutracker" && item.id != null && item.id !== "") {
      prefetchTorrentDetails(String(item.id));
    }
  }
}

watch([rtLoggedIn, recentHistory], prefetchRecentRutrackerCoversForHome, { deep: true });

// ── Search History ────────────────────────────────────────────────────────────
const searchHistory = ref(loadSearchHistory());

// ── Playlists ─────────────────────────────────────────────────────────────────
const playlists = ref(loadPlaylists());
const currentPlaylistId = ref(null);
const currentPlaylist = computed(() => playlists.value.find((p) => p.id === currentPlaylistId.value) ?? null);

const addToPlaylistModal = ref(false);
const addToPlaylistTrack = ref(null);

function openPlaylist(id) {
  currentPlaylistId.value = id;
  view.value = "playlist";
}

function handleCreatePlaylist() {
  playlists.value = createPlaylist(`Плейлист ${playlists.value.length + 1}`);
  const newPl = playlists.value[playlists.value.length - 1];
  openPlaylist(newPl.id);
}

function handleDeletePlaylist(id) {
  playlists.value = deletePlaylist(id);
  if (currentPlaylistId.value === id) {
    currentPlaylistId.value = null;
    view.value = "home";
  }
}

function handleRenamePlaylist(id, name) {
  playlists.value = renamePlaylist(id, name);
}

function handleRemoveTrackFromPlaylist(id, { magnet, fileIdx }) {
  playlists.value = removeTrackFromPlaylist(id, magnet, fileIdx);
}

function handleShowAddToPlaylist(track) {
  addToPlaylistTrack.value = track;
  addToPlaylistModal.value = true;
}

function handleAddToPlaylist(playlistId) {
  if (!addToPlaylistTrack.value) return;
  playlists.value = addTrackToPlaylist(playlistId, addToPlaylistTrack.value);
  addToPlaylistModal.value = false;
  addToPlaylistTrack.value = null;
}

function handleAddToPlaylistNew() {
  playlists.value = createPlaylist(`Плейлист ${playlists.value.length + 1}`);
  const newPl = playlists.value[playlists.value.length - 1];
  if (addToPlaylistTrack.value) {
    playlists.value = addTrackToPlaylist(newPl.id, addToPlaylistTrack.value);
  }
  addToPlaylistModal.value = false;
  addToPlaylistTrack.value = null;
  openPlaylist(newPl.id);
}

function handlePlayPlaylist(startIdx) {
  const pl = currentPlaylist.value;
  if (!pl?.tracks?.length) return;
  allowPlayerAutoplay();
  queue.value = pl.tracks.map((t) => ({
    magnet: t.magnet,
    fileIdx: t.fileIdx,
    fileName: t.fileName,
    torrentName: t.torrentName,
    torrentId: t.torrentId,
    source: t.source,
    artist: t.artist ?? null,
    coverFileIdx: t.coverFileIdx ?? null,
  }));
  queuePos.value = startIdx ?? 0;
}

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
        await closeAppDebugWindow();
      }
    },
    { immediate: true },
  );

  watch(view, (v, prev) => {
    appDebugLog("ui", `nav: ${prev ?? "—"} → ${v}`);
  });

  watch(queuePos, (pos) => {
    const t = nowPlaying.value;
    appDebugLog("player", "queue position changed", {
      pos,
      fileIdx: t?.fileIdx,
      fileName: t?.fileName?.slice?.(0, 80),
    });
  });

  watch(nowPlaying, (t) => {
    if (t == null) {
      appDebugLog("player", "now playing: cleared (queue empty or stopped)");
    } else {
      appDebugLog("player", `now playing: fileIdx=${t.fileIdx} "${t.fileName?.slice?.(0, 80)}"`, {
        torrentId: t.torrentId,
      });
    }
  });

  appDebugVisibilityHandler = () => {
    appDebugLog("ui", `window visibility: ${document.visibilityState}`);
  };
  document.addEventListener("visibilitychange", appDebugVisibilityHandler);
}

// ── Search ────────────────────────────────────────────────────────────────────
const searchQuery = ref("");
/** Rutracker rows (albums / torrents). */
const searchAlbumResults = shallowRef([]);
/** SoulSeek grouped track rows. */
const searchTrackResults = shallowRef([]);
const searchLoadingRt = ref(false);
const searchLoadingSlsk = ref(false);
const searchRtError = ref(null);
const searchSlskError = ref(null);
const loading = computed(() => searchLoadingRt.value || searchLoadingSlsk.value);
const hasSearchResults = computed(
  () => searchAlbumResults.value.length > 0 || searchTrackResults.value.length > 0,
);
const error   = ref(null);
/** Счётчик запросов: старый поиск не сбрасывает спиннер, если уже запущен новый. */
let searchRequestSeq = 0;
/** Увеличивается при каждом новом поиске; вкладки в Results сбрасываются только по нему, не при батчах SoulSeek. */
const searchResultsEpoch = ref(0);
/** Narrow SoulSeek track list to this username (search results unchanged). */
const slskPeerBrowseUser = ref(null);

// ── Torrent ───────────────────────────────────────────────────────────────────
const selected      = ref(null);
const torrentMagnet = ref("");
const torrentCover  = ref(null);   // base64 data URL or null
const files         = shallowRef([]);
const loadingFiles  = ref(false);

/** Полный список файлов раздачи до предпросмотра одного альбома (как из лайков). */
const torrentFilesBeforeAlbumPreview = ref(null);
const torrentSelectedBeforeAlbumPreview = ref(null);

/** Стек для кнопки «вперёд»: снимки экранов при «назад». */
const forwardStack = ref([]);
/** История «назад» по поиску: результаты → раздача A → раздача B → … */
const backStack = ref([]);

function snapshotSearchForBack() {
  return {
    type: "search",
    searchQuery: searchQuery.value,
    resultsAlbums: [...searchAlbumResults.value],
    resultsTracks: [...searchTrackResults.value],
    error: error.value,
    slskPeerBrowseUser: slskPeerBrowseUser.value,
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

let exportDbgLastAt = 0;
let exportDbgLastPhase = "";
let exportDbgLastBatch = null;

watch(downloadProgress, (v) => {
  if (v == null) {
    downloadOverlayExpanded.value = true;
    exportDbgLastPhase = "";
    exportDbgLastBatch = null;
    return;
  }
  {
    const phase = v.phase ?? "";
    const now = Date.now();
    const batch = v.batchIndex ?? null;
    let skip = false;
    if (phase === "downloading") {
      const sameSlice =
        phase === exportDbgLastPhase &&
        batch === exportDbgLastBatch &&
        now - exportDbgLastAt < 2000;
      skip = sameSlice;
    }
    exportDbgLastPhase = phase;
    exportDbgLastBatch = batch;
    if (!skip) {
      exportDbgLastAt = now;
      void appDebugLog(
        "export",
        `${phase}: ${String(v.message ?? "").slice(0, 220)}`,
        {
          pct: v.pct,
          progressBytes: v.progressBytes,
          totalBytes: v.totalBytes,
          torrentState: v.torrentState,
          batchIndex: v.batchIndex,
          batchTotal: v.batchTotal,
          copyIndex: v.copyIndex,
          copyTotal: v.copyTotal,
          queueLen: v.queueLabels?.length,
        }
      );
    }
  }
});

// ── Likes (persisted locally) ────────────────────────────────────────────────
const likes = ref(loadLikes());
watch(likes, (v) => saveLikes(v), { deep: true });

/** Состояние воспроизведения из плеера — подсветка и анимация в списках. */
const playerPlaying = ref(true);

// ── Achievements (opt-in; localStorage) ─────────────────────────────────────────
const achievementsOptIn = ref(loadAchievementsOptIn());
const achievementsState = ref(loadAchievementsState());

const achievementToastOpen = ref(false);
const achievementToastTitle = ref("");
const achievementToastDesc = ref("");

/**
 * Shows a single toast for the first id in the list (others appear only in settings).
 *
 * Args:
 *     ids: Newly unlocked achievement ids.
 *
 * Returns:
 *     void
 */
function showAchievementToastForIds(ids) {
  if (!ids.length) return;
  const m = achievementMeta(ids[0]);
  if (!m) return;
  achievementToastTitle.value = m.title;
  achievementToastDesc.value = m.description;
  achievementToastOpen.value = true;
}

/**
 * Persists state and optionally shows toast when opt-in is on.
 *
 * Args:
 *     nextState: New achievement state snapshot.
 *     newUnlocked: Ids to notify (toast).
 *
 * Returns:
 *     void
 */
function commitAchievementsState(nextState, newUnlocked) {
  achievementsState.value = nextState;
  saveAchievementsState(nextState);
  if (achievementsOptIn.value && newUnlocked.length) {
    showAchievementToastForIds(newUnlocked);
  }
}

watch(playerPlaying, (playing, wasPlaying) => {
  if (!playing || !nowPlaying.value) return;
  if (wasPlaying) return;
  const r = applyPlaybackStarted(achievementsState.value, achievementsOptIn.value);
  if (r.state === achievementsState.value) return;
  commitAchievementsState(r.state, r.newUnlocked);
});

/**
 * Args:
 *     enabled: New opt-in value from settings.
 *
 * Returns:
 *     void
 */
function handleAchievementsOptInChange(enabled) {
  achievementsOptIn.value = enabled;
  saveAchievementsOptIn(enabled);
  if (!enabled) {
    achievementToastOpen.value = false;
    return;
  }
  const likesCount = Object.keys(likes.value).length;
  const retro = applyRetroactiveOptIn(achievementsState.value, likesCount);
  if (retro.state !== achievementsState.value) {
    achievementsState.value = retro.state;
    saveAchievementsState(retro.state);
  }
}

/**
 * Wipes stored achievement marks so the user can earn them again.
 *
 * Returns:
 *     void
 */
function handleAchievementsReset() {
  achievementToastOpen.value = false;
  const next = emptyAchievementsProgress();
  achievementsState.value = next;
  saveAchievementsState(next);
}

const nowPlayingMatchForLikes = computed(() => {
  const np = nowPlaying.value;
  if (!np) return null;
  if (np.source === "soulseek") {
    return {
      source: "soulseek",
      fileIdx: np.fileIdx,
      slskUsername: np.slskUsername,
      slskFilepath: np.slskFilepath,
    };
  }
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

// ── SoulSeek login handlers ───────────────────────────────────────────────────

async function handleSoulseekLogin(username, password) {
  slskLoggingIn.value = true;
  slskLoginError.value = null;
  try {
    const result = await soulseekLogin(username, password);
    if (result.success) {
      slskConnected.value = true;
      slskUsername.value = result.username;
      soulseekSaveCredentials(username, password).catch(() => {});
    } else {
      slskLoginError.value = result.error ?? "Ошибка подключения";
    }
  } catch (e) {
    slskLoginError.value = String(e?.message ?? e ?? "Ошибка");
  } finally {
    slskLoggingIn.value = false;
  }
}

async function handleSoulseekLogout() {
  try {
    await soulseekLogout();
  } catch {
    /* ignore */
  }
  try {
    await soulseekClearSavedCredentials();
  } catch {
    /* ignore */
  }
  slskConnected.value = false;
  slskUsername.value = null;
  clearSlskCoverCache();
  searchTrackResults.value = [];
}

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
  searchAlbumResults.value = [];
  searchTrackResults.value = [];
  selected.value     = null;
  files.value        = [];
  torrentMagnet.value = "";
  torrentCover.value  = null;
  queue.value        = [];
  forwardStack.value = [];
  backStack.value    = [];
}

/**
 * After Rutracker and SoulSeek requests finish, sets the empty-state message and caches hits.
 *
 * Args:
 *     seqActive: Active search id; stale calls are ignored.
 *     queryNorm: Lowercase trimmed query used in the LRU cache key.
 */
function finalizeCombinedSearch(seqActive, queryNorm) {
  if (seqActive !== searchRequestSeq) return;
  if (searchLoadingRt.value || searchLoadingSlsk.value) return;
  const na = searchAlbumResults.value.length;
  const nt = searchTrackResults.value.length;
  if (na === 0 && nt === 0) {
    if (!rtLoggedIn.value && !slskConnected.value) {
      error.value = null;
    } else if (searchRtError.value || searchSlskError.value) {
      error.value = searchRtError.value ?? searchSlskError.value;
    } else {
      error.value = "Ничего не найдено.";
    }
  } else {
    error.value = null;
    _searchCacheSet(queryNorm + "|mixed", {
      albums: [...searchAlbumResults.value],
      tracks: [...searchTrackResults.value],
    });
  }
  appDebugLog("search", `query "${queryNorm}" [combined]: rt=${na} slsk=${nt}`);
}

async function handleSearch(query) {
  if (!query?.trim()) {
    slskPeerBrowseUser.value = null;
    searchAlbumResults.value = [];
    searchTrackResults.value = [];
    searchRtError.value = null;
    searchSlskError.value = null;
    error.value = null;
    selected.value = null;
    files.value = [];
    return;
  }
  const q = query.trim();
  const qn = q.toLowerCase();
  if (slskPeerBrowseUser.value) {
    const pu = String(slskPeerBrowseUser.value).trim().toLowerCase();
    if (qn !== pu) slskPeerBrowseUser.value = null;
  }
  forwardStack.value = [];
  backStack.value    = [];
  error.value        = null;
  searchRtError.value = null;
  searchSlskError.value = null;
  selected.value     = null;
  files.value        = [];
  torrentCover.value = null;
  view.value         = "search";

  searchHistory.value = addToSearchHistory(q);
  searchResultsEpoch.value += 1;

  const cached = _searchCacheGet(qn + "|mixed");
  if (cached) {
    searchAlbumResults.value = cached.albums ?? [];
    searchTrackResults.value = cached.tracks ?? [];
    const empty = !searchAlbumResults.value.length && !searchTrackResults.value.length;
    if (empty) error.value = "Ничего не найдено.";
    appDebugLog(
      "search",
      `query "${q}" [combined]: cache hit (rt=${searchAlbumResults.value.length} slsk=${searchTrackResults.value.length})`,
    );
    return;
  }

  appDebugLog("search", `query "${q}": sending request (combined)`);
  const seq = ++searchRequestSeq;
  searchAlbumResults.value = [];
  searchTrackResults.value = [];
  searchLoadingRt.value = rtLoggedIn.value;
  searchLoadingSlsk.value = slskConnected.value;

  if (!rtLoggedIn.value) {
    searchLoadingRt.value = false;
    finalizeCombinedSearch(seq, qn);
  } else {
    searchMusic(q)
      .then((rows) => filterRutrackerRowsWithPlayableAudio(rows))
      .then((rows) => {
        if (seq !== searchRequestSeq) return;
        searchAlbumResults.value = rows;
      })
      .catch((e) => {
        if (seq !== searchRequestSeq) return;
        searchRtError.value = e?.toString?.() ?? "Ошибка Rutracker";
        searchAlbumResults.value = [];
      })
      .finally(() => {
        if (seq === searchRequestSeq) searchLoadingRt.value = false;
        finalizeCombinedSearch(seq, qn);
      });
  }

  if (!slskConnected.value) {
    searchLoadingSlsk.value = false;
    finalizeCombinedSearch(seq, qn);
  } else {
    let slskAccum = [];
    let slskBatchRaf = 0;
    listen("soulseek-search-batch", (e) => {
      const p = e.payload;
      if (p.requestId !== seq) return;
      slskAccum = slskAccum.concat(p.rows);
      if (seq !== searchRequestSeq) return;
      if (slskBatchRaf) return;
      slskBatchRaf = requestAnimationFrame(() => {
        slskBatchRaf = 0;
        if (seq !== searchRequestSeq) return;
        searchTrackResults.value = groupSlskResults(slskAccum);
      });
    })
      .then((unlistenSlsk) => {
        soulseekSearch(q, seq)
          .then((finalRows) => {
            if (seq !== searchRequestSeq) return;
            if (slskBatchRaf) {
              cancelAnimationFrame(slskBatchRaf);
              slskBatchRaf = 0;
            }
            searchTrackResults.value = groupSlskResults(finalRows);
          })
          .catch((e) => {
            if (seq !== searchRequestSeq) return;
            searchSlskError.value = e?.toString?.() ?? "Ошибка SoulSeek";
            searchTrackResults.value = [];
          })
          .finally(() => {
            if (slskBatchRaf) {
              cancelAnimationFrame(slskBatchRaf);
              slskBatchRaf = 0;
            }
            unlistenSlsk();
            if (seq === searchRequestSeq) searchLoadingSlsk.value = false;
            finalizeCombinedSearch(seq, qn);
          });
      })
      .catch(() => {
        if (seq !== searchRequestSeq) return;
        searchSlskError.value = "Не удалось подписаться на результаты SoulSeek";
        searchLoadingSlsk.value = false;
        finalizeCombinedSearch(seq, qn);
      });
  }
}

const magnetPanelOpen = ref(false);
const magnetDraft = ref("");
const magnetError = ref(null);

/**
 * Extracts a `magnet:?…` substring from pasted text (extra words or quotes allowed).
 *
 * Returns:
 *     The magnet URI or null if none found.
 */
function extractMagnetUri(raw) {
  const s = String(raw ?? "").trim();
  const lower = s.toLowerCase();
  const i = lower.indexOf("magnet:?");
  if (i < 0) return null;
  const slice = s.slice(i);
  const end = slice.search(/\s/);
  const core = end < 0 ? slice : slice.slice(0, end);
  return core.replace(/[),.;>]+$/g, "");
}

/**
 * Parses the BTIH (hex or base32) from a magnet link for stable synthetic ids.
 *
 * Returns:
 *     Lowercase hash string or null.
 */
function parseBtihFromMagnet(magnet) {
  const u = String(magnet ?? "");
  const hex = /btih:([a-fA-F0-9]{40})/i.exec(u);
  if (hex) return hex[1].toLowerCase();
  const b32 = /btih:([a-z2-7]{32})/i.exec(u);
  if (b32) return b32[1].toLowerCase();
  return null;
}

/**
 * Display name for a magnet-only torrent (`dn` parameter or short hash fallback).
 *
 * Returns:
 *     Non-empty title string.
 */
function magnetTitleFromMagnet(magnet) {
  const u = String(magnet ?? "");
  const dn = /[?&]dn=([^&]+)/.exec(u);
  if (dn) {
    const spaced = dn[1].replace(/\+/g, " ");
    const fixed = spaced.replace(/%(?![0-9A-Fa-f]{2})/g, "%25");
    const t = decodeURIComponent(fixed).trim();
    if (t) return t;
  }
  const h = parseBtihFromMagnet(u);
  return h ? `Раздача ${h.slice(0, 8)}…` : "Раздача по ссылке";
}

async function submitMagnetLink() {
  magnetError.value = null;
  const extracted = extractMagnetUri(magnetDraft.value);
  if (!extracted) {
    magnetError.value = "Вставьте magnet-ссылку (начинается с magnet:?)";
    return;
  }
  if (!extracted.toLowerCase().includes("btih:")) {
    magnetError.value = "В ссылке нет info hash (btih)";
    return;
  }
  const enriched = enrichMagnetWithOpenTrackers(extracted);
  const btih = parseBtihFromMagnet(enriched);
  if (!btih) {
    magnetError.value = "Не удалось разобрать hash раздачи";
    return;
  }
  const syntheticId = `magnet-${btih}`;
  if (selected.value?.id === syntheticId) {
    magnetPanelOpen.value = false;
    magnetDraft.value = "";
    forwardStack.value = [];
    backStack.value = [];
    selected.value = null;
    files.value = [];
    torrentMagnet.value = "";
    torrentCover.value = null;
    torrentFilesBeforeAlbumPreview.value = null;
    torrentSelectedBeforeAlbumPreview.value = null;
    return;
  }

  const synthetic = {
    id: syntheticId,
    name: magnetTitleFromMagnet(enriched),
    category: "—",
    size: 0,
    seeders: "?",
    leechers: 0,
    added: "—",
    source: "magnet",
  };

  if (selected.value) {
    backStack.value.push(snapshotTorrentForBack());
  } else {
    backStack.value.push(snapshotSearchForBack());
  }
  forwardStack.value = [];
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;
  selected.value = synthetic;
  files.value = [];
  torrentMagnet.value = "";
  torrentCover.value = null;
  loadingFiles.value = true;
  view.value = "search";
  error.value = null;

  try {
    const rawFiles = await magnetListFiles(enriched);
    torrentMagnet.value = enriched;
    files.value = rawFiles.map((f, i) => ({
      name: f.path[f.path.length - 1] ?? "",
      path: f.path.join("/"),
      size: f.size,
      idx: i,
      origIdx: i,
    }));
    magnetPanelOpen.value = false;
    magnetDraft.value = "";
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
  } catch (e) {
    console.error("submitMagnetLink:", e);
    magnetError.value = String(e?.message ?? e);
    backStack.value.pop();
    selected.value = null;
    files.value = [];
    torrentMagnet.value = "";
    torrentCover.value = null;
  } finally {
    loadingFiles.value = false;
  }
}

function closeMagnetPanel() {
  if (
    loadingFiles.value &&
    selected.value?.source === "magnet" &&
    !torrentMagnet.value
  ) {
    torrentPrepareCancel();
    if (backStack.value.length > 0) backStack.value.pop();
    selected.value = null;
    files.value = [];
    torrentMagnet.value = "";
    torrentCover.value = null;
    loadingFiles.value = false;
  }
  magnetPanelOpen.value = false;
  magnetError.value = null;
}

async function handleSelect(torrent) {
  if (selected.value?.id === torrent.id) {
    forwardStack.value = [];
    backStack.value = [];
    selected.value = null; files.value = []; torrentMagnet.value = ""; torrentCover.value = null;
    torrentFilesBeforeAlbumPreview.value = null;
    torrentSelectedBeforeAlbumPreview.value = null;
    appDebugLog("search", `torrent deselected: #${torrent.id} "${torrent.name}"`);
    return;
  }
  appDebugLog("search", `torrent opened: #${torrent.id} "${torrent.name}" seeders=${torrent.seeders}`);
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

  // ── SoulSeek: no torrent details needed, build file list from grouped tracks ──
  if (torrent.source === "soulseek") {
    const trackList = torrent.slsk_tracks?.length
      ? torrent.slsk_tracks
      : [{ slsk_filepath: torrent.slsk_filepath, slsk_username: torrent.slsk_username, size: torrent.size }];

    files.value = trackList.map((t, i) => {
      const normalized = (t.slsk_filepath ?? "").replace(/\\/g, "/");
      const filename = normalized.split("/").pop() || t.name || `track_${i}`;
      return {
        name: filename,
        path: normalized || filename,
        size: t.size ?? 0,
        idx: i,
        origIdx: i,
        slskUsername: t.slsk_username ?? torrent.slsk_username,
        slskFilepath: t.slsk_filepath ?? normalized,
        slskFilesize: t.size ?? 0,
        /** Same id as search rows — `slskMeta` map key for artist/title/cover from Results. */
        slskMetaTrackId: torrent.id,
        slskFolderCoverUsername: torrent.slsk_cover_username ?? null,
        slskFolderCoverFilepath: torrent.slsk_cover_filepath ?? null,
        slskFolderCoverSize: torrent.slsk_cover_size ?? 0,
      };
    });
    loadingFiles.value = false;
    return;
  }

  try {
    const details = await getTorrentDetails(torrent.id);
    torrentMagnet.value = details.magnet ?? "";
    torrentCover.value  = details.cover_data_url ?? null;
    if (details.artist) selected.value = { ...selected.value, artist: details.artist };
    files.value = details.files.map((f, i) => ({
      name:     f.path[f.path.length - 1] ?? "",
      path:     f.path.join("/"),
      size:     f.size,
      idx:      i,
      origIdx:  i,
    }));
    appDebugLog("search", `torrent files loaded: #${torrent.id} files=${files.value.length} hasMagnet=${!!details.magnet}`);
    // Warm .torrent file cache while user browses the track list.
    // By the time they click play it'll already be resolved → streamUrl skips the fetch.
    void torrentFileB64ForTrack({ source: torrent.source, torrentId: torrent.id });
    // Record to recent history after a successful open.
    recentHistory.value = addToRecentHistory({
      id: String(torrent.id),
      name: torrent.name ?? "",
      source: torrent.source ?? "rutracker",
      artist: details.artist ?? torrent.artist ?? "",
      magnet: details.magnet ?? "",
    });
  } catch (e) {
    console.error("handleSelect:", e);
    appDebugLog("search", `torrent open error: #${torrent.id} — ${String(e)}`);
    // Leave files empty — TorrentView shows "Аудиофайлы не найдены."
  } finally {
    loadingFiles.value = false;
  }
}

/** Play a SoulSeek single track directly from search results (no TorrentView). */
function handlePlaySlskTrack(track) {
  allowPlayerAutoplay();
  const filepath = (track.slsk_filepath ?? track.slsk_tracks?.[0]?.slsk_filepath ?? "").replace(/\\/g, "/");
  const username = track.slsk_username ?? track.slsk_tracks?.[0]?.slsk_username ?? "";
  const filename = filepath.split("/").pop() || track.name || "track";
  const item = {
    magnet: "",
    fileIdx: 0,
    fileName: filename,
    torrentName: filename,
    torrentId: track.id,
    source: "soulseek",
    artist: null,
    coverFileIdx: null,
    albumDirPath: null,
    seeders: 1,
    slskUsername: username,
    slskFilepath: track.slsk_filepath ?? track.slsk_tracks?.[0]?.slsk_filepath ?? filepath,
    slskFilesize: track.size ?? 0,
    slskMetaTrackId: track.id,
    slskFolderCoverUsername: track.slsk_cover_username ?? null,
    slskFolderCoverFilepath: track.slsk_cover_filepath ?? null,
    slskFolderCoverSize: track.slsk_cover_size ?? 0,
  };
  queue.value = [item];
  queuePos.value = 0;
}

/**
 * Builds a library «like» row from a SoulSeek search result row (same identity as
 * `groupSlskResults` ids and `handlePlaySlskTrack` queue fields).
 *
 * Args:
 *     track: Flat search result with `slsk_username`, `slsk_filepath`, optional `id`.
 *
 * Returns:
 *     Object with `id`, `type: "track"`, and fields expected by `handleToggleLike` / LikesView.
 */
function soulseekSearchResultToLike(track) {
  const filepath = (track.slsk_filepath ?? track.slsk_tracks?.[0]?.slsk_filepath ?? "").replace(/\\/g, "/");
  const username = track.slsk_username ?? track.slsk_tracks?.[0]?.slsk_username ?? "";
  const slskFilepath = track.slsk_filepath ?? track.slsk_tracks?.[0]?.slsk_filepath ?? filepath;
  const filename = filepath.split("/").pop() || track.name || "track";
  const id = track.id ?? `slsk_track_${username}_${slskFilepath}`;
  return {
    id,
    type: "track",
    source: "soulseek",
    magnet: "",
    fileIdx: 0,
    fileName: filepath || filename,
    torrentName: filename,
    torrentId: track.id ?? id,
    artist: track.artist ?? null,
    slskUsername: username,
    slskFilepath,
    slskFilesize: track.size ?? track.slsk_tracks?.[0]?.size ?? 0,
  };
}

function handleLikeSlskTrack(track) {
  handleToggleLike(soulseekSearchResultToLike(track));
}

function makeQueueItem(f, torrent, magnet, fileList, explicitCoverFileIdx) {
  let coverFileIdx = explicitCoverFileIdx ?? null;
  let albumDirPath = null;
  if (fileList?.length) {
    const albs = detectAlbums(fileList);
    for (const a of albs) {
      if (a.audioFiles.some((af) => af.origIdx === f.origIdx)) {
        if (coverFileIdx == null) coverFileIdx = a.coverFile?.origIdx ?? null;
        albumDirPath = a.dirPath || null;
        break;
      }
    }
  }
  const rawSeeds = torrent?.seeders;
  const seeders =
    rawSeeds != null && rawSeeds !== "?" && Number.isFinite(Number(rawSeeds))
      ? Number(rawSeeds)
      : null;
  const item = {
    magnet,
    fileIdx:      f.origIdx,
    fileName:     trackDisplayBasename(f.path),
    torrentName:  torrent?.name   ?? "",
    torrentId:    torrent?.id     ?? "",
    source:       torrent?.source ?? "rutracker",
    artist:       torrent?.artist ?? null,
    coverFileIdx,
    albumDirPath,
    seeders,
  };
  // Carry SoulSeek-specific fields needed for streaming (per-track, from file object)
  if (torrent?.source === "soulseek") {
    item.slskUsername = f.slskUsername ?? torrent.slsk_username ?? null;
    item.slskFilepath = f.slskFilepath ?? f.path ?? null;
    item.slskFilesize = f.slskFilesize ?? f.size ?? torrent.size ?? 0;
    item.slskMetaTrackId = f.slskMetaTrackId ?? torrent?.id ?? null;
    item.slskFolderCoverUsername = f.slskFolderCoverUsername ?? torrent?.slsk_cover_username ?? null;
    item.slskFolderCoverFilepath = f.slskFolderCoverFilepath ?? torrent?.slsk_cover_filepath ?? null;
    item.slskFolderCoverSize = f.slskFolderCoverSize ?? torrent?.slsk_cover_size ?? 0;
  }
  return item;
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

/**
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameQueueItem(a, b) {
  if (a?.source === "soulseek" && b?.source === "soulseek") {
    return (
      String(a.slskUsername) === String(b.slskUsername) &&
      String(a.slskFilepath) === String(b.slskFilepath)
    );
  }
  return String(a.magnet) === String(b.magnet) && Number(a.fileIdx) === Number(b.fileIdx);
}

/**
 * Appends a track to the end of the playback queue. Ignores duplicates.
 *
 * @param {object} item - Same shape as `makeQueueItem` output.
 * @returns {void}
 */
function appendToQueue(item) {
  if (queue.value.some((q) => sameQueueItem(q, item))) return;
  const wasEmpty = queue.value.length === 0;
  queue.value = [...queue.value, item];
  if (wasEmpty) queuePos.value = 0;
}

/**
 * @param {number} fileIdx - `origIdx` of an audio file in the open torrent.
 * @returns {void}
 */
function handleAddToQueueFromTorrent(fileIdx) {
  const audioFiles = orderedAudioFiles(files.value);
  const f = audioFiles.find((x) => x.origIdx === fileIdx);
  if (!f || !selected.value || !torrentMagnet.value) return;
  appendToQueue(makeQueueItem(f, selected.value, torrentMagnet.value, files.value));
}

/**
 * @param {object} like - Track like from `likes`.
 * @returns {void}
 */
function handleAddToQueueFromLike(like) {
  const base = {
    magnet: like.magnet ?? "",
    fileIdx: like.fileIdx,
    fileName: trackDisplayBasename(like.fileName),
    torrentName: like.torrentName,
    torrentId: like.torrentId,
    source: like.source,
    artist: like.artist ?? null,
    coverFileIdx: trackCoverFileIdxForLike(like, likes.value),
    albumDirPath: like.albumDirPath ?? null,
    seeders: null,
  };
  if (like.source === "soulseek" && like.slskUsername && like.slskFilepath) {
    appendToQueue({
      ...base,
      slskUsername: like.slskUsername,
      slskFilepath: like.slskFilepath,
      slskFilesize: like.slskFilesize ?? 0,
    });
    return;
  }
  appendToQueue(base);
}

/**
 * @param {object} track - Saved playlist track row.
 * @returns {void}
 */
function handleAddToQueueFromPlaylistTrack(track) {
  appendToQueue({
    magnet: track.magnet,
    fileIdx: track.fileIdx,
    fileName: trackDisplayBasename(track.fileName),
    torrentName: track.torrentName,
    torrentId: track.torrentId,
    source: track.source,
    artist: track.artist ?? null,
    coverFileIdx: track.coverFileIdx ?? null,
    albumDirPath: track.albumDirPath ?? null,
    seeders: track.seeders ?? null,
  });
}

/**
 * @param {number} i - Target index in the queue.
 * @returns {void}
 */
function handleQueueJump(i) {
  if (i < 0 || i >= queue.value.length) return;
  allowPlayerAutoplay();
  queuePos.value = i;
}

/**
 * @param {number} i - Index to remove.
 * @returns {void}
 */
function handleQueueRemove(i) {
  const cur = queuePos.value;
  const next = queue.value.filter((_, j) => j !== i);
  let pos = cur;
  if (i < cur) pos--;
  else if (i === cur) {
    if (next.length === 0) pos = 0;
    else if (cur >= next.length) pos = next.length - 1;
  }
  queue.value = next;
  queuePos.value = pos;
}

function handleToggleLike(like) {
  const likesBefore = Object.keys(likes.value).length;
  const next = { ...likes.value };
  if (next[like.id]) delete next[like.id];
  else next[like.id] = { ...like, addedAt: Date.now() };
  const likesAfter = Object.keys(next).length;
  likes.value = next;
  if (!achievementsOptIn.value) return;
  const lr = applyLikeChange(achievementsState.value, true, likesAfter, likesBefore);
  if (lr.state !== achievementsState.value) {
    commitAchievementsState(lr.state, lr.newUnlocked);
  }
}

/** Предпросмотр одного альбома из галереи — как handleOpenTorrentFromLike для type === "album". */
function handleOpenAlbumPreview({ album, displayName }) {
  if (!selected.value || !album?.audioFiles?.length) return;

  if (!torrentFilesBeforeAlbumPreview.value) {
    torrentFilesBeforeAlbumPreview.value = files.value;
    torrentSelectedBeforeAlbumPreview.value = { ...selected.value };
  }

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
  if (like?.source === "soulseek" && like.slskUsername) {
    const prevView = view.value;
    const prevPlId = currentPlaylistId.value;
    returnView.value = prevView;
    forwardStack.value = [];
    await handleNavigateSoulseekPeer(like.slskUsername);
    if (prevView === "likes") backStack.value.push({ type: "likes" });
    else if (prevView === "playlist" && prevPlId) {
      backStack.value.push({ type: "playlist", playlistId: prevPlId });
    }
    return;
  }
  forwardStack.value = [];
  if (selected.value) {
    backStack.value.push(snapshotTorrentForBack());
  } else if (view.value === "playlist" && currentPlaylistId.value) {
    backStack.value.push({ type: "playlist", playlistId: currentPlaylistId.value });
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
  returnView.value    = view.value === "playlist" ? "playlist" : "likes";
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

/**
 * Clears SoulSeek peer-only filter on search results.
 */
function clearSlskPeerBrowseUser() {
  slskPeerBrowseUser.value = null;
}

/**
 * Opens «источник» exactly like clicking the track title in the player: same payload as
 * `handleOpenTorrentFromPlayer`, using the current раздача + optional track `origIdx`.
 *
 * Args:
 *     origIdx: File `origIdx` from the track row context menu, or null.
 */
function handleOpenTorrentSourceFromView(origIdx) {
  const t = selected.value;
  if (!t) return;
  const list = files.value ?? [];
  const f =
    origIdx != null ? list.find((x) => x.origIdx === origIdx) : null;
  let albumDirPath = null;
  if (list.length && f) {
    const albs = detectAlbums(list);
    const album = albs.find((a) => a.audioFiles.some((af) => af.origIdx === f.origIdx));
    albumDirPath = album?.dirPath ?? null;
  }
  const payload = {
    torrentId: t.id,
    torrentName: t.name ?? "",
    source: t.source,
    magnet: torrentMagnet.value ?? "",
    artist: t.artist ?? null,
    seeders: t.seeders ?? null,
    fileIdx: f?.origIdx ?? origIdx ?? 0,
    albumDirPath,
  };
  if (t.source === "soulseek") {
    payload.slskUsername = f?.slskUsername ?? t.slsk_username ?? list[0]?.slskUsername ?? null;
    payload.slskFilepath = f?.slskFilepath ?? null;
  }
  handleOpenTorrentFromPlayer(payload);
}

/**
 * Builds the same payload as the player emits for `open-torrent` (library / playlist rows).
 *
 * Args:
 *     row: Liked track or playlist track entry.
 *
 * Returns:
 *     Object for `handleOpenTorrentFromPlayer`, or null if not openable.
 */
function libraryRowToPlayerOpenPayload(row) {
  if (!row || (!row.torrentId && !row.magnet)) return null;
  const o = {
    torrentId: row.torrentId,
    torrentName: row.torrentName ?? "",
    source: row.source ?? "rutracker",
    magnet: row.magnet ?? "",
    artist: row.artist ?? null,
    seeders: row.seeders ?? null,
    fileIdx: row.fileIdx ?? 0,
    albumDirPath: row.albumDirPath ?? null,
  };
  if (row.source === "soulseek" && row.slskUsername) {
    o.slskUsername = row.slskUsername;
    o.slskFilepath = row.slskFilepath ?? null;
  }
  return o;
}

/**
 * SoulSeek search row: same as player «open album» for that result.
 *
 * Args:
 *     track: Grouped SoulSeek row with `id` and `slsk_username`.
 */
function handleOpenSoulseekSourceFromResults(track) {
  const u = track?.slsk_username;
  if (!u || !track?.id) return;
  handleOpenTorrentFromPlayer({
    torrentId: track.id,
    torrentName: track.name ?? "",
    source: "soulseek",
    magnet: "",
    fileIdx: 0,
    albumDirPath: null,
    slskUsername: u,
    slskFilepath: track.slsk_filepath ?? null,
  });
}

/**
 * SoulSeek: jump to search filtered to this user (full search by username).
 *
 * Args:
 *     username: Peer login.
 */
async function handleNavigateSoulseekPeer(username) {
  const u = String(username ?? "").trim();
  if (!u) return;
  slskPeerBrowseUser.value = u;
  searchQuery.value = u;
  view.value = "search";
  selected.value = null;
  files.value = [];
  torrentMagnet.value = "";
  torrentCover.value = null;
  await handleSearch(u);
}

/**
 * Opens source for a liked or playlist track — same navigation as the player title click.
 *
 * Args:
 *     row: Like object or playlist track row.
 */
function handleOpenTrackSource(row) {
  const p = libraryRowToPlayerOpenPayload(row);
  if (p) handleOpenTorrentFromPlayer(p);
}

function handlePlayFromLike(like) {
  allowPlayerAutoplay();
  const likedTracks = Object.values(likes.value)
    .filter((l) => l.type === "track").sort((a, b) => b.addedAt - a.addedAt);
  const startIdx = Math.max(0, likedTracks.findIndex((l) => l.id === like.id));
  const fullQueue = likedTracks.map((l) => {
    const row = {
      magnet: l.magnet ?? "",
      fileIdx: l.fileIdx,
      fileName: l.fileName,
      torrentName: l.torrentName,
      torrentId: l.torrentId,
      source: l.source,
      coverFileIdx: trackCoverFileIdxForLike(l, likes.value),
    };
    if (l.source === "soulseek" && l.slskUsername && l.slskFilepath) {
      return {
        ...row,
        slskUsername: l.slskUsername,
        slskFilepath: l.slskFilepath,
        slskFilesize: l.slskFilesize ?? 0,
      };
    }
    return row;
  });
  const existing = queue.value.findIndex((q) => {
    if (like.source === "soulseek") {
      return (
        q.source === "soulseek" &&
        String(q.slskUsername) === String(like.slskUsername) &&
        String(q.slskFilepath) === String(like.slskFilepath)
      );
    }
    return (
      q.fileIdx === like.fileIdx &&
      q.magnet === like.magnet &&
      q.torrentId === like.torrentId
    );
  });
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

/** Скачивание трека из списка «Мне нравится» без открытия раздачи. */
function handleDownloadTrackFromLike(like) {
  if (!like?.magnet || like.fileIdx == null) return;
  downloadOverlayExpanded.value = true;
  const idx = Number(like.fileIdx);
  const label = trackDisplayBasename(like.fileName);
  exportTorrentFiles(like.magnet, [idx], [label], null, (p) => {
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

function handleSearchArtist(artist) {
  if (!artist?.trim()) return;
  searchQuery.value = artist.trim();
  appDebugLog("search", `artist filter: "${artist.trim()}"`);
  void handleSearch(artist.trim());
}

/**
 * Applies album-scoped view for the given track after full file list is loaded.
 * Locates the album by fileIdx in detectAlbums result; falls back to albumDirPath match.
 * No-op when only one album exists (full list is already the album) or no match found.
 *
 * Args:
 *     fileIdx: origIdx of the playing track used to locate the containing album.
 *     albumDirPath: optional hint from queue item for matching when fileIdx lookup fails.
 */
function _applyAlbumScopeForTrack(fileIdx, albumDirPath) {
  const albs = detectAlbums(files.value);
  if (albs.length <= 1) return;
  let album = null;
  if (fileIdx != null) {
    album = albs.find((a) => a.audioFiles.some((f) => f.origIdx === fileIdx)) ?? null;
  }
  if (!album && albumDirPath) {
    album = albs.find((a) => a.dirPath === albumDirPath) ?? null;
  }
  if (!album?.audioFiles?.length) return;
  torrentFilesBeforeAlbumPreview.value = files.value;
  torrentSelectedBeforeAlbumPreview.value = { ...selected.value };
  files.value = album.coverFile
    ? [...album.audioFiles, album.coverFile]
    : [...album.audioFiles];
  const dirName = album.dirPath.split("/").filter(Boolean).pop() || "";
  const base = torrentSelectedBeforeAlbumPreview.value;
  const m = base?.name?.match(/^(.+?)\s+[-–—]\s+/);
  selected.value = {
    ...base,
    name: dirName || base?.name || "",
    fromLikes: true,
    artist: m ? m[1].trim() : (base?.artist ?? ""),
  };
}

function handleOpenTorrentFromPlayer(track) {
  if (!track?.torrentId && !track?.magnet) return;
  if (track.source === "soulseek" && track.slskUsername) {
    void handleNavigateSoulseekPeer(track.slskUsername);
    return;
  }
  if (selected.value?.id === track.torrentId) {
    view.value = "search";
    if (!torrentFilesBeforeAlbumPreview.value) {
      _applyAlbumScopeForTrack(track.fileIdx, track.albumDirPath ?? null);
    }
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
    return;
  }
  forwardStack.value = [];
  if (selected.value) {
    backStack.value.push(snapshotTorrentForBack());
  } else {
    backStack.value.push(snapshotSearchForBack());
  }
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;
  view.value = "search";
  returnView.value = "search";
  selected.value = {
    id: track.torrentId,
    name: track.torrentName,
    source: track.source,
    seeders: track.seeders ?? "?",
    size: 0,
    category: "—",
    added: "—",
    artist: track.artist ?? "",
  };
  torrentCover.value = null;
  torrentMagnet.value = track.magnet ?? "";
  files.value = [];
  loadingFiles.value = true;
  const fetching = track.source === "magnet"
    ? magnetListFiles(track.magnet).then((rawFiles) => {
        torrentMagnet.value = track.magnet;
        files.value = rawFiles.map((f, i) => ({
          name: f.path[f.path.length - 1] ?? "",
          path: f.path.join("/"),
          size: f.size,
          idx: i,
          origIdx: i,
        }));
        _applyAlbumScopeForTrack(track.fileIdx, track.albumDirPath);
      })
    : getTorrentDetails(track.torrentId).then((details) => {
        torrentMagnet.value = details.magnet ?? track.magnet ?? "";
        torrentCover.value = details.cover_data_url ?? null;
        if (details.artist) selected.value = { ...selected.value, artist: details.artist };
        files.value = details.files.map((f, i) => ({
          name: f.path[f.path.length - 1] ?? "",
          path: f.path.join("/"),
          size: f.size,
          idx: i,
          origIdx: i,
        }));
        void torrentFileB64ForTrack({ source: track.source, torrentId: track.torrentId });
        _applyAlbumScopeForTrack(track.fileIdx, track.albumDirPath);
      });
  void fetching.finally(() => {
    loadingFiles.value = false;
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
  });
}

/**
 * Open a torrent by source and ID from a neegde:// deep link.
 * Navigates to search view, loads files from Rutracker.
 * @param {string} source - e.g. "rutracker"
 * @param {string} torrentId
 */
async function openTorrentByDeepLink(source, torrentId) {
  forwardStack.value = [];
  backStack.value = [];
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;
  view.value = "search";
  returnView.value = "search";
  selected.value = { id: torrentId, name: "", source, seeders: "?", size: 0, category: "—", added: "—" };
  files.value = [];
  torrentCover.value = null;
  torrentMagnet.value = "";
  loadingFiles.value = true;
  const details = await getTorrentDetails(torrentId);
  torrentMagnet.value = details.magnet ?? "";
  torrentCover.value = details.cover_data_url ?? null;
  if (details.artist) selected.value = { ...selected.value, artist: details.artist };
  files.value = details.files.map((f, i) => ({
    name: f.path[f.path.length - 1] ?? "",
    path: f.path.join("/"),
    size: f.size,
    idx: i,
    origIdx: i,
  }));
  void torrentFileB64ForTrack({ source, torrentId });
  loadingFiles.value = false;
}

/**
 * Handle a neegde:// URL dispatched by the OS (deep link).
 * Supports: neegde://torrent/{source}/{torrentId}
 * @param {string} urlStr
 */
async function handleDeepLink(urlStr) {
  const url = new URL(urlStr);
  if (url.host === "torrent") {
    const parts = url.pathname.split("/").filter(Boolean);
    const [source, torrentId] = parts;
    if (source && torrentId) void openTorrentByDeepLink(source, torrentId);
  }
}

/**
 * Randomizes order of all tracks except the current one; current becomes first.
 */
function shuffleQueueInPlaceKeepingCurrent() {
  const q = queue.value;
  const len = q.length;
  if (len < 2) return;
  const pos = queuePos.value;
  if (pos < 0 || pos >= len) return;
  const cur = q[pos];
  const rest = q.filter((_, i) => i !== pos);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = rest[i];
    rest[i] = rest[j];
    rest[j] = t;
  }
  queue.value = [cur, ...rest];
  queuePos.value = 0;
}

function toggleShuffle() {
  if (queue.value.length < 2) return;
  if (shuffleOn.value) {
    shuffleOn.value = false;
    localStorage.setItem("neegde.player.shuffle", "0");
    return;
  }
  shuffleOn.value = true;
  localStorage.setItem("neegde.player.shuffle", "1");
  shuffleQueueInPlaceKeepingCurrent();
}

function cycleRepeatMode() {
  const order = ["off", "all", "one"];
  const i = order.indexOf(repeatMode.value);
  repeatMode.value = order[(i + 1) % order.length];
}

/** Next track: UI, media keys, and explicit skip — supports repeat-all wrap. */
function handlePlayerNext() {
  allowPlayerAutoplay();
  const len = queue.value.length;
  if (len === 0) return;
  if (queuePos.value < len - 1) queuePos.value++;
  else if (repeatMode.value === "all") queuePos.value = 0;
  else {
    queue.value = [];
    queuePos.value = 0;
  }
}

/** Natural track end (`repeat-one` is handled in Player — `ended` is not emitted). */
function handleTrackEnded() {
  allowPlayerAutoplay();
  const len = queue.value.length;
  if (len === 0) return;
  if (queuePos.value < len - 1) queuePos.value++;
  else if (repeatMode.value === "all") queuePos.value = 0;
  else {
    queue.value = [];
    queuePos.value = 0;
  }
}

function handlePrev() {
  allowPlayerAutoplay();
  const len = queue.value.length;
  if (len === 0) return;
  if (queuePos.value > 0) queuePos.value--;
  else if (repeatMode.value === "all" && len > 1) queuePos.value = len - 1;
}

function handleOpenRecent(item) {
  // Reset selected before calling handleSelect to avoid the deselect branch
  // (if this torrent was already open, handleSelect would deselect it instead).
  selected.value = null;
  files.value = [];
  searchQuery.value = "";
  searchAlbumResults.value = [];
  searchTrackResults.value = [];
  view.value = "search";
  void handleSelect({
    id: item.id,
    name: item.name,
    source: item.source ?? "rutracker",
    seeders: "?",
    size: 0,
    category: "—",
    added: "—",
  });
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
      let albums = [...(entry.resultsAlbums ?? [])];
      let tracks = [...(entry.resultsTracks ?? [])];
      if (!albums.length && !tracks.length && entry.results?.length) {
        if (entry.results[0]?.source === "soulseek") tracks = [...entry.results];
        else albums = [...entry.results];
      }
      searchAlbumResults.value = albums;
      searchTrackResults.value = tracks;
      slskPeerBrowseUser.value = entry.slskPeerBrowseUser ?? null;
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
    } else if (entry.type === "playlist" && entry.playlistId) {
      currentPlaylistId.value = entry.playlistId;
      view.value = "playlist";
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
  } else if (returnView.value === "playlist") {
    view.value = "playlist";
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

const MOUSE_NAV_CAPTURE = { capture: true, passive: false };

function isMouseBackButton(e) {
  const b = e.button;
  if (b === 3 || b === 8) return true;
  return (e.buttons & 8) === 8;
}

function isMouseForwardButton(e) {
  const b = e.button;
  if (b === 4 || b === 9) return true;
  return (e.buttons & 16) === 16;
}

/** На mouseup после отпускания e.buttons часто 0 — смотрим только button. */
function isSideButtonAny(e) {
  const b = e.button;
  return b === 3 || b === 4 || b === 8 || b === 9;
}

/** Назад / вперёд по приложению (mousedown). */
function onMouseSideButtonDown(e) {
  if (!isMouseBackButton(e) && !isMouseForwardButton(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (isMouseBackButton(e) && navCanGoBack.value) {
    handleNavBack();
  } else if (isMouseForwardButton(e) && forwardStack.value.length > 0) {
    handleForwardNav();
  }
}

/**
 * Блокирует встроенный history.back/forward в Wry после синтетического mouseup.
 */
function onMouseSideButtonUp(e) {
  if (!isSideButtonAny(e)) return;
  e.preventDefault();
  e.stopPropagation();
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
        <!-- Home -->
        <button
          :class="['source-btn', view === 'home' ? 'active' : '']"
          @click="view = 'home'"
        >
          <span class="source-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/>
              <polyline points="9,21 9,12 15,12 15,21"/>
            </svg>
          </span>
          Главная
        </button>

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
        </button>

        <!-- Library -->
        <div class="nav-label" style="margin-top: 16px">Библиотека</div>
        <button
          :class="['source-btn', view === 'likes' ? 'active' : '']"
          @click="view = view === 'likes' ? 'search' : 'likes'"
        >
          <span class="source-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
          </span>
          Мне нравится
        </button>

        <!-- Playlists -->
        <div class="nav-label nav-label--pl">
          Плейлисты
          <button class="sidebar-pl-create-btn" title="Новый плейлист" @click="handleCreatePlaylist">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
        <div class="sidebar-playlists">
          <button
            v-for="pl in playlists"
            :key="pl.id"
            :class="['source-btn sidebar-pl-item', currentPlaylistId === pl.id && view === 'playlist' ? 'active' : '']"
            @click="openPlaylist(pl.id)"
          >
            <span class="source-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
            </span>
            {{ pl.name }}
          </button>
        </div>

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

    </aside>

    <!-- ── Main ────────────────────────────────────────────────────── -->
    <div class="main-wrap" ref="mainRef">
      <div class="main-content">
        <div v-if="view === 'search'" class="main-toolbar">
          <div class="main-toolbar-row">
            <div class="main-toolbar-search">
              <SearchBar
                v-model="searchQuery"
                :loading="loading"
                :show-categories="false"
                @search="handleSearch"
              />
            </div>
            <button
              type="button"
              class="toolbar-magnet-btn"
              title="Открыть раздачу по magnet-ссылке"
              :disabled="loadingFiles"
              @click="magnetPanelOpen = true"
            >
              По ссылке
            </button>
          </div>
        </div>

        <MagnetLinkDialog
          v-model:open="magnetPanelOpen"
          v-model:draft="magnetDraft"
          :error="magnetError"
          :resolving="loadingFiles && magnetPanelOpen"
          @submit="submitMagnetLink"
          @close="closeMagnetPanel"
        />

        <!-- Home view -->
        <HomeView
          v-if="view === 'home'"
          :recent-history="recentHistory"
          @open-recent="handleOpenRecent"
          @go-to-search="navToSearch"
          @search-query="(q) => { searchQuery = q; view = 'search'; void handleSearch(q); }"
        />

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
            @open-track-source="handleOpenTrackSource"
            @download="handleDownloadTrackFromLike"
            @add-to-queue="handleAddToQueueFromLike"
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
            :theme="theme"
            :app-debug-enabled="appDebugEnabled"
            :achievements-opt-in="achievementsOptIn"
            :achievements-unlocked="achievementsState.unlocked"
            :slsk-connected="slskConnected"
            :slsk-username="slskUsername"
            :slsk-logging-in="slskLoggingIn"
            :slsk-login-error="slskLoginError"
            @login="handleLogin"
            @logout="handleLogout"
            @theme-change="handleThemeChange"
            @update:app-debug-enabled="appDebugEnabled = $event"
            @achievements-opt-in-change="handleAchievementsOptInChange"
            @achievements-reset="handleAchievementsReset"
            @slsk-login="handleSoulseekLogin"
            @slsk-logout="handleSoulseekLogout"
          />
        </KeepAlive>

        <!-- Playlist view -->
        <PlaylistView
          v-if="view === 'playlist' && currentPlaylist"
          :playlist="currentPlaylist"
          :now-playing="nowPlayingMatchForLikes"
          :player-playing="playerPlaying"
          @play="handlePlayPlaylist"
          @open-track-source="handleOpenTrackSource"
          @remove-track="handleRemoveTrackFromPlaylist(currentPlaylistId, $event)"
          @delete="handleDeletePlaylist(currentPlaylistId)"
          @rename="handleRenamePlaylist(currentPlaylistId, $event)"
          @add-to-queue="handleAddToQueueFromPlaylistTrack"
        />

        <!-- Search view -->
        <template v-if="view !== 'likes' && view !== 'settings' && view !== 'home' && view !== 'playlist'">
          <p v-if="error && !loading" class="error-msg">{{ error }}</p>

          <!-- Onboarding: nudge to settings if not connected -->
          <div
            v-if="!restoringSession && !rtLoggedIn && !slskConnected && !hasSearchResults && !selected && !loading"
            class="onboarding"
          >
            <div class="onboarding-card" style="cursor:pointer" @click="view = 'settings'">
              <div class="onboarding-icon">🔗</div>
              <div class="onboarding-body">
                <div class="onboarding-title">Подключите источники поиска</div>
                <div class="onboarding-desc">
                  <strong style="color:var(--text)">Rutracker</strong> — альбомы и раздачи.
                  <strong style="color:var(--text)">SoulSeek</strong> — отдельные треки.
                  Настройки открываются здесь или в боковой панели.
                </div>
              </div>
            </div>
          </div>

          <!-- Recent search queries -->
          <div
            v-if="!selected && !hasSearchResults && !loading && searchHistory.length"
            class="search-history-wrap"
          >
            <div class="search-history-label">Недавние запросы</div>
            <div class="search-history-pills">
              <button
                v-for="q in searchHistory"
                :key="q"
                class="search-history-pill"
                @click="searchQuery = q; void handleSearch(q)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"
                  style="opacity:0.5; flex-shrink:0">
                  <polyline points="12 8 12 12 14 14"/>
                  <path d="M3.05 11A9 9 0 1 0 4 6.1"/>
                  <polyline points="3 3 3 7 7 7"/>
                </svg>
                {{ q }}
              </button>
            </div>
          </div>

          <Results
            v-if="!selected && hasSearchResults"
            :search-epoch="searchResultsEpoch"
            :album-results="searchAlbumResults"
            :track-results="searchTrackResults"
            :slsk-peer-filter="slskPeerBrowseUser"
            :loading-albums="searchLoadingRt"
            :loading-tracks="searchLoadingSlsk"
            :rt-logged-in="rtLoggedIn"
            :slsk-connected="slskConnected"
            :rt-error="searchRtError"
            :slsk-error="searchSlskError"
            :selected-id="null"
            @select="handleSelect"
            @play-slsk-track="handlePlaySlskTrack"
            @like-slsk-track="handleLikeSlskTrack"
            @open-slsk-source="handleOpenSoulseekSourceFromResults"
            @clear-slsk-peer-filter="clearSlskPeerBrowseUser"
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
            @add-to-playlist="handleShowAddToPlaylist"
            @add-to-queue="handleAddToQueueFromTorrent"
            @open-torrent-source="handleOpenTorrentSourceFromView"
          />
        </template>

      </div>
    </div>

    <!-- ── Player ──────────────────────────────────────────────────── -->
    <Player
      :track="nowPlaying"
      :next-track="nextInQueue"
      :second-next-track="secondNextInQueue"
      :suppress-autoplay="suppressAutoplayAfterSessionRestore"
      :has-prev="playerHasPrev"
      :has-next="playerHasNext"
      :repeat-mode="repeatMode"
      :shuffle-on="shuffleOn"
      :likes="likes"
      :playback-queue="queue"
      :queue-index="queuePos"
      @prev="handlePrev"
      @next="handlePlayerNext"
      @ended="handleTrackEnded"
      @cycle-repeat="cycleRepeatMode"
      @toggle-shuffle="toggleShuffle"
      @request-stream="allowPlayerAutoplay"
      @playing-change="playerPlaying = $event"
      @toggle-like="handleToggleLike"
      @search-artist="handleSearchArtist"
      @open-torrent="handleOpenTorrentFromPlayer"
      @queue-jump="handleQueueJump"
      @queue-remove="handleQueueRemove"
    />

    <AppSplash :visible="holdSplashForReview || restoringSession" />

    <AchievementToast
      v-model:open="achievementToastOpen"
      :title="achievementToastTitle"
      :description="achievementToastDesc"
    />

    <DownloadProgressOverlay
      v-model:expanded="downloadOverlayExpanded"
      :progress="downloadProgress"
    />

    <!-- Add-to-playlist modal -->
    <Teleport to="body">
      <div v-if="addToPlaylistModal" class="pl-modal-overlay" @click.self="addToPlaylistModal = false">
        <div class="pl-modal">
          <div class="pl-modal-title">Добавить в плейлист</div>
          <div class="pl-modal-list">
            <button
              v-for="pl in playlists"
              :key="pl.id"
              class="pl-modal-item"
              @click="handleAddToPlaylist(pl.id)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
              {{ pl.name }}
            </button>
            <button class="pl-modal-new" @click="handleAddToPlaylistNew">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Новый плейлист
            </button>
          </div>
        </div>
      </div>
    </Teleport>

  </div>
</template>
