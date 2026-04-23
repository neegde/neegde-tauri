/**
 * Magnet-link paste dialog state + submit flow.
 */

import { ref, type Ref } from "vue";
import { extractMagnetUri, parseBtihFromMagnet, magnetTitleFromMagnet } from "../lib/magnet.js";
import { enrichMagnetWithOpenTrackers, type FileRow } from "../lib/utils.js";
import { magnetListFiles } from "../torrent/api.js";
import { torrentPrepareCancel } from "../torrent/torrentSession.js";

interface TorrentLike {
  id?: string | number;
  source?: string;
  [k: string]: unknown;
}

export interface UseMagnetDialogCtx {
  selected: Ref<TorrentLike | null>;
  files: Ref<FileRow[]>;
  torrentMagnet: Ref<string>;
  torrentCover: Ref<string | null>;
  torrentFilesBeforeAlbumPreview: Ref<FileRow[] | null>;
  torrentSelectedBeforeAlbumPreview: Ref<TorrentLike | null>;
  loadingFiles: Ref<boolean>;
  view: Ref<string>;
  error: Ref<string | null>;
  forwardStack: Ref<unknown[]>;
  backStack: Ref<unknown[]>;
  snapshotTorrentForBack: () => unknown;
  snapshotSearchForBack: () => unknown;
  mainRef: Ref<HTMLElement | null>;
}

export function useMagnetDialog(ctx: UseMagnetDialogCtx) {
  const magnetPanelOpen = ref<boolean>(false);
  const magnetDraft = ref<string>("");
  const magnetError = ref<string | null>(null);

  async function submitMagnetLink(): Promise<void> {
    magnetError.value = null;
    const extracted = extractMagnetUri(magnetDraft.value);
    if (!extracted) {
      magnetError.value = "Вставьте magnet-ссылку (начинается с magnet:?)";
      return;
    }
    if (!extracted.toLowerCase().includes("btih:")) {
      magnetError.value = "В ссылке нет info hash (btih)";
      return;
    }
    const enriched = enrichMagnetWithOpenTrackers(extracted);
    const btih = parseBtihFromMagnet(enriched);
    if (!btih) {
      magnetError.value = "Не удалось разобрать hash раздачи";
      return;
    }
    const syntheticId = `magnet-${btih}`;
    if (ctx.selected.value?.id === syntheticId) {
      magnetPanelOpen.value = false;
      magnetDraft.value = "";
      ctx.forwardStack.value = [];
      ctx.backStack.value = [];
      ctx.selected.value = null;
      ctx.files.value = [];
      ctx.torrentMagnet.value = "";
      ctx.torrentCover.value = null;
      ctx.torrentFilesBeforeAlbumPreview.value = null;
      ctx.torrentSelectedBeforeAlbumPreview.value = null;
      return;
    }

    const synthetic: TorrentLike = {
      id: syntheticId,
      name: magnetTitleFromMagnet(enriched),
      category: "—",
      size: 0,
      seeders: "?",
      leechers: 0,
      added: "—",
      source: "magnet",
    };

    if (ctx.selected.value) ctx.backStack.value.push(ctx.snapshotTorrentForBack());
    else                    ctx.backStack.value.push(ctx.snapshotSearchForBack());

    ctx.forwardStack.value = [];
    ctx.torrentFilesBeforeAlbumPreview.value = null;
    ctx.torrentSelectedBeforeAlbumPreview.value = null;
    ctx.selected.value = synthetic;
    ctx.files.value = [];
    ctx.torrentMagnet.value = "";
    ctx.torrentCover.value = null;
    ctx.loadingFiles.value = true;
    ctx.view.value = "home";
    ctx.error.value = null;

    try {
      const rawFiles = await magnetListFiles(enriched) as Array<{ path: string[]; size: number }>;
      ctx.torrentMagnet.value = enriched;
      ctx.files.value = rawFiles.map((f, i) => ({
        name: f.path[f.path.length - 1] ?? "",
        path: f.path.join("/"),
        size: f.size,
        idx: i,
        origIdx: i,
      } as FileRow));
      magnetPanelOpen.value = false;
      magnetDraft.value = "";
      if (ctx.mainRef.value) ctx.mainRef.value.scrollTo(0, 0);
    } catch (e) {
      console.error("submitMagnetLink:", e);
      magnetError.value = String((e as { message?: string })?.message ?? e);
      ctx.backStack.value.pop();
      ctx.selected.value = null;
      ctx.files.value = [];
      ctx.torrentMagnet.value = "";
      ctx.torrentCover.value = null;
    } finally {
      ctx.loadingFiles.value = false;
    }
  }

  function closeMagnetPanel(): void {
    if (
      ctx.loadingFiles.value &&
      ctx.selected.value?.source === "magnet" &&
      !ctx.torrentMagnet.value
    ) {
      void torrentPrepareCancel();
      if (ctx.backStack.value.length > 0) ctx.backStack.value.pop();
      ctx.selected.value = null;
      ctx.files.value = [];
      ctx.torrentMagnet.value = "";
      ctx.torrentCover.value = null;
      ctx.loadingFiles.value = false;
    }
    magnetPanelOpen.value = false;
    magnetError.value = null;
  }

  return {
    magnetPanelOpen,
    magnetDraft,
    magnetError,
    submitMagnetLink,
    closeMagnetPanel,
  };
}
