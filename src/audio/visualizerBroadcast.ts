import { emit, emitTo } from "@tauri-apps/api/event";
import { getVisualizerAnalyser } from "./equalizerGraph.js";

export const PLAYER_VIZ_EVENT = "player-viz-frame";
export const PLAYER_VIZ_BC = "neegde-player-viz";

let rafId = 0;
let playingFlag = false;
let emitTargetLabel: string | null = null;
let bc: BroadcastChannel | null = null;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function downsampleFreq(src: Uint8Array, out: Uint8Array): void {
  const sl = src.length;
  const ol = out.length;
  for (let i = 0; i < ol; i++) {
    const a = Math.floor((i / ol) * sl);
    const b = Math.min(sl - 1, Math.floor(((i + 1) / ol) * sl));
    let m = 0;
    for (let j = a; j <= b; j++) m = Math.max(m, src[j]!);
    out[i] = m;
  }
}

function copyTimePrefix(src: Uint8Array, out: Uint8Array): void {
  const n = Math.min(src.length, out.length);
  for (let i = 0; i < n; i++) out[i] = src[i]!;
}

const FREQ_OUT = new Uint8Array(128);
const TIME_OUT = new Uint8Array(512);

function tick(tMs: number): void {
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

export function startVisualizerBroadcast(): void {
  if (rafId) return;
  if (typeof BroadcastChannel !== "undefined") {
    bc = new BroadcastChannel(PLAYER_VIZ_BC);
  }
  rafId = requestAnimationFrame(tick);
}

export function setVisualizerEmitTarget(label: string | null): void {
  emitTargetLabel = typeof label === "string" && label.length > 0 ? label : null;
}

export function stopVisualizerBroadcast(): void {
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

export function setVisualizerBroadcastPlaying(v: unknown): void {
  playingFlag = Boolean(v);
}
