<script setup>
import { ref, onMounted } from "vue";
import { login, logout } from "../rutracker/auth.js";
import { getMirror, setMirror, resetMirror, hasCustomMirror, DEFAULT_MIRROR } from "../rutracker/config.js";
import { clearRutrackerCoverCache } from "../rutracker/search.js";

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
  try { await logout(); } catch (_) { /* ignore */ }
  emit("logout");
}

// ── Параметры для задротов ────────────────────────────────────────────────────
const nerdOpen   = ref(false);
const mirrorUrl  = ref("");
const mirrorSaved = ref(false);

onMounted(() => {
  mirrorUrl.value = getMirror();
});

function saveMirror() {
  setMirror(mirrorUrl.value);
  clearRutrackerCoverCache();
  mirrorSaved.value = true;
  setTimeout(() => { mirrorSaved.value = false; }, 2000);
}

function doResetMirror() {
  resetMirror();
  mirrorUrl.value = DEFAULT_MIRROR;
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
        <div class="settings-card-header">

          <!-- ── Logged in: Spotify-style user card ── -->
          <template v-if="rtLoggedIn">
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
              class="settings-action-btn settings-action-btn--ghost"
              @click="handleRtLogout"
            >
              Отключить
            </button>
          </template>

          <!-- ── Restoring session: loading skeleton ── -->
          <template v-else-if="restoringSession">
            <div class="settings-card-icon rt-loading-icon">
              <span class="spinner" style="width:20px;height:20px;" />
            </div>
            <div class="settings-card-info">
              <div class="settings-card-name">Rutracker</div>
              <div class="settings-card-status">
                <span class="settings-status-dot status-loading" />
                Проверяем сессию…
              </div>
            </div>
          </template>

          <!-- ── Not logged in: generic icon ── -->
          <template v-else>
            <div class="settings-card-icon">🔗</div>
            <div class="settings-card-info">
              <div class="settings-card-name">Rutracker</div>
              <div class="settings-card-status">
                <span class="settings-status-dot status-off" />
                Не подключено
              </div>
            </div>
          </template>

        </div>

        <div v-if="!rtLoggedIn && !restoringSession" class="settings-card-body">
          <p class="settings-card-desc">
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
            Если основное зеркало заблокировано, укажи другое.
            Вход и поиск будут работать через него незаметно для тебя.
          </p>
          <div class="nerd-mirror-row">
            <input
              class="login-input nerd-mirror-input"
              type="url"
              placeholder="https://rutracker.net"
              v-model="mirrorUrl"
              spellcheck="false"
            />
            <button class="login-btn nerd-save-btn" @click="saveMirror">
              {{ mirrorSaved ? '✓ Сохранено' : 'Сохранить' }}
            </button>
          </div>
          <button
            v-if="hasCustomMirror()"
            class="nerd-reset-btn"
            @click="doResetMirror"
          >
            Сбросить до rutracker.net
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
            <div class="settings-card-status">Версия 0.1.0 · Tauri + Vue 3</div>
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

.nerd-mirror-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.nerd-mirror-input { flex: 1; margin-bottom: 0; }
.nerd-save-btn { white-space: nowrap; margin-top: 0; min-width: 110px; }

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
