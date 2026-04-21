import { EQ_BANDS } from "./equalizerConfig.js";

let audioContext = null;
/** @type {{ audio: HTMLMediaElement, source: MediaElementAudioSourceNode, filters: BiquadFilterNode[], outputGain: GainNode, analyser: AnalyserNode } | null} */
let active = null;

const VIS_FFT_SIZE = 2048;

export function getEqualizerAudioContext() {
  return audioContext;
}

function getOrCreateContext() {
  if (!audioContext) {
    audioContext = new AudioContext({ latencyHint: "playback" });
  }
  return audioContext;
}

/**
 * Подключает цепочку peaking-фильтров к элементу (один раз на элемент).
 * Громкость выводится через GainNode: в WebView volume у media-элемента часто не влияет на граф.
 */
export function ensureEqualizer(audio, gainsDb) {
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
  let source;
  try {
    source = ctx.createMediaElementSource(audio);
  } catch (e) {
    console.error("[equalizer] createMediaElementSource failed", e);
    return null;
  }
  const filters = [];

  let node = source;
  for (let i = 0; i < EQ_BANDS.length; i++) {
    const f = ctx.createBiquadFilter();
    f.type = "peaking";
    f.frequency.value = EQ_BANDS[i].freq;
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

export function isEqualizerActive() {
  return active != null;
}

/** Линейная громкость 0…1 на выходе цепочки (вместо HTMLMediaElement.volume). */
export function setEqualizerOutputGain(linear) {
  if (!active?.outputGain) return;
  const g = Number(linear);
  if (!Number.isFinite(g)) return;
  active.outputGain.gain.value = Math.min(1, Math.max(0, g));
}

export function setEqualizerGains(gainsDb) {
  if (!active?.filters?.length) return;
  for (let i = 0; i < active.filters.length; i++) {
    const v = gainsDb[i];
    active.filters[i].gain.value =
      typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
}

export function destroyEqualizer() {
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

/**
 * Returns the shared analyser after the EQ chain, or null when no graph is active.
 *
 * Returns:
 *     AnalyserNode or null.
 */
export function getVisualizerAnalyser() {
  return active?.analyser ?? null;
}

export async function resumeEqualizerContext() {
  const ctx = audioContext;
  if (ctx && ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }
}
