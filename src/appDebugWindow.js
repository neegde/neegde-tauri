import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const APP_DEBUG_WINDOW_LABEL = "app-debug";

/** Module-level reference — cleared via tauri://destroyed so we always know the real state. */
let _win = null;

/**
 * Opens or focuses the application debug log in a dedicated Tauri window.
 *
 * Returns:
 *     Promise that resolves when the window exists (created or already open).
 */
export async function openAppDebugWindow() {
  if (_win) {
    const visible = await _win.isVisible().catch(() => false);
    if (visible) {
      await _win.setFocus().catch(() => {});
      return _win;
    }
    // Window exists but isn't visible — on macOS the red-X hides rather than
    // destroys; call destroy() explicitly so the label is freed, then recreate.
    await _win.destroy().catch(() => {});
    _win = null;
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
  _win = win;

  // Keep _win in sync: clear it when the window is closed/destroyed
  win.once("tauri://destroyed", () => {
    if (_win === win) _win = null;
  });

  return new Promise((resolve, reject) => {
    win.once("tauri://created", () => resolve(win));
    win.once("tauri://error", (e) => {
      if (_win === win) _win = null;
      reject(e);
    });
  });
}
