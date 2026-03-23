<script setup>
import { ref } from "vue";

const emit = defineEmits(["login"]);

const username = ref("");
const password = ref("");
const loading = ref(false);
const error = ref(null);

async function handleSubmit(e) {
  e.preventDefault();
  if (!username.value.trim() || !password.value) return;
  loading.value = true;
  error.value = null;
  try {
    const result = await emit("login", username.value.trim(), password.value);
    if (result && !result.success) error.value = result.error || "Ошибка входа";
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-panel">
    <div class="login-title">Войти в Rutracker</div>
    <form class="login-form" @submit="handleSubmit">
      <input
        class="login-input"
        type="text"
        placeholder="Логин"
        v-model="username"
        autocomplete="username"
      />
      <input
        class="login-input"
        type="password"
        placeholder="Пароль"
        v-model="password"
        autocomplete="current-password"
      />
      <p v-if="error" class="login-error">{{ error }}</p>
      <button
        class="login-btn"
        type="submit"
        :disabled="loading || !username.trim() || !password"
      >
        <span v-if="loading" class="spinner" />
        <template v-else>Войти</template>
      </button>
    </form>
  </div>
</template>
