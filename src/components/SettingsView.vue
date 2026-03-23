<script setup>
import { ref } from "vue";

const props = defineProps({
  rtLoggedIn: Boolean,
  appUser: Object,
  theme: { type: String, default: "dark" },
});

const emit = defineEmits(["login", "logout", "app-logout", "open-auth", "theme-change"]);

// Rutracker login form state (embedded in the card)
const rtUsername = ref("");
const rtPassword = ref("");
const rtLoading = ref(false);
const rtError = ref(null);

async function handleRtLogin(e) {
  e.preventDefault();
  if (!rtUsername.value.trim() || !rtPassword.value) return;
  rtLoading.value = true;
  rtError.value = null;
  try {
    emit("login", rtUsername.value.trim(), rtPassword.value);
    rtUsername.value = "";
    rtPassword.value = "";
  } catch (err) {
    rtError.value = err.message;
  } finally {
    rtLoading.value = false;
  }
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
          <div :class="['settings-card-icon', rtLoggedIn ? 'settings-card-icon--on' : '']">
            🔗
          </div>
          <div class="settings-card-info">
            <div class="settings-card-name">Rutracker</div>
            <div class="settings-card-status">
              <span :class="['settings-status-dot', rtLoggedIn ? 'status-on' : 'status-off']" />
              {{ rtLoggedIn ? "Подключено" : "Не подключено" }}
            </div>
          </div>
          <button
            v-if="rtLoggedIn"
            class="settings-action-btn settings-action-btn--ghost"
            @click="emit('logout')"
          >
            Отключить
          </button>
        </div>

        <div v-if="!rtLoggedIn" class="settings-card-body">
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
