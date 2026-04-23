/**
 * App theme composable.
 *
 * - Persists the user's choice ("dark" | "light" | "system") in localStorage.
 * - Applies the resolved theme to `<html data-theme>`.
 * - Follows OS theme changes while the user stays on "system".
 */

import { ref, onMounted } from "vue";

const STORAGE_KEY = "theme";

function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyEffectiveTheme(mode) {
  const effective = mode === "system" ? getSystemTheme() : mode;
  document.documentElement.setAttribute("data-theme", effective);
}

export function useTheme() {
  const theme = ref(localStorage.getItem(STORAGE_KEY) || "dark");

  onMounted(() => {
    applyEffectiveTheme(theme.value);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => {
      if (theme.value === "system") applyEffectiveTheme("system");
    });
  });

  function setTheme(next) {
    theme.value = next;
    localStorage.setItem(STORAGE_KEY, next);
    applyEffectiveTheme(next);
  }

  return { theme, setTheme };
}
