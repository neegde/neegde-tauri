<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import { listen } from "@tauri-apps/api/event";
import { visualizerDrawFrame } from "./audio/visualizerDrawFrame.js";
import {
  PLAYER_VIZ_BC,
  PLAYER_VIZ_EVENT,
} from "./audio/visualizerBroadcast.js";
import { buildStarField } from "./components/player/visualizerPresets.js";

const PRESET_KEYS = ["bloom", "meridian", "aurora", "lattice"];

const canvasRef = ref(null);
const presetId = ref("bloom");

const STORAGE_KEY = "neegde.player.viz.preset";

function loadSavedPreset() {
  if (typeof localStorage === "undefined") return "bloom";
  const v = localStorage.getItem(STORAGE_KEY);
  if (v && PRESET_KEYS.includes(v)) return v;
  return "bloom";
}

presetId.value = loadSavedPreset();

watch(presetId, (v) => {
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, v);
});

/** @type {import("@tauri-apps/api/event").UnlistenFn | null} */
let unlistenEvent = null;
/** @type {BroadcastChannel | null} */
let bc = null;

let rafId = 0;
/** @type {{ playing: boolean, hasData: boolean } | null} */
let lastRemote = null;
const freqU8 = new Uint8Array(128);
const timeU8 = new Uint8Array(512);
timeU8.fill(128);
const bloomSmooth = new Float32Array(128);
const auroraCols = new Float32Array(56);
const stars = buildStarField(26, "neegde-viz-lattice-v1");

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Applies spectrum payload from главного окна.
 *
 * Args:
 *     p: Event payload с freq/time массивами.
 */
function applyRemote(p) {
  if (!p) return;
  const nf = p.freq?.length ?? 0;
  const nt = p.time?.length ?? 0;
  for (let i = 0; i < freqU8.length; i++) {
    freqU8[i] = nf ? p.freq[Math.min(i, nf - 1)] : 0;
  }
  for (let i = 0; i < timeU8.length; i++) {
    timeU8[i] = nt ? p.time[Math.min(i, nt - 1)] : 128;
  }
  lastRemote = { playing: Boolean(p.playing), hasData: Boolean(p.hasData) };
}

/**
 * Draws one frame (idle без входящих пакетов тоже рисуется).
 *
 * Args:
 *     tMs: requestAnimationFrame time.
 */
function frame(tMs) {
  rafId = requestAnimationFrame(frame);
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  let w = canvas.width / dpr;
  let h = canvas.height / dpr;
  if (w < 2 || h < 2) {
    resizeCanvas();
    w = canvas.width / dpr;
    h = canvas.height / dpr;
  }
  if (w < 2 || h < 2) {
    w = Math.max(2, window.innerWidth);
    h = Math.max(2, window.innerHeight);
  }
  const timeSec = tMs / 1000;
  const effectivePlay = Boolean(lastRemote?.playing && lastRemote?.hasData);

  visualizerDrawFrame({
    ctx,
    w,
    h,
    timeSec,
    presetId: presetId.value,
    effectivePlay,
    freq: freqU8,
    timeDomain: timeU8,
    bloomSmooth,
    auroraCols,
    stars,
  });
}

function resizeCanvas() {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(2, Math.floor(window.innerWidth));
  const H = Math.max(2, Math.floor(window.innerHeight));
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function onWinResize() {
  resizeCanvas();
}

onMounted(async () => {
  document.documentElement.setAttribute(
    "data-theme",
    localStorage.getItem("theme") || "dark",
  );

  if (typeof BroadcastChannel !== "undefined") {
    bc = new BroadcastChannel(PLAYER_VIZ_BC);
    bc.onmessage = (ev) => applyRemote(ev.data);
  }

  if (isTauriRuntime()) {
    unlistenEvent = await listen(PLAYER_VIZ_EVENT, (e) => {
      applyRemote(e.payload);
    });
  }

  window.addEventListener("storage", (ev) => {
    if (ev.key === STORAGE_KEY && ev.newValue && PRESET_KEYS.includes(ev.newValue)) {
      presetId.value = ev.newValue;
    }
  });
  window.addEventListener("resize", onWinResize);

  await nextTick();
  resizeCanvas();
  requestAnimationFrame(() => resizeCanvas());
  rafId = requestAnimationFrame(frame);
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  window.removeEventListener("resize", onWinResize);
  if (unlistenEvent) unlistenEvent();
  if (bc) bc.close();
});
</script>

<template>
  <div class="player-viz-standalone">
    <canvas ref="canvasRef" class="pvz-canvas" />
  </div>
</template>

<style scoped>
.player-viz-standalone {
  position: fixed;
  inset: 0;
  margin: 0;
  overflow: hidden;
  background: #0c0b0a;
}

.pvz-canvas {
  display: block;
  width: 100vw;
  height: 100vh;
  vertical-align: top;
}
</style>
