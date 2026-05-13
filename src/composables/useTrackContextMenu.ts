/**
 * useTrackContextMenu — shared right-click menu for track rows.
 *
 * The three library-ish views (LikesView, PlaylistView, AlbumView) all open
 * an identical `<TrackContextMenu>` popup on right-click of a track row. The
 * repetitive bits — `ctxOpen` / `ctxX` / `ctxY` / `ctxTrack` refs, the
 * `openTrackCtx` handler, and the `onCtxAction` dispatcher — live here.
 *
 * Each caller provides its own `actionsFor(track)` (different views show
 * different items; AlbumView has "play" and "like", Likes/Playlist don't)
 * and `onAction(id, track)` dispatch map.
 */

import { ref, shallowRef, computed, type Ref, type ShallowRef, type ComputedRef } from "vue";
import type { Track } from "../track/Track.js";
import {
  forceReloadTrackCover,
  forceReloadTrackCoverFromFullFile,
} from "../track/forceReloadTrackCover.js";
import { sourceContextLabel, canDownload } from "../track/labels.js";
import { fullFileEmbeddedCoverAvailableForTrack } from "../torrent/embeddedCover.js";

export interface CtxActionDef {
  id: string;
  label?: string;
  /** Known icons include `cover` (reload artwork). */
  icon?: string;
  disabled?: boolean;
}

export interface UseTrackContextMenuOptions {
  /** Build the action list for a given track. Re-evaluated when ctxTrack changes. */
  actionsFor: (track: Track) => CtxActionDef[];
  /** Called when the user picks an action. */
  onAction: (id: string, track: Track) => void;
}

export interface UseTrackContextMenuApi {
  ctxOpen: Ref<boolean>;
  ctxX: Ref<number>;
  ctxY: Ref<number>;
  ctxTrack: ShallowRef<Track | null>;
  ctxActions: ComputedRef<CtxActionDef[]>;
  openTrackCtx: (e: MouseEvent, track: Track) => void;
  onCtxAction: (id: string) => void;
}

export function useTrackContextMenu(opts: UseTrackContextMenuOptions): UseTrackContextMenuApi {
  const ctxOpen = ref(false);
  const ctxX = ref(0);
  const ctxY = ref(0);
  const ctxTrack = shallowRef<Track | null>(null);

  const ctxActions = computed<CtxActionDef[]>(() => {
    const t = ctxTrack.value;
    if (!t) return [];
    return opts.actionsFor(t);
  });

  function openTrackCtx(e: MouseEvent, track: Track): void {
    e.preventDefault();
    ctxX.value = e.clientX;
    ctxY.value = e.clientY;
    ctxTrack.value = track;
    ctxOpen.value = true;
  }

  function onCtxAction(id: string): void {
    const t = ctxTrack.value;
    if (!t) return;
    if (id === "reload-cover") {
      forceReloadTrackCover(t);
      return;
    }
    if (id === "reload-cover-full-file") {
      forceReloadTrackCoverFromFullFile(t);
      return;
    }
    opts.onAction(id, t);
  }

  return { ctxOpen, ctxX, ctxY, ctxTrack, ctxActions, openTrackCtx, onCtxAction };
}

/**
 * Preset used by LikesView + PlaylistView — both views show the same
 * "queue / playlist / download / source" action set.
 */
export function libraryTrackActions(track: Track): CtxActionDef[] {
  const canReadFullEmbeddedCover = fullFileEmbeddedCoverAvailableForTrack(track);
  return [
    { id: "reload-cover", label: "Загрузить обложку", icon: "cover" },
    {
      id: "reload-cover-full-file",
      label: "Обложка из полного файла",
      icon: "cover",
      disabled: !canReadFullEmbeddedCover,
    },
    { id: "divider" },
    { id: "queue", label: "В очередь", icon: "queue" },
    { id: "playlist", label: "В плейлист", icon: "playlist" },
    { id: "download", label: "Скачать", icon: "download", disabled: !canDownload(track) },
    { id: "divider" },
    { id: "source", label: sourceContextLabel(track), icon: "source" },
  ];
}
