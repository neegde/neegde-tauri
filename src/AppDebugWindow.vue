<script setup>
import { onMounted } from "vue";
import AppDebugConsole from "./components/debug/AppDebugConsole.vue";

onMounted(() => {
  document.documentElement.setAttribute(
    "data-theme",
    localStorage.getItem("theme") || "dark",
  );
});
</script>

<template>
  <div class="app-debug-window-root">
    <AppDebugConsole />
  </div>
</template>

<style scoped>
.app-debug-window-root {
  box-sizing: border-box;
  width: 100vw;
  height: 100vh;
  margin: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg, #18181c);
}
</style>
