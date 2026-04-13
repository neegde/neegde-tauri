<script setup>
import { ref, onMounted, onUnmounted, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { login, logout, restoreSession } from "../../rutracker/auth.js";
import { normalizeLoginStatus } from "../../rutracker/sessionStatus.js";
import {
  getMirror,
  setMirror,
  resetMirror,
  hasCustomMirror,
  DEFAULT_MIRROR,
  KNOWN_MIRRORS,
  MIRROR_MODE_AUTO,
  MIRROR_MODE_MANUAL,
  getMirrorMode,
  setMirrorMode,
  probeMirrorsNow,
} from "../../rutracker/config.js";
import {
  RT_HTTP_PROXY_PX1,
  RT_HTTP_PROXY_PX2,
  getHttpProxy,
  setHttpProxy,
  setRtHttpProxyCache,
  hasHttpProxyConfigured,
  probeHttpProxy,
} from "../../rutracker/proxyConfig.js";
import { clearRutrackerCoverCache } from "../../rutracker/search.js";
import EqualizerPanel from "./EqualizerPanel.vue";
import { openAppDebugWindow } from "../../appDebugWindow.js";
import {
  fetchLatestGithubRelease,
  compareSemver,
  normalizeVersionTag,
} from "../../githubReleaseCheck.js";
import appIconSrc from "../../assets/neegde-logo.png";
import vozduxanLogoSrc from "../../assets/vozduxan-logo.png";

const props = defineProps({
  rtLoggedIn:       Boolean,
  rtUsername:       { type: String, default: null },
  rtAvatarUrl:      { type: String, default: null },
  restoringSession: { type: Boolean, default: false },
  theme:            { type: String, default: "dark" },
  /** Полный журнал отладки приложения (UI, плеер, торрент-стриминг). */
  appDebugEnabled: { type: Boolean, default: false },
});

// avatar image error fallback
const avatarImgFailed = ref(false);

const emit = defineEmits([
  "login",
  "logout",
  "theme-change",
  "update:appDebugEnabled",
]);

/** Подставляется из `package.json` в `vite.config.js` (`define.__APP_VERSION__`). */
const appVersion = __APP_VERSION__;
/** Версия vozduxan из `vozduxan/CMakeLists.txt`, инжектится в `vite.config.js`. */
const vozduxanVersion = __VOZDUXAN_VERSION__;

/** URL GitHub API «последний релиз»; пусто, если в `package.json` нет `repository` с GitHub. */
const githubReleaseApiUrl = __GITHUB_RELEASES_LATEST_API__;
const githubProjectUrl = __GITHUB_PROJECT_URL__;
const telegramChannelUrl = __TELEGRAM_CHANNEL_URL__;

const releaseCheckState = ref(githubReleaseApiUrl ? "loading" : "idle");
const releaseRemoteTag = ref(null);
const releasePageUrl = ref(null);

const aboutStackEl = ref(null);
const aboutAppCardEl = ref(null);
const aboutVozCardEl = ref(null);
let aboutPairResizeObserver = null;

/**
 * Sets both «About» cards to the same height (the taller natural height).
 *
 * @returns {void}
 */
function syncAboutPairHeights() {
  const a = aboutAppCardEl.value;
  const b = aboutVozCardEl.value;
  const stack = aboutStackEl.value;
  if (!a || !b) return;
  if (aboutPairResizeObserver) {
    aboutPairResizeObserver.disconnect();
  }
  a.style.minHeight = "";
  b.style.minHeight = "";
  const ha = a.getBoundingClientRect().height;
  const hb = b.getBoundingClientRect().height;
  const h = Math.max(ha, hb);
  if (h > 0) {
    a.style.minHeight = `${h}px`;
    b.style.minHeight = `${h}px`;
  }
  requestAnimationFrame(() => {
    if (aboutPairResizeObserver && stack) {
      aboutPairResizeObserver.observe(stack);
    }
  });
}

/**
 * Fetches the latest GitHub release and compares it to `appVersion`.
 *
 * @returns {void}
 */
function runReleaseCheck() {
  if (!githubReleaseApiUrl) return;
  releaseCheckState.value = "loading";
  fetchLatestGithubRelease(githubReleaseApiUrl)
    .then((info) => {
      if (!info) {
        releaseCheckState.value = "none";
        releaseRemoteTag.value = null;
        releasePageUrl.value = null;
        return;
      }
      releaseRemoteTag.value = info.tagName;
      releasePageUrl.value = info.htmlUrl || null;
      const cur = normalizeVersionTag(appVersion);
      const remote = normalizeVersionTag(info.tagName);
      const cmp = compareSemver(cur, remote);
      if (cmp === 0) releaseCheckState.value = "latest";
      else if (cmp < 0) releaseCheckState.value = "outdated";
      else releaseCheckState.value = "ahead";
    })
    .catch(() => {
      releaseCheckState.value = "error";
    });
}

/**
 * Opens an HTTPS URL in the system browser (Tauri) or a new tab as fallback.
 *
 * @param {string} url - URL to open.
 * @returns {void}
 */
function openExternalUrl(url) {
  if (!url) return;
  openUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

// ── Rutracker login form ───────────────────────────────────────────────────────
const rtUsername = ref("");
const rtPassword = ref("");
const rtLoading  = ref(false);
const rtError    = ref(null);

async function handleRtLogin(e) {
  e.preventDefault();
  if (!rtUsername.value.trim() || !rtPassword.value) return;
  rtLoading.value = true;
  rtError.value   = null;
  try {
    const result = await login(rtUsername.value.trim(), rtPassword.value);
    if (result.success) {
      rtCredentialsHiddenUntilLogout.value = false;
      emit("login", result.username, result.avatar_url || null);
      rtUsername.value = "";
      rtPassword.value = "";
      avatarImgFailed.value = false;
    } else {
      rtError.value = result.error || "Ошибка входа";
    }
  } catch (err) {
    rtError.value = "Нет соединения — проверьте зеркало и интернет";
  } finally {
    rtLoading.value = false;
  }
}

async function handleRtLogout() {
  rtReconnectMsg.value = null;
  rtCredentialsHiddenUntilLogout.value = false;
  rtError.value = null;
  try { await logout(); } catch (_) { /* ignore */ }
  emit("logout", { forgetAccount: true });
}

const rtReconnectBusy = ref(false);
const rtReconnectMsg = ref(null);
/** После неуспеха переподключения скрываем текст и форму ввода до «Выйти из аккаунта» (или успешного входа). */
const rtCredentialsHiddenUntilLogout = ref(false);

/** Повторная проверка сохранённых cookies на сервере (без пароля). */
async function handleRtReconnect() {
  rtError.value = null;
  rtReconnectBusy.value = true;
  try {
    const raw = await restoreSession();
    const s = normalizeLoginStatus(raw);
    if (s.loggedIn) {
      rtReconnectMsg.value = null;
      rtCredentialsHiddenUntilLogout.value = false;
      emit("login", s.username, s.avatarUrl);
      avatarImgFailed.value = false;
    } else {
      emit("logout");
      rtCredentialsHiddenUntilLogout.value = true;
      rtReconnectMsg.value =
        "Сессия недействительна. Нажмите «Выйти из аккаунта», затем появится форма входа.";
    }
  } catch (e) {
    rtCredentialsHiddenUntilLogout.value = true;
    const t = e?.toString?.() ?? String(e);
    rtReconnectMsg.value =
      /сетев|network|timed out|dns/i.test(t)
        ? "Не удалось связаться с Rutracker — проверьте интернет и зеркало."
        : t;
  } finally {
    rtReconnectBusy.value = false;
  }
}

// ── Дополнительно ─────────────────────────────────────────────────────────────
const nerdOpen   = ref(false);
const mirrorMode = ref(MIRROR_MODE_MANUAL);
const mirrorSelect = ref(KNOWN_MIRRORS[0]);
const mirrorUrl  = ref("");
const mirrorSaved = ref(false);
const nerdProbeBusy = ref(false);
const nerdProbeError = ref(null);
/** Сохранённый режим (для кнопки «Обновить» после записи в localStorage). */
const persistedMirrorMode = ref(getMirrorMode());
/** Активное зеркало после сохранения / загрузки (для подписи). */
const activeMirrorDisplay = ref(getMirror());

function syncMirrorSelectFromStorage() {
  const m = getMirror();
  if (KNOWN_MIRRORS.includes(m)) {
    mirrorSelect.value = m;
  } else {
    mirrorSelect.value = "__custom__";
  }
  mirrorUrl.value = m;
}

function onMirrorSelectChange() {
  if (mirrorSelect.value !== "__custom__") {
    mirrorUrl.value = mirrorSelect.value;
  }
}

function hostLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

onMounted(() => {
  mirrorMode.value = getMirrorMode();
  persistedMirrorMode.value = getMirrorMode();
  syncMirrorSelectFromStorage();
  activeMirrorDisplay.value = getMirror();
  getHttpProxy()
    .then((url) => {
      proxySelect.value = proxyUrlToSelect(url);
    })
    .catch(() => {});
  if (githubReleaseApiUrl) runReleaseCheck();
  nextTick(() => {
    aboutPairResizeObserver = new ResizeObserver(() => {
      syncAboutPairHeights();
    });
    syncAboutPairHeights();
  });
  window.addEventListener("resize", syncAboutPairHeights);
});

onUnmounted(() => {
  window.removeEventListener("resize", syncAboutPairHeights);
  if (aboutPairResizeObserver) {
    aboutPairResizeObserver.disconnect();
    aboutPairResizeObserver = null;
  }
});

watch(releaseCheckState, () => {
  nextTick(() => syncAboutPairHeights());
});

watch(mirrorMode, (v) => {
  if (v === MIRROR_MODE_MANUAL) {
    syncMirrorSelectFromStorage();
  }
});

async function saveMirror() {
  nerdProbeError.value = null;
  try {
    if (mirrorMode.value === MIRROR_MODE_AUTO) {
      setMirrorMode(MIRROR_MODE_AUTO);
      nerdProbeBusy.value = true;
      const picked = await probeMirrorsNow();
      activeMirrorDisplay.value = picked;
    } else {
      setMirrorMode(MIRROR_MODE_MANUAL);
      const url =
        mirrorSelect.value === "__custom__"
          ? mirrorUrl.value.trim()
          : mirrorSelect.value;
      if (!url) {
        nerdProbeError.value = "Укажите адрес зеркала.";
        return;
      }
      setMirror(url);
      activeMirrorDisplay.value = getMirror();
    }
    clearRutrackerCoverCache();
    persistedMirrorMode.value = getMirrorMode();
    mirrorSaved.value = true;
    setTimeout(() => { mirrorSaved.value = false; }, 2000);
  } catch (e) {
    nerdProbeError.value =
      e?.toString?.() ?? "Не удалось подобрать зеркало";
  } finally {
    nerdProbeBusy.value = false;
  }
}

async function refreshAutoMirror() {
  if (getMirrorMode() !== MIRROR_MODE_AUTO) return;
  nerdProbeError.value = null;
  nerdProbeBusy.value = true;
  try {
    const picked = await probeMirrorsNow();
    activeMirrorDisplay.value = picked;
    clearRutrackerCoverCache();
  } catch (e) {
    nerdProbeError.value = e?.toString?.() ?? "Ошибка проверки";
  } finally {
    nerdProbeBusy.value = false;
  }
}

function doResetMirror() {
  resetMirror();
  mirrorMode.value = MIRROR_MODE_MANUAL;
  persistedMirrorMode.value = getMirrorMode();
  mirrorUrl.value = DEFAULT_MIRROR;
  mirrorSelect.value = DEFAULT_MIRROR;
  activeMirrorDisplay.value = DEFAULT_MIRROR;
  clearRutrackerCoverCache();
  mirrorSaved.value = true;
  setTimeout(() => { mirrorSaved.value = false; }, 2000);
}

const PROXY_SELECT_NONE = "none";
const PROXY_SELECT_PX1 = "px1";
const PROXY_SELECT_PX2 = "px2";

/**
 * Maps persisted proxy URL to the nerd select value.
 *
 * @param {string | null | undefined} url
 * @returns {string}
 */
function proxyUrlToSelect(url) {
  if (!url) return PROXY_SELECT_NONE;
  if (url === RT_HTTP_PROXY_PX1) return PROXY_SELECT_PX1;
  if (url === RT_HTTP_PROXY_PX2) return PROXY_SELECT_PX2;
  return PROXY_SELECT_NONE;
}

/**
 * @param {string} sel
 * @returns {string | null}
 */
function proxySelectToUrl(sel) {
  if (sel === PROXY_SELECT_PX1) return RT_HTTP_PROXY_PX1;
  if (sel === PROXY_SELECT_PX2) return RT_HTTP_PROXY_PX2;
  return null;
}

const proxySelect = ref(PROXY_SELECT_NONE);
const proxySaved = ref(false);
const proxySaveBusy = ref(false);
const proxySaveError = ref(null);
const proxyProbeBusy = ref(false);
const proxyProbeOk = ref(false);
const proxyProbeError = ref(null);

/**
 * @returns {string}
 */
function rutrackerProbeTargetUrl() {
  const base = getMirror().replace(/\/$/, "");
  return `${base}/forum/index.php`;
}

/**
 * GETs the configured mirror's `forum/index.php` via the proxy preset currently selected in UI.
 *
 * @returns {Promise<void>}
 */
async function probeProxy() {
  proxyProbeError.value = null;
  proxyProbeOk.value = false;
  proxyProbeBusy.value = true;
  try {
    const url = proxySelectToUrl(proxySelect.value);
    await probeHttpProxy(url, rutrackerProbeTargetUrl());
    proxyProbeOk.value = true;
    window.setTimeout(() => {
      proxyProbeOk.value = false;
    }, 5000);
  } catch (e) {
    proxyProbeError.value = e?.toString?.() ?? String(e);
  } finally {
    proxyProbeBusy.value = false;
  }
}

async function saveProxy() {
  proxySaveError.value = null;
  proxyProbeError.value = null;
  proxyProbeOk.value = false;
  proxySaveBusy.value = true;
  try {
    const url = proxySelectToUrl(proxySelect.value);
    await setHttpProxy(url);
    setRtHttpProxyCache(url || "");
    proxySaved.value = true;
    setTimeout(() => {
      proxySaved.value = false;
    }, 2000);
  } catch (e) {
    proxySaveError.value = e?.toString?.() ?? String(e);
  } finally {
    proxySaveBusy.value = false;
  }
}

// ── Память и кэш (диагностика) ───────────────────────────────────────────────
const nerdDiagLoading = ref(false);
const nerdDiagError = ref(null);
/** @type {import('vue').Ref<null | {
 *   residentMemoryBytes: number | null,
 *   appDataPath: string,
 *   streamCacheBytes: number,
 *   coverTorrentCacheBytes: number,
 *   totalAppDataBytes: number,
 *   streamCacheLimitBytes: number,
 *   streamCacheTtlSecs: number,
 *   deferWritesMb: number,
 *   streamingTorrentCount: number,
 *   streamCacheDirLabel: string,
 *   coverCacheDirLabel: string,
 * }>} */
const nerdDiag = ref(null);

const cacheFormMaxMib = ref(500);
const cacheFormTtlMinutes = ref(60);
const cacheSaveBusy = ref(false);
const cacheSaveOk = ref(false);
const cacheClearBusy = ref(false);
const cacheSettingsError = ref(null);

function formatBytes(n) {
  if (n == null || Number(n) === 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГиБ", "ТиБ"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const rounded = i === 0 ? String(Math.round(v)) : v < 10 && i > 0 ? v.toFixed(1) : String(Math.round(v));
  return `${rounded} ${units[i]}`;
}

function formatTtlHuman(secs) {
  if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600} ч`;
  if (secs >= 60 && secs % 60 === 0) return `${secs / 60} мин`;
  return `${secs} с`;
}

async function loadNerdDiagnostics() {
  nerdDiagError.value = null;
  cacheSettingsError.value = null;
  nerdDiagLoading.value = true;
  try {
    nerdDiag.value = await invoke("get_nerd_diagnostics");
  } catch (e) {
    nerdDiagError.value = e?.toString?.() ?? String(e);
    nerdDiag.value = null;
  }
  try {
    const settings = await invoke("get_user_cache_settings");
    cacheFormMaxMib.value = Math.round(settings.streamCacheMaxBytes / (1024 * 1024));
    cacheFormTtlMinutes.value = Math.round(settings.streamCacheTtlSecs / 60);
  } catch (e) {
    cacheSettingsError.value = e?.toString?.() ?? String(e);
  } finally {
    nerdDiagLoading.value = false;
  }
}

async function saveCacheSettings() {
  const mib = Number(cacheFormMaxMib.value);
  const min = Number(cacheFormTtlMinutes.value);
  if (!Number.isFinite(mib) || mib < 50 || mib > 8192) {
    cacheSettingsError.value = "Лимит кэша стриминга: от 50 до 8192 МиБ.";
    return;
  }
  if (!Number.isFinite(min) || min < 5 || min > 20160) {
    cacheSettingsError.value = "Время жизни неактивного кэша: от 5 минут до 14 суток.";
    return;
  }
  cacheSettingsError.value = null;
  cacheSaveBusy.value = true;
  try {
    await invoke("set_user_cache_settings", {
      settings: {
        streamCacheMaxBytes: Math.round(mib * 1024 * 1024),
        streamCacheTtlSecs: Math.round(min * 60),
      },
    });
    cacheSaveOk.value = true;
    setTimeout(() => {
      cacheSaveOk.value = false;
    }, 2000);
    await loadNerdDiagnostics();
  } catch (e) {
    cacheSettingsError.value = e?.toString?.() ?? String(e);
  } finally {
    cacheSaveBusy.value = false;
  }
}

async function confirmClearStreaming() {
  const ok = await ask(
    "Остановится воспроизведение и удалятся загруженные фрагменты треков в папке стриминга. Продолжить?",
    { title: "Очистить кэш стриминга", kind: "warning" },
  );
  if (!ok) return;
  cacheClearBusy.value = true;
  cacheSettingsError.value = null;
  try {
    await invoke("purge_streaming_cache");
    await loadNerdDiagnostics();
  } catch (e) {
    cacheSettingsError.value = e?.toString?.() ?? String(e);
  } finally {
    cacheClearBusy.value = false;
  }
}

async function onAppDebugChange(e) {
  const enabled = Boolean(e.target.checked);
  await invoke("set_app_debug_enabled", { enabled });
  emit("update:appDebugEnabled", enabled);
}

async function openAppDebugLogWindow() {
  await openAppDebugWindow().catch(() => {});
}

async function confirmClearCoverTorrents() {
  const ok = await ask(
    "Удалятся обложки, загруженные через BitTorrent из раздач (отдельная папка). Продолжить?",
    { title: "Очистить кэш обложек", kind: "warning" },
  );
  if (!ok) return;
  cacheClearBusy.value = true;
  cacheSettingsError.value = null;
  try {
    await invoke("purge_cover_torrent_cache");
    await loadNerdDiagnostics();
  } catch (e) {
    cacheSettingsError.value = e?.toString?.() ?? String(e);
  } finally {
    cacheClearBusy.value = false;
  }
}

watch(nerdOpen, (open) => {
  if (open) loadNerdDiagnostics();
});
</script>

<template>
  <div class="settings-view">
    <h1 class="settings-title">Настройки</h1>

    <!-- ── Источники ─────────────────────────────────────────── -->
    <div class="settings-section">
      <div class="settings-section-label">Источники музыки</div>

      <div class="settings-card">
        <!-- ── Logged in: user card + выход ── -->
        <div v-if="rtLoggedIn" class="settings-card-header">
          <div class="rt-avatar">
            <img
              v-if="props.rtAvatarUrl && !avatarImgFailed"
              :src="props.rtAvatarUrl"
              :alt="props.rtUsername || 'R'"
              @error="avatarImgFailed = true"
            />
            <span v-else>{{ (props.rtUsername || 'R').charAt(0).toUpperCase() }}</span>
          </div>
          <div class="settings-card-info">
            <div class="settings-card-name">{{ props.rtUsername }}</div>
            <div class="settings-card-status">
              <span class="settings-status-dot status-on" />
              Подключено · Rutracker
            </div>
          </div>
          <button
            type="button"
            class="settings-action-btn settings-action-btn--ghost"
            @click="handleRtLogout"
          >
            Выйти
          </button>
        </div>

        <!-- ── Restoring session: loading skeleton ── -->
        <div v-else-if="restoringSession" class="settings-card-header">
          <div class="settings-card-icon rt-loading-icon">
            <span class="spinner" style="width:20px;height:20px;" />
          </div>
          <div class="settings-card-info">
            <div class="settings-card-name">Rutracker</div>
            <div class="settings-card-status">
              <span class="settings-status-dot status-loading" />
              Проверяем доступность…
            </div>
          </div>
        </div>

        <!-- ── Not logged in: generic icon ── -->
        <div v-else class="settings-card-header">
          <div class="settings-card-icon">🔗</div>
          <div class="settings-card-info">
            <div class="settings-card-name">Rutracker</div>
            <div class="settings-card-status">
              <span class="settings-status-dot status-off" />
              Не подключено
            </div>
          </div>
        </div>

        <div v-if="!rtLoggedIn && !restoringSession" class="settings-card-body">
          <p v-if="rtReconnectMsg" class="rt-reconnect-msg rt-reconnect-msg--error">
            {{ rtReconnectMsg }}
          </p>
          <p v-else class="settings-card-desc rt-session-desc">
            Уже входили в этом приложении? Можно восстановить сессию без пароля.
          </p>
          <div class="rt-session-actions rt-session-actions--failure">
            <button
              type="button"
              class="settings-action-btn settings-action-btn--primary"
              :disabled="rtReconnectBusy"
              @click="handleRtReconnect"
            >
              <span v-if="rtReconnectBusy" class="spinner" />
              <template v-else>{{ rtCredentialsHiddenUntilLogout ? "Попробовать снова" : "Переподключиться" }}</template>
            </button>
            <button
              type="button"
              class="settings-action-btn settings-action-btn--ghost"
              :disabled="rtReconnectBusy"
              @click="handleRtLogout"
            >
              Выйти из аккаунта
            </button>
          </div>

          <template v-if="!rtCredentialsHiddenUntilLogout">
            <p class="settings-card-desc settings-card-desc--after-reconnect">
              Введите данные аккаунта Rutracker, чтобы искать и слушать музыку.
            </p>
            <form class="settings-login-form" @submit="handleRtLogin">
              <input
                class="login-input"
                type="text"
                placeholder="Логин"
                v-model="rtUsername"
                autocomplete="username"
              />
              <input
                class="login-input"
                type="password"
                placeholder="Пароль"
                v-model="rtPassword"
                autocomplete="current-password"
              />
              <p v-if="rtError" class="login-error">{{ rtError }}</p>
              <button
                class="login-btn"
                type="submit"
                :disabled="rtLoading || !rtUsername.trim() || !rtPassword"
              >
                <span v-if="rtLoading" class="spinner" />
                <template v-else>Войти в Rutracker</template>
              </button>
            </form>
          </template>
        </div>
      </div>
    </div>

    <!-- ── Внешний вид ────────────────────────────────────────── -->
    <div class="settings-section">
      <div class="settings-section-label">Внешний вид</div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-icon settings-card-icon--app">🎨</div>
          <div class="settings-card-info">
            <div class="settings-card-name">Тема</div>
            <div class="settings-card-status">{{ theme === 'light' ? 'Светлая' : theme === 'system' ? 'Системная' : 'Тёмная' }}</div>
          </div>
          <div class="theme-toggle">
            <button
              :class="['theme-btn', theme === 'dark' ? 'active' : '']"
              @click="emit('theme-change', 'dark')"
            >Тёмная</button>
            <button
              :class="['theme-btn', theme === 'system' ? 'active' : '']"
              @click="emit('theme-change', 'system')"
            >Авто</button>
            <button
              :class="['theme-btn', theme === 'light' ? 'active' : '']"
              @click="emit('theme-change', 'light')"
            >Светлая</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Звук ─────────────────────────────────────────────────────── -->
    <div class="settings-section">
      <div class="settings-section-label">Звук</div>
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-icon settings-card-icon--app">🎚</div>
          <div class="settings-card-info">
            <div class="settings-card-name">Эквалайзер</div>
            <div class="settings-card-status">10 полос · Web Audio · локально</div>
          </div>
        </div>
        <div class="settings-card-body settings-card-body--eq">
          <EqualizerPanel />
        </div>
      </div>
    </div>

    <!-- ── Дополнительно ─────────────────────────────── -->
    <div class="settings-section">
      <button class="nerd-toggle" @click="nerdOpen = !nerdOpen">
        <span class="nerd-toggle-icon">{{ nerdOpen ? '▾' : '▸' }}</span>
        Дополнительно
        <span
          v-if="hasCustomMirror() || hasHttpProxyConfigured()"
          class="nerd-custom-dot"
          title="Нестандартные зеркало или прокси"
        />
      </button>

      <div v-if="nerdOpen" class="nerd-stack">
        <div class="settings-card nerd-card">
          <div class="settings-card-header">
            <div class="settings-card-icon settings-card-icon--app">🪞</div>
            <div class="settings-card-info">
              <div class="settings-card-name">Зеркало Rutracker</div>
              <div class="settings-card-status">Адрес сайта для подключения</div>
            </div>
          </div>

          <div class="settings-card-body">
            <p class="settings-card-desc nerd-desc">
              Если доступ к основному домену закрыт, включи автовыбор — приложение
              переберёт известные зеркала и возьмёт первое отвечающее. Либо выбери
              зеркало вручную из списка или введи свой URL.
            </p>

            <div class="nerd-mode-row" role="radiogroup" aria-label="Режим зеркала">
              <label class="nerd-radio">
                <input type="radio" v-model="mirrorMode" :value="MIRROR_MODE_AUTO" />
                Автовыбор зеркала
              </label>
              <label class="nerd-radio">
                <input type="radio" v-model="mirrorMode" :value="MIRROR_MODE_MANUAL" />
                Вручную
              </label>
            </div>

            <template v-if="mirrorMode === MIRROR_MODE_AUTO">
              <p class="settings-card-desc nerd-desc nerd-active-mirror">
                Сейчас:
                <span class="nerd-mirror-host">{{ hostLabel(activeMirrorDisplay) }}</span>
              </p>
              <div class="nerd-mirror-actions">
                <button
                  type="button"
                  class="login-btn nerd-save-btn"
                  :disabled="nerdProbeBusy"
                  @click="saveMirror"
                >
                  <span v-if="nerdProbeBusy" class="spinner" />
                  <template v-else>{{ mirrorSaved ? '✓ Сохранено' : 'Сохранить' }}</template>
                </button>
                <button
                  v-if="persistedMirrorMode === MIRROR_MODE_AUTO"
                  type="button"
                  class="login-btn nerd-save-btn nerd-save-btn--ghost"
                  :disabled="nerdProbeBusy"
                  @click="refreshAutoMirror"
                >
                  Обновить зеркало
                </button>
              </div>
            </template>

            <template v-else>
              <div class="nerd-mirror-row nerd-mirror-row--stack">
                <select
                  class="login-input nerd-mirror-select"
                  v-model="mirrorSelect"
                  @change="onMirrorSelectChange"
                >
                  <option v-for="u in KNOWN_MIRRORS" :key="u" :value="u">
                    {{ hostLabel(u) }}
                  </option>
                  <option value="__custom__">Свой URL…</option>
                </select>
                <input
                  v-if="mirrorSelect === '__custom__'"
                  class="login-input nerd-mirror-input"
                  type="url"
                  placeholder="https://…"
                  v-model="mirrorUrl"
                  spellcheck="false"
                />
              </div>
              <div class="nerd-mirror-row">
                <button
                  type="button"
                  class="login-btn nerd-save-btn"
                  :disabled="nerdProbeBusy"
                  @click="saveMirror"
                >
                  <span v-if="nerdProbeBusy" class="spinner" />
                  <template v-else>{{ mirrorSaved ? '✓ Сохранено' : 'Сохранить' }}</template>
                </button>
              </div>
            </template>

            <p v-if="nerdProbeError" class="login-error nerd-probe-error">{{ nerdProbeError }}</p>

            <p class="settings-card-desc nerd-desc nerd-mirror-hint">
              Список зеркал: rutracker.net, rutracker.org, rutracker.nl, rutracker.cr,
              maintracker.org, rutracker.lib. При смене зеркала сессия может сброситься —
              войди в Rutracker снова.
            </p>

            <button
              v-if="hasCustomMirror()"
              type="button"
              class="nerd-reset-btn"
              @click="doResetMirror"
            >
              Сбросить к rutracker.net (ручной режим)
            </button>
          </div>
        </div>

        <div class="settings-card nerd-card">
          <div class="settings-card-header">
            <div class="settings-card-icon settings-card-icon--app">🌐</div>
            <div class="settings-card-info">
              <div class="settings-card-name">HTTP-прокси</div>
              <div class="settings-card-status">Тип HTTP · пресеты blockme</div>
            </div>
          </div>
          <div class="settings-card-body">
            <p class="settings-card-desc nerd-desc">
              Исходящие запросы бэкенда (Rutracker, обложки iTunes) пойдут через выбранный
              прокси. Торренты и стриминг к ним не относятся.
            </p>
            <div class="nerd-mirror-row nerd-mirror-row--stack">
              <select v-model="proxySelect" class="login-input nerd-mirror-select">
                <option :value="PROXY_SELECT_NONE">Нет</option>
                <option :value="PROXY_SELECT_PX1">px1.blockme.site · порт 23128</option>
                <option :value="PROXY_SELECT_PX2">px2.blockme.site · порт 3128</option>
              </select>
            </div>
            <div class="nerd-mirror-actions">
              <button
                type="button"
                class="login-btn nerd-save-btn"
                :disabled="proxySaveBusy || proxyProbeBusy"
                @click="saveProxy"
              >
                <span v-if="proxySaveBusy" class="spinner" />
                <template v-else>{{ proxySaved ? '✓ Сохранено' : 'Сохранить' }}</template>
              </button>
              <button
                type="button"
                class="login-btn nerd-save-btn nerd-save-btn--ghost"
                :disabled="proxyProbeBusy || proxySaveBusy"
                @click="probeProxy"
              >
                <span v-if="proxyProbeBusy" class="spinner" />
                <template v-else>Проверить</template>
              </button>
            </div>
            <p v-if="proxyProbeOk" class="settings-card-desc nerd-desc nerd-proxy-probe-ok">
              Запрос к текущему зеркалу (forum/index.php) прошёл — для выбранного варианта прокси
              соединение работает.
            </p>
            <p v-if="proxyProbeError" class="login-error nerd-probe-error">{{ proxyProbeError }}</p>
            <p v-if="proxySaveError" class="login-error nerd-probe-error">{{ proxySaveError }}</p>
            <p class="settings-card-desc nerd-desc nerd-mirror-hint">
              Проверка использует выбранный выше вариант (можно до «Сохранить») и адрес зеркала из
              блока выше. По умолчанию без прокси. Порты: 23128 — для px1; 3128 — для px2.
            </p>
          </div>
        </div>

        <div class="settings-card nerd-card">
          <div class="settings-card-header">
            <div class="settings-card-icon settings-card-icon--app">🪲</div>
            <div class="settings-card-info">
              <div class="settings-card-name">Журнал отладки</div>
              <div class="settings-card-status">Клики, экраны, плеер, торренты</div>
            </div>
            <label class="nerd-toggle-inline">
              <input
                type="checkbox"
                :checked="appDebugEnabled"
                @change="onAppDebugChange"
              />
            </label>
          </div>
          <div v-if="appDebugEnabled" class="settings-card-body">
            <button
              type="button"
              class="login-btn nerd-save-btn"
              @click="openAppDebugLogWindow"
            >
              Открыть журнал
            </button>
          </div>
        </div>

        <div class="settings-card nerd-card nerd-card--cache">
          <div class="settings-card-header">
            <div class="settings-card-icon settings-card-icon--app">⏱</div>
            <div class="settings-card-info">
              <div class="settings-card-name">Кэш на диске</div>
              <div class="settings-card-status">Лимиты и ручная очистка</div>
            </div>
          </div>
          <div class="settings-card-body">
            <p class="settings-card-desc nerd-desc">
              Стриминг хранит фрагменты треков в папке данных; обложки из торрентов — отдельно.
              Можно задать максимальный размер и «возраст» неиспользуемых данных, а также
              освободить место вручную.
            </p>

            <p v-if="cacheSettingsError" class="login-error nerd-probe-error">{{ cacheSettingsError }}</p>

            <div class="nerd-cache-fields">
              <label class="nerd-cache-field">
                <span class="nerd-cache-field-label">Лимит кэша стриминга (МиБ)</span>
                <input
                  v-model.number="cacheFormMaxMib"
                  class="login-input nerd-cache-input"
                  type="number"
                  min="50"
                  max="8192"
                  step="10"
                />
                <span class="nerd-cache-field-hint">50…8192 · при переполнении удаляются старые неактивные раздачи</span>
              </label>
              <label class="nerd-cache-field">
                <span class="nerd-cache-field-label">Неиспользуемый кэш стриминга (минут)</span>
                <input
                  v-model.number="cacheFormTtlMinutes"
                  class="login-input nerd-cache-input"
                  type="number"
                  min="5"
                  max="20160"
                  step="5"
                />
                <span class="nerd-cache-field-hint">5 мин…14 суток · дольше не держим торрент без воспроизведения</span>
              </label>
            </div>

            <div class="nerd-cache-actions">
              <button
                type="button"
                class="login-btn nerd-save-btn"
                :disabled="cacheSaveBusy || cacheClearBusy"
                @click="saveCacheSettings"
              >
                <span v-if="cacheSaveBusy" class="spinner" />
                <template v-else>{{ cacheSaveOk ? '✓ Сохранено' : 'Сохранить лимиты' }}</template>
              </button>
            </div>

            <div class="nerd-cache-divider" />

            <p class="nerd-cache-clear-intro">Очистка сразу удаляет файлы с диска.</p>
            <div class="nerd-cache-clear-row">
              <button
                type="button"
                class="nerd-btn-danger"
                :disabled="cacheClearBusy || cacheSaveBusy"
                @click="confirmClearStreaming"
              >
                <span v-if="cacheClearBusy" class="spinner" />
                <template v-else>Очистить кэш стриминга</template>
              </button>
              <button
                type="button"
                class="nerd-btn-danger nerd-btn-danger--ghost"
                :disabled="cacheClearBusy || cacheSaveBusy"
                @click="confirmClearCoverTorrents"
              >
                Очистить кэш обложек (торренты)
              </button>
            </div>
          </div>
        </div>

        <div class="settings-card nerd-card nerd-card--stats">
          <div class="settings-card-header">
            <div class="settings-card-icon settings-card-icon--app">◉</div>
            <div class="settings-card-info">
              <div class="settings-card-name">Память и данные</div>
              <div class="settings-card-status">Сколько занимает процесс и кэш на диске</div>
            </div>
            <button
              type="button"
              class="nerd-refresh-stats"
              :disabled="nerdDiagLoading"
              title="Обновить"
              @click="loadNerdDiagnostics"
            >
              <span v-if="nerdDiagLoading" class="spinner nerd-refresh-spinner" />
              <template v-else>↻</template>
            </button>
          </div>

          <div class="settings-card-body">
            <p class="settings-card-desc nerd-desc nerd-stats-lead">
              Ниже — фактическое использование RAM и папки данных приложения. Кэш стриминга
              ограничен сверху; при выходе из приложения загруженные для прослушивания данные
              обычно удаляются.
            </p>

            <p v-if="nerdDiagError" class="login-error nerd-probe-error">{{ nerdDiagError }}</p>

            <div v-else-if="nerdDiagLoading && !nerdDiag" class="nerd-stats-loading">
              <span class="spinner" />
              <span>Считаем размеры…</span>
            </div>

            <div v-else-if="nerdDiag" class="nerd-stats-body">
              <div class="nerd-stat-block">
                <div class="nerd-stat-row">
                  <span class="nerd-stat-label">Память процесса (RSS)</span>
                  <span class="nerd-stat-value">
                    {{
                      nerdDiag.residentMemoryBytes != null
                        ? formatBytes(nerdDiag.residentMemoryBytes)
                        : "—"
                    }}
                  </span>
                </div>
                <p class="nerd-stat-hint">Оценка «сколько оперативной памяти» занимает приложение сейчас.</p>
              </div>

              <div class="nerd-stat-block">
                <div class="nerd-stat-row">
                  <span class="nerd-stat-label">Папка данных (всего)</span>
                  <span class="nerd-stat-value">{{ formatBytes(nerdDiag.totalAppDataBytes) }}</span>
                </div>
                <p class="nerd-stat-path">{{ nerdDiag.appDataPath }}</p>
              </div>

              <div class="nerd-stat-block">
                <div class="nerd-stat-row">
                  <span class="nerd-stat-label">Кэш стриминга</span>
                  <span class="nerd-stat-value">
                    {{ formatBytes(nerdDiag.streamCacheBytes) }}
                    <span class="nerd-stat-of">
                      / {{ formatBytes(nerdDiag.streamCacheLimitBytes) }}
                    </span>
                  </span>
                </div>
                <p class="nerd-stat-hint">
                  Папка «{{ nerdDiag.streamCacheDirLabel }}»: фрагменты треков для воспроизведения.
                  Старые раздачи могут удаляться, если кэш переполняется или давно не использовались.
                </p>
                <div
                  v-if="nerdDiag.streamCacheLimitBytes > 0"
                  class="nerd-cache-bar"
                  :title="`${Math.min(100, Math.round((nerdDiag.streamCacheBytes / nerdDiag.streamCacheLimitBytes) * 100))}%`"
                >
                  <div
                    class="nerd-cache-bar-fill"
                    :style="{
                      width: `${Math.min(
                        100,
                        (nerdDiag.streamCacheBytes / nerdDiag.streamCacheLimitBytes) * 100
                      )}%`,
                    }"
                  />
                </div>
              </div>

              <div class="nerd-stat-block">
                <div class="nerd-stat-row">
                  <span class="nerd-stat-label">Кэш обложек (торренты)</span>
                  <span class="nerd-stat-value">{{ formatBytes(nerdDiag.coverTorrentCacheBytes) }}</span>
                </div>
                <p class="nerd-stat-hint">
                  Отдельная папка «{{ nerdDiag.coverCacheDirLabel }}» для обложек из раздач.
                </p>
              </div>

              <div class="nerd-stat-block nerd-stat-block--inline">
                <div class="nerd-stat-row">
                  <span class="nerd-stat-label">Торрентов в сессии стриминга</span>
                  <span class="nerd-stat-value">{{ nerdDiag.streamingTorrentCount }}</span>
                </div>
              </div>

              <div class="nerd-policy-box">
                <div class="nerd-policy-title">Как настроен кэш</div>
                <ul class="nerd-policy-list">
                  <li>
                    Текущий лимит папки стриминга:
                    <strong>{{ formatBytes(nerdDiag.streamCacheLimitBytes) }}</strong>
                    — при превышении вытесняются старые неактивные раздачи (настраивается в блоке выше).
                  </li>
                  <li>
                    Неиспользуемые торренты старше
                    <strong>{{ formatTtlHuman(nerdDiag.streamCacheTtlSecs) }}</strong>
                    могут быть удалены (пока приложение запущено или при следующем старте).
                  </li>
                  <li>
                    Запись на диск буферизуется примерно
                    <strong>{{ nerdDiag.deferWritesMb }} МиБ</strong>
                    — меньше мелких обращений к диску во время прослушивания.
                  </li>
                </ul>
              </div>
            </div>

            <p v-else class="nerd-stat-hint">Нажми ↻ чтобы обновить.</p>
          </div>
        </div>

      </div>
    </div>

    <!-- ── О приложении ───────────────────────────────────────── -->
    <div class="settings-section">
      <div class="settings-section-label">О приложении</div>

      <div ref="aboutStackEl" class="settings-about-stack">
        <div ref="aboutAppCardEl" class="settings-card settings-about-stack__app">
          <div class="settings-card-header settings-card-header--about">
            <div class="settings-card-icon settings-card-icon--app settings-card-icon--about-logo">
              <img
                class="settings-about-logo-img"
                :src="appIconSrc"
                alt="Нигде"
                width="72"
                height="72"
              />
            </div>
            <div class="settings-card-info">
              <div class="settings-card-name">Нигде</div>
            <div class="settings-card-status">Версия {{ appVersion }} · Tauri + Vue 3</div>
            <div
              v-if="githubProjectUrl || telegramChannelUrl"
              class="settings-about-links"
            >
              <a
                v-if="githubProjectUrl"
                class="settings-about-link"
                :href="githubProjectUrl"
                rel="noopener noreferrer"
                @click.prevent="openExternalUrl(githubProjectUrl)"
              >Проект на GitHub</a>
              <span
                v-if="githubProjectUrl && telegramChannelUrl"
                class="settings-about-links-sep"
                aria-hidden="true"
              >·</span>
              <a
                v-if="telegramChannelUrl"
                class="settings-about-link"
                :href="telegramChannelUrl"
                rel="noopener noreferrer"
                title="Канал в Telegram"
                @click.prevent="openExternalUrl(telegramChannelUrl)"
              >Щитпост паблик</a>
            </div>
            <div v-if="githubReleaseApiUrl" class="settings-release-check">
              <template v-if="releaseCheckState === 'loading'">
                <span class="settings-status-dot status-loading" />
                <span>Проверяем обновления…</span>
              </template>
              <template v-else-if="releaseCheckState === 'error'">
                <span class="settings-status-dot status-off" />
                <span>Не удалось проверить обновления</span>
                <button
                  type="button"
                  class="settings-release-retry"
                  @click="runReleaseCheck"
                >
                  Повторить
                </button>
              </template>
              <template v-else-if="releaseCheckState === 'latest'">
                <span class="settings-status-dot status-on" />
                <span>Это последняя версия</span>
              </template>
              <template v-else-if="releaseCheckState === 'outdated'">
                <span class="settings-status-dot status-off" />
                <span>Доступна версия {{ releaseRemoteTag }}</span>
                <a
                  v-if="releasePageUrl"
                  class="settings-release-link"
                  :href="releasePageUrl"
                  rel="noopener noreferrer"
                  @click.prevent="openExternalUrl(releasePageUrl)"
                >Релиз на GitHub</a>
              </template>
              <template v-else-if="releaseCheckState === 'ahead'">
                <span class="settings-status-dot status-on" />
                <span>Сборка новее опубликованного релиза ({{ releaseRemoteTag }})</span>
              </template>
              <template v-else-if="releaseCheckState === 'none'">
                <span class="settings-status-dot status-off" />
                <span>На GitHub пока нет релизов</span>
              </template>
            </div>
          </div>
        </div>
        </div>

        <div class="settings-about-connector" aria-hidden="true">
          <span class="settings-about-connector__rail" />
          <span class="settings-about-connector__pulse" />
          <span class="settings-about-connector__pulse settings-about-connector__pulse--echo" />
        </div>

        <!-- vozduxan -->
        <div ref="aboutVozCardEl" class="settings-card settings-card--vozduxan">
        <div class="settings-card-header settings-card-header--about">
          <div class="settings-card-icon settings-card-icon--app settings-card-icon--about-logo settings-card-icon--vozduxan-logo">
            <img
              class="settings-about-logo-img settings-about-vozduxan-img"
              :src="vozduxanLogoSrc"
              alt=""
              width="72"
              height="72"
            />
          </div>
          <div class="settings-card-info">
            <div class="settings-card-name settings-card-name--with-dep">
              <span>vozduxan</span>
              <template v-if="vozduxanVersion">
                <span class="settings-about-dep-version">v{{ vozduxanVersion }}</span>
              </template>
            </div>
            <div class="settings-card-status">Стриминг аудио из торрент-роёв в реальном времени · C++ · libtorrent</div>
            <div class="settings-about-links">
              <a
                class="settings-about-link"
                href="https://github.com/neegde/vozduxan"
                rel="noopener noreferrer"
                @click.prevent="openExternalUrl('https://github.com/neegde/vozduxan')"
              >GitHub</a>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style>
/* ── Rutracker avatar ────────────────────────────────────────────────────── */
.rt-avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  font-weight: 700;
  color: #000;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
}
.rt-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.rt-session-desc {
  margin-bottom: 12px;
}
.rt-session-actions--failure {
  margin-top: 4px;
  margin-bottom: 12px;
}
.rt-reconnect-msg--error {
  color: var(--text);
  margin-bottom: 10px;
}
.settings-card-desc--after-reconnect {
  margin-top: 4px;
  margin-bottom: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}
.rt-session-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.rt-reconnect-msg {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.4;
}

/* ── Дополнительно ────────────────────────────────────────────────────────── */
.nerd-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: none;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  padding: 4px 0;
  margin-bottom: 10px;
  transition: color 0.15s;
}
.nerd-toggle:hover { color: var(--text); }
.nerd-toggle-icon  { font-size: 10px; }

.nerd-toggle-inline {
  display: flex;
  align-items: center;
  cursor: pointer;
  margin-left: auto;
}
.nerd-toggle-inline input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--accent);
}

.nerd-custom-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  display: inline-block;
  margin-left: 2px;
}

.nerd-card { margin-top: 0; }

.nerd-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.nerd-desc { font-size: 12px; }

.nerd-mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 20px;
  margin-top: 12px;
}
.nerd-radio {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}
.nerd-radio input {
  accent-color: var(--accent);
}

.nerd-active-mirror {
  margin-top: 10px;
  margin-bottom: 0;
}
.nerd-mirror-host {
  color: var(--accent);
  font-weight: 600;
  word-break: break-all;
}

.nerd-mirror-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  align-items: center;
}

.nerd-proxy-probe-ok {
  margin-top: 10px;
  margin-bottom: 0;
  color: var(--success);
}

.nerd-mirror-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.nerd-mirror-row--stack {
  flex-direction: column;
  align-items: stretch;
}
.nerd-mirror-select {
  width: 100%;
  margin-bottom: 0;
  cursor: pointer;
}
.nerd-mirror-input { flex: 1; margin-bottom: 0; }
.nerd-save-btn { white-space: nowrap; margin-top: 0; min-width: 110px; }
.nerd-save-btn--ghost {
  background: transparent;
  border: 1px solid var(--border, rgba(255,255,255,.12));
  color: var(--text);
}
.nerd-save-btn--ghost:hover:not(:disabled) {
  border-color: var(--muted);
}

.nerd-mirror-hint {
  margin-top: 12px;
  opacity: 0.85;
}
.nerd-probe-error {
  margin-top: 10px;
  margin-bottom: 0;
}

.nerd-reset-btn {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  padding: 6px 0 0;
  text-decoration: underline;
  text-underline-offset: 3px;
  transition: color 0.15s;
}
.nerd-reset-btn:hover { color: var(--red); }

/* ── Кэш на диске ─────────────────────────────────────────────────────────── */
.nerd-cache-fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 4px;
}
.nerd-cache-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nerd-cache-field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.nerd-cache-input {
  max-width: 200px;
  margin-bottom: 0;
}
.nerd-cache-field-hint {
  font-size: 11px;
  line-height: 1.35;
  color: var(--muted);
}
.nerd-cache-actions {
  margin-top: 12px;
}
.nerd-app-debug {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  margin-top: 14px;
}
.nerd-app-debug-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--text, #ddd);
  cursor: pointer;
  user-select: none;
}
.nerd-app-debug-row input {
  margin-top: 3px;
  flex-shrink: 0;
}
.nerd-app-debug-open-btn {
  align-self: flex-start;
}
.nerd-cache-divider {
  margin: 18px 0 12px;
  height: 1px;
  background: var(--border, rgba(255,255,255,.08));
}
.nerd-cache-clear-intro {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 10px;
}
.nerd-cache-clear-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.nerd-btn-danger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 16px;
  border-radius: 10px;
  border: none;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background: rgba(220, 80, 80, 0.22);
  color: #ffb4b4;
  transition: background 0.15s, color 0.15s;
}
.nerd-btn-danger:hover:not(:disabled) {
  background: rgba(220, 80, 80, 0.35);
  color: #fff;
}
.nerd-btn-danger:disabled {
  opacity: 0.55;
  cursor: default;
}
.nerd-btn-danger--ghost {
  background: transparent;
  border: 1px solid rgba(220, 80, 80, 0.45);
  color: #e8a0a0;
}
.nerd-btn-danger--ghost:hover:not(:disabled) {
  background: rgba(220, 80, 80, 0.12);
}

/* ── Память и данные (диагностика) ─────────────────────────────────────────── */
.nerd-card--stats .settings-card-header {
  align-items: flex-start;
}
.nerd-refresh-stats {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: 1px solid var(--border, rgba(255,255,255,.12));
  background: rgba(255,255,255,.04);
  color: var(--text);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, border-color 0.15s;
}
.nerd-refresh-stats:hover:not(:disabled) {
  background: rgba(255,255,255,.08);
  border-color: var(--muted);
}
.nerd-refresh-stats:disabled {
  opacity: 0.6;
  cursor: default;
}
.nerd-refresh-spinner {
  width: 18px;
  height: 18px;
}
.nerd-stats-lead {
  margin-bottom: 14px;
}
.nerd-stats-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--muted);
  padding: 8px 0;
}
.nerd-stats-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.nerd-stat-block {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border, rgba(255,255,255,.06));
}
.nerd-stat-block:last-of-type {
  border-bottom: none;
  padding-bottom: 0;
}
.nerd-stat-block--inline {
  padding-bottom: 0;
  border-bottom: none;
}
.nerd-stat-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.nerd-stat-label {
  font-size: 13px;
  color: var(--text);
  font-weight: 600;
}
.nerd-stat-value {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  font-weight: 700;
}
.nerd-stat-of {
  font-weight: 600;
  color: var(--muted);
  font-size: 13px;
}
.nerd-stat-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
}
.nerd-stat-path {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.35;
  color: var(--muted);
  opacity: 0.85;
  word-break: break-all;
  font-family: ui-monospace, monospace;
}
.nerd-cache-bar {
  margin-top: 10px;
  height: 6px;
  border-radius: 4px;
  background: rgba(255,255,255,.08);
  overflow: hidden;
}
.nerd-cache-bar-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  max-width: 100%;
  transition: width 0.25s ease;
}
.nerd-policy-box {
  margin-top: 4px;
  padding: 14px 14px 12px;
  border-radius: 12px;
  background: rgba(255,255,255,.04);
  border: 1px solid var(--border, rgba(255,255,255,.08));
}
.nerd-policy-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 10px;
}
.nerd-policy-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
}
.nerd-policy-list li {
  margin-bottom: 8px;
}
.nerd-policy-list li:last-child {
  margin-bottom: 0;
}
.nerd-policy-list strong {
  color: var(--accent);
  font-weight: 600;
}

.settings-card-header--about {
  align-items: flex-start;
}
.settings-about-stack {
  --about-icon-size: 72px;
  --about-connector-x: calc(20px + var(--about-icon-size) / 2);
}
.settings-about-stack > .settings-card > .settings-card-header > .settings-card-icon:first-child {
  width: var(--about-icon-size);
  min-width: var(--about-icon-size);
  height: var(--about-icon-size);
  flex-shrink: 0;
}
.settings-card-icon--about-logo {
  padding: 0;
  overflow: hidden;
}
.settings-about-logo-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
}
.settings-card-icon.settings-card-icon--vozduxan-logo {
  border-radius: 14px;
  background: transparent;
}
.settings-about-vozduxan-img {
  object-fit: contain;
  padding: 5px;
  box-sizing: border-box;
}
.settings-about-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 4px;
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.45;
}
.settings-about-links-sep {
  color: var(--muted);
  user-select: none;
}
.settings-about-link {
  color: var(--accent);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.settings-about-link:hover {
  color: var(--text);
}
.settings-about-stack > .settings-about-stack__app.settings-card {
  margin-bottom: 0;
}
.settings-about-stack .settings-card--vozduxan {
  margin-top: 0;
}
.settings-about-connector {
  position: relative;
  height: 32px;
  margin: 0;
  pointer-events: none;
}
.settings-about-connector__rail {
  position: absolute;
  left: var(--about-connector-x);
  top: 2px;
  bottom: 2px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: linear-gradient(
    180deg,
    rgba(var(--accent-rgb), 0.38) 0%,
    rgba(var(--accent-rgb), 0.26) 55%,
    rgba(var(--accent-rgb), 0.12) 100%
  );
  box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.12);
}
.settings-about-connector__pulse {
  position: absolute;
  left: var(--about-connector-x);
  top: 0;
  width: 7px;
  height: 7px;
  margin-left: -3.5px;
  border-radius: 50%;
  background: radial-gradient(
    circle at 30% 30%,
    rgba(255, 255, 255, 0.45),
    var(--accent) 55%,
    rgba(var(--accent-rgb), 0.35) 100%
  );
  box-shadow:
    0 0 10px rgba(var(--accent-rgb), 0.65),
    0 0 18px rgba(var(--accent-rgb), 0.35);
  animation: settings-about-pulse-move 2.6s ease-in-out infinite;
  will-change: transform, opacity;
}
.settings-about-connector__pulse::after {
  content: "";
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  border: 1px solid rgba(var(--accent-rgb), 0.35);
  opacity: 0.55;
  animation: settings-about-pulse-ring 2.6s ease-in-out infinite;
}
.settings-about-connector__pulse--echo {
  width: 5px;
  height: 5px;
  margin-left: -2.5px;
  opacity: 0.55;
  box-shadow:
    0 0 8px rgba(var(--accent-rgb), 0.45),
    0 0 14px rgba(var(--accent-rgb), 0.22);
  animation-delay: 1.3s;
}
.settings-about-connector__pulse--echo::after {
  display: none;
}
@keyframes settings-about-pulse-move {
  0% {
    transform: translateY(21px) scale(0.88);
    opacity: 0.45;
  }
  40% {
    opacity: 1;
  }
  100% {
    transform: translateY(5px) scale(1);
    opacity: 0.55;
  }
}
@keyframes settings-about-pulse-ring {
  0% {
    transform: scale(0.65);
    opacity: 0.2;
  }
  45% {
    opacity: 0.65;
  }
  100% {
    transform: scale(1.35);
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .settings-about-connector__pulse,
  .settings-about-connector__pulse::after {
    animation: none;
  }
  .settings-about-connector__pulse {
    top: 50%;
    transform: translateY(-50%);
    opacity: 0.65;
  }
  .settings-about-connector__pulse::after {
    display: none;
  }
  .settings-about-connector__pulse--echo {
    display: none;
  }
}
.settings-card-name--with-dep {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 0.4em;
}
.settings-about-dep-version {
  font-size: 12px;
  font-weight: 400;
  line-height: 1.2;
  color: var(--muted);
  letter-spacing: 0.01em;
}
.settings-release-check {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  margin-top: 10px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--muted);
}
.settings-release-check .settings-status-dot {
  flex-shrink: 0;
}
.settings-release-link {
  color: var(--accent);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.settings-release-link:hover {
  color: var(--text);
}
.settings-release-retry {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.settings-release-retry:hover {
  color: var(--text);
}
</style>
