import { createApp } from "vue";
import "./style.css";
import "./audio/equalizerState.js";
import App from "./App.vue";
import AppDebugWindow from "./AppDebugWindow.vue";
import PlayerVizStandalone from "./PlayerVizStandalone.vue";
import { appDebugLog } from "./appDebugLog.js";

const hash = window.location.hash || "";
const isAppDebugWindow =
  hash === "#/app-debug" ||
  hash.startsWith("#/app-debug") ||
  hash === "#/streaming-debug" ||
  hash.startsWith("#/streaming-debug");
const isPlayerVizWindow = hash === "#/player-viz" || hash.startsWith("#/player-viz");

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

function serializeArg(a: unknown): string {
  if (a === null) return "null";
  if (a === undefined) return "undefined";
  if (a instanceof Error) return a.stack ?? String(a);
  if (typeof a === "object") {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

// Route ALL console output exclusively to the in-app debug window.
// Skip the debug/viz windows themselves to avoid echo loops.
if (!isAppDebugWindow && !isPlayerVizWindow) {
  for (const method of ["log", "info", "warn", "error", "debug"] as ConsoleMethod[]) {
    (console[method] as (...args: unknown[]) => void) = (...args: unknown[]) => {
      const category = method === "log" || method === "debug" ? "js" : method;
      void appDebugLog(category, args.map(serializeArg).join(" ")).catch(() => {});
    };
  }

  window.addEventListener("error", (ev) => {
    const msg = ev.error instanceof Error ? (ev.error.stack ?? String(ev.error)) : ev.message;
    void appDebugLog("error", `uncaught: ${msg}`).catch(() => {});
  });

  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const r: unknown = ev.reason;
    const msg = r instanceof Error ? (r.stack ?? String(r)) : String(r);
    void appDebugLog("error", `unhandled rejection: ${msg}`).catch(() => {});
  });
}

if (isAppDebugWindow) {
  createApp(AppDebugWindow).mount("#app");
} else if (isPlayerVizWindow) {
  createApp(PlayerVizStandalone).mount("#app");
} else {
  createApp(App).mount("#app");
}
