/**
 * Queue-item right-click menu state.
 *
 * Decouples the open/close machinery and the "which actions are enabled for
 * the item at this index" logic from Player.vue. The caller wires two emit
 * callbacks (download / add-to-playlist) and passes the queue ref.
 */

import { ref, computed } from "vue";

/**
 * @param {{
 *   playbackQueue: import("vue").Ref<Array<object>> | import("vue").ComputedRef<Array<object>>,
 *   onDownload: (row: object) => void,
 *   onAddToPlaylist: (row: object) => void,
 * }} ctx
 */
export function useQueueContextMenu(ctx) {
  const queueCtxOpen = ref(false);
  const queueCtxX = ref(0);
  const queueCtxY = ref(0);
  /** @type {import('vue').Ref<number | null>} */
  const queueCtxIdx = ref(null);

  function openQueueCtx(e, idx) {
    e.preventDefault();
    queueCtxX.value = e.clientX;
    queueCtxY.value = e.clientY;
    queueCtxIdx.value = idx;
    queueCtxOpen.value = true;
  }

  const queueCtxActions = computed(() => {
    const idx = queueCtxIdx.value;
    const q = idx != null ? ctx.playbackQueue.value?.[idx] : null;
    const canDownload =
      !!q &&
      String(q.magnet ?? "").trim().length > 0 &&
      q.fileIdx != null &&
      Number.isFinite(Number(q.fileIdx));
    return [
      { id: "download", label: "Скачать", icon: "download", disabled: !canDownload },
      { id: "divider" },
      { id: "playlist", label: "В плейлист", icon: "playlist" },
    ];
  });

  function onQueueCtxAction(id) {
    const idx = queueCtxIdx.value;
    if (idx == null) return;
    const q = ctx.playbackQueue.value?.[idx];
    if (!q) return;
    if (id === "playlist") ctx.onAddToPlaylist(q);
    if (id === "download") {
      if (
        !String(q.magnet ?? "").trim() ||
        q.fileIdx == null ||
        !Number.isFinite(Number(q.fileIdx))
      ) {
        return;
      }
      ctx.onDownload(q);
    }
  }

  return {
    queueCtxOpen,
    queueCtxX,
    queueCtxY,
    queueCtxActions,
    openQueueCtx,
    onQueueCtxAction,
  };
}
