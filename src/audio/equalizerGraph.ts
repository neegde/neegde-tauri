import { EQ_BANDS } from "./equalizerConfig.js";

let audioContext: AudioContext | null = null;

interface EqualizerHandle {
  audio: HTMLMediaElement;
  source: MediaElementAudioSourceNode;
  filters: BiquadFilterNode[];
  ctx: AudioContext;
  outputGain: GainNode;
  analyser: AnalyserNode;
}

let active: EqualizerHandle | null = null;

const VIS_FFT_SIZE = 2048;

export function getEqualizerAudioContext(): AudioContext | null {
  return audioContext;
}

function getOrCreateContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext({ latencyHint: "playback" });
  }
  return audioContext;
}

/**
 * Подключает цепочку peaking-фильтров к элементу (один раз на элемент).
 * Громкость выводится через GainNode: в WebView volume у media-элемента часто не влияет на граф.
 */
export function ensureEqualizer(
  audio: HTMLMediaElement | null,
  gainsDb: number[],
): EqualizerHandle | null {
  if (!audio) {
    destroyEqualizer();
    return null;
  }

  if (active?.audio === audio) {
    setEqualizerGains(gainsDb);
    return active;
  }

  destroyEqualizer();

  const ctx = getOrCreateContext();
  let source: MediaElementAudioSourceNode;
  try {
    source = ctx.createMediaElementSource(audio);
  } catch (e) {
    console.error("[equalizer] createMediaElementSource failed", e);
    return null;
  }
  const filters: BiquadFilterNode[] = [];

  let node: AudioNode = source;
  for (let i = 0; i < EQ_BANDS.length; i++) {
    const f = ctx.createBiquadFilter();
    f.type = "peaking";
    f.frequency.value = EQ_BANDS[i]!.freq;
    f.Q.value = 1.2;
    f.gain.value = gainsDb[i] ?? 0;
    node.connect(f);
    node = f;
    filters.push(f);
  }
  const outputGain = ctx.createGain();
  outputGain.gain.value = 1;
  node.connect(outputGain);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = VIS_FFT_SIZE;
  analyser.smoothingTimeConstant = 0.75;
  analyser.minDecibels = -85;
  analyser.maxDecibels = -12;
  outputGain.connect(analyser);
  analyser.connect(ctx.destination);

  active = { audio, source, filters, ctx, outputGain, analyser };
  return active;
}

export function isEqualizerActive(): boolean {
  return active != null;
}

/** Линейная громкость 0…1 на выходе цепочки (вместо HTMLMediaElement.volume). */
export function setEqualizerOutputGain(linear: number): void {
  if (!active?.outputGain) return;
  const g = Number(linear);
  if (!Number.isFinite(g)) return;
  active.outputGain.gain.value = Math.min(1, Math.max(0, g));
}

export function setEqualizerGains(gainsDb: number[]): void {
  if (!active?.filters?.length) return;
  for (let i = 0; i < active.filters.length; i++) {
    const v = gainsDb[i];
    active.filters[i]!.gain.value =
      typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
}

export function destroyEqualizer(): void {
  if (!active) return;
  try {
    active.source.disconnect();
    for (const f of active.filters) f.disconnect();
    active.outputGain?.disconnect();
    active.analyser?.disconnect();
  } catch {
    /* элемент уже уничтожен */
  }
  active = null;
}

/** Shared analyser after the EQ chain, or null when no graph is active. */
export function getVisualizerAnalyser(): AnalyserNode | null {
  return active?.analyser ?? null;
}

export async function resumeEqualizerContext(): Promise<void> {
  const ctx = audioContext;
  if (ctx && ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }
}
