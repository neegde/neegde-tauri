<script setup>
import { ref, watch, onUnmounted, nextTick } from "vue";
import {
  getVisualizerAnalyser,
  resumeEqualizerContext,
} from "../../audio/equalizerGraph.js";
import { visualizerDrawFrame } from "../../audio/visualizerDrawFrame.js";
import { PRESET_LABELS, buildStarField } from "./visualizerPresets.js";
import { openPlayerVizWindow } from "../../playerVizWindow.js";

const PRESET_KEYS = ["bloom", "meridian", "aurora", "lattice"];

const props = defineProps({
  open: Boolean,
  /** Whether the underlying player reports playback as active. */
  playing: Boolean,
});

const emit = defineEmits(["close"]);

const canvasRef = ref(null);
const canvasWrapRef = ref(null);
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

let rafId = 0;
/** @type {Uint8Array | null} */
let freqScratch = null;
/** @type {Uint8Array | null} */
let timeScratch = null;
const bloomSmooth = new Float32Array(128);
const auroraCols = new Float32Array(56);
const stars = buildStarField(26, "neegde-viz-lattice-v1");
const silentFreq = new Uint8Array(512);
const idleTimeDomain = new Uint8Array(2048);
idleTimeDomain.fill(128);

function resizeCanvas() {
  const canvas = canvasRef.value;
  const wrap = canvasWrapRef.value;
  if (!canvas || !wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  const W = Math.max(320, Math.floor(rect.width));
  const H = Math.max(200, Math.floor(rect.height));
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Single animation frame: spectrum-driven art or gentle idle motion.
 *
 * Args:
 *     tMs: Monotonic timestamp from requestAnimationFrame (milliseconds).
 */
function frame(tMs) {
  rafId = requestAnimationFrame(frame);
  const canvas = canvasRef.value;
  if (!canvas || !props.open) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const timeSec = tMs / 1000;

  const analyser = getVisualizerAnalyser();
  let freq = silentFreq;
  let hasData = false;

  if (analyser) {
    const fc = analyser.frequencyBinCount;
    const ts = analyser.fftSize;
    if (!freqScratch || freqScratch.length !== fc) freqScratch = new Uint8Array(fc);
    if (!timeScratch || timeScratch.length !== ts) timeScratch = new Uint8Array(ts);
    analyser.getByteFrequencyData(freqScratch);
    analyser.getByteTimeDomainData(timeScratch);
    freq = freqScratch;
    hasData = true;
  }

  const effectivePlay = Boolean(props.playing && hasData);

  visualizerDrawFrame({
    ctx,
    w,
    h,
    timeSec,
    presetId: presetId.value,
    effectivePlay,
    freq,
    timeDomain: timeScratch ?? idleTimeDomain,
    bloomSmooth,
    auroraCols,
    stars,
  });
}

function openDetached() {
  void openPlayerVizWindow().catch(() => {});
}

function onKey(e) {
  if (e.key === "Escape") emit("close");
}

watch(
  () => props.open,
  async (open) => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (open) {
      await resumeEqualizerContext();
      window.addEventListener("keydown", onKey);
      await nextTick();
      resizeCanvas();
      if (ro && canvasWrapRef.value) {
        ro.disconnect();
        ro.observe(canvasWrapRef.value);
      }
      void requestAnimationFrame(() => {
        resizeCanvas();
        rafId = requestAnimationFrame(frame);
      });
    } else {
      window.removeEventListener("keydown", onKey);
    }
  }
);

function onResize() {
  if (!props.open) return;
  resizeCanvas();
}

let ro;
if (typeof ResizeObserver !== "undefined") {
  ro = new ResizeObserver(() => {
    onResize();
  });
}

watch(
  () => [props.open, canvasWrapRef.value],
  () => {
    if (!props.open || !ro || !canvasWrapRef.value) return;
    ro.disconnect();
    ro.observe(canvasWrapRef.value);
  },
  { flush: "post" }
);

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  window.removeEventListener("keydown", onKey);
  ro?.disconnect();
});

function onBackdropClick() {
  emit("close");
}

function stop(e) {
  e.stopPropagation();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="viz-fs">
      <div
        v-if="open"
        class="viz-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Визуализация"
        @click="onBackdropClick"
      >
        <div class="viz-panel" @click="stop">
          <header class="viz-head">
            <div class="viz-title-group">
              <span class="viz-title">Плеер · визуализация</span>
              <span class="viz-sub">как в плеерах прошлого века, только мягче</span>
            </div>
            <div class="viz-head-actions">
              <button
                type="button"
                class="viz-external-btn"
                title="Открыть в отдельном окне (спектр из главного плеера)"
                @click="openDetached"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <rect x="3" y="3" width="9" height="9" rx="1.5"/>
                  <rect x="12" y="12" width="9" height="9" rx="1.5"/>
                  <path d="M12 9h3a3 3 0 0 1 3 3v3"/>
                  <path d="M9 15H6a3 3 0 0 1-3-3V9"/>
                </svg>
                <span>Окно</span>
              </button>
              <button type="button" class="viz-close" aria-label="Закрыть" @click="emit('close')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </header>

          <div class="viz-presets" role="tablist" aria-label="Пресеты">
            <button
              v-for="key in PRESET_KEYS"
              :key="key"
              type="button"
              role="tab"
              class="viz-pill"
              :class="{ 'viz-pill--active': presetId === key }"
              :aria-selected="presetId === key"
              @click="presetId = key"
            >
              {{ PRESET_LABELS[key] }}
            </button>
          </div>

          <div ref="canvasWrapRef" class="viz-canvas-wrap">
            <canvas ref="canvasRef" class="viz-canvas" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.viz-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  padding-bottom: calc(24px + var(--player-h, 90px));
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
}

.viz-panel {
  width: min(720px, 100%);
  height: min(86vh, 520px);
  max-height: min(86vh, 560px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--player-queue-shadow);
  overflow: hidden;
}

.viz-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--border);
}

.viz-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.viz-external-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--sidebar-bg);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.viz-external-btn:hover {
  color: var(--text);
  border-color: rgba(var(--accent-rgb), 0.35);
  background: rgba(var(--accent-rgb), 0.1);
}

.viz-title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.viz-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.02em;
}

.viz-sub {
  font-size: 12px;
  color: var(--muted2);
}

.viz-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.viz-close:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
}

.viz-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 18px 10px;
}

.viz-pill {
  border: 1px solid var(--border);
  background: var(--sidebar-bg);
  color: var(--muted);
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.viz-pill:hover {
  color: var(--text);
  border-color: rgba(255, 255, 255, 0.12);
}

.viz-pill--active {
  background: rgba(var(--accent-rgb), 0.18);
  border-color: rgba(var(--accent-rgb), 0.45);
  color: var(--accent-h);
}

.viz-canvas-wrap {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 12px 14px;
}

.viz-canvas {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 240px;
  border-radius: 10px;
  background: #0c0b0a;
}

.viz-fs-enter-active,
.viz-fs-leave-active {
  transition: opacity 0.2s ease;
}

.viz-fs-enter-active .viz-panel,
.viz-fs-leave-active .viz-panel {
  transition: transform 0.22s ease, opacity 0.22s ease;
}

.viz-fs-enter-from,
.viz-fs-leave-to {
  opacity: 0;
}

.viz-fs-enter-from .viz-panel,
.viz-fs-leave-to .viz-panel {
  transform: translateY(12px) scale(0.98);
  opacity: 0.85;
}
</style>
