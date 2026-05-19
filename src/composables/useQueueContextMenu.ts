/**
 * Queue-item right-click menu state.
 *
 * Decouples the open/close machinery and the "which actions are enabled
 * for the item at this index" logic from Player.vue. The caller wires two
 * emit callbacks (download / add-to-playlist) and passes the queue ref.
 *
 * Queue items are `Track` instances. `download` is enabled when the track
 * reports it has a playable identity (Rutracker magnet, Soulseek peer coords);
 * `playlist` has no precondition.
 */

import { ref, computed, type Ref, type ComputedRef } from "vue";
import type { Track } from "../track/Track.js";
import {
  forceReloadTrackCover,
  forceReloadTrackCoverFromFullFile,
} from "../track/forceReloadTrackCover.js";
import { fullFileEmbeddedCoverAvailableForTrack } from "../torrent/embeddedCover.js";
import { showTrackInfo } from "./useTrackInfo.js";

export interface UseQueueContextMenuOptions {
  playbackQueue: Ref<Track[]> | ComputedRef<Track[]>;
  onDownload: (t: Track) => void;
  onAddToPlaylist: (t: Track) => void;
}

export interface QueueCtxAction {
  id: string;
  label?: string;
  icon?: string;
  disabled?: boolean;
}

export function useQueueContextMenu(ctx: UseQueueContextMenuOptions) {
  const queueCtxOpen = ref(false);
  const queueCtxX = ref(0);
  const queueCtxY = ref(0);
  const queueCtxIdx = ref<number | null>(null);

  function openQueueCtx(e: MouseEvent, idx: number): void {
    e.preventDefault();
    queueCtxX.value = e.clientX;
    queueCtxY.value = e.clientY;
    queueCtxIdx.value = idx;
    queueCtxOpen.value = true;
  }

  const queueCtxActions = computed<QueueCtxAction[]>(() => {
    const idx = queueCtxIdx.value;
    const t = idx != null ? ctx.playbackQueue.value?.[idx] : null;
    const canDownload = !!t && typeof t.hasPlaybackIdentity === "function" && t.hasPlaybackIdentity();
    const canReadFullEmbeddedCover = !!t && fullFileEmbeddedCoverAvailableForTrack(t);
    return [
      { id: "reload-cover", label: "Загрузить обложку", icon: "cover" },
      {
        id: "reload-cover-full-file",
        label: "Обложка из полного файла",
        icon: "cover",
        disabled: !canReadFullEmbeddedCover,
      },
      { id: "divider" },
      { id: "download", label: "Скачать",   icon: "download", disabled: !canDownload },
      { id: "divider" },
      { id: "playlist", label: "В плейлист", icon: "playlist" },
      { id: "divider" },
      { id: "info", label: "О треке", icon: "info" },
    ];
  });

  function onQueueCtxAction(id: string): void {
    const idx = queueCtxIdx.value;
    if (idx == null) return;
    const t = ctx.playbackQueue.value?.[idx];
    if (!t) return;
    if (id === "reload-cover") {
      forceReloadTrackCover(t);
      return;
    }
    if (id === "reload-cover-full-file") {
      forceReloadTrackCoverFromFullFile(t);
      return;
    }
    if (id === "info") {
      showTrackInfo(t.id);
      return;
    }
    if (id === "playlist") ctx.onAddToPlaylist(t);
    if (id === "download") {
      if (typeof t.hasPlaybackIdentity === "function" && !t.hasPlaybackIdentity()) return;
      ctx.onDownload(t);
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
