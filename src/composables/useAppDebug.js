/**
 * In-app debug console wiring.
 *
 * Encapsulates the `appDebugEnabled` flag plus all the side effects that
 * attach/detach when the user toggles debug mode in Settings:
 *   - opens / closes the dedicated debug window
 *   - captures every `click` for event-trace logging
 *   - watches view / queue / now-playing changes and writes them to the log
 *   - tracks window `visibilitychange`
 *
 * The reactive inputs (`view`, `queuePos`, `nowPlaying`) are passed in so the
 * composable has no hidden dependency on App.vue's local state — caller is
 * explicit about what gets traced.
 */

import { ref, watch, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { appDebugLog, appDebugClickDetail } from "../appDebugLog.js";
import { openAppDebugWindow, closeAppDebugWindow } from "../appDebugWindow.js";

/**
 * @param {{
 *   view: import("vue").Ref<string>,
 *   queuePos: import("vue").Ref<number>,
 *   nowPlaying: import("vue").ComputedRef<object | null>,
 * }} traced
 */
export function useAppDebug(traced) {
  const appDebugEnabled = ref(false);

  let unlistenClick = null;
  let onVisibilityChange = null;

  function disconnectClickListener() {
    unlistenClick?.();
    unlistenClick = null;
  }

  onMounted(async () => {
    try {
      appDebugEnabled.value = await invoke("get_app_debug_enabled");
    } catch {
      /* no Tauri API (browser preview) */
    }

    watch(
      appDebugEnabled,
      async (on) => {
        disconnectClickListener();
        if (on) {
          const onClick = (e) => appDebugLog("ui", "click", appDebugClickDetail(e.target));
          document.addEventListener("click", onClick, true);
          unlistenClick = () => document.removeEventListener("click", onClick, true);
          void openAppDebugWindow().catch(() => {});
        } else {
          await closeAppDebugWindow();
        }
      },
      { immediate: true },
    );

    watch(traced.view, (v, prev) => {
      appDebugLog("ui", `nav: ${prev ?? "—"} → ${v}`);
    });

    watch(traced.queuePos, (pos) => {
      const t = traced.nowPlaying.value;
      appDebugLog("player", "queue position changed", {
        pos,
        fileIdx: t?.fileIdx,
        fileName: t?.fileName?.slice?.(0, 80),
      });
    });

    watch(traced.nowPlaying, (t) => {
      if (t == null) {
        appDebugLog("player", "now playing: cleared (queue empty or stopped)");
      } else {
        appDebugLog("player", `now playing: fileIdx=${t.fileIdx} "${t.fileName?.slice?.(0, 80)}"`, {
          torrentId: t.torrentId,
        });
      }
    });

    onVisibilityChange = () => {
      appDebugLog("ui", `window visibility: ${document.visibilityState}`);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
  });

  onUnmounted(() => {
    disconnectClickListener();
    if (onVisibilityChange) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      onVisibilityChange = null;
    }
  });

  return { appDebugEnabled };
}
