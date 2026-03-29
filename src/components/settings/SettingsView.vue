<script setup>
import { ref, onMounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
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
import { clearRutrackerCoverCache } from "../../rutracker/search.js";
import EqualizerPanel from "./EqualizerPanel.vue";
import { openAppDebugWindow } from "../../appDebugWindow.js";

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

// ── Параметры для задротов ────────────────────────────────────────────────────
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
            <div class="settings-card-status">{{ theme === 'light' ? 'Светлая' : 'Тёмная' }}</div>
          </div>
          <div class="theme-toggle">
            <button
              :class="['theme-btn', theme !== 'light' ? 'active' : '']"
              @click="emit('theme-change', 'dark')"
            >Тёмная</button>
            <button
              :class="['theme-btn', theme === 'light' ? 'active' : '']"
              @click="emit('theme-change', 'light')"
            >Светлая</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Параметры для задротов ─────────────────────────────── -->
    <div class="settings-section">
      <button class="nerd-toggle" @click="nerdOpen = !nerdOpen">
        <span class="nerd-toggle-icon">{{ nerdOpen ? '▾' : '▸' }}</span>
        Параметры для задротов
        <span v-if="hasCustomMirror()" class="nerd-custom-dot" title="Зеркало изменено" />
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

            <div class="nerd-app-debug">
              <label class="nerd-app-debug-row">
                <input
                  type="checkbox"
                  :checked="appDebugEnabled"
                  @change="onAppDebugChange"
                />
                <span>Журнал отладки: клики, экраны, плеер, торренты — только в отдельном окне</span>
              </label>
              <button
                v-if="appDebugEnabled"
                type="button"
                class="login-btn nerd-save-btn nerd-app-debug-open-btn"
                @click="openAppDebugLogWindow"
              >
                Открыть журнал отладки
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

        <div class="settings-card nerd-card">
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
    </div>

    <!-- ── О приложении ───────────────────────────────────────── -->
    <div class="settings-section">
      <div class="settings-section-label">О приложении</div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-icon settings-card-icon--app">♫</div>
          <div class="settings-card-info">
            <div class="settings-card-name">Нигде</div>
            <div class="settings-card-status">Версия {{ appVersion }} · Tauri + Vue 3</div>
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

/* ── Параметры для задротов ───────────────────────────────────────────────── */
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
</style>
