import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const APP_DEBUG_WINDOW_LABEL = "app-debug";

let _win: WebviewWindow | null = null;
/** Monotonically increasing suffix — guarantees a fresh label even if Tauri's
 *  backend hasn't freed the old one yet, eliminating tauri://error on recreation. */
let _seq = 0;

function _makeLabel(): string {
  return `${APP_DEBUG_WINDOW_LABEL}-${++_seq}`;
}

/** Opens or focuses the application debug log in a dedicated Tauri window. */
export async function openAppDebugWindow(): Promise<WebviewWindow> {
  if (_win) {
    const visible = await _win.isVisible().catch(() => false);
    if (visible) {
      await _win.setFocus().catch(() => {});
      return _win;
    }
    await _win.destroy().catch(() => {});
    _win = null;
  }

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

  return new Promise<WebviewWindow>((resolve, reject) => {
    win.once("tauri://created", () => resolve(win));
    win.once("tauri://error", (e: unknown) => {
      if (_win === win) _win = null;
      reject(e);
    });
  });
}

/** Closes the debug window if it is open. */
export async function closeAppDebugWindow(): Promise<void> {
  if (_win) {
    await _win.close().catch(() => {});
    _win = null;
  }
}
