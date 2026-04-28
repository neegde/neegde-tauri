import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "neegde.closeTray.v1";

export function useTrayPreference() {
  const closeTray = ref(localStorage.getItem(STORAGE_KEY) === "true");

  onMounted(async () => {
    try {
      await invoke("set_close_to_tray", { enabled: closeTray.value });
    } catch { /* no Tauri API */ }
  });

  async function setCloseTray(enabled: boolean) {
    closeTray.value = enabled;
    localStorage.setItem(STORAGE_KEY, String(enabled));
    try {
      await invoke("set_close_to_tray", { enabled });
    } catch { /* no Tauri API */ }
  }

  return { closeTray, setCloseTray };
}
