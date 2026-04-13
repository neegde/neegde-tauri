import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const APP_DEBUG_WINDOW_LABEL = "app-debug";

/** Module-level reference to the live debug window (null when closed/never opened). */
let _win = null;
/** Monotonically increasing suffix — guarantees a fresh label even if Tauri's
 *  backend hasn't freed the old one yet, eliminating tauri://error on recreation. */
let _seq = 0;

function _makeLabel() {
  return `${APP_DEBUG_WINDOW_LABEL}-${++_seq}`;
}

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
    // Not visible — destroy explicitly so macOS-hidden windows are cleaned up.
    await _win.destroy().catch(() => {});
    _win = null;
  }

  // Use a unique label each time: eliminates any label-conflict tauri://error
  // that would occur if the backend hasn't freed the previous label yet.
  const label = _makeLabel();
  const win = new WebviewWindow(label, {
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

/**
 * Closes the debug window if it is open.
 */
export async function closeAppDebugWindow() {
  if (_win) {
    await _win.close().catch(() => {});
    _win = null;
  }
}
