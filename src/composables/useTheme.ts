/**
 * App theme composable.
 *
 * - Persists the user's choice ("dark" | "light" | "system") in localStorage.
 * - Applies the resolved theme to `<html data-theme>`.
 * - Follows OS theme changes while the user stays on "system".
 */

import { ref, onMounted, type Ref } from "vue";

export type ThemeName = "dark" | "light" | "system";

const STORAGE_KEY = "theme";

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyEffectiveTheme(mode: ThemeName): void {
  const effective = mode === "system" ? getSystemTheme() : mode;
  document.documentElement.setAttribute("data-theme", effective);
}

export function useTheme(): { theme: Ref<ThemeName>; setTheme: (t: ThemeName) => void } {
  const stored = localStorage.getItem(STORAGE_KEY);
  const initial: ThemeName = stored === "light" || stored === "system" ? stored : "dark";
  const theme = ref<ThemeName>(initial);

  onMounted(() => {
    applyEffectiveTheme(theme.value);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => {
      if (theme.value === "system") applyEffectiveTheme("system");
    });
  });

  function setTheme(next: ThemeName): void {
    theme.value = next;
    localStorage.setItem(STORAGE_KEY, next);
    applyEffectiveTheme(next);
  }

  return { theme, setTheme };
}
