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
import { useAppDebug } from "./composables/useAppDebug.js";
import { useTheme } from "./composables/useTheme.js";
import { useMouseSideButtonNav } from "./composables/useMouseSideButtonNav.js";
import { useAchievements } from "./composables/useAchievements.js";
import { useDownloads } from "./composables/useDownloads.js";
import { useNavStack } from "./composables/useNavStack.js";
import { useMagnetDialog } from "./composables/useMagnetDialog.js";
import { useAlbumPreview } from "./composables/useAlbumPreview.js";
import { loadPersistedState } from "./persistence/bootstrap.js";
import {
  likedTracks as libraryLikedTracks,
  likedTrackIds as libraryLikedTrackIds,
  likedAlbumIds as libraryLikedAlbumIds,
  likedAt as libraryLikedAt,
  toggleLikeTrack,
  toggleLikeAlbum as libToggleLikeAlbum,
  isAlbumLiked as libIsAlbumLiked,
  playlists as libraryPlaylists,
  getPlaylistTracks,
  addTrackToPlaylist as libAddTrackToPlaylist,
  removeTrackFromPlaylist as libRemoveTrackFromPlaylist,
  deletePlaylist as libDeletePlaylist,
  renamePlaylist as libRenamePlaylist,
  createPlaylist as libCreatePlaylist,
  seedLikesFromSnapshot,
  seedPlaylistsFromSnapshot,
} from "./stores/library.js";
import {
  queueIds as queueStoreIds,
  queuePos as queueStorePos,
  nowPlayingTrack as nowPlayingTrackFromStore,
  nextTrack as nextTrackFromStore,
  secondNextTrack as secondNextTrackFromStore,
  hasPrev as queueHasPrev,
  hasNext as queueHasNext,
  repeatMode,
  shuffleOn,
  replaceQueue,
  enqueueTrack,
  playTrackNow,
  jumpTo,
  removeAt,
  next as queueNext,
  prev as queuePrev,
  clear as clearQueue,
  setRepeat,
  toggleShuffle as storeToggleShuffle,
  seedQueueFromSnapshot,
} from "./stores/queue.js";
import { getTrack } from "./stores/entities.js";
import { torrentFileB64ForTrack, streamUrl, magnetListFiles } from "./torrent/api.js";
import { releaseTorrentStreamUrl, torrentPrepareCancel } from "./torrent/torrentSession.js";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";

import SearchBar    from "./components/search/SearchBar.vue";
import Results      from "./components/search/Results.vue";
import SearchIntentHint from "./components/search/SearchIntentHint.vue";
import TorrentView  from "./components/torrent/TorrentView.vue";
import LikesView    from "./components/likes/LikesView.vue";
import AlbumView    from "./components/album/AlbumView.vue";
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
import PlaylistView from "./components/playlist/PlaylistView.vue";
import AchievementToast from "./components/shell/AchievementToast.vue";
import SystemIcon from "./components/shared/SystemIcon.vue";

// Queue + repeat/shuffle are owned by `stores/queue`. Auto-persist is handled
// inside the store. App.vue reads derived values and delegates mutations.
const nowPlaying = nowPlayingTrackFromStore;  // alias used by useAppDebug
const { appDebugEnabled } = useAppDebug({ view, queuePos: queueStorePos, nowPlaying });

/** Track[] view over the queue ids — used for the in-player queue panel. */
const playbackQueueTracks = computed(() =>
  queueStoreIds.value
    .map((id) => getTrack(id))
    .filter((t) => t != null),
);

/**
 * HMR-safe Track check. `instanceof Track` breaks after Vite HMR: if the
 * Track module or any of its subclasses gets re-imported, instances created
 * by the old module no longer match the new class prototype and silently
 * fail guards like `if (!(x instanceof Track)) return`. Duck-type on the
 * API surface instead — it's present on every Track subclass regardless of
 * reload generation.
 */
function isTrack(t) {
  return !!t && t.type === "track" && typeof t.prepareStream === "function";
}

/** On cold start with a restored queue we don't want HTML autoplay on src assignment. */
const suppressAutoplayAfterSessionRestore = ref(queueStoreIds.value.length > 0);

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
// Playlist state is owned by `stores/library` (v2 persistence). App.vue reads
// derived views (currentPlaylist, currentPlaylistTracks) and delegates all
// mutations to library store functions (see onAddTrackToPlaylist etc.).
const currentPlaylist = computed(
  () => libraryPlaylists.value.find((p) => p.id === currentPlaylistId.value) ?? null,
);
const currentPlaylistTracks = computed(() =>
  currentPlaylistId.value ? getPlaylistTracks(currentPlaylistId.value) : [],
);

// ── Playlist handlers (thin wrappers around stores/library) ────────────────
const addToPlaylistModal = ref(false);
/** @type {import('vue').ShallowRef<Track | null>} */
const addToPlaylistTrack = shallowRef(null);

function openPlaylist(id) {
  currentPlaylistId.value = id;
  view.value = "playlist";
}

function handleCreatePlaylist() {
  const pl = libCreatePlaylist(`Плейлист ${libraryPlaylists.value.length + 1}`);
  openPlaylist(pl.id);
}

function handleDeletePlaylist(id) {
  libDeletePlaylist(id);
  if (currentPlaylistId.value === id) {
    currentPlaylistId.value = null;
    view.value = "home";
  }
}

function handleRenamePlaylist(id, name) {
  libRenamePlaylist(id, name);
}

function handleRemoveTrackFromPlaylist(id, trackId) {
  libRemoveTrackFromPlaylist(id, trackId);
}

/**
 * Accepts either a Track instance (new callers: LikesView, PlaylistView,
 * search Results) or a legacy row (TorrentView's `makePlaylistTrack` /
 * `makeTrackLike`). Resolves or synthesizes a Track via the entities
 * registry. Null when the payload can't produce a playable track.
 */
function resolveTrackFromPayload(payload) {
  if (!payload) return null;
  if (isTrack(payload)) return payload;
  const id = payload.id ?? `track:${payload.source}:${payload.torrentId}:${payload.fileIdx}`;
  const existing = getTrack(id);
  if (existing) return existing;
  let ent = null;
  if (payload.source === "soulseek" && payload.slskUsername && payload.slskFilepath) {
    ent = buildSlskTrackEntity({
      username: payload.slskUsername,
      filepath: payload.slskFilepath,
      size: payload.slskFilesize ?? 0,
      filename: payload.fileName,
      artist: payload.artist ?? null,
      cover: null,
      albumTitle: payload.torrentName,
    });
  } else {
    const btih = payload.source === "magnet" ? parseBtihFromMagnet(payload.magnet ?? "") : null;
    ent = buildRtTrackEntity(
      { origIdx: payload.fileIdx, path: payload.fileName, size: 0 },
      { id: payload.torrentId, name: payload.torrentName, artist: payload.artist ?? null, source: payload.source },
      payload.magnet ?? "",
      btih,
      payload.coverFileIdx ?? null,
      payload.albumDirPath ?? null,
    );
  }
  if (!ent) return null;
  registerAndGetId(ent);
  return getTrack(ent.id);
}

/** User picked a track for the "add to playlist" modal. */
function handleShowAddToPlaylist(payload) {
  const track = resolveTrackFromPayload(payload);
  if (!track) return;
  addToPlaylistTrack.value = track;
  addToPlaylistModal.value = true;
}

function handleAddToPlaylist(playlistId) {
  const t = addToPlaylistTrack.value;
  if (!t) return;
  libAddTrackToPlaylist(playlistId, t);
  addToPlaylistModal.value = false;
  addToPlaylistTrack.value = null;
}

function handleAddToPlaylistNew() {
  const pl = libCreatePlaylist(`Плейлист ${libraryPlaylists.value.length + 1}`);
  const t = addToPlaylistTrack.value;
  if (t) libAddTrackToPlaylist(pl.id, t);
  addToPlaylistModal.value = false;
  addToPlaylistTrack.value = null;
  openPlaylist(pl.id);
}

// ── Per-track actions from LikesView / PlaylistView / search ───────────────

const nowPlayingTrackId = computed(() => nowPlayingTrackFromStore.value?.id ?? null);

function onToggleLikeTrack(track) {
  if (!isTrack(track)) return;
  toggleLikeTrack(track);
}

function onPlayTrack(track) {
  if (!isTrack(track)) return;
  allowPlayerAutoplay();
  playTrackNow(track);
}

function onOpenTrackSource(track) {
  if (!isTrack(track)) return;
  const target = track.navigationTarget();
  if (target) handleOpenTorrentFromPlayer(target);
}

function onDownloadTrack(track) {
  if (!isTrack(track)) return;
  downloadOverlayExpanded.value = true;
  void track.exportToDisk((p) => { downloadProgress.value = p; });
}

function onAddToQueue(track) {
  if (!isTrack(track)) return;
  enqueueTrack(track);
}

function onAddTrackToPlaylist(track) {
  if (!isTrack(track)) return;
  handleShowAddToPlaylist(track);
}

function onRemoveTrackFromPlaylist(trackId) {
  if (currentPlaylistId.value) libRemoveTrackFromPlaylist(currentPlaylistId.value, trackId);
}

function onDeleteCurrentPlaylist() {
  if (currentPlaylistId.value) handleDeletePlaylist(currentPlaylistId.value);
}

function onRenameCurrentPlaylist(newName) {
  if (currentPlaylistId.value) libRenamePlaylist(currentPlaylistId.value, newName);
}

function handlePlayPlaylist(startIdx) {
  const tracks = currentPlaylistTracks.value;
  if (!tracks.length) return;
  allowPlayerAutoplay();
  replaceQueue(tracks, Math.max(0, Math.min(startIdx ?? 0, tracks.length - 1)));
}

// ── AlbumView handlers ─────────────────────────────────────────────────────

/** Resolve an album's trackIds to live Track instances via the registry. */
function currentAlbumTracks() {
  const alb = currentAlbum.value;
  if (!alb) return [];
  const out = [];
  for (const id of alb.trackIds ?? []) {
    const t = getTrack(id);
    if (t) out.push(t);
  }
  return out;
}

function handleAlbumPlayAll() {
  const tracks = currentAlbumTracks();
  if (!tracks.length) return;
  allowPlayerAutoplay();
  replaceQueue(tracks, 0);
}

function handleAlbumToggleLike(album) {
  if (!album) return;
  libToggleLikeAlbum(album);
}

function handleAlbumDownloadAll() {
  const tracks = currentAlbumTracks();
  if (!tracks.length) return;
  downloadOverlayExpanded.value = true;
  for (const t of tracks) {
    void t.exportToDisk((p) => { downloadProgress.value = p; });
  }
}

const currentAlbumLiked = computed(() => {
  const alb = currentAlbum.value;
  if (!alb) return false;
  libraryLikedAlbumIds.value; // reactive dep
  return libIsAlbumLiked(alb.id);
});

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
/**
 * Active Album entity for the new AlbumView path (search → album click).
 * Mutually exclusive with `selected` (legacy TorrentView path).
 * Opening an album from search sets this; opening a magnet / deep link /
 * recent topic sets `selected` instead.
 */
const currentAlbum  = shallowRef(null);
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
  snapshotAlbumForBack,
  pushCurrentScreenToForwardStack,
  handleBack,
  handleForwardNav,
  handleNavBack,
} = useNavStack({
  selected, files, torrentMagnet, torrentCover,
  torrentFilesBeforeAlbumPreview, torrentSelectedBeforeAlbumPreview,
  currentAlbum,
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

// Likes are owned by `stores/library` (v2 persistence). The library store is
// seeded on boot from `loadPersistedState()`; this module only reads.
// NOTE: a small number of legacy handlers below (TorrentView / Player toggle-
// like paths, `handleDownloadTrackFromLike`, etc.) still expect the old
// `likes` dict shape. We derive it on the fly from the library store until
// those consumers migrate too (task #54 / #56). This is a *read-only* view,
// never written back — the library store remains the single source of truth.
const likes = computed(() => {
  const out = {};
  for (const t of libraryLikedTracks.value) {
    out[t.id] = {
      id: t.id,
      type: "track",
      source: t.kind,
      magnet: t.sources?.[0]?.refs?.magnet ?? "",
      fileIdx: t.sources?.[0]?.refs?.fileIdx ?? 0,
      fileName: t.fileName,
      torrentName: t.albumTitle ?? "",
      torrentId: t.sources?.[0]?.refs?.topicId ?? t.id,
      artist: t.artist,
      coverFileIdx: t.sources?.[0]?.refs?.coverFileIdx ?? null,
      albumDirPath: t.sources?.[0]?.refs?.albumDirPath ?? null,
      slskUsername: t.sources?.[0]?.refs?.slskUsername,
      slskFilepath: t.sources?.[0]?.refs?.slskFilepath,
      slskFilesize: t.size ?? 0,
      addedAt: libraryLikedAt.value.get(t.id) ?? 0,
    };
  }
  return out;
});

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
  clearQueue();
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
/**
 * Open an Album entity in the new AlbumView — no legacy row transformation.
 * Tracks resolve through the entities registry; AlbumView reads them by id.
 * Legacy row payloads (deep link, recent history) still go through
 * `handleSelectLegacyTopic` + TorrentView.
 */
function handleSelect(album) {
  if (!album || album.type !== "album") {
    return handleSelectLegacyTopic(album);
  }

  // Toggle off if clicking the already-open album.
  if (currentAlbum.value?.id === album.id) {
    forwardStack.value = [];
    backStack.value = [];
    currentAlbum.value = null;
    appDebugLog("search", `album deselected: ${album.id}`);
    return;
  }

  appDebugLog("search", `album opened: ${album.id} "${album.title}"`);
  if (currentAlbum.value) backStack.value.push(snapshotAlbumForBack());
  else if (selected.value) backStack.value.push(snapshotTorrentForBack());
  else                     backStack.value.push(snapshotSearchForBack());
  forwardStack.value = [];

  // Clear legacy TorrentView state — the two paths are mutually exclusive.
  selected.value = null;
  files.value = [];
  torrentMagnet.value = "";
  torrentCover.value = null;
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;

  currentAlbum.value = album;

  // RT: prewarm torrent file cache + record recent history (topic-level).
  const src = album.sources?.[0];
  if (src?.kind === "rutracker") {
    const topicId = src.refs?.topicId;
    const topicRow = src.raw?.topicRow;
    const details = src.raw?.details;
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
  }
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

/** Play a single Track entity directly from search results. */
function handlePlaySlskTrack(track) {
  if (!isTrack(track)) return;
  allowPlayerAutoplay();
  playTrackNow(track);
}

/** Play a full Album entity: resolve trackIds via search results, hand off to queue store. */
function handlePlaySlskAlbumEntity(album) {
  allowPlayerAutoplay();
  if (!album || album.type !== "album") return;
  const byId = new Map();
  for (const e of searchEntities.value) byId.set(e.id, e);
  const tracks = (album.trackIds ?? [])
    .map((id) => byId.get(id))
    .filter((t) => t?.type === "track");
  if (tracks.length === 0) return;
  // registerEntity normalizes plain data to class instances and returns them via getTrack.
  for (const t of tracks) registerEntity(t);
  const trackInstances = tracks.map((t) => getTrack(t.id)).filter(Boolean);
  if (trackInstances.length === 0) return;
  replaceQueue(trackInstances, 0);
}

/** SLSK track-row click → toggle like via the library store. */
function handleLikeSlskTrack(track) {
  if (!isTrack(track)) return;
  toggleLikeTrack(track);
}

/**
 * Build (or fetch from registry) a Track instance for a file inside the
 * currently-open torrent / SoulSeek folder.
 */
function makeTrackFromFile(f, torrent, magnet, fileList, explicitCoverFileIdx) {
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
  if (torrent?.source === "soulseek") {
    const ent = buildSlskTrackEntity({
      username: f.slskUsername ?? torrent.slsk_username ?? null,
      filepath: f.slskFilepath ?? f.path ?? null,
      size: f.slskFilesize ?? f.size ?? torrent.size ?? 0,
      filename: trackDisplayBasename(f.path),
      artist: torrent?.artist ?? null,
      cover: (f.slskFolderCoverUsername && f.slskFolderCoverFilepath)
        ? { slsk_username: f.slskFolderCoverUsername, slsk_filepath: f.slskFolderCoverFilepath, size: f.slskFolderCoverSize }
        : null,
      albumTitle: torrent?.name ?? "",
    });
    const id = registerAndGetId(ent);
    return id ? getTrack(id) : null;
  }
  const synthTorrent = {
    id: torrent?.__topicId ?? torrent?.id ?? "",
    name: torrent?.name ?? "",
    artist: torrent?.artist ?? null,
    source: torrent?.source ?? "rutracker",
  };
  const btih = torrent?.source === "magnet" ? parseBtihFromMagnet(magnet) : null;
  const ent = buildRtTrackEntity(f, synthTorrent, magnet, btih, coverFileIdx, albumDirPath);
  const id = registerAndGetId(ent);
  return id ? getTrack(id) : null;
}

function tracksFromFiles(fileArray, coverIdxOverride) {
  return fileArray
    .map((f) => makeTrackFromFile(f, selected.value, torrentMagnet.value, files.value, coverIdxOverride))
    .filter((t) => t != null);
}

function handlePlay(fileIdx) {
  allowPlayerAutoplay();
  const audioFiles = orderedAudioFiles(files.value);
  const startIdx = Math.max(0, audioFiles.findIndex((f) => f.origIdx === fileIdx));
  const tracks = tracksFromFiles(audioFiles, null);
  if (tracks.length === 0) return;
  // If the user clicked the same file that's already first in queue, just jump.
  const sameQueue = queueStoreIds.value.length === tracks.length
    && queueStoreIds.value.every((id, i) => id === tracks[i]?.id);
  if (sameQueue) {
    jumpTo(startIdx);
    return;
  }
  replaceQueue(tracks, startIdx);
}

function handlePlayAll() {
  allowPlayerAutoplay();
  const audioFiles = orderedAudioFiles(files.value);
  if (!audioFiles.length) return;
  const tracks = tracksFromFiles(audioFiles, null);
  if (tracks.length === 0) return;
  replaceQueue(tracks, 0);
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
  const tracks = tracksFromFiles(albumFiles, coverIdx);
  if (tracks.length === 0) return;
  replaceQueue(tracks, 0);
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
/** Enqueue a track from an audio file in the current torrent. */
function handleAddToQueueFromTorrent(fileIdx) {
  const audioFiles = orderedAudioFiles(files.value);
  const f = audioFiles.find((x) => x.origIdx === fileIdx);
  if (!f || !selected.value) return;
  const track = makeTrackFromFile(f, selected.value, torrentMagnet.value, files.value);
  if (track) enqueueTrack(track);
}

function onQueueJump(i) {
  allowPlayerAutoplay();
  jumpTo(i);
}

function onQueueRemove(i) {
  removeAt(i);
}

/** Legacy placeholder — gets called from nav stack restore; no-op in v2 because
 *  the queue is an always-resolvable id list. Kept as a stub so template refs
 *  to handleQueueRemove don't crash during stale renders. */
function handleQueueRemove(i) {
  onQueueRemove(i);
}
function handleQueueJump(i) {
  onQueueJump(i);
}

/**
 * Legacy toggle-like bridge — consumed by TorrentView / Player which still
 * emit the old row shape. Resolves / synthesizes a Track and delegates to
 * the library store. Will be removed once those components migrate to
 * emitting Track instances directly.
 */
function handleToggleLike(payload) {
  const track = resolveTrackFromPayload(payload);
  if (!track) return;
  const before = libraryLikedTrackIds.value.size;
  toggleLikeTrack(track);
  recordLikeChange(libraryLikedTrackIds.value.size, before);
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
  if (!isTrack(track)) return;
  const payload = track.navigationTarget();
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

// Legacy handlers removed — LikesView now emits `onPlayTrack(track)` which
// resolves directly through the queue store. Album likes aren't wired in v2
// (the Likes view intentionally only shows track likes now).

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

function handlePrev() {
  allowPlayerAutoplay();
  queuePrev();
}

function handlePlayerNext() {
  allowPlayerAutoplay();
  const len = queueStoreIds.value.length;
  if (len === 0) return;
  if (queueStorePos.value < len - 1) queueNext();
  else if (repeatMode.value === "all") queueNext();
  else clearQueue();
}

/** Natural track end — `repeat-one` is handled in Player. */
function handleTrackEnded() {
  handlePlayerNext();
}

function cycleRepeatMode() {
  const order = ["off", "all", "one"];
  const i = order.indexOf(repeatMode.value);
  setRepeat(order[(i + 1) % order.length]);
}

function toggleShuffle() {
  if (queueStoreIds.value.length < 2) return;
  const wasOn = shuffleOn.value;
  storeToggleShuffle();
  if (!wasOn) shuffleQueueInPlaceKeepingCurrent();
}

/** Randomise the queue ids in place, keeping the current track at pos 0. */
function shuffleQueueInPlaceKeepingCurrent() {
  const ids = queueStoreIds.value;
  const len = ids.length;
  if (len < 2) return;
  const pos = queueStorePos.value;
  if (pos < 0 || pos >= len) return;
  const cur = ids[pos];
  const rest = ids.filter((_, i) => i !== pos);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = rest[i]; rest[i] = rest[j]; rest[j] = t;
  }
  // Reseed the store directly with the reshuffled ids.
  const tracks = [cur, ...rest].map((id) => getTrack(id)).filter(Boolean);
  if (tracks.length === len) replaceQueue(tracks, 0);
}

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
