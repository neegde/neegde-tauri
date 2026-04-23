/**
 * In-app debug console wiring.
 */

import { ref, watch, onMounted, onUnmounted, type Ref, type ComputedRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { appDebugLog, appDebugClickDetail } from "../appDebugLog.js";
import { openAppDebugWindow, closeAppDebugWindow } from "../appDebugWindow.js";

interface TracedNowPlaying {
  fileIdx?: number;
  fileName?: string;
  torrentId?: string | number;
  [k: string]: unknown;
}

export interface UseAppDebugOptions {
  view: Ref<string>;
  queuePos: Ref<number>;
  nowPlaying: ComputedRef<TracedNowPlaying | null>;
}

export function useAppDebug(traced: UseAppDebugOptions) {
  const appDebugEnabled = ref<boolean>(false);

  let unlistenClick: (() => void) | null = null;
  let onVisibilityChange: (() => void) | null = null;

  function disconnectClickListener(): void {
    unlistenClick?.();
    unlistenClick = null;
  }

  onMounted(async () => {
    try {
      appDebugEnabled.value = await invoke<boolean>("get_app_debug_enabled");
    } catch {
      /* no Tauri API (browser preview) */
    }

    watch(
      appDebugEnabled,
      async (on) => {
        disconnectClickListener();
        if (on) {
          const onClick = (e: MouseEvent): void => {
            void appDebugLog("ui", "click", appDebugClickDetail(e.target));
          };
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
      void appDebugLog("ui", `nav: ${prev ?? "—"} → ${v}`);
    });

    watch(traced.queuePos, (pos) => {
      const t = traced.nowPlaying.value;
      void appDebugLog("player", "queue position changed", {
        pos,
        fileIdx: t?.fileIdx,
        fileName: t?.fileName?.slice?.(0, 80),
      });
    });

    watch(traced.nowPlaying, (t) => {
      if (t == null) {
        void appDebugLog("player", "now playing: cleared (queue empty or stopped)");
      } else {
        void appDebugLog("player", `now playing: fileIdx=${t.fileIdx} "${t.fileName?.slice?.(0, 80)}"`, {
          torrentId: t.torrentId,
        });
      }
    });

    onVisibilityChange = (): void => {
      void appDebugLog("ui", `window visibility: ${document.visibilityState}`);
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
