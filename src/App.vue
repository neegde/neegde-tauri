<script setup>
import { ref, computed, watch } from "vue";
import { isAudio, basename } from "./utils.js";
import { MOCK_RESULTS, MOCK_FILES_MAP, MOCK_FILES_DEFAULT } from "./mockData.js";

import SearchBar from "./components/SearchBar.vue";
import Results from "./components/Results.vue";
import TorrentView from "./components/TorrentView.vue";
import LikesView from "./components/LikesView.vue";
import Player from "./components/Player.vue";
import LoginPanel from "./components/LoginPanel.vue";
import AppAuthPanel from "./components/AppAuthPanel.vue";

// ── Auth ──────────────────────────────────────────────────────────────────────
const rtLoggedIn = ref(false);
const appUser = ref(null);
const authPanelOpen = ref(false);

// ── View ──────────────────────────────────────────────────────────────────────
const view = ref("search");
const returnView = ref("search");

// ── Search ────────────────────────────────────────────────────────────────────
const results = ref([]);
const loading = ref(false);
const error = ref(null);

// ── Torrent ───────────────────────────────────────────────────────────────────
const selected = ref(null);
const torrentMagnet = ref("");
const files = ref([]);
const loadingFiles = ref(false);

// ── Likes ─────────────────────────────────────────────────────────────────────
const likes = ref({});

// ── Queue ─────────────────────────────────────────────────────────────────────
const queue = ref([]);
const queuePos = ref(0);
const nowPlaying = computed(() => queue.value[queuePos.value] ?? null);

// ── Computed ──────────────────────────────────────────────────────────────────
const likesCount = computed(() => Object.keys(likes.value).length);
const showRtLogin = computed(() => !rtLoggedIn.value && !appUser.value);
const mainRef = ref(null);

watch(
  () => selected.value?.id,
  (newId) => {
    if (newId && mainRef.value) mainRef.value.scrollTo(0, 0);
  }
);

// ── Handlers ──────────────────────────────────────────────────────────────────
function handleLogin(_username, _password) {
  // Mock: instant success
  rtLoggedIn.value = true;
  return { success: true };
}

function handleLogout() {
  rtLoggedIn.value = false;
  results.value = [];
  selected.value = null;
  queue.value = [];
}

function handleAppLogin(username, _password) {
  appUser.value = { username };
  authPanelOpen.value = false;
}

function handleAppRegister(_username, _password) {
  // stub
}

function handleAppLogout() {
  appUser.value = null;
  likes.value = {};
}

async function handleSearch(_query, _cat) {
  loading.value = true;
  error.value = null;
  results.value = [];
  selected.value = null;
  files.value = [];
  view.value = "search";

  await new Promise((r) => setTimeout(r, 700));
  loading.value = false;
  results.value = MOCK_RESULTS;
}

function handleSelect(torrent) {
  if (selected.value?.id === torrent.id) {
    selected.value = null;
    files.value = [];
    torrentMagnet.value = "";
    return;
  }
  selected.value = torrent;
  files.value = [];
  torrentMagnet.value = "mock-magnet";
  loadingFiles.value = true;

  setTimeout(() => {
    loadingFiles.value = false;
    files.value = MOCK_FILES_MAP[torrent.id] ?? MOCK_FILES_DEFAULT;
  }, 500);
}

function makeQueueItem(f, torrent, magnet) {
  return {
    magnet,
    fileIdx: f.origIdx,
    fileName: basename(f.path),
    torrentName: torrent?.name ?? "",
    torrentId: torrent?.id ?? "",
    source: torrent?.source ?? "rutracker",
  };
}

function handlePlay(fileIdx, _fileName) {
  const existing = queue.value.findIndex(
    (q) => q.fileIdx === fileIdx && q.magnet === torrentMagnet.value
  );
  if (existing !== -1) { queuePos.value = existing; return; }

  const audioFiles = files.value.filter((f) => isAudio(f.path));
  const clickedPos = audioFiles.findIndex((f) => f.origIdx === fileIdx);
  const startIdx = clickedPos !== -1 ? clickedPos : 0;

  queue.value = audioFiles.slice(startIdx).map((f) =>
    makeQueueItem(f, selected.value, torrentMagnet.value)
  );
  queuePos.value = 0;
}

function handlePlayAll() {
  const audioFiles = files.value.filter((f) => isAudio(f.path));
  if (!audioFiles.length) return;
  queue.value = audioFiles.map((f) =>
    makeQueueItem(f, selected.value, torrentMagnet.value)
  );
  queuePos.value = 0;
}

function handlePlayAlbum(albumFiles) {
  if (!albumFiles.length) return;
  queue.value = albumFiles.map((f) =>
    makeQueueItem(f, selected.value, torrentMagnet.value)
  );
  queuePos.value = 0;
}

function handleDownload(_fileIdx, _fileName) {
  // No backend — noop
}

function handleDownloadAll() {
  // No backend — noop
}

function handleDownloadAlbum(_albumFiles) {
  // No backend — noop
}

function handleToggleLike(like) {
  const next = { ...likes.value };
  if (next[like.id]) delete next[like.id];
  else next[like.id] = { ...like, addedAt: Date.now() };
  likes.value = next;
}

function handleOpenTorrentFromLike(like) {
  const artistMatch = like.torrentName?.match(/^(.+?)\s+[-–—]\s+/);
  const torrent = {
    id: like.torrentId,
    name: like.type === "album" ? (like.albumName || like.torrentName) : like.torrentName,
    source: like.source,
    seeders: "?",
    size: 0,
    category: "—",
    added: "—",
    fromLikes: true,
    artist: artistMatch ? artistMatch[1].trim() : "",
  };
  returnView.value = "likes";
  view.value = "search";
  selected.value = torrent;
  torrentMagnet.value = like.magnet ?? "mock-magnet";

  if (like.type === "album" && like.audioFiles?.length) {
    files.value = like.coverFile
      ? [...like.audioFiles, like.coverFile]
      : like.audioFiles;
    loadingFiles.value = false;
    return;
  }

  files.value = MOCK_FILES_MAP[like.torrentId] ?? MOCK_FILES_DEFAULT;
  loadingFiles.value = false;
}

function handlePlayFromLike(like) {
  const likedTracks = Object.values(likes.value)
    .filter((l) => l.type === "track")
    .sort((a, b) => b.addedAt - a.addedAt);
  const startIdx = Math.max(0, likedTracks.findIndex((l) => l.id === like.id));
  queue.value = likedTracks.slice(startIdx).map((l) => ({
    magnet: l.magnet,
    fileIdx: l.fileIdx,
    fileName: l.fileName,
    torrentName: l.torrentName,
    torrentId: l.torrentId,
    source: l.source,
  }));
  queuePos.value = 0;
}

function handlePlayAlbumFromLike(like) {
  if (!like.audioFiles?.length) return;
  queue.value = like.audioFiles.map((f) => ({
    magnet: like.magnet,
    fileIdx: f.origIdx,
    fileName: basename(f.path),
    torrentName: like.torrentName,
    torrentId: like.torrentId,
    source: like.source,
  }));
  queuePos.value = 0;
}

function handleNext() {
  if (queuePos.value < queue.value.length - 1) queuePos.value++;
  else { queue.value = []; queuePos.value = 0; }
}

function handlePrev() {
  queuePos.value = Math.max(0, queuePos.value - 1);
}

function navToSearch() {
  view.value = "search";
  selected.value = null;
  files.value = [];
  torrentMagnet.value = "";
  error.value = null;
}

function handleBack() {
  selected.value = null;
  files.value = [];
  torrentMagnet.value = "";
  if (returnView.value === "likes") {
    view.value = "likes";
    returnView.value = "search";
  }
}
</script>

<template>
  <div :class="['app', nowPlaying ? 'has-player' : '']">

    <!-- ── Sidebar ─────────────────────────────────────────────────── -->
    <aside class="sidebar">
      <div class="sidebar-logo">
        <div class="logo-text">Где слушаешь? <span class="logo-nigde">Нигде.</span></div>
      </div>

      <nav class="sidebar-nav">
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
          <span :class="['rt-dot', rtLoggedIn ? 'rt-dot-on' : 'rt-dot-off']" />
        </button>

        <div class="nav-label" style="margin-top: 16px">Библиотека</div>
        <button
          :class="['source-btn', view === 'likes' ? 'active' : '']"
          @click="view = view === 'likes' ? 'search' : 'likes'"
        >
          <span class="source-icon">♥</span>
          Мне нравится
          <span v-if="likesCount > 0" class="likes-badge">{{ likesCount }}</span>
        </button>
      </nav>

      <div v-if="showRtLogin" class="sidebar-login">
        <LoginPanel @login="handleLogin" />
      </div>

      <div v-if="rtLoggedIn" class="sidebar-bottom-rt">
        <button class="logout-btn" @click="handleLogout">Выйти из Rutracker</button>
      </div>

      <!-- App account block -->
      <div class="sidebar-account">
        <div v-if="appUser" class="account-info">
          <div class="account-avatar">{{ appUser.username[0].toUpperCase() }}</div>
          <div class="account-name">{{ appUser.username }}</div>
          <button class="account-logout-btn" title="Выйти" @click="handleAppLogout">↩</button>
        </div>
        <button v-else class="account-login-btn" @click="authPanelOpen = true">
          Войти в аккаунт
        </button>
      </div>
    </aside>

    <!-- ── Main ────────────────────────────────────────────────────── -->
    <div class="main-wrap" ref="mainRef">
      <div class="main-content">

        <LikesView
          v-if="view === 'likes'"
          :likes="Object.values(likes)"
          @toggle-like="handleToggleLike"
          @play="handlePlayFromLike"
          @play-album="handlePlayAlbumFromLike"
          @open-torrent="handleOpenTorrentFromLike"
        />

        <template v-else>
          <SearchBar
            :loading="loading"
            :show-categories="false"
            @search="handleSearch"
          />

          <p v-if="error && !loading" class="error-msg">{{ error }}</p>

          <!-- Onboarding -->
          <div v-if="showRtLogin && !results.length && !selected && !loading" class="onboarding">
            <div class="onboarding-card">
              <div class="onboarding-icon">🎵</div>
              <div class="onboarding-body">
                <div class="onboarding-title">Войдите в Rutracker</div>
                <div class="onboarding-desc">
                  Введите логин и пароль в боковой панели — поиск заработает сразу.
                  Лайки сохранятся только в этом браузере.
                </div>
              </div>
            </div>
            <div class="onboarding-card onboarding-card--dim">
              <div class="onboarding-icon">♥</div>
              <div class="onboarding-body">
                <div class="onboarding-title">Аккаунт — для библиотеки</div>
                <div class="onboarding-desc">
                  Войдите в аккаунт внизу слева, чтобы лайки сохранялись между
                  устройствами и сессиями.
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
            :now-playing-idx="nowPlaying?.fileIdx ?? null"
            :likes="likes"
            @play="handlePlay"
            @play-all="handlePlayAll"
            @play-album="handlePlayAlbum"
            @download-album="handleDownloadAlbum"
            @download="handleDownload"
            @download-all="handleDownloadAll"
            @toggle-like="handleToggleLike"
            @back="handleBack"
          />
        </template>

      </div>
    </div>

    <!-- ── Player ──────────────────────────────────────────────────── -->
    <Player
      v-if="nowPlaying"
      :key="`${nowPlaying.magnet}:${nowPlaying.fileIdx}`"
      :track="nowPlaying"
      :has-prev="queuePos > 0"
      :has-next="queuePos < queue.length - 1"
      @prev="handlePrev"
      @next="handleNext"
      @ended="handleNext"
      @close="queue = []; queuePos = 0"
    />

    <!-- ── App auth modal ──────────────────────────────────────────── -->
    <AppAuthPanel
      v-if="authPanelOpen"
      @login="handleAppLogin"
      @register="handleAppRegister"
      @close="authPanelOpen = false"
    />

  </div>
</template>
