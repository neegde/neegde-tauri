import { emit, emitTo } from "@tauri-apps/api/event";
import { getVisualizerAnalyser } from "./equalizerGraph.js";

export const PLAYER_VIZ_EVENT = "player-viz-frame";
export const PLAYER_VIZ_BC = "neegde-player-viz";

let rafId = 0;
let playingFlag = false;
/** WebviewWindow label — без него второе окно Tauri часто не получает кадры (emit шлёт не туда). */
let emitTargetLabel = null;
/** @type {BroadcastChannel | null} */
let bc = null;

/**
 * Returns true when running inside the Tauri webview (not plain browser dev server).
 *
 * Returns:
 *     Whether Tauri APIs are available.
 */
function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Downsamples byte frequency data to a fixed length for IPC.
 *
 * Args:
 *     src: Source frequency bins from AnalyserNode.
 *     out: Preallocated output array (reused).
 */
function downsampleFreq(src, out) {
  const sl = src.length;
  const ol = out.length;
  for (let i = 0; i < ol; i++) {
    const a = Math.floor((i / ol) * sl);
    const b = Math.min(sl - 1, Math.floor(((i + 1) / ol) * sl));
    let m = 0;
    for (let j = a; j <= b; j++) m = Math.max(m, src[j]);
    out[i] = m;
  }
}

/**
 * Copies a prefix of time-domain samples for the oscilloscope preset.
 *
 * Args:
 *     src: Time-domain bytes from AnalyserNode.
 *     out: Target buffer (length <= src.length).
 */
function copyTimePrefix(src, out) {
  const n = Math.min(src.length, out.length);
  for (let i = 0; i < n; i++) out[i] = src[i];
}

const FREQ_OUT = new Uint8Array(128);
const TIME_OUT = new Uint8Array(512);

/**
 * Emits one compressed spectrum snapshot for the detached visualizer window.
 *
 * Args:
 *     tMs: requestAnimationFrame timestamp (ms).
 */
function tick(tMs) {
  rafId = requestAnimationFrame(tick);
  const analyser = getVisualizerAnalyser();
  const tSec = tMs / 1000;
  let hasData = false;

  if (analyser) {
    const fc = analyser.frequencyBinCount;
    const ts = analyser.fftSize;
    const rawFreq = new Uint8Array(fc);
    const rawTime = new Uint8Array(ts);
    analyser.getByteFrequencyData(rawFreq);
    analyser.getByteTimeDomainData(rawTime);
    downsampleFreq(rawFreq, FREQ_OUT);
    copyTimePrefix(rawTime, TIME_OUT);
    hasData = true;
  } else {
    FREQ_OUT.fill(0);
    TIME_OUT.fill(128);
  }

  const payload = {
    tSec,
    hasData,
    playing: playingFlag,
    freq: Array.from(FREQ_OUT),
    time: Array.from(TIME_OUT),
  };

  if (isTauriRuntime()) {
    if (emitTargetLabel) {
      void emitTo(
        { kind: "WebviewWindow", label: emitTargetLabel },
        PLAYER_VIZ_EVENT,
        payload,
      );
    }
    void emit(PLAYER_VIZ_EVENT, payload);
  }
  if (bc) {
    bc.postMessage(payload);
  }
}

/**
 * Starts the per-frame broadcaster (only one instance at a time).
 * Для второго окна Tauri сначала вызовите setVisualizerEmitTarget(label).
 */
export function startVisualizerBroadcast() {
  if (rafId) return;
  if (typeof BroadcastChannel !== "undefined") {
    bc = new BroadcastChannel(PLAYER_VIZ_BC);
  }
  rafId = requestAnimationFrame(tick);
}

/**
 * Цель для emitTo — label из WebviewWindow (тот же, что при создании окна).
 *
 * Args:
 *     label: Строка label или null чтобы снова слать emit всем.
 */
export function setVisualizerEmitTarget(label) {
  emitTargetLabel = typeof label === "string" && label.length > 0 ? label : null;
}

/**
 * Stops spectrum broadcasting and closes the BroadcastChannel when used.
 */
export function stopVisualizerBroadcast() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  emitTargetLabel = null;
  if (bc) {
    bc.close();
    bc = null;
  }
}

/**
 * Mirrors player «playing» so the child window can dim idle motion correctly.
 *
 * Args:
 *     v: Whether the track is currently playing.
 */
export function setVisualizerBroadcastPlaying(v) {
  playingFlag = Boolean(v);
}
