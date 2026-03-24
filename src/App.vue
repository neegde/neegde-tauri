<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { isAudio, detectAlbums, orderedAudioFiles, trackDisplayBasename } from "./lib/utils.js";
import { trackCoverFileIdxForLike } from "./library/likesCover.js";
import { loadLikes, saveLikes } from "./library/libraryStorage.js";
import { restoreSession } from "./rutracker/auth.js";
import { resolveMirrorIfNeeded } from "./rutracker/config.js";
import { normalizeLoginStatus } from "./rutracker/sessionStatus.js";
import { searchMusic, getTorrentDetails, clearRutrackerCoverCache } from "./rutracker/search.js";
import { exportTorrentFiles } from "./torrent/torrentExport.js";

import SearchBar    from "./components/search/SearchBar.vue";
import Results      from "./components/search/Results.vue";
import TorrentView  from "./components/torrent/TorrentView.vue";
import LikesView    from "./components/likes/LikesView.vue";
import SettingsView from "./components/settings/SettingsView.vue";
import Player       from "./components/player/Player.vue";
import AppAuthPanel from "./components/shell/AppAuthPanel.vue";
import NavArrows    from "./components/shell/NavArrows.vue";
import DownloadProgressOverlay from "./components/shell/DownloadProgressOverlay.vue";

// ── Theme ─────────────────────────────────────────────────────────────────────
const theme = ref(localStorage.getItem("theme") || "dark");

const restoringSession = ref(true);

/** If restore hangs (сеть/DNS), не оставляем UI в вечном «подключении». */
const RESTORE_UI_MAX_MS = 20_000;

onMounted(async () => {
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
  finally {
    window.clearTimeout(unblockTimer);
    restoringSession.value = false;
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

// ── Search ────────────────────────────────────────────────────────────────────
const searchQuery = ref("");
const results = ref([]);
const loading = ref(false);
const error   = ref(null);

// ── Torrent ───────────────────────────────────────────────────────────────────
const selected      = ref(null);
const torrentMagnet = ref("");
const torrentCover  = ref(null);   // base64 data URL or null
const files         = ref([]);
const loadingFiles  = ref(false);

/** Полный список файлов раздачи до предпросмотра одного альбома (как из лайков). */
const torrentFilesBeforeAlbumPreview = ref(null);
const torrentSelectedBeforeAlbumPreview = ref(null);

/** Стек для кнопки «вперёд» (как в Spotify): снимки экранов при «назад». */
const forwardStack = ref([]);

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

// ── Queue ─────────────────────────────────────────────────────────────────────
const queue    = ref([]);
const queuePos = ref(0);
const nowPlaying = computed(() => queue.value[queuePos.value] ?? null);

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
const likesCount = computed(() => Object.keys(likes.value).length);
const mainRef    = ref(null);

const navCanGoBack = computed(() => {
  if (view.value !== "search") return false;
  if (torrentFilesBeforeAlbumPreview.value) return true;
  return !!selected.value;
});

watch(
  () => selected.value?.id,
  (newId) => { if (newId && mainRef.value) mainRef.value.scrollTo(0, 0); }
);

watch(
  () => view.value,
  (v) => {
    if (v === "settings" || v === "likes") forwardStack.value = [];
  }
);

// ── Handlers ──────────────────────────────────────────────────────────────────
function handleLogin(username, avatarUrl) {
  rtLoggedIn.value  = true;
  rtUsername.value  = username || null;
  rtAvatarUrl.value = avatarUrl || null;
}

function handleLogout() {
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
  clearRutrackerCoverCache();
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
  forwardStack.value = [];
  loading.value      = true;
  error.value        = null;
  results.value      = [];
  selected.value     = null;
  files.value        = [];
  torrentCover.value = null;
  view.value         = "search";
  try {
    results.value = await searchMusic(query.trim());
    if (!results.value.length) error.value = "Ничего не найдено.";
  } catch (e) {
    error.value = e?.toString?.() ?? "Ошибка поиска";
  } finally {
    loading.value = false;
  }
}

async function handleSelect(torrent) {
  torrentFilesBeforeAlbumPreview.value = null;
  torrentSelectedBeforeAlbumPreview.value = null;
  if (selected.value?.id === torrent.id) {
    forwardStack.value = [];
    selected.value = null; files.value = []; torrentMagnet.value = ""; torrentCover.value = null;
    return;
  }
  forwardStack.value = [];
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
  return {
    magnet,
    fileIdx:     f.origIdx,
    fileName:    trackDisplayBasename(f.path),
    torrentName: torrent?.name    ?? "",
    torrentId:   torrent?.id      ?? "",
    source:      torrent?.source  ?? "rutracker",
    coverFileIdx,
  };
}

function handlePlay(fileIdx) {
  const existing = queue.value.findIndex(
    (q) => q.fileIdx === fileIdx && q.magnet === torrentMagnet.value
  );
  if (existing !== -1) { queuePos.value = existing; return; }
  const audioFiles = orderedAudioFiles(files.value);
  const startIdx   = Math.max(0, audioFiles.findIndex((f) => f.origIdx === fileIdx));
  queue.value    = audioFiles.slice(startIdx).map((f) => makeQueueItem(f, selected.value, torrentMagnet.value, files.value));
  queuePos.value = 0;
}

function handlePlayAll() {
  const audioFiles = orderedAudioFiles(files.value);
  if (!audioFiles.length) return;
  queue.value = audioFiles.map((f) => makeQueueItem(f, selected.value, torrentMagnet.value, files.value));
  queuePos.value = 0;
}

function handlePlayAlbum(albumFiles) {
  if (!albumFiles.length) return;
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

  forwardStack.value = [];
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
  const likedTracks = Object.values(likes.value)
    .filter((l) => l.type === "track").sort((a, b) => b.addedAt - a.addedAt);
  const startIdx = Math.max(0, likedTracks.findIndex((l) => l.id === like.id));
  queue.value = likedTracks.slice(startIdx).map((l) => ({
    magnet: l.magnet, fileIdx: l.fileIdx, fileName: l.fileName,
    torrentName: l.torrentName, torrentId: l.torrentId, source: l.source,
    coverFileIdx: trackCoverFileIdxForLike(l, likes.value),
  }));
  queuePos.value = 0;
}

function handlePlayAlbumFromLike(like) {
  if (!like.audioFiles?.length) return;
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
  exportTorrentFiles(torrentMagnet.value, [origIdx], [label], (p) => {
    downloadProgress.value = p;
  });
}

function handleDownloadAll() {
  downloadOverlayExpanded.value = true;
  const audio = files.value.filter((f) => isAudio(f.path));
  const idxs = audio.map((f) => f.origIdx);
  const labels = audio.map((f) => trackDisplayBasename(f.path));
  exportTorrentFiles(torrentMagnet.value, idxs, labels, (p) => {
    downloadProgress.value = p;
  });
}

function handleDownloadAlbum(albumFiles) {
  downloadOverlayExpanded.value = true;
  const audio = (albumFiles ?? []).filter((f) => isAudio(f.path));
  const idxs = audio.map((f) => f.origIdx);
  const labels = audio.map((f) => trackDisplayBasename(f.path));
  exportTorrentFiles(torrentMagnet.value, idxs, labels, (p) => {
    downloadProgress.value = p;
  });
}

function handleNext() {
  if (queuePos.value < queue.value.length - 1) queuePos.value++;
  else { queue.value = []; queuePos.value = 0; }
}
function handlePrev() { queuePos.value = Math.max(0, queuePos.value - 1); }

function navToSearch() {
  forwardStack.value = [];
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
  if (selected.value) {
    forwardStack.value.push({
      type: "torrent",
      selected: { ...selected.value },
      files: [...files.value],
      magnet: torrentMagnet.value,
      cover: torrentCover.value,
      restoreLikesView: returnView.value === "likes",
    });
  }
  selected.value = null;
  files.value = [];
  torrentMagnet.value = "";
  torrentCover.value = null;
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
    if (snap.restoreLikesView) {
      returnView.value = "likes";
      view.value = "search";
    }
    selected.value = snap.selected;
    files.value = snap.files;
    torrentMagnet.value = snap.magnet;
    torrentCover.value = snap.cover;
    torrentFilesBeforeAlbumPreview.value = null;
    torrentSelectedBeforeAlbumPreview.value = null;
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
          <span v-if="likesCount > 0" class="likes-badge">{{ likesCount }}</span>
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
        title="Проверяем сохранённый вход в Rutracker"
      >
        <span class="spinner sidebar-rt-connecting-spinner" />
        <span class="sidebar-rt-connecting-label">Вход в Rutracker…</span>
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

        <!-- Settings view -->
        <SettingsView
          v-else-if="view === 'settings'"
          :rt-logged-in="rtLoggedIn"
          :rt-username="rtUsername"
          :rt-avatar-url="rtAvatarUrl"
          :restoring-session="restoringSession"
          :app-user="appUser"
          :theme="theme"
          @login="handleLogin"
          @logout="handleLogout"
          @app-logout="handleAppLogout"
          @open-auth="authPanelOpen = true"
          @theme-change="handleThemeChange"
        />

        <!-- Search view -->
        <template v-else>
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
      :has-prev="queuePos > 0"
      :has-next="queuePos < queue.length - 1"
      @prev="handlePrev"
      @next="handleNext"
      @ended="handleNext"
      @playing-change="playerPlaying = $event"
      @close="queue = []; queuePos = 0"
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
