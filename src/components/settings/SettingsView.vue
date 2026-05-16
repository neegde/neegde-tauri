<script setup>
import { ref, computed, onMounted, onUnmounted, onActivated, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkConnectivity, login, loginViaWebview, logout, restoreSession } from "../../rutracker/auth.js";
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
import { hadRutrackerAccount } from "../../rutracker/accountHint.js";
import { clearSlskCoverCache } from "../../soulseek/api.js";
import { clearDiscordPresence } from "../../discordPresence.js";
import EqualizerPanel from "./EqualizerPanel.vue";
import AchievementsModal from "./AchievementsModal.vue";
import SystemIcon from "../shared/SystemIcon.vue";
import {
  fetchLatestGithubRelease,
  compareSemver,
  normalizeVersionTag,
} from "../../githubReleaseCheck.js";
import { appDebugLog } from "../../appDebugLog.js";
import appIconSrc from "../../assets/neegde-logo.png";
import vozduxanLogoSrc from "../../assets/vozduxan-logo.png";
import { ACHIEVEMENT_CATALOG } from "../../achievements/achievementsCore.js";

const props = defineProps({
  rtLoggedIn:       Boolean,
  rtUsername:       { type: String, default: null },
  rtAvatarUrl:      { type: String, default: null },
  restoringSession: { type: Boolean, default: false },
  theme:            { type: String, default: "dark" },
  achievementsOptIn:   { type: Boolean, default: false },
  achievementsUnlocked: { type: Array, default: () => [] },
  // SoulSeek
  slskConnected:    { type: Boolean, default: false },
  slskUsername:     { type: String, default: null },
  slskLoggingIn:    { type: Boolean, default: false },
  slskLoginError:   { type: String, default: null },
  closeTray:        { type: Boolean, default: true },
  discordPresenceEnabled: { type: Boolean, default: true },
  discordPresencePreviewTitle: { type: String, default: "Трек" },
  discordPresencePreviewSubtitle: { type: String, default: "Исполнитель" },
  discordPresencePreviewPlaying: { type: Boolean, default: false },
});

// avatar image error fallback
const avatarImgFailed = ref(false);

// SoulSeek connectivity probe
const slskReachabilityState = ref("idle"); // idle | checking | ok | fail
const slskReachabilityLatency = ref(null);
const slskReachabilityError = ref(null);

function slskReachabilityLabel() {
  if (slskReachabilityState.value === "checking") return "Проверяем доступность SoulSeek…";
  if (slskReachabilityState.value === "ok") {
    if (slskReachabilityLatency.value) return `SoulSeek доступен (${slskReachabilityLatency.value} мс)`;
    return "SoulSeek доступен";
  }
  if (slskReachabilityState.value === "fail") return "Сервер SoulSeek недоступен";
  return "Доступность не проверялась";
}

function slskReachabilityDescription() {
  if (slskReachabilityState.value === "checking") return "Подключаемся к server.slsknet.org:2242…";
  if (slskReachabilityState.value === "ok") return "Сервер отвечает — можно входить.";
  if (slskReachabilityState.value === "fail") return "Не удалось подключиться к серверу. Проверьте интернет или попробуйте позже.";
  return "Нажмите «Проверить», чтобы убедиться в доступности сервера.";
}

async function runSlskConnectivityProbe() {
  slskReachabilityState.value = "checking";
  slskReachabilityError.value = null;
  slskReachabilityLatency.value = null;
  try {
    const result = await invoke("soulseek_check_connectivity");
    slskReachabilityLatency.value = result.latency_ms ?? null;
    if (result.reachable) {
      slskReachabilityState.value = "ok";
    } else {
      slskReachabilityState.value = "fail";
      slskReachabilityError.value = result.error || null;
    }
  } catch (err) {
    slskReachabilityState.value = "fail";
    slskReachabilityError.value = err?.message ?? String(err);
  }
}

// SoulSeek login form state
const slskFormUser = ref(localStorage.getItem("neegde.slsk.user") || "");
const slskFormPass = ref("");
watch(slskFormUser, (v) => localStorage.setItem("neegde.slsk.user", v));

/**
 * After explicit logout the backend deletes `slsk_creds.json` — clear the form if nothing saved.
 *
 * Returns:
 *     void
 */
watch(
  () => props.slskConnected,
  async (connected, prev) => {
    if (prev !== true || connected !== false) return;
    let creds = null;
    try {
      creds = await invoke("soulseek_load_credentials");
    } catch {
      return;
    }
    if (!creds) {
      slskFormUser.value = "";
      slskFormPass.value = "";
      try {
        localStorage.removeItem("neegde.slsk.user");
      } catch {
        /* ignore */
      }
    }
  },
);

// Предзаполняем форму сохранёнными credentials
onMounted(async () => {
  try {
    const creds = await invoke("soulseek_load_credentials");
    if (creds && !slskFormUser.value) {
      slskFormUser.value = creds[0];
      slskFormPass.value = creds[1];
    } else if (creds && !slskFormPass.value) {
      slskFormPass.value = creds[1];
    }
  } catch { /* ignore */ }
});

const emit = defineEmits([
  "login",
  "logout",
  "theme-change",
  "achievements-opt-in-change",
  "achievements-reset",
  "slsk-login",
  "slsk-logout",
  "show-update",
  "close-tray-change",
  "discord-presence-enabled-change",
]);

function onDiscordPresenceToggle(checked) {
  const enabled = Boolean(checked);
  emit("discord-presence-enabled-change", enabled);
  if (!enabled) void clearDiscordPresence();
}

const achievementRows = computed(() => {
  const u = new Set(props.achievementsUnlocked ?? []);
  return ACHIEVEMENT_CATALOG.map((a) => ({
    ...a,
    unlocked: a.stub ? false : u.has(a.id),
  }));
});

const achievementRowsReal = computed(() => achievementRows.value.filter((r) => !r.stub));

const unlockedAchievementsCount = computed(
  () => achievementRowsReal.value.filter((r) => r.unlocked).length
);

/** Подставляется из `package.json` в `vite.config.js` (`define.__APP_VERSION__`). */
const appVersion = __APP_VERSION__;
/** Версия vozduxan из `vozduxan/CMakeLists.txt`, инжектится в `vite.config.js`. */
const vozduxanVersion = __VOZDUXAN_VERSION__;

/** URL GitHub API «последний релиз»; пусто, если в `package.json` нет `repository` с GitHub. */
const githubReleaseApiUrl = __GITHUB_RELEASES_LATEST_API__;
const githubProjectUrl = __GITHUB_PROJECT_URL__;
const telegramChannelUrl = __TELEGRAM_CHANNEL_URL__;

/** Сайт Soulseek: справка по аккаунту и сеть. */
const SOULSEEK_ACCOUNT_INFO_URL = "https://www.slsknet.org/news/user";

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
  appDebugLog("update", `release check → ${githubReleaseApiUrl}`);
  fetchLatestGithubRelease(githubReleaseApiUrl)
    .then((info) => {
      if (!info) {
        releaseCheckState.value = "none";
        releaseRemoteTag.value = null;
        releasePageUrl.value = null;
        appDebugLog("update", "release check: no releases found (404 or empty)");
        return;
      }
      releaseRemoteTag.value = info.tagName;
      releasePageUrl.value = info.htmlUrl || null;
      const cur = normalizeVersionTag(appVersion);
      const remote = normalizeVersionTag(info.tagName);
      const cmp = compareSemver(cur, remote);
      const state = cmp === 0 ? "latest" : cmp < 0 ? "outdated" : "ahead";
      releaseCheckState.value = state;
      appDebugLog("update", `release check: local=${appVersion} remote=${info.tagName} → ${state}`);
    })
    .catch((e) => {
      releaseCheckState.value = "error";
      appDebugLog("update", `release check error: ${e?.message ?? e}`);
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
const rtWebviewLoading = ref(false);
const rtError    = ref(null);
const rtReachabilityState = ref("idle");
const rtReachabilityStatus = ref(null);
const rtReachabilityError = ref(null);

const RT_LOGIN_TIMEOUT_MS = 25_000;

function withPromiseTimeout(promise, ms, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        window.clearTimeout(timer);
        reject(err);
      });
  });
}

function rtReachabilityLabel() {
  if (rtReachabilityState.value === "checking") return "Проверяем доступность RuTracker…";
  if (rtReachabilityState.value === "ok") {
    if (rtReachabilityStatus.value) return `RuTracker доступен (HTTP ${rtReachabilityStatus.value})`;
    return "RuTracker доступен";
  }
  if (rtReachabilityState.value === "fail") {
    if (rtReachabilityStatus.value) return `RuTracker недоступен (HTTP ${rtReachabilityStatus.value})`;
    return "Не удалось достучаться до RuTracker";
  }
  return "Проверка доступности не запускалась";
}

function rtReachabilityDescription() {
  if (rtQuickProxyApplying.value) return "Применяем прокси и запускаем повторную проверку…";
  if (rtReachabilityState.value === "checking") return "Проверяем соединение с форумом и текущим mirror.";
  if (rtReachabilityState.value === "ok") return "Соединение есть — форма входа открыта ниже.";
  if (rtReachabilityState.value === "fail") return "Не удалось подключиться. Выберите прокси и перепроверьте.";
  return "Нажмите «Проверить доступность», чтобы продолжить вход.";
}

async function runRtConnectivityProbe(reason = "manual") {
  rtReachabilityState.value = "checking";
  rtReachabilityError.value = null;
  await appDebugLog("rutracker", `connectivity probe: start (${reason})`);
  try {
    const result = await withPromiseTimeout(
      checkConnectivity(),
      15_000,
      "Проверка доступности RuTracker превысила лимит ожидания",
    );
    rtReachabilityStatus.value = result?.status ?? null;
    if (result?.reachable) {
      rtReachabilityState.value = "ok";
      await appDebugLog("rutracker", "connectivity probe: reachable", {
        reason,
        status: result?.status ?? null,
        usingProxy: result?.using_proxy ?? null,
      });
      return;
    }
    rtReachabilityState.value = "fail";
    rtReachabilityError.value = result?.error || null;
    await appDebugLog("rutracker", "connectivity probe: unreachable", {
      reason,
      status: result?.status ?? null,
      error: result?.error ?? null,
      usingProxy: result?.using_proxy ?? null,
    });
  } catch (err) {
    rtReachabilityState.value = "fail";
    rtReachabilityStatus.value = null;
    rtReachabilityError.value = err?.message ?? String(err);
    await appDebugLog("rutracker", "connectivity probe: error", {
      reason,
      error: err?.message ?? String(err),
    });
  }
}

async function handleRtLogin(e) {
  e.preventDefault();
  if (!rtUsername.value.trim() || !rtPassword.value) return;
  rtLoading.value = true;
  rtError.value   = null;
  await appDebugLog("rutracker", "login: submit", {
    hasUsername: Boolean(rtUsername.value.trim()),
    mirrorMode: getMirrorMode(),
    mirror: getMirror(),
  });
  try {
    const result = await withPromiseTimeout(
      login(rtUsername.value.trim(), rtPassword.value),
      RT_LOGIN_TIMEOUT_MS,
      "Запрос входа превысил лимит ожидания",
    );
    if (result.success) {
      rtCredentialsHiddenUntilLogout.value = false;
      emit("login", result.username, result.avatar_url || null);
      rtUsername.value = "";
      rtPassword.value = "";
      avatarImgFailed.value = false;
      await appDebugLog("rutracker", "login: success", {
        username: result.username ?? null,
      });
    } else {
      rtError.value = result.error || "Ошибка входа";
      await appDebugLog("rutracker", "login: rejected", {
        error: result.error ?? null,
      });
      void runRtConnectivityProbe("login-rejected");
    }
  } catch (err) {
    const text = err?.message ?? String(err);
    if (/превысил лимит|timeout|timed out/i.test(text)) {
      rtError.value = "Слишком долго нет ответа от RuTracker. Попробуйте прокси или другое зеркало.";
    } else {
      rtError.value = "Нет соединения — проверьте зеркало и интернет";
    }
    await appDebugLog("rutracker", "login: error", {
      error: text,
    });
    void runRtConnectivityProbe("login-error");
  } finally {
    rtLoading.value = false;
  }
}

/**
 * Opens embedded RuTracker login page and promotes cookies into app session.
 *
 * Returns:
 *     void
 */
async function handleRtLoginViaBrowser() {
  rtError.value = null;
  rtWebviewLoading.value = true;
  await appDebugLog("rutracker", "login via webview: open");
  try {
    const result = await loginViaWebview();
    if (result.success) {
      rtCredentialsHiddenUntilLogout.value = false;
      emit("login", result.username, result.avatar_url || null);
      rtUsername.value = "";
      rtPassword.value = "";
      avatarImgFailed.value = false;
      await appDebugLog("rutracker", "login via webview: success", {
        username: result.username ?? null,
      });
      return;
    }
    rtError.value = result.error || "Вход через браузер отменён";
    await appDebugLog("rutracker", "login via webview: rejected", {
      error: result.error ?? null,
    });
    void runRtConnectivityProbe("webview-login-rejected");
  } catch (err) {
    rtError.value = "Не удалось открыть окно входа";
    await appDebugLog("rutracker", "login via webview: error", {
      error: err?.message ?? String(err),
    });
  } finally {
    rtWebviewLoading.value = false;
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

/**
 * Показывать «Переподключиться» / «Выйти из аккаунта» только если есть сохранённая сессия
 * или уже шёл сценарий ошибки сессии — не после явного «Выйти» без следов аккаунта.
 *
 * Returns:
 *     Whether session-recovery actions should be visible.
 */
const showRutrackerSessionRecovery = computed(() => {
  if (props.rtLoggedIn || props.restoringSession) return false;
  return (
    hadRutrackerAccount() ||
    Boolean(rtReconnectMsg.value) ||
    rtCredentialsHiddenUntilLogout.value
  );
});

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

const achievementsBrowseOpen = ref(false);
/** Раскрыт блок «Щитпост» (как nerdOpen). */
const shitpostOpen = ref(false);

// ── Параметры для задротов ─────────────────────────────────────────────────────────────
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
      const sel = proxyUrlToSelect(url);
      proxySelect.value = sel;
      rtQuickProxy.value = sel;
    })
    .catch(() => {});
  nextTick(() => {
    aboutPairResizeObserver = new ResizeObserver(() => {
      syncAboutPairHeights();
    });
    syncAboutPairHeights();
  });
  window.addEventListener("resize", syncAboutPairHeights);
  void runRtConnectivityProbe("settings-mounted");
  if (!props.slskConnected) void runSlskConnectivityProbe();
});

onActivated(() => {
  loadNerdDiagnostics();
  if (githubReleaseApiUrl) runReleaseCheck();
  if (!props.slskConnected) void runSlskConnectivityProbe();
  if (props.rtLoggedIn) {
    invoke("rutracker_refresh_avatar", { mirror: getMirror() })
      .then((newUrl) => {
        if (newUrl) {
          avatarImgFailed.value = false;
          emit("login", props.rtUsername, newUrl);
        }
      })
      .catch(() => {});
  }
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
const rtQuickProxy = ref(PROXY_SELECT_NONE);
const rtQuickProxyApplying = ref(false);
const proxySaved = ref(false);
const proxySaveBusy = ref(false);
const proxySaveError = ref(null);
const proxyProbeBusy = ref(false);
const proxyProbeOk = ref(false);
const proxyProbeError = ref(null);

async function applyRtQuickProxyAndProbe(sel) {
  if (rtQuickProxyApplying.value) return;
  rtQuickProxyApplying.value = true;
  proxySaveError.value = null;
  rtError.value = null;
  proxySelect.value = sel;
  const url = proxySelectToUrl(sel);
  try {
    await setHttpProxy(url);
    setRtHttpProxyCache(url || "");
    rtQuickProxy.value = sel;
    await appDebugLog("rutracker", "quick proxy applied", {
      proxy: sel,
      url: url ?? null,
    });
  } catch (e) {
    const msg = e?.toString?.() ?? String(e);
    proxySaveError.value = msg;
    rtReachabilityError.value = msg;
    await appDebugLog("rutracker", "quick proxy apply error", {
      proxy: sel,
      error: msg,
    });
    rtQuickProxyApplying.value = false;
    return;
  }
  rtQuickProxyApplying.value = false;
  await runRtConnectivityProbe(`quick-proxy-${sel}`);
}

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
    rtQuickProxy.value = proxySelect.value;
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

/**
 * Bytes under app data dir not covered by stream + cover subfolders (DB, session state, etc.).
 *
 * @returns {number}
 */
const nerdDiagOtherBytes = computed(() => {
  const d = nerdDiag.value;
  if (!d) return 0;
  const t = Number(d.totalAppDataBytes) || 0;
  const s = Number(d.streamCacheBytes) || 0;
  const c = Number(d.coverTorrentCacheBytes) || 0;
  const o = t - s - c;
  return o > 0 ? o : 0;
});

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

async function confirmClearCoverTorrents() {
  const ok = await ask(
    "Удалятся обложки, загруженные через BitTorrent из раздач (отдельная папка). Сбросится и кэш обложек SoulSeek в памяти приложения. Продолжить?",
    { title: "Очистить кэш обложек", kind: "warning" },
  );
  if (!ok) return;
  cacheClearBusy.value = true;
  cacheSettingsError.value = null;
  try {
    await invoke("purge_cover_torrent_cache");
    clearSlskCoverCache();
    await loadNerdDiagnostics();
  } catch (e) {
    cacheSettingsError.value = e?.toString?.() ?? String(e);
  } finally {
    cacheClearBusy.value = false;
  }
}

/**
 * Asks confirmation and clears persisted achievement marks via parent.
 *
 * Returns:
 *     void
 */
async function confirmResetAchievements() {
  const ok = await ask(
    "Сбросятся отметки о полученных достижениях и флаг первого прослушивания — их можно заработать снова. Список лайков не меняется. Продолжить?",
    { title: "Сбросить достижения", kind: "warning" },
  );
  if (!ok) return;
  emit("achievements-reset");
}

const factoryResetBusy = ref(false);

async function confirmFactoryReset() {
  const ok = await ask(
    "Удалятся все данные приложения: лайки, очередь, плейлисты, кэши, сессии RuTracker и SoulSeek. Приложение перезапустится как новое. Отменить нельзя. Продолжить?",
    { title: "Сброс до заводских настроек", kind: "warning" },
  );
  if (!ok) return;
  factoryResetBusy.value = true;
  localStorage.clear();
  await invoke("factory_reset").catch(() => {});
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

</script>

<template src="./SettingsView.html"></template>

<style src="./SettingsView.scoped.css"></style>

