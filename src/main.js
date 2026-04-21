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

// Route all console output to the in-app debug window.
// Original behaviour (DevTools console) is preserved.
// Skip patching inside the debug window itself to avoid echo loops.
if (!isAppDebugWindow && !isPlayerVizWindow) {
  for (const method of ["log", "info", "warn", "error"]) {
    console[method] = (...args) => {
      const message = args
        .map((a) => {
          if (a === null) return "null";
          if (a === undefined) return "undefined";
          if (typeof a === "object") {
            try { return JSON.stringify(a); } catch { return String(a); }
          }
          return String(a);
        })
        .join(" ");
      appDebugLog(method === "log" ? "js" : method, message).catch(() => {});
    };
  }
}

if (isAppDebugWindow) {
  createApp(AppDebugWindow).mount("#app");
} else if (isPlayerVizWindow) {
  createApp(PlayerVizStandalone).mount("#app");
} else {
  createApp(App).mount("#app");
}
