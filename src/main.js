import { createApp } from "vue";
import "./style.css";
import "./audio/equalizerState.js";
import App from "./App.vue";
import AppDebugWindow from "./AppDebugWindow.vue";

const hash = window.location.hash || "";
const isAppDebugWindow =
  hash === "#/app-debug" ||
  hash.startsWith("#/app-debug") ||
  hash === "#/streaming-debug" ||
  hash.startsWith("#/streaming-debug");

if (isAppDebugWindow) {
  createApp(AppDebugWindow).mount("#app");
} else {
  createApp(App).mount("#app");
}
