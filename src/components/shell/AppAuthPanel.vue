<script setup>
import { ref } from "vue";

const emit = defineEmits(["login", "register", "close"]);

const tab = ref("login");
const username = ref("");
const password = ref("");
const loading = ref(false);
const error = ref(null);
const success = ref(null);

function switchTab(t) {
  tab.value = t;
  error.value = null;
  success.value = null;
}

async function handleSubmit(e) {
  e.preventDefault();
  if (!username.value.trim() || !password.value) return;
  loading.value = true;
  error.value = null;
  success.value = null;
  try {
    if (tab.value === "login") {
      emit("login", username.value.trim(), password.value);
    } else {
      emit("register", username.value.trim(), password.value);
      success.value = "Аккаунт создан! Выполняю вход…";
      emit("login", username.value.trim(), password.value);
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="app-auth-overlay" @click="emit('close')">
    <div class="app-auth-modal" @click.stop>
      <button class="app-auth-close" @click="emit('close')">✕</button>

      <div class="app-auth-tabs">
        <button
          :class="['app-auth-tab', tab === 'login' ? 'active' : '']"
          @click="switchTab('login')"
        >Войти</button>
        <button
          :class="['app-auth-tab', tab === 'register' ? 'active' : '']"
          @click="switchTab('register')"
        >Регистрация</button>
      </div>

      <form class="login-form" @submit="handleSubmit">
        <input
          class="login-input"
          type="text"
          placeholder="Логин"
          v-model="username"
          autocomplete="username"
          :maxlength="12"
        />
        <input
          class="login-input"
          type="password"
          placeholder="Пароль"
          v-model="password"
          :autocomplete="tab === 'login' ? 'current-password' : 'new-password'"
        />
        <p v-if="error" class="login-error">{{ error }}</p>
        <p v-if="success" class="login-success">{{ success }}</p>
        <button
          class="login-btn"
          type="submit"
          :disabled="loading || !username.trim() || !password"
        >
          <span v-if="loading" class="spinner" />
          <template v-else>{{ tab === "login" ? "Войти" : "Создать аккаунт" }}</template>
        </button>
      </form>
    </div>
  </div>
</template>
