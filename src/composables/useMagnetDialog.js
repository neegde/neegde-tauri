/**
 * Magnet-link paste dialog state + submit flow.
 *
 * Owns `magnetPanelOpen` / `magnetDraft` / `magnetError` and the submit path
 * that parses a pasted blob, resolves its btih, fetches the file list, and
 * installs a synthetic torrent row into `selected`. Deep torrent-state
 * coupling is kept inside this composable instead of bleeding into App.vue.
 */

import { ref } from "vue";
import { extractMagnetUri, parseBtihFromMagnet, magnetTitleFromMagnet } from "../lib/magnet.js";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { magnetListFiles } from "../torrent/api.js";
import { torrentPrepareCancel } from "../torrent/torrentSession.js";

/**
 * @param {{
 *   selected: import("vue").Ref<object | null>,
 *   files: import("vue").Ref<Array<object>>,
 *   torrentMagnet: import("vue").Ref<string>,
 *   torrentCover: import("vue").Ref<string | null>,
 *   torrentFilesBeforeAlbumPreview: import("vue").Ref<Array<object> | null>,
 *   torrentSelectedBeforeAlbumPreview: import("vue").Ref<object | null>,
 *   loadingFiles: import("vue").Ref<boolean>,
 *   view: import("vue").Ref<string>,
 *   error: import("vue").Ref<string | null>,
 *   forwardStack: import("vue").Ref<Array<object>>,
 *   backStack: import("vue").Ref<Array<object>>,
 *   snapshotTorrentForBack: () => object,
 *   snapshotSearchForBack: () => object,
 *   mainRef: import("vue").Ref<HTMLElement | null>,
 * }} ctx
 */
export function useMagnetDialog(ctx) {
  const magnetPanelOpen = ref(false);
  const magnetDraft = ref("");
  const magnetError = ref(null);

  async function submitMagnetLink() {
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

    const synthetic = {
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
      const rawFiles = await magnetListFiles(enriched);
      ctx.torrentMagnet.value = enriched;
      ctx.files.value = rawFiles.map((f, i) => ({
        name: f.path[f.path.length - 1] ?? "",
        path: f.path.join("/"),
        size: f.size,
        idx: i,
        origIdx: i,
      }));
      magnetPanelOpen.value = false;
      magnetDraft.value = "";
      if (ctx.mainRef.value) ctx.mainRef.value.scrollTo(0, 0);
    } catch (e) {
      console.error("submitMagnetLink:", e);
      magnetError.value = String(e?.message ?? e);
      ctx.backStack.value.pop();
      ctx.selected.value = null;
      ctx.files.value = [];
      ctx.torrentMagnet.value = "";
      ctx.torrentCover.value = null;
    } finally {
      ctx.loadingFiles.value = false;
    }
  }

  function closeMagnetPanel() {
    if (
      ctx.loadingFiles.value &&
      ctx.selected.value?.source === "magnet" &&
      !ctx.torrentMagnet.value
    ) {
      torrentPrepareCancel();
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
