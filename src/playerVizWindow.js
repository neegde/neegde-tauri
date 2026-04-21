import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  startVisualizerBroadcast,
  stopVisualizerBroadcast,
  setVisualizerEmitTarget,
} from "./audio/visualizerBroadcast.js";

export const PLAYER_VIZ_WINDOW_LABEL = "player-viz";

/** @type {import("@tauri-apps/api/webviewWindow").WebviewWindow | null} */
let _win = null;
let _seq = 0;

function _makeLabel() {
  return `${PLAYER_VIZ_WINDOW_LABEL}-${++_seq}`;
}

/**
 * Returns true when running inside the Tauri shell.
 *
 * Returns:
 *     Whether Tauri webview globals are present.
 */
function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Opens the visualizer in a small secondary window (Tauri) or a browser popup (dev).
 *
 * Returns:
 *     Promise resolving when the window is ready or rejecting on error.
 */
export async function openPlayerVizWindow() {
  if (isTauriRuntime()) {
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
      url: "index.html#/player-viz",
      title: "Визуализация",
      width: 520,
      height: 420,
      minWidth: 320,
      minHeight: 260,
      resizable: true,
      center: true,
    });
    _win = win;

    win.once("tauri://destroyed", () => {
      if (_win === win) _win = null;
      stopVisualizerBroadcast();
    });

    return new Promise((resolve, reject) => {
      win.once("tauri://created", () => {
        setVisualizerEmitTarget(label);
        startVisualizerBroadcast();
        resolve(win);
      });
      win.once("tauri://error", (e) => {
        if (_win === win) _win = null;
        reject(e);
      });
    });
  }

  const url = `${window.location.origin}${window.location.pathname}#/player-viz`;
  window.open(url, "neegde-player-viz", "noopener,noreferrer,width=520,height=420");
  startVisualizerBroadcast();
  return Promise.resolve(null);
}

/**
 * Closes the detached visualizer if it was opened via Tauri.
 */
export async function closePlayerVizWindow() {
  stopVisualizerBroadcast();
  if (_win) {
    await _win.close().catch(() => {});
    _win = null;
  }
}
