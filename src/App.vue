<script setup>
import { ref, shallowRef, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { legacyAlbumLikeRowToAlbumData } from "./persistence/legacyAlbumLikeRowToAlbumData.js";
import { restoreSession } from "./rutracker/auth.js";
import { markRutrackerHadAccount, clearRutrackerHadAccount } from "./rutracker/accountHint.js";
import { resolveMirrorIfNeeded, withTimeout } from "./rutracker/config.js";
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
  searchResultsEpoch,
  searchResolving,
  searchResolved,
  searchProviderQuery,
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
import { useAppUpdate } from "./composables/useAppUpdate.js";
import { useTrayPreference } from "./composables/useTrayPreference.js";
import { useTheme } from "./composables/useTheme.js";
import { useMouseSideButtonNav } from "./composables/useMouseSideButtonNav.js";
import { useAchievements } from "./composables/useAchievements.js";
import { useDownloads } from "./composables/useDownloads.js";
import { useNavStack } from "./composables/useNavStack.js";
import { useMagnetDialog } from "./composables/useMagnetDialog.js";
import { useAlbumPreview } from "./composables/useAlbumPreview.js";
import { useTorrentDetail } from "./composables/useTorrentDetail.js";
import { usePlaylistCrud } from "./composables/usePlaylistCrud.js";
import { useSearchUI } from "./composables/useSearchUI.js";
import { useDownloadProgress } from "./composables/useDownloadProgress.js";
import { loadPersistedState } from "./persistence/bootstrap.js";
import {
  likedTracks as libraryLikedTracks,
  likedAlbums as libraryLikedAlbums,
  likedTrackIds as libraryLikedTrackIds,
  likedAlbumIds as libraryLikedAlbumIds,
  likedAt as libraryLikedAt,
  toggleLikeTrack,
  toggleLikeAlbum as libToggleLikeAlbum,
  isAlbumLiked as libIsAlbumLiked,
  playlists as libraryPlaylists,
  getPlaylistTracks,
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
  allowAutoplay,
  seedQueueFromSnapshot,
} from "./stores/queue.js";
import { getTrack } from "./stores/entities.js";
import { torrentFileB64ForTrack, streamUrl, magnetListFiles } from "./torrent/api.js";
import { releaseTorrentStreamUrl, torrentPrepareCancel } from "./torrent/torrentSession.js";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { clearDiscordPresence } from "./discordPresence.js";

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
import OnboardingDialog from "./components/shell/OnboardingDialog.vue";
import HomeView from "./components/home/HomeView.vue";
import { openAppDebugWindow } from "./appDebugWindow.js";
import { loadRecentHistory, addToRecentHistory, removeFromRecentHistory } from "./lib/recentHistory.js";
import { loadSearchHistory, removeFromSearchHistory } from "./lib/searchHistory.js";
import PlaylistView from "./components/playlist/PlaylistView.vue";
import AchievementToast from "./components/shell/AchievementToast.vue";
import UpdateDialog from "./components/shell/UpdateDialog.vue";
import SystemIcon from "./components/shared/SystemIcon.vue";

// Queue + repeat/shuffle are owned by `stores/queue`. Auto-persist is handled
// inside the store. App.vue reads derived values and delegates mutations.
const nowPlaying = nowPlayingTrackFromStore;  // alias used by useAppDebug
const { appDebugEnabled } = useAppDebug({ view, queuePos: queueStorePos, nowPlaying });

// playbackQueueTracks moved into queue store as `queueTracks`; Player.vue
// reads it directly without a prop.

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

/**
 * Autoplay-suppression flag is owned by the queue store. `seedFromSnapshot`
 * sets it to true on cold start when the restored queue is non-empty; this
 * alias just surfaces the "allow" toggle under its historical name for the
 * handlers that call it.
 */
function allowPlayerAutoplay() {
  allowAutoplay();
}

// ── Theme ─────────────────────────────────────────────────────────────────────
const { theme, setTheme } = useTheme();

// ── Tray preference ───────────────────────────────────────────────────────────
const { closeTray, setCloseTray } = useTrayPreference();
const DISCORD_PRESENCE_ENABLED_KEY = "neegde.discordPresence.enabled";
const discordPresenceEnabled = ref(localStorage.getItem(DISCORD_PRESENCE_ENABLED_KEY) === "1");

function handleDiscordPresenceEnabledChange(enabled) {
  const next = Boolean(enabled);
  discordPresenceEnabled.value = next;
  localStorage.setItem(DISCORD_PRESENCE_ENABLED_KEY, next ? "1" : "0");
  if (!next) void clearDiscordPresence();
}

// ── Auto-update ───────────────────────────────────────────────────────────────
const {
  updateVersion,
  updateDate,
  updateNotesHtml,
  dialogOpen: updateDialogOpen,
  installing: updateInstalling,
  installProgress: updateInstallProgress,
  installError: updateInstallError,
  installUpdate,
  dismissUpdate,
  showUpdateDialog,
} = useAppUpdate();

// ── Onboarding ────────────────────────────────────────────────────────────────
const ONBOARDING_DONE_KEY = "neegde.onboarding.v1.done";
const isFirstLaunch = !localStorage.getItem(ONBOARDING_DONE_KEY);

// On first launch we skip the loading splash entirely — otherwise its typewriter
// animation flashes for a moment before being replaced by the onboarding dialog.
const restoringSession = ref(!isFirstLaunch);
// splashAnimDone: true immediately on first launch (no splash shown), otherwise
// set to true when AppSplash emits "complete" (typewriter + dots have finished).
const splashAnimDone = ref(isFirstLaunch);
const splashVisible = computed(() => restoringSession.value || !splashAnimDone.value);
function handleSplashComplete() { splashAnimDone.value = true; }
const showOnboarding = ref(isFirstLaunch);

function dismissOnboarding() {
  showOnboarding.value = false;
  localStorage.setItem(ONBOARDING_DONE_KEY, "1");
}

function handleOnboardingSlskConnected(username) {
  setSlskConnected(username);
}

/** If restore hangs (сеть/DNS), не оставляем UI в вечном «подключении». */
const RESTORE_UI_MAX_MS = 5_000;

/** Cap `rutracker_restore_session` so a wedged request cannot block shell forever. */
const RESTORE_SESSION_BUDGET_MS = 20_000;

onMounted(async () => {
  const unblockTimer = window.setTimeout(() => {
    restoringSession.value = false;
  }, RESTORE_UI_MAX_MS);

  // v2 persistence bootstrap: migrate legacy rows once, seed new stores.
  // Runs before anything else so Track ids referenced by likes / playlists /
  // queue snapshots are already resolvable through the entities registry.
  const persisted = loadPersistedState();
  seedLikesFromSnapshot(persisted.likes);
  seedPlaylistsFromSnapshot(persisted.playlists);
  seedQueueFromSnapshot(persisted.queue);

  try {
    await resolveMirrorIfNeeded();
    const raw = await withTimeout(
      restoreSession(),
      RESTORE_SESSION_BUDGET_MS
    );
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
    window.__neegde_dev_show_onboarding = () => { showOnboarding.value = true; };
  }
  window.clearTimeout(unblockTimer);
  restoringSession.value = false;

  // Deep link: app already running (neegde://torrent/...)
  onOpenUrl((urls) => { if (urls?.[0]) void handleDeepLink(urls[0]); });
  // Deep link: cold start — URL passed at launch
  getCurrent().then((urls) => { if (urls?.[0]) void handleDeepLink(urls[0]); }).catch(() => {});
});

onUnmounted(() => {
  if (typeof unlistenSlskDisconnected === "function") {
    unlistenSlskDisconnected();
    unlistenSlskDisconnected = null;
  }
});

const handleThemeChange = setTheme;

// ── Auth ──────────────────────────────────────────────────────────────────────
// Reactive state lives in src/stores/auth.js. Only RT session restore and SLSK
// auto-login side-effects run here.

// Throttles auto-reconnect on `soulseek-disconnected` so a flapping server (or
// the rare race where an old session emits a stale event right after manual
// re-login) can't pin us into a relogin loop.
const SLSK_RECONNECT_COOLDOWN_MS = 5000;
let slskReconnecting = false;
let slskLastReconnectAt = 0;
let unlistenSlskDisconnected = null;

/**
 * Re-login to SoulSeek using saved credentials. Used both at app start (when no
 * live session is reported by the backend) and when the backend emits
 * `soulseek-disconnected` for a previously live session.
 *
 * Returns:
 *   Resolves once the relogin attempt finished. Failures fall back to
 *   `setSlskDisconnected()` so the UI shows the real state.
 */
async function tryAutoLoginSoulseek() {
  if (slskReconnecting) return;
  const now = Date.now();
  if (now - slskLastReconnectAt < SLSK_RECONNECT_COOLDOWN_MS) return;
  slskReconnecting = true;
  slskLastReconnectAt = now;
  const creds = await soulseekLoadCredentials().catch(() => null);
  if (!creds) {
    slskReconnecting = false;
    return;
  }
  const [username, password] = creds;
  const result = await soulseekLogin(username, password).catch(() => null);
  if (result?.success) {
    setSlskConnected(result.username);
  } else {
    setSlskDisconnected();
  }
  slskReconnecting = false;
}

onMounted(async () => {
  const status = await soulseekStatus().catch(() => null);
  if (status?.connected) {
    setSlskConnected(status.username);
  } else {
    await tryAutoLoginSoulseek();
  }

  // Backend emits `soulseek-disconnected` when the server connection or peer
  // listener of a live session terminates (idle kick, NAT timeout, sleep/wake).
  // Without this listener the session would silently hang and search would
  // return zero hits until the user manually re-logged in.
  unlistenSlskDisconnected = await listen("soulseek-disconnected", () => {
    setSlskDisconnected();
    void tryAutoLoginSoulseek();
  }).catch(() => null);
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

// ── Playlist handlers ──────────────────────────────────────────────────────

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

// Late-bound history-recording playlist opener. `useNavStack` runs further
// down (it depends on torrent-detail refs), so this ref is set to a no-op
// during construction and reassigned to the real `navigateToTopLevelView`
// once the nav stack is wired. Same indirection trick used by the snapshot
// callbacks below — see torrentDetailOpts comment.
let onOpenPlaylistRef = (_id) => {};
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
} = usePlaylistCrud({
  currentPlaylistId,
  view,
  resolveTrackFromPayload,
  onOpenPlaylist: (id) => onOpenPlaylistRef(id),
});

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
  if (currentPlaylistId.value) handleRemoveTrackFromPlaylist(currentPlaylistId.value, trackId);
}

function onDeleteCurrentPlaylist() {
  if (currentPlaylistId.value) handleDeletePlaylist(currentPlaylistId.value);
}

function onRenameCurrentPlaylist(newName) {
  if (currentPlaylistId.value) handleRenamePlaylist(currentPlaylistId.value, newName);
}

function handlePlayPlaylist(startIdx) {
  const tracks = currentPlaylistTracks.value;
  if (!tracks.length) return;
  allowPlayerAutoplay();
  replaceQueue(tracks, Math.max(0, Math.min(startIdx ?? 0, tracks.length - 1)));
}

// Album / torrent handlers moved into useTorrentDetail (see setup above).

// ── Search ────────────────────────────────────────────────────────────────────
// Reactive surface lives in src/stores/search.js. The useSearchUI composable
// owns the UI-local bits (input text, home-vs-recent toggle, per-peer filter)
// plus the `handleSearch` / `handleRevertToRaw` wrappers. The reset callback
// captures `selected` / `files` / `torrentCover` / nav stacks declared below
// by useTorrentDetail / useNavStack — JS closures resolve those lazily at
// callback-invocation time, so declaration order is fine.
const {
  searchQuery,
  homeSearchActive,
  slskPeerBrowseUser,
  loading,
  hasSearchResults,
  error,
  handleSearch,
  handleRevertToRaw,
  handleSearchCandidate,
} = useSearchUI({
  resetViewForSearch: () => {
    selected.value = null;
    files.value = [];
    torrentCover.value = null;
    currentAlbum.value = null;
    navForwardStack.value = [];
    navBackStack.value = [];
    view.value = "home";
  },
  authFlags: () => ({
    rtLoggedIn: rtLoggedIn.value,
    slskConnected: slskConnected.value,
  }),
  searchHistory,
});
const searchResultsTab = ref("tracks");

// ── Torrent / Album detail (state + handlers) ──────────────────────────────
// Two composables share a few refs: `useTorrentDetail` owns the selected
// torrent / current Album state, `useNavStack` owns back/forward history.
// They're wired via shared backStack/forwardStack refs + late-bound snapshot
// getters so torrent-detail handlers can push nav snapshots built by
// useNavStack (which itself reads torrent state).

const mainRef = ref(null);

const navBackStack     = ref([]);
const navForwardStack  = ref([]);
// Late-bound "what screen is showing right now?" callback — points at
// useNavStack's `snapshotCurrentScreen` once it's constructed below.
// During the brief window between this declaration and the assignment
// further down the file, the placeholder returns a generic search entry
// (no nav events fire that early in the lifecycle).
let navSnapCurrentScreenRef = () => ({ type: "search" });

// Mutable options object — we re-assign `downloadOverlayExpanded` + `downloadProgress`
// after useDownloads runs so useTorrentDetail's handlers can write to the real refs.
const torrentDetailOpts = {
  backStack: navBackStack,
  forwardStack: navForwardStack,
  snapshotCurrentScreen: () => navSnapCurrentScreenRef(),
  recentHistory,
  allowPlayerAutoplay,
  openTorrentFromPlayer: (payload) => handleOpenTorrentFromPlayer(payload),
  downloadOverlayExpanded: ref(false),  // placeholder — replaced below
  downloadProgress: ref(null),          // placeholder — replaced below
};

const {
  selected,
  torrentMagnet,
  torrentCover,
  files,
  currentAlbum,
  loadingFiles,
  torrentFilesBeforeAlbumPreview,
  torrentSelectedBeforeAlbumPreview,
  currentAlbumLiked,
  handleSelect,
  handleSelectLegacyTopic,
  handlePlay,
  handlePlayAll,
  handlePlayAlbum,
  handleAddToQueueFromTorrent,
  handleOpenTorrentSourceFromView,
  handleAlbumPlayAll,
  handleAlbumToggleLike,
  handleAlbumDownloadAll,
  makeTrackFromFile,
  tracksFromFiles,
} = useTorrentDetail(torrentDetailOpts);

const {
  forwardStack,
  backStack,
  snapshotCurrentScreen,
  pushCurrentScreenToForwardStack,
  navigateToTopLevelView,
  handleBack,
  handleForwardNav,
  handleNavBack,
} = useNavStack({
  selected, files, torrentMagnet, torrentCover,
  torrentFilesBeforeAlbumPreview, torrentSelectedBeforeAlbumPreview,
  currentAlbum,
  view, returnView, currentPlaylistId,
  searchQuery, searchEntities, slskPeerBrowseUser, searchResultsTab, error,
  mainRef,
  backStack: navBackStack,
  forwardStack: navForwardStack,
});

// Late-bind the current-screen snapshot into useTorrentDetail's /
// useMagnetDialog's closures, plus the playlist nav callback.
navSnapCurrentScreenRef = snapshotCurrentScreen;
onOpenPlaylistRef = (id) => navigateToTopLevelView("playlist", id);

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

// Swap in the real download overlay refs so useTorrentDetail's
// handleAlbumDownloadAll writes to the proper shared state.
torrentDetailOpts.downloadOverlayExpanded = downloadOverlayExpanded;
torrentDetailOpts.downloadProgress = downloadProgress;

useDownloadProgress({ downloadProgress, downloadOverlayExpanded });

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
  for (const id of libraryLikedAlbumIds.value) {
    out[id] = {
      id,
      type: "album",
      addedAt: libraryLikedAt.value.get(id) ?? 0,
    };
  }
  return out;
});

/** Состояние воспроизведения из плеера — подсветка и анимация в списках. */
const playerPlaying = ref(true);

const discordPresencePreviewTitle = computed(() => {
  const t = nowPlaying.value;
  if (!t) return "Трек";
  const ttl = typeof t.title === "string" ? t.title.trim() : "";
  if (ttl) return ttl;
  return trackDisplayBasename(t.fileName ?? "Трек");
});

const discordPresencePreviewSubtitle = computed(() => {
  const t = nowPlaying.value;
  if (!t) return "Исполнитель";
  const artist = typeof t.artist === "string" ? t.artist.trim() : "";
  if (artist) return artist;
  return extractTrackArtist(t.albumTitle, null, null, null) || "Неизвестный исполнитель";
});

const discordPresencePreviewPlaying = computed(
  () => Boolean(discordPresenceEnabled.value && nowPlaying.value && playerPlaying.value),
);

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
  const n = libraryLikedTrackIds.value.size + libraryLikedAlbumIds.value.size;
  _handleAchievementsOptInChange(enabled, n);
}

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
  // Album-preview drill-down inside an open torrent is poppable independently
  // of the cross-screen back stack — the first Back press exits the preview.
  if (torrentFilesBeforeAlbumPreview.value) return true;
  return backStack.value.length > 0;
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
  snapshotCurrentScreen,
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
/** Play a single Track entity directly from search results. */
function handlePlaySlskTrack(track) {
  if (!isTrack(track)) return;
  allowPlayerAutoplay();
  playTrackNow(track);
}

/** SLSK track-row click → toggle like via the library store. */
function handleLikeSlskTrack(track) {
  if (!isTrack(track)) return;
  toggleLikeTrack(track);
}

// makeTrackFromFile / tracksFromFiles / handlePlay / handlePlayAll /
// handlePlayAlbum / handleAddToQueueFromTorrent moved into useTorrentDetail.

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
 * Legacy toggle-like bridge — consumed by TorrentView (track / album / torrent
 * row shape) and Player. Resolves a Track and/or v2 `AlbumData` and delegates
 * to the library store.
 */
function handleToggleLike(payload) {
  if (!payload) return;
  const before =
    libraryLikedTrackIds.value.size + libraryLikedAlbumIds.value.size;
  if (payload.type === "album") {
    const album = legacyAlbumLikeRowToAlbumData(payload);
    if (!album) return;
    libToggleLikeAlbum(album);
    recordLikeChange(
      libraryLikedTrackIds.value.size + libraryLikedAlbumIds.value.size,
      before,
    );
    return;
  }
  const track = resolveTrackFromPayload(payload);
  if (!track) return;
  toggleLikeTrack(track);
  recordLikeChange(
    libraryLikedTrackIds.value.size + libraryLikedAlbumIds.value.size,
    before,
  );
}

const { handleOpenAlbumPreview, applyAlbumScopeForTrack } = useAlbumPreview({
  selected, files,
  torrentFilesBeforeAlbumPreview, torrentSelectedBeforeAlbumPreview,
  mainRef,
});

/**
 * Clears SoulSeek peer-only filter on search results.
 */
function clearSlskPeerBrowseUser() {
  slskPeerBrowseUser.value = null;
}

// handleOpenTorrentSourceFromView moved into useTorrentDetail.

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
  // Record the previous screen (Likes / playlist / search / open album)
  // before swapping to the peer-filtered search view.
  backStack.value.push(snapshotCurrentScreen());
  forwardStack.value = [];
  slskPeerBrowseUser.value = u;
  searchQuery.value = u;
  view.value = "home";
  selected.value = null;
  files.value = [];
  torrentMagnet.value = "";
  torrentCover.value = null;
  await handleSearch(u);
}

function handleSearchArtist(artist) {
  const trimmed = artist?.trim();
  if (!trimmed) return;
  // Artist click from the player is a navigation event — record current
  // screen so Back returns to wherever the user was (open album, Likes,
  // a different search query, etc).
  backStack.value.push(snapshotCurrentScreen());
  forwardStack.value = [];
  searchQuery.value = trimmed;
  appDebugLog("search", `artist filter: "${trimmed}"`);
  void handleSearch(trimmed);
}


/**
 * Opens a liked album in the main torrent view (RuTracker scope or SoulSeek peer).
 *
 * Args:
 *     album: Registered `Album` instance from the library store.
 */
function handleOpenLikedAlbum(album) {
  if (!album) return;
  resetSearchStateForHomeLibraryNav();
  currentAlbum.value = null;
  const data = typeof album.toJSON === "function" ? album.toJSON() : album;
  const src0 = data.sources?.[0];
  if (src0?.kind === "rutracker" && src0.refs?.topicId) {
    const topicId = String(src0.refs.topicId);
    const magnet = src0.raw?.details?.magnet ?? "";
    let albumDirPath = src0.refs.rootPath ?? null;
    if (albumDirPath === undefined || albumDirPath === "") {
      const id = String(data.id ?? "");
      if (id.startsWith("album:")) {
        const parts = id.split(":");
        if (parts.length >= 4) {
          const tail = parts.slice(3).join(":");
          albumDirPath = tail === "root" || tail === "" ? null : tail;
        }
      }
    } else if (albumDirPath === "root") {
      albumDirPath = null;
    }
    let fileIdx = 0;
    const firstTid = data.trackIds?.[0];
    if (typeof firstTid === "string" && firstTid.startsWith("rt:track:")) {
      const mm = firstTid.match(/^rt:track:[^:]+:(\d+)$/);
      if (mm) fileIdx = parseInt(mm[1], 10);
    }
    handleOpenTorrentFromPlayer({
      source: "rutracker",
      torrentId: topicId,
      torrentName: data.title ?? "",
      magnet,
      artist: data.artist ?? null,
      fileIdx,
      albumDirPath,
      seeders: data.seeders ?? "?",
    });
    return;
  }
  if (src0?.kind === "soulseek" && src0.refs?.slskUsername) {
    void handleNavigateSoulseekPeer(String(src0.refs.slskUsername));
    return;
  }
}

function handleOpenTorrentFromPlayer(track) {
  if (!track) return;
  if (track.source === "soulseek") {
    if (track.slskUsername) void handleNavigateSoulseekPeer(track.slskUsername);
    return;
  }
  if (!track.torrentId && !track.magnet) return;
  if (selected.value?.id === track.torrentId) {
    view.value = "home";
    if (!torrentFilesBeforeAlbumPreview.value) {
      applyAlbumScopeForTrack(track.fileIdx, track.albumDirPath ?? null);
    }
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
    return;
  }
  // Record the screen the user was on (Likes / playlist / search / open
  // torrent / album) BEFORE we flip view to home. Without this, opening a
  // liked album from Likes would push a stale empty-search snapshot and
  // Back would land on home instead of returning to Likes.
  backStack.value.push(snapshotCurrentScreen());
  forwardStack.value = [];
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
 * Sidebar Home button.
 *
 * Two distinct intents folded into one button:
 *   1. From any non-home screen → cross-screen back/forward navigation
 *      records the switch (history-preserving like Spotify's sidebar).
 *   2. Already on home → "clean home" affordance: clears search, open
 *      torrent / album, and the entire history stack so the user gets
 *      a fresh start. This is opinionated UX that diverges from Spotify
 *      but is the established neegde behavior.
 */
function handleSidebarHome() {
  if (view.value !== "home") {
    navigateToTopLevelView("home");
    return;
  }
  if (!homeSearchActive.value && !selected.value && !currentAlbum.value) {
    if (mainRef.value) mainRef.value.scrollTo(0, 0);
    return;
  }
  searchQuery.value = "";
  void handleSearch("");
  torrentMagnet.value = "";
  torrentCover.value = null;
  currentAlbum.value = null;
  forwardStack.value = [];
  backStack.value = [];
  if (mainRef.value) mainRef.value.scrollTo(0, 0);
}

/** Sidebar Likes button — history-recording navigation. */
function handleSidebarLikes() {
  navigateToTopLevelView("likes");
}

/** Sidebar Settings button — history-recording navigation. */
function handleSidebarSettings() {
  navigateToTopLevelView("settings");
}

/** Sidebar playlist click — history-recording navigation. */
function handleSidebarOpenPlaylist(id) {
  navigateToTopLevelView("playlist", id);
}

useMouseSideButtonNav({
  canGoBack: navCanGoBack,
  canGoForward: computed(() => forwardStack.value.length > 0),
  onBack: handleNavBack,
  onForward: handleForwardNav,
});
</script>

<template src="./App.html"></template>
