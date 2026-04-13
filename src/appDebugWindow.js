import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const APP_DEBUG_WINDOW_LABEL = "app-debug";

/**
 * Opens or focuses the application debug log in a dedicated Tauri window.
 *
 * Returns:
 *     Promise that resolves when the window exists (created or already open).
 */
export async function openAppDebugWindow() {
  const existing = await WebviewWindow.getByLabel(APP_DEBUG_WINDOW_LABEL);
  if (existing) {
    // Check if the window is actually alive
    const visible = await existing.isVisible().catch(() => null);
    if (visible) {
      await existing.setFocus().catch(() => {});
      return existing;
    }
    // Window is dead/closed but the label is still registered — destroy it
    // so Tauri frees the label before we create a new window with the same label.
    await existing.destroy().catch(() => {});
  }

  const win = new WebviewWindow(APP_DEBUG_WINDOW_LABEL, {
    url: "index.html#/app-debug",
    title: "Журнал отладки",
    width: 920,
    height: 640,
    minWidth: 420,
    minHeight: 260,
    resizable: true,
    center: true,
  });
  return new Promise((resolve, reject) => {
    win.once("tauri://created", () => resolve(win));
    win.once("tauri://error", (e) => reject(e));
  });
}
