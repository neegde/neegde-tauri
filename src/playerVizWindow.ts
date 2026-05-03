import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  startVisualizerBroadcast,
  stopVisualizerBroadcast,
  setVisualizerEmitTarget,
} from "./audio/visualizerBroadcast.js";

export const PLAYER_VIZ_WINDOW_LABEL = "player-viz";

let _win: WebviewWindow | null = null;
let _seq = 0;

function _makeLabel(): string {
  return `${PLAYER_VIZ_WINDOW_LABEL}-${++_seq}`;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Opens the visualizer in a small secondary window (Tauri) or a browser popup (dev). */
export async function openPlayerVizWindow(): Promise<WebviewWindow | null> {
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

    return new Promise<WebviewWindow>((resolve, reject) => {
      win.once("tauri://created", () => {
        setVisualizerEmitTarget(label);
        startVisualizerBroadcast();
        resolve(win);
      });
      win.once("tauri://error", (e: unknown) => {
        if (_win === win) _win = null;
        reject(e);
      });
    });
  }

  const url = `${window.location.origin}${window.location.pathname}#/player-viz`;
  window.open(url, "neegde-player-viz", "noopener,noreferrer,width=520,height=420");
  startVisualizerBroadcast();
  return null;
}

/** Closes the detached visualizer if it was opened via Tauri. */
export async function closePlayerVizWindow(): Promise<void> {
  stopVisualizerBroadcast();
  if (_win) {
    await _win.close().catch(() => {});
    _win = null;
  }
}
