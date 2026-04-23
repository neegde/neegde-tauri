<script setup>
import { ref, shallowRef, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { appDebugLog } from "./appDebugLog.js";
import {
  isAudio,
  detectAlbums,
  orderedAudioFiles,
  trackDisplayBasename,
  enrichMagnetWithOpenTrackers,
} from "./lib/utils.js";
import { parseBtihFromMagnet } from "./lib/magnet.js";
import {
  buildRtTrackEntity,
  buildSlskTrackEntity,
  registerAndGetId,
} from "./player/trackForQueue.js";
import { trackCoverFileIdxForLike } from "./library/likesCover.js";
import { slskFieldsFromTrackEntity } from "./library/slskFieldsFromTrackEntity.js";
import {
  playlistTrackFromLike as _playlistTrackFromLike,
  queueItemToPlaylistTrack,
} from "./library/rowAdapters.js";
import {
  asLikeRowFor,
  asPlaylistRowFor,
  asQueueItemFor,
  navigationTargetFor,
  exportTrackFor,
} from "./track/ops.js";
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
  getTorrentDetails,
  prefetchTorrentDetails,
} from "./rutracker/search.js";
import {
  soulseekLogin,
  soulseekLogout,
  soulseekStatus,
  soulseekSaveCredentials,
  soulseekLoadCredentials,
  soulseekClearSavedCredentials,
  clearSlskCoverCache,
} from "./soulseek/api.js";
import { getAlbum } from "./stores/entities.js";
import {
  searchEntities,
  searchLoadingRt,
  searchLoadingSlsk,
  searchRtError,
  searchSlskError,
  searchError,
  searchResultsEpoch,
  searchResolving,
  searchResolved,
  searchProviderQuery,
  runSearch,
  resetSearch,
} from "./stores/search.js";
import {
  rtLoggedIn,
  rtUsername,
  rtAvatarUrl,
  slskConnected,
  slskUsername,
  slskLoggingIn,
  slskLoginError,
  setRtLoggedIn,
  setRtLoggedOut,
  setSlskConnected,
  setSlskDisconnected,
} from "./stores/auth.js";
import { view, returnView, currentPlaylistId } from "./stores/view.js";
import {
  likedTrackIds as libraryLikedTrackIds,
  likedAlbumIds as libraryLikedAlbumIds,
  likedAt as libraryLikedAt,
  playlists as libraryPlaylists,
} from "./stores/library.js";
import { useAppDebug } from "./composables/useAppDebug.js";
import { useTheme } from "./composables/useTheme.js";
import { useMouseSideButtonNav } from "./composables/useMouseSideButtonNav.js";
import { useAchievements } from "./composables/useAchievements.js";
import { useDownloads } from "./composables/useDownloads.js";
import { usePlaylistManager } from "./composables/usePlaylistManager.js";
import { useQueueControls } from "./composables/useQueueControls.js";
import { useNavStack } from "./composables/useNavStack.js";
import { useMagnetDialog } from "./composables/useMagnetDialog.js";
import { useAlbumPreview } from "./composables/useAlbumPreview.js";
import { loadPersistedState } from "./persistence/bootstrap.js";
import { seedLikesFromSnapshot, seedPlaylistsFromSnapshot } from "./stores/library.js";
import { seedQueueFromSnapshot } from "./stores/queue.js";
import { torrentFileB64ForTrack, streamUrl, magnetListFiles } from "./torrent/api.js";
import { releaseTorrentStreamUrl, torrentPrepareCancel } from "./torrent/torrentSession.js";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";

import SearchBar    from "./components/search/SearchBar.vue";
import Results      from "./components/search/Results.vue";
import SearchIntentHint from "./components/search/SearchIntentHint.vue";
import TorrentView  from "./components/torrent/TorrentView.vue";
import LikesView    from "./components/likes/LikesView.vue";
import SettingsView from "./components/settings/SettingsView.vue";
import Player       from "./components/player/Player.vue";
import NavArrows       from "./components/shell/NavArrows.vue";
import MagnetLinkDialog from "./components/shell/MagnetLinkDialog.vue";
import DownloadProgressOverlay from "./components/shell/DownloadProgressOverlay.vue";
import AppSplash from "./components/shell/AppSplash.vue";
import HomeView from "./components/home/HomeView.vue";
import { openAppDebugWindow } from "./appDebugWindow.js";
import { loadRecentHistory, addToRecentHistory, removeFromRecentHistory } from "./lib/recentHistory.js";
import { loadSearchHistory, addToSearchHistory, removeFromSearchHistory } from "./lib/searchHistory.js";
import { loadPlaylists } from "./lib/playlistStorage.js";
import PlaylistView from "./components/playlist/PlaylistView.vue";
import AchievementToast from "./components/shell/AchievementToast.vue";
import SystemIcon from "./components/shared/SystemIcon.vue";

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

// In-app debug console (Settings → checkbox). Side effects + trace wiring live
// in useAppDebug; App.vue only holds the reactive toggle.
const { appDebugEnabled } = useAppDebug({ view, queuePos, nowPlaying });
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
const { theme, setTheme } = useTheme();

const restoringSession = ref(true);

/** If restore hangs (сеть/DNS), не оставляем UI в вечном «подключении». */
const RESTORE_UI_MAX_MS = 5_000;

onMounted(async () => {
  // v2 persistence bootstrap: migrate legacy rows once, seed new stores.
  // Runs before anything else so Track ids referenced by likes / playlists /
  // queue snapshots are already resolvable through the entities registry.
  const persisted = loadPersistedState();
  seedLikesFromSnapshot(persisted.likes);
  seedPlaylistsFromSnapshot(persisted.playlists);
  seedQueueFromSnapshot(persisted.queue);

  window.addEventListener("beforeunload", flushPlayerSessionToStorage);
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
});

const handleThemeChange = setTheme;

// ── Auth ──────────────────────────────────────────────────────────────────────
// Reactive state lives in src/stores/auth.js. Only RT session restore and SLSK
// auto-login side-effects run here.
onMounted(async () => {
  try {
    const status = await soulseekStatus();
    if (status?.connected) {
      setSlskConnected(status.username);
      return;
    }
    const creds = await soulseekLoadCredentials();
    if (creds) {
      const [username, password] = creds;
      const result = await soulseekLogin(username, password);
      if (result?.success) setSlskConnected(result.username);
    }
  } catch { /* no Tauri API */ }
});
// ── View ──────────────────────────────────────────────────────────────────────
// `view`, `returnView`, `currentPlaylistId` live in src/stores/view.js.

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
const currentPlaylist = computed(() => playlists.value.find((p) => p.id === currentPlaylistId.value) ?? null);

// Mirror legacy playlists into the entities-backed store so new code can read
// Track entities by id. Runs once per mutation; still cheap for normal sizes.
watch(
  playlists,
  (lst) => {
    const out = [];
    for (const pl of lst) {
      const trackIds = [];
      for (const t of pl.tracks ?? []) {
        let ent = null;
        if (t.source === "soulseek" && t.slskUsername && t.slskFilepath) {
          ent = buildSlskTrackEntity({
            username: t.slskUsername,
            filepath: t.slskFilepath,
            size: t.slskFilesize ?? 0,
            filename: t.fileName,
            artist: t.artist ?? null,
            cover: null,
            albumTitle: t.torrentName,
          });
        } else {
          const btih = t.source === "magnet" ? parseBtihFromMagnet(t.magnet ?? "") : null;
          ent = buildRtTrackEntity(
            { origIdx: t.fileIdx, path: t.fileName, size: 0 },
            { id: t.torrentId, name: t.torrentName, artist: t.artist ?? null, source: t.source },
            t.magnet ?? "",
            btih,
            t.coverFileIdx ?? null,
            t.albumDirPath ?? null,
          );
        }
        const id = registerAndGetId(ent);
        if (id) trackIds.push(id);
      }
      out.push({
        type: "playlist",
        id: pl.id,
        title: pl.name ?? pl.title ?? "Без названия",
        coverUrl: null,
        createdAt: pl.createdAt ?? Date.now(),
        updatedAt: pl.updatedAt ?? Date.now(),
        trackIds,
      });
    }
    libraryPlaylists.value = out;
  },
  { immediate: true, deep: true },
);

const {
  addToPlaylistModal,
  addToPlaylistTrack,
  openPlaylist,
  handleCreatePlaylist,
  handleDeletePlaylist,
  handleRenamePlaylist,
  handleRemoveTrackFromPlaylist,
  handleShowAddToPlaylist,
  handleAddToPlaylist,
  handleAddToPlaylistNew,
} = usePlaylistManager({ playlists, currentPlaylistId, view });

function handlePlayPlaylist(startIdx) {
  const pl = currentPlaylist.value;
  if (!pl?.tracks?.length) return;
  allowPlayerAutoplay();
  queue.value = pl.tracks.map((t) => {
    const row = {
      magnet: t.magnet,
      fileIdx: t.fileIdx,
      fileName: t.fileName,
      torrentName: t.torrentName,
      torrentId: t.torrentId,
      source: t.source,
      artist: t.artist ?? null,
      coverFileIdx: t.coverFileIdx ?? null,
      albumDirPath: t.albumDirPath ?? null,
    };
    if (t.source === "soulseek" && t.slskUsername && t.slskFilepath) {
      row.slskUsername = t.slskUsername;
      row.slskFilepath = t.slskFilepath;
      row.slskFilesize = t.slskFilesize ?? 0;
      row.trackId = registerAndGetId(buildSlskTrackEntity({
        username: t.slskUsername,
        filepath: t.slskFilepath,
        size: t.slskFilesize ?? 0,
        filename: t.fileName,
        artist: t.artist ?? null,
        cover: null,
        albumTitle: t.torrentName,
      }));
    } else {
      const btih = t.source === "magnet" ? parseBtihFromMagnet(t.magnet) : null;
      row.trackId = registerAndGetId(buildRtTrackEntity(
        { origIdx: t.fileIdx, path: t.fileName, size: 0 },
        { id: t.torrentId, name: t.torrentName, artist: t.artist, source: t.source },
        t.magnet,
        btih,
        t.coverFileIdx ?? null,
        t.albumDirPath ?? null,
      ));
    }
    return row;
  });
  queuePos.value = startIdx ?? 0;
}


// ── Search ────────────────────────────────────────────────────────────────────
// Reactive surface lives in src/stores/search.js. We only keep UI-local bits
// here (current input text, home-vs-recent toggle, per-peer filter).
const searchQuery = ref("");
const loading = computed(() => searchLoadingRt.value || searchLoadingSlsk.value);
const hasSearchResults = computed(() => searchEntities.value.length > 0);
/** Пользователь отправил непустой запрос с главной — показываем выдачу, а не только «Недавно». */
const homeSearchActive = ref(false);
/** Alias: search errors and navigation errors share the same UI slot. Writes
 *  from non-search code paths just clear it before showing a fresh screen. */
const error = searchError;
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

const mainRef = ref(null);

const {
  forwardStack,
  backStack,
  snapshotSearchForBack,
  snapshotTorrentForBack,
  pushCurrentScreenToForwardStack,
  handleBack,
  handleForwardNav,
  handleNavBack,
} = useNavStack({
  selected, files, torrentMagnet, torrentCover,
  torrentFilesBeforeAlbumPreview, torrentSelectedBeforeAlbumPreview,
  view, returnView, currentPlaylistId,
  searchQuery, searchEntities, slskPeerBrowseUser, error,
  mainRef,
});

// Download state + handlers (overlay progress, export helpers) live in
// useDownloads. See src/composables/useDownloads.js for the full surface.
const {
  downloadProgress,
  downloadOverlayExpanded,
  handleDownloadTrack,
  handleDownloadTrackFromLike,
  handleDownloadSlskTrack,
  handleDownloadPlaylist,
  handleDownloadFromQueue,
  handleDownloadAll,
  handleDownloadAlbum,
} = useDownloads({ selected, torrentMagnet, files, currentPlaylist });

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

// Mirror legacy likes into the entities-registry-based library store: every
// liked row is converted to a Track/Album entity, registered, and its id
// tracked in `likedTrackIds` / `likedAlbumIds`. Keeps the new store in sync
// with the legacy storage until the UI switches over wholesale.
watch(
  likes,
  (v) => {
    const trackIds = new Set();
    const albumIds = new Set();
    const at = new Map();
    for (const key of Object.keys(v)) {
      const like = v[key];
      if (!like) continue;
      at.set(like.id ?? key, like.addedAt ?? 0);
      if (like.type === "track") {
        let ent = null;
        if (like.source === "soulseek") {
          ent = buildSlskTrackEntity({
            username: like.slskUsername,
            filepath: like.slskFilepath,
            size: like.slskFilesize ?? 0,
            filename: like.fileName,
            artist: like.artist ?? null,
            cover: null,
            albumTitle: like.torrentName,
          });
        } else {
          const btih = like.source === "magnet" ? parseBtihFromMagnet(like.magnet ?? "") : null;
          ent = buildRtTrackEntity(
            { origIdx: like.fileIdx, path: like.fileName, size: 0 },
            { id: like.torrentId, name: like.torrentName, artist: like.artist ?? null, source: like.source },
            like.magnet ?? "",
            btih,
            like.coverFileIdx ?? null,
            like.albumDirPath ?? null,
          );
        }
        const id = registerAndGetId(ent);
        if (id) trackIds.add(id);
      }
      // Album likes keep their legacy representation for now — the Album
      // entity model doesn't yet cover the "snapshot of files at like time"
      // semantics the legacy code expects for offline-open.
    }
    libraryLikedTrackIds.value = trackIds;
    libraryLikedAlbumIds.value = albumIds;
    libraryLikedAt.value = at;
  },
  { immediate: true, deep: true },
);

/** Состояние воспроизведения из плеера — подсветка и анимация в списках. */
const playerPlaying = ref(true);

// ── Achievements (opt-in; localStorage) ─────────────────────────────────────
const {
  achievementsOptIn,
  achievementsState,
  achievementToastOpen,
  achievementToastTitle,
  achievementToastDesc,
  recordLikeChange,
  handleAchievementsOptInChange: _handleAchievementsOptInChange,
  handleAchievementsReset,
} = useAchievements({ playerPlaying, nowPlaying });

function handleAchievementsOptInChange(enabled) {
  _handleAchievementsOptInChange(enabled, Object.keys(likes.value).length);
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

const navCanGoBack = computed(() => {
  if (view.value !== "home") return false;
  if (torrentFilesBeforeAlbumPreview.value) return true;
  if (backStack.value.length > 0) return true;
  return !!selected.value;
});

watch(
  () => selected.value?.id,
  (newId) => { if (newId && mainRef.value) mainRef.value.scrollTo(0, 0); }
);

watch(view, () => {
  nextTick(() => {
    mainRef.value?.scrollTo?.(0, 0);
  });
});

// ── SoulSeek login handlers ───────────────────────────────────────────────────

async function handleSoulseekLogin(username, password) {
  slskLoggingIn.value = true;
  slskLoginError.value = null;
  try {
    const result = await soulseekLogin(username, password);
    if (result.success) {
      setSlskConnected(result.username);
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
  try { await soulseekLogout(); } catch { /* ignore */ }
  try { await soulseekClearSavedCredentials(); } catch { /* ignore */ }
  setSlskDisconnected();
  clearSlskCoverCache();
  // Drop SoulSeek entities from the current feed; RT entities stay.
  searchEntities.value = searchEntities.value.filter(
    (e) => e.sources?.[0]?.kind !== "soulseek",
  );
}

// ── Handlers ──────────────────────────────────────────────────────────────────
function handleLogin(username, avatarUrl) {
  markRutrackerHadAccount();
  setRtLoggedIn(username, avatarUrl);
}

/** @param {{ forgetAccount?: boolean } | void} evt — forgetAccount: явный выход (настройки), сбрасываем «раньше входили». */
function handleLogout(evt) {
  const forgetAccount = Boolean(evt && typeof evt === "object" && evt.forgetAccount);
  if (forgetAccount) clearRutrackerHadAccount();
  setRtLoggedOut();
  homeSearchActive.value = false;
  searchEntities.value = [];
  selected.value     = null;
  files.value        = [];
  torrentMagnet.value = "";
  torrentCover.value  = null;
  queue.value        = [];
  forwardStack.value = [];
  backStack.value    = [];
}

/**
 * Resets mixed-search UI before opening a torrent from library (likes / recent) on home.
 * Does not clear `selected` or files.
 */
function resetSearchStateForHomeLibraryNav() {
  resetSearch();
  homeSearchActive.value = false;
  slskPeerBrowseUser.value = null;
  searchQuery.value = "";
}

async function handleSearch(query, opts = {}) {
  if (!query?.trim()) {
    resetSearch();
    homeSearchActive.value = false;
    slskPeerBrowseUser.value = null;
    selected.value = null;
    files.value = [];
    return;
  }
  homeSearchActive.value = true;
  const q = query.trim();
  const qn = q.toLowerCase();
  if (slskPeerBrowseUser.value) {
    const pu = String(slskPeerBrowseUser.value).trim().toLowerCase();
    if (qn !== pu) slskPeerBrowseUser.value = null;
  }
  forwardStack.value = [];
  backStack.value    = [];
  selected.value     = null;
  files.value        = [];
  torrentCover.value = null;
  view.value         = "home";

  searchHistory.value = addToSearchHistory(q);

  await runSearch(
    q,
    { rtLoggedIn: rtLoggedIn.value, slskConnected: slskConnected.value },
    { skipResolver: Boolean(opts.skipResolver) },
  );
  appDebugLog("search", `query "${q}": dispatched`);
}

/** «Искать как строку» — повторяем текущий запрос минуя резолвер. */
async function handleRevertToRaw() {
  const q = searchQuery.value;
  if (!q?.trim()) return;
  await handleSearch(q, { skipResolver: true });
}

const {
  magnetPanelOpen,
  magnetDraft,
  magnetError,
  submitMagnetLink,
  closeMagnetPanel,
} = useMagnetDialog({
  selected, files, torrentMagnet, torrentCover,
  torrentFilesBeforeAlbumPreview, torrentSelectedBeforeAlbumPreview,
  loadingFiles, view, error,
  forwardStack, backStack,
  snapshotTorrentForBack, snapshotSearchForBack,
  mainRef,
});

/**
 * Open an Album entity in detail view (TorrentView). Accepts an Album
 * entity directly — no legacy row shape. For legacy callers (deep link,
 * likes, recent history) that only know a RuTracker topic id, use
 * `handleSelectLegacyTopic` below which fetches details and synthesizes
 * an Album entity on the fly.
 *
 * `selected` is still shaped for TorrentView back-compat: it carries the
 * display fields TorrentView reads today (name/artist/source/seeders etc).
 * A reference to the original `__entity` stays attached so we don't lose
 * the connection when TorrentView is finally migrated in Phase 6.
 */
async function handleSelect(album) {
  if (!album || album.type !== "album") {
    // Legacy fallback — called with a synthesized row (e.g. from a deep
    // link). Delegate to the topic-id opener below.
    return handleSelectLegacyTopic(album);
  }

  if (selected.value?.__entity?.id === album.id) {
    forwardStack.value = [];
    backStack.value = [];
    selected.value = null;
    files.value = [];
    torrentMagnet.value = "";
    torrentCover.value = null;
    torrentFilesBeforeAlbumPreview.value = null;
    torrentSelectedBeforeAlbumPreview.value = null;
    appDebugLog("search", `album deselected: ${album.id}`);
    return;
  }
  appDebugLog("search", `album opened: ${album.id} "${album.title}"`);
  if (selected.value) backStack.value.push(snapshotTorrentForBack());
  else                backStack.value.push(snapshotSearchForBack());
  forwardStack.value = [];
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;

  const src = album.sources?.[0];
  const kind = src?.kind;

  if (kind === "rutracker") {
    const details = src.raw?.details;
    const topicRow = src.raw?.topicRow;
    const topicId = src.refs?.topicId;
    const trackEntities = (album.trackIds ?? [])
      .map((id) => searchEntities.value.find((e) => e.id === id))
      .filter(Boolean);

    // TorrentView still reads legacy row fields — build one from the entity.
    selected.value = {
      id: String(topicId ?? album.id),
      name: topicRow?.name ?? album.title,
      source: "rutracker",
      artist: album.artist ?? details?.artist ?? null,
      seeders: album.seeders ?? topicRow?.seeders ?? 0,
      leechers: album.leechers ?? topicRow?.leechers ?? 0,
      size: album.size ?? topicRow?.size ?? 0,
      added: topicRow?.added ?? "",
      category: topicRow?.category ?? "",
      __entity: album,
    };
    torrentMagnet.value = details?.magnet ?? "";
    torrentCover.value = album.coverUrl ?? null;

    files.value = trackEntities.map((t) => {
      const file = t.sources?.[0]?.raw?.file;
      const fileIdx = t.sources?.[0]?.refs?.fileIdx ?? 0;
      const pathStr = (file?.path ?? []).join("/") || t.fileName;
      return {
        name: t.fileName,
        path: pathStr,
        size: t.size ?? file?.size ?? 0,
        idx: fileIdx,
        origIdx: fileIdx,
      };
    });
    // Include THIS album's folder cover (cover.jpg / folder.jpg) so
    // AlbumFolderCover in TorrentView can fetch the per-album image via BT
    // instead of falling back to the topic's post preview.
    const albumCoverFile = src.raw?.albumDir?.coverFile;
    if (albumCoverFile?._origIdx != null) {
      files.value.push({
        name: albumCoverFile.path.split("/").pop() ?? "",
        path: albumCoverFile.path,
        size: albumCoverFile.size,
        idx: albumCoverFile._origIdx,
        origIdx: albumCoverFile._origIdx,
      });
    }
    loadingFiles.value = false;
    appDebugLog("search", `rt album opened: "${album.title}" tracks=${files.value.length} hasMagnet=${!!details?.magnet}`);

    if (topicId) {
      void torrentFileB64ForTrack({ source: "rutracker", torrentId: topicId });
      if (topicRow) {
        recentHistory.value = addToRecentHistory({
          id: String(topicId),
          name: topicRow.name ?? album.title,
          source: "rutracker",
          artist: album.artist ?? details?.artist ?? "",
          magnet: details?.magnet ?? "",
        });
      }
    }
    return;
  }

  if (kind === "soulseek") {
    // Resolve Track entities → raw rows for TorrentView's file list.
    const trackEntities = (album.trackIds ?? [])
      .map((id) => searchEntities.value.find((e) => e.id === id))
      .filter(Boolean);
    const cover = src.raw?.cover ?? null;

    selected.value = {
      id: album.id,
      name: album.title,
      source: "soulseek",
      artist: album.artist ?? null,
      seeders: album.peers ?? 1,
      leechers: 0,
      size: album.size ?? 0,
      added: "—",
      category: album.bitrate ? `MP3 ${album.bitrate} kbps` : "SoulSeek",
      slsk_username: src.refs?.slskUsername ?? null,
      slsk_folder: src.refs?.slskFolder ?? null,
      slsk_cover_username: cover?.slsk_username ?? null,
      slsk_cover_filepath: cover?.slsk_filepath ?? null,
      slsk_cover_size: cover?.size ?? 0,
      __entity: album,
    };

    // Synthetic common folder so TorrentView's detectAlbums collapses
    // cross-peer tracks into one group.
    const albumFolder =
      (src.refs?.slskFolder?.split("/").pop() || album.title || "album").trim();

    files.value = trackEntities.map((t, i) => {
      const tsrc = t.sources?.[0];
      const filepath = (tsrc?.refs?.slskFilepath ?? "").replace(/\\/g, "/");
      const filename = filepath.split("/").pop() || t.fileName || `track_${i}`;
      return {
        name: filename,
        path: `${albumFolder}/${filename}`,
        size: t.size ?? 0,
        idx: i,
        origIdx: i,
        slskUsername: tsrc?.refs?.slskUsername,
        slskFilepath: tsrc?.refs?.slskFilepath,
        slskFilesize: t.size ?? 0,
        slskMetaTrackId: t.id,
        slskFolderCoverUsername: cover?.slsk_username ?? null,
        slskFolderCoverFilepath: cover?.slsk_filepath ?? null,
        slskFolderCoverSize: cover?.size ?? 0,
      };
    });
    loadingFiles.value = false;
    appDebugLog("search", `slsk album opened: "${album.title}" tracks=${files.value.length}`);
    return;
  }

  loadingFiles.value = false;
}

/**
 * Legacy fallback — called with a synthesized "torrent row" from code paths
 * that don't have an Album entity (deep link handler, likes, recent
 * history). Fetches TorrentDetails and builds a displayable `selected`
 * row + files list inline. Eventually these callers should synthesize an
 * Album entity instead and go through `handleSelect`.
 */
async function handleSelectLegacyTopic(torrent) {
  if (!torrent?.id) return;
  if (selected.value?.id === torrent.id) {
    forwardStack.value = [];
    backStack.value = [];
    selected.value = null; files.value = []; torrentMagnet.value = ""; torrentCover.value = null;
    torrentFilesBeforeAlbumPreview.value = null;
    torrentSelectedBeforeAlbumPreview.value = null;
    return;
  }
  if (selected.value) backStack.value.push(snapshotTorrentForBack());
  else                backStack.value.push(snapshotSearchForBack());
  forwardStack.value = [];
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;
  selected.value      = torrent;
  files.value         = [];
  torrentMagnet.value = "";
  torrentCover.value  = null;
  loadingFiles.value  = true;

  if (torrent.source === "soulseek") {
    // Likes / history can pre-populate slsk_tracks (fallback when Album entity missing)
    const trackList = torrent.slsk_tracks?.length
      ? torrent.slsk_tracks
      : [{ slsk_filepath: torrent.slsk_filepath, slsk_username: torrent.slsk_username, size: torrent.size }];
    const albumFolder =
      (torrent.slsk_folder?.split("/").pop() || torrent.name || "album").trim();
    files.value = trackList.map((t, i) => {
      const normalized = (t.slsk_filepath ?? "").replace(/\\/g, "/");
      const filename = normalized.split("/").pop() || t.name || `track_${i}`;
      return {
        name: filename,
        path: `${albumFolder}/${filename}`,
        size: t.size ?? 0,
        idx: i, origIdx: i,
        slskUsername: t.slsk_username ?? torrent.slsk_username,
        slskFilepath: t.slsk_filepath ?? normalized,
        slskFilesize: t.size ?? 0,
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
      name: f.path[f.path.length - 1] ?? "",
      path: f.path.join("/"),
      size: f.size,
      idx: i,
      origIdx: i,
    }));
    void torrentFileB64ForTrack({ source: torrent.source, torrentId: torrent.id });
    recentHistory.value = addToRecentHistory({
      id: String(torrent.id),
      name: torrent.name ?? "",
      source: torrent.source ?? "rutracker",
      artist: details.artist ?? torrent.artist ?? "",
      magnet: details.magnet ?? "",
    });
  } catch (e) {
    console.error("handleSelectLegacyTopic:", e);
    appDebugLog("search", `torrent open error: #${torrent.id} — ${String(e)}`);
  } finally {
    loadingFiles.value = false;
  }
}

/** Play a single track directly from an entity (no TorrentView). */
function handlePlaySlskTrack(track) {
  if (!track || track.type !== "track") return;
  allowPlayerAutoplay();
  registerAndGetId(track);
  const item = asQueueItemFor(track);
  if (!item) return;
  queue.value = [item];
  queuePos.value = 0;
}

/** Play a full Album entity from search results: resolve trackIds via registry. */
function handlePlaySlskAlbumEntity(album) {
  allowPlayerAutoplay();
  if (!album || album.type !== "album") return;
  const byId = new Map();
  for (const e of searchEntities.value) byId.set(e.id, e);
  const tracks = (album.trackIds ?? [])
    .map((id) => byId.get(id))
    .filter((t) => t?.type === "track");
  if (tracks.length === 0) return;
  for (const t of tracks) registerAndGetId(t);
  queue.value = tracks.map(asQueueItemFor).filter(Boolean);
  queuePos.value = 0;
}

function playlistTrackFromLike(like) {
  return _playlistTrackFromLike(like, likes.value);
}

function handleLikeSlskTrack(track) {
  const like = asLikeRowFor(track);
  if (like) handleToggleLike(like);
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
  // RT Album cards carry `__topicId` (the underlying rutracker topic id) so
  // streaming & the .torrent file cache can key by it, even though the row's
  // display id is the per-album entity id. Fall back to `id` for legacy rows.
  const torrentId = torrent?.__topicId ?? torrent?.id ?? "";
  const item = {
    magnet,
    fileIdx:      f.origIdx,
    fileName:     trackDisplayBasename(f.path),
    torrentName:  torrent?.name   ?? "",
    torrentId,
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
    item.trackId = registerAndGetId(buildSlskTrackEntity({
      username: item.slskUsername,
      filepath: item.slskFilepath,
      size: item.slskFilesize,
      filename: item.fileName,
      artist: item.artist,
      cover: (item.slskFolderCoverUsername && item.slskFolderCoverFilepath)
        ? { slsk_username: item.slskFolderCoverUsername, slsk_filepath: item.slskFolderCoverFilepath, size: item.slskFolderCoverSize }
        : null,
      albumTitle: item.torrentName,
    }));
  } else {
    const btih = torrent?.source === "magnet" ? parseBtihFromMagnet(magnet) : null;
    item.trackId = registerAndGetId(
      buildRtTrackEntity(f, torrent, magnet, btih, coverFileIdx, albumDirPath),
    );
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
      slskMetaTrackId: like.id,
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
  const item = {
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
  };
  if (track.source === "soulseek" && track.slskUsername && track.slskFilepath) {
    item.slskUsername = track.slskUsername;
    item.slskFilepath = track.slskFilepath;
    item.slskFilesize = track.slskFilesize ?? 0;
  }
  appendToQueue(item);
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
  recordLikeChange(likesAfter, likesBefore);
}

const { handleOpenAlbumPreview, applyAlbumScopeForTrack } = useAlbumPreview({
  selected, files,
  torrentFilesBeforeAlbumPreview, torrentSelectedBeforeAlbumPreview,
  mainRef,
});

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
  resetSearchStateForHomeLibraryNav();
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
  const tid = like.torrentId != null && like.torrentId !== "" ? String(like.torrentId) : String(like.id ?? "");
  const torrent = {
    id: tid,
    name: like.type === "album" ? (like.albumName || like.torrentName) : like.torrentName,
    source: like.source, seeders: "?", size: 0, category: "—", added: "—",
    fromLikes: true, artist: m ? m[1].trim() : "",
  };
  returnView.value    = view.value === "playlist" ? "playlist" : "likes";
  view.value          = "home";
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
    const details = await getTorrentDetails(tid);
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
  const payload = navigationTargetFor(track);
  if (payload) handleOpenTorrentFromPlayer(payload);
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
  view.value = "home";
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
    const coverFileIdx = trackCoverFileIdxForLike(l, likes.value);
    const row = {
      magnet: l.magnet ?? "",
      fileIdx: l.fileIdx,
      fileName: l.fileName,
      torrentName: l.torrentName,
      torrentId: l.torrentId,
      source: l.source,
      coverFileIdx,
    };
    if (l.source === "soulseek" && l.slskUsername && l.slskFilepath) {
      row.slskUsername = l.slskUsername;
      row.slskFilepath = l.slskFilepath;
      row.slskFilesize = l.slskFilesize ?? 0;
      row.slskMetaTrackId = l.id;
      row.trackId = registerAndGetId(buildSlskTrackEntity({
        username: l.slskUsername,
        filepath: l.slskFilepath,
        size: l.slskFilesize ?? 0,
        filename: l.fileName,
        artist: l.artist ?? null,
        cover: null,
        albumTitle: l.torrentName,
      }));
      return row;
    }
    const btih = l.source === "magnet" ? parseBtihFromMagnet(l.magnet ?? "") : null;
    row.trackId = registerAndGetId(buildRtTrackEntity(
      { origIdx: l.fileIdx, path: l.fileName, size: 0 },
      { id: l.torrentId, name: l.torrentName, artist: l.artist ?? null, source: l.source },
      l.magnet ?? "",
      btih,
      coverFileIdx,
      l.albumDirPath ?? null,
    ));
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
  const coverIdx = like.coverFile?.origIdx ?? null;
  const btih = like.source === "magnet" ? parseBtihFromMagnet(like.magnet ?? "") : null;
  queue.value = like.audioFiles.map((f) => {
    const row = {
      magnet: like.magnet,
      fileIdx: f.origIdx,
      fileName: trackDisplayBasename(f.path),
      torrentName: like.torrentName,
      torrentId: like.torrentId,
      source: like.source,
      coverFileIdx: coverIdx,
    };
    row.trackId = registerAndGetId(buildRtTrackEntity(
      f,
      { id: like.torrentId, name: like.torrentName, artist: like.artist ?? null, source: like.source },
      like.magnet ?? "",
      btih,
      coverIdx,
      null,
    ));
    return row;
  });
  queuePos.value = 0;
}

function handleSearchArtist(artist) {
  if (!artist?.trim()) return;
  searchQuery.value = artist.trim();
  appDebugLog("search", `artist filter: "${artist.trim()}"`);
  void handleSearch(artist.trim());
}


function handleOpenTorrentFromPlayer(track) {
  if (!track?.torrentId && !track?.magnet) return;
  if (track.source === "soulseek" && track.slskUsername) {
    void handleNavigateSoulseekPeer(track.slskUsername);
    return;
  }
  if (selected.value?.id === track.torrentId) {
    view.value = "home";
    if (!torrentFilesBeforeAlbumPreview.value) {
      applyAlbumScopeForTrack(track.fileIdx, track.albumDirPath ?? null);
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
  view.value = "home";
  returnView.value = "home";
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
        applyAlbumScopeForTrack(track.fileIdx, track.albumDirPath);
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
        applyAlbumScopeForTrack(track.fileIdx, track.albumDirPath);
      });
  void fetching.finally(() => {
    loadingFiles.value = false;
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
  });
}

/**
 * Open a torrent by source and ID from a neegde:// deep link.
 * Navigates to home, loads files from Rutracker.
 * @param {string} source - e.g. "rutracker"
 * @param {string} torrentId
 */
async function openTorrentByDeepLink(source, torrentId) {
  forwardStack.value = [];
  backStack.value = [];
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;
  view.value = "home";
  returnView.value = "home";
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

const {
  shuffleQueueInPlaceKeepingCurrent,
  toggleShuffle,
  cycleRepeatMode,
  handlePlayerNext,
  handleTrackEnded,
  handlePrev,
} = useQueueControls({ queue, queuePos, repeatMode, shuffleOn, allowPlayerAutoplay });

function handleOpenRecent(item) {
  // Полный сброс режима поиска как при пустой строке, но без handleSearch(""):
  // тот выставляет selected/files в null и снова «выкидывает» на главную уже после открытия раздачи.
  resetSearchStateForHomeLibraryNav();
  selected.value = null;
  files.value = [];
  view.value = "home";
  void handleSelect({
    id: String(item.id),
    name: item.name,
    source: item.source ?? "rutracker",
    seeders: "?",
    size: 0,
    category: "—",
    added: "—",
  });
}

function handleRemoveFromRecent(item) {
  recentHistory.value = removeFromRecentHistory(item.id);
}

function handleRemoveSearchQuery(q) {
  searchHistory.value = removeFromSearchHistory(q);
}

function navToSearch() {
  forwardStack.value = [];
  backStack.value = [];
  view.value          = "home";
  selected.value      = null;
  files.value         = [];
  torrentMagnet.value = "";
  torrentCover.value  = null;
  error.value         = null;
  if (mainRef.value) mainRef.value.scrollTo(0, 0);
}

/**
 * Sidebar home button: switches to home; if already on home, clears search results, query,
 * open torrent, and nav stacks (habitual «clean home»).
 */
function handleSidebarHome() {
  if (view.value !== "home") {
    view.value = "home";
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
    return;
  }
  if (!homeSearchActive.value && !selected.value) {
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
    return;
  }
  searchQuery.value = "";
  void handleSearch("");
  torrentMagnet.value = "";
  torrentCover.value = null;
  forwardStack.value = [];
  backStack.value = [];
  if (mainRef.value) mainRef.value.scrollTo(0, 0);
}

useMouseSideButtonNav({
  canGoBack: navCanGoBack,
  canGoForward: computed(() => forwardStack.value.length > 0),
  onBack: handleNavBack,
  onForward: handleForwardNav,
});
</script>

<template src="./App.html"></template>
