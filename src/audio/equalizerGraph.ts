/**
 * Thin delegate on top of the unified {@link ./Equalizer.ts} singleton.
 * Exposes the WebAudio graph lifecycle with the legacy function names used
 * by the player composable, visualizer modal, and broadcast channel.
 */

import { equalizer } from "./Equalizer.js";

export function getEqualizerAudioContext(): AudioContext | null {
  return equalizer.getAudioContext();
}

export function ensureEqualizer(
  audio: HTMLMediaElement | null,
  gainsDb: number[],
): ReturnType<typeof equalizer.ensure> {
  return equalizer.ensure(audio, gainsDb);
}

export function isEqualizerActive(): boolean {
  return equalizer.isActive();
}

export function setEqualizerOutputGain(linear: number): void {
  equalizer.setOutputGain(linear);
}

export function setEqualizerGains(gainsDb: number[]): void {
  equalizer.setGains(gainsDb);
}

export function destroyEqualizer(): void {
  equalizer.destroy();
}

export function getVisualizerAnalyser(): AnalyserNode | null {
  return equalizer.getAnalyser();
}

export async function resumeEqualizerContext(): Promise<void> {
  await equalizer.resumeContext();
}
