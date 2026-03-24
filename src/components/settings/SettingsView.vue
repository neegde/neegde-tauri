<script setup>
import { ref, onMounted, watch } from "vue";
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

const props = defineProps({
  rtLoggedIn:       Boolean,
  rtUsername:       { type: String, default: null },
  rtAvatarUrl:      { type: String, default: null },
  restoringSession: { type: Boolean, default: false },
  appUser:          Object,
  theme:            { type: String, default: "dark" },
});

// avatar image error fallback
const avatarImgFailed = ref(false);

const emit = defineEmits(["login", "logout", "app-logout", "open-auth", "theme-change"]);

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

    <!-- ── Аккаунт ────────────────────────────────────────────── -->
    <div class="settings-section">
      <div class="settings-section-label">
        Аккаунт Нигде
        <span class="settings-soon-badge">скоро</span>
      </div>

      <div class="settings-card settings-card--disabled">
        <div class="settings-card-header">
          <div class="settings-card-icon">👤</div>
          <div class="settings-card-info">
            <div class="settings-card-name">Нигде</div>
            <div class="settings-card-status">
              <span class="settings-status-dot status-off" />
              В разработке
            </div>
          </div>
          <span class="settings-wip-pill">В разработке</span>
        </div>

        <div class="settings-card-body">
          <p class="settings-card-desc">
            Синхронизация лайков между устройствами появится в следующих версиях.
          </p>
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

      <div v-if="nerdOpen" class="settings-card nerd-card">
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
</style>
