import { ref, onMounted } from "vue";
import type { Update } from "@tauri-apps/plugin-updater";

export function simpleMarkdown(md: string): string {
  if (!md) return "";
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;

  function inline(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
  }

  for (const raw of lines) {
    const esc = raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    if (/^###\s/.test(raw)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h4>${inline(esc.slice(4))}</h4>`);
    } else if (/^##\s/.test(raw)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h3>${inline(esc.slice(3))}</h3>`);
    } else if (/^#\s/.test(raw)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h2>${inline(esc.slice(2))}</h2>`);
    } else if (/^[-*]\s/.test(raw)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(esc.slice(2))}</li>`);
    } else if (raw.trim() === "") {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<div class="update-notes-gap"></div>`);
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${inline(esc)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

export function useAppUpdate() {
  const updateAvailable = ref(false);
  const updateVersion = ref("");
  const updateDate = ref("");
  const updateNotesHtml = ref("");
  const dialogOpen = ref(false);
  const installing = ref(false);
  const installProgress = ref(0);
  const installError = ref("");

  let pendingUpdate: Update | null = null;

  onMounted(async () => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update?.available) {
        pendingUpdate = update;
        updateVersion.value = update.version;
        updateDate.value = update.date
          ? new Date(update.date).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
          : "";
        updateNotesHtml.value = simpleMarkdown(update.body ?? "");
        updateAvailable.value = true;
        dialogOpen.value = true;
      }
    } catch {
      // No network or no release manifest yet — silent
    }
  });

  async function installUpdate() {
    if (installing.value || !pendingUpdate) return;
    installing.value = true;
    installError.value = "";
    installProgress.value = 0;
    try {
      let downloaded = 0;
      let total = 0;
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          installProgress.value = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
        } else if (event.event === "Finished") {
          installProgress.value = 100;
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e: unknown) {
      installError.value = String((e as Error)?.message ?? e ?? "Ошибка установки");
      installing.value = false;
    }
  }

  function dismissUpdate() {
    dialogOpen.value = false;
  }

  function showUpdateDialog() {
    if (updateAvailable.value) dialogOpen.value = true;
  }

  return {
    updateAvailable,
    updateVersion,
    updateDate,
    updateNotesHtml,
    dialogOpen,
    installing,
    installProgress,
    installError,
    installUpdate,
    dismissUpdate,
    showUpdateDialog,
  };
}
