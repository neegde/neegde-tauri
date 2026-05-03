/**
 * Equalizer — unified owner of the 10-band EQ.
 *
 * Three concerns live here under one roof:
 *   1. **Config** — band frequencies, preset gains, min/max dB, persistence key.
 *   2. **Reactive state** — `bandsDb` / `presetId` Refs consumed by the
 *      settings UI. Debounced localStorage persistence fires on change; the
 *      WebAudio graph (when connected) is kept in sync.
 *   3. **WebAudio graph** — BiquadFilter chain + output GainNode + Analyser.
 *      `ensure(audio, gains)` attaches to an `<audio>` element; `destroy()`
 *      tears the chain down. `setOutputGain(v)` replaces HTMLMediaElement
 *      volume (which is unreliable in WebView when a graph is attached).
 *
 * A default singleton is created below. Each legacy module (equalizerConfig /
 * equalizerState / equalizerGraph) re-exports its surface from here so the
 * 6 import sites don't need to change.
 */

import { ref, watch, type Ref } from "vue";

// ── Config ───────────────────────────────────────────────────────────────────

/** 10 полос (Гц), типичная сетка графического эквалайзера */
export const EQ_BANDS = [
  { freq: 32, label: "32" },
  { freq: 64, label: "64" },
  { freq: 125, label: "125" },
  { freq: 250, label: "250" },
  { freq: 500, label: "500" },
  { freq: 1000, label: "1k" },
  { freq: 2000, label: "2k" },
  { freq: 4000, label: "4k" },
  { freq: 8000, label: "8k" },
  { freq: 16000, label: "16k" },
] as const;

export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;

export interface EqPreset {
  id: string;
  name: string;
  hint: string;
  gains: number[];
}

export const EQ_PRESETS: EqPreset[] = [
  { id: "flat",       name: "Ровно",     hint: "Без изменений",                                   gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "bass",       name: "Бас",       hint: "Низ для электроники и хип-хопа",                  gains: [7, 5, 3, 1, 0, 0, 0, 0, 1, 2] },
  { id: "treble",     name: "Высокие",   hint: "Яркость и детали",                                gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { id: "rock",       name: "Рок",       hint: "Классическая V-форма",                            gains: [5, 4, 2, 0, -1, -1, 0, 2, 3, 4] },
  { id: "pop",        name: "Поп",       hint: "Середина и верх — «радио»",                       gains: [0, 2, 3, 4, 3, 1, 0, 2, 3, 3] },
  { id: "jazz",       name: "Джаз",      hint: "Тёплый низ, мягкий верх",                         gains: [4, 3, 2, 1, 0, -1, -1, 0, 2, 3] },
  { id: "classical",  name: "Классика",  hint: "Чуть воздуха наверху",                            gains: [0, 0, 0, 0, 0, 0, 0, 0, 2, 3] },
  { id: "electronic", name: "Электро",   hint: "Низ и верх, выемка в середине",                   gains: [6, 5, 3, 1, 0, 0, 2, 4, 5, 6] },
  { id: "vocal",      name: "Вокал",     hint: "Подчёркивание речи и пения",                      gains: [-1, -1, -2, -1, 2, 5, 4, 2, 0, -1] },
  { id: "acoustic",   name: "Акустика",  hint: "Сбалансировано для гитары и живого звука",        gains: [2, 3, 2, 1, 0, 1, 2, 3, 3, 2] },
];

export const EQ_STORAGE_KEY = "neegdeEqualizerV1";

export function clampDb(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, n));
}

export interface StoredEqState {
  gains: number[];
  presetId: string;
}

export function parseStoredState(raw: string | null | undefined): StoredEqState | null {
  try {
    if (raw == null) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    const gains = o.gains ?? o.bands;
    if (!Array.isArray(gains) || gains.length !== EQ_BANDS.length) return null;
    const bands = gains.map((g: unknown) => clampDb(g));
    let presetId = typeof o.presetId === "string" ? o.presetId : "flat";
    if (presetId !== "custom" && !EQ_PRESETS.some((p) => p.id === presetId)) {
      presetId = "flat";
    }
    return { gains: bands, presetId };
  } catch {
    return null;
  }
}

export function defaultEqGains(): number[] {
  return EQ_PRESETS[0]!.gains.slice();
}

export function presetGainsById(id: string): number[] | null {
  return EQ_PRESETS.find((p) => p.id === id)?.gains ?? null;
}

// ── Graph handle ─────────────────────────────────────────────────────────────

const VIS_FFT_SIZE = 2048;

interface EqualizerHandle {
  audio: HTMLMediaElement;
  source: MediaElementAudioSourceNode;
  filters: BiquadFilterNode[];
  ctx: AudioContext;
  outputGain: GainNode;
  analyser: AnalyserNode;
}

// ── Class ────────────────────────────────────────────────────────────────────

export class Equalizer {
  readonly bandsDb: Ref<number[]>;
  readonly presetId: Ref<string>;

  private _audioContext: AudioContext | null = null;
  private _active: EqualizerHandle | null = null;

  constructor() {
    const initial = this._loadInitial();
    this.bandsDb = ref<number[]>(initial.gains.map(clampDb));
    this.presetId = ref<string>(initial.presetId);

    watch(
      [this.bandsDb, this.presetId],
      () => {
        this._save();
        this.setGains(this.bandsDb.value);
      },
      { deep: true },
    );
  }

  // ── Reactive state mutators ────────────────────────────────────────────────

  applyPreset(id: string): void {
    const g = presetGainsById(id);
    if (!g) return;
    this.presetId.value = id;
    this.bandsDb.value = g.map(clampDb);
  }

  resetFlat(): void {
    this.applyPreset("flat");
  }

  setBand(index: number, db: number): void {
    const i = index | 0;
    if (i < 0 || i >= this.bandsDb.value.length) return;
    const next = this.bandsDb.value.slice();
    next[i] = clampDb(db);
    this.bandsDb.value = next;
    this.presetId.value = "custom";
  }

  // ── Graph lifecycle ────────────────────────────────────────────────────────

  getAudioContext(): AudioContext | null {
    return this._audioContext;
  }

  isActive(): boolean {
    return this._active != null;
  }

  getAnalyser(): AnalyserNode | null {
    return this._active?.analyser ?? null;
  }

  /**
   * Подключает цепочку peaking-фильтров к элементу (один раз на элемент).
   * Громкость выводится через GainNode: в WebView volume у media-элемента
   * часто не влияет на граф.
   */
  ensure(audio: HTMLMediaElement | null, gainsDb: number[]): EqualizerHandle | null {
    if (!audio) {
      this.destroy();
      return null;
    }

    if (this._active?.audio === audio) {
      this.setGains(gainsDb);
      return this._active;
    }

    this.destroy();

    const ctx = this._getOrCreateContext();
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

    this._active = { audio, source, filters, ctx, outputGain, analyser };
    return this._active;
  }

  /** Линейная громкость 0…1 на выходе цепочки (вместо HTMLMediaElement.volume). */
  setOutputGain(linear: number): void {
    if (!this._active?.outputGain) return;
    const g = Number(linear);
    if (!Number.isFinite(g)) return;
    this._active.outputGain.gain.value = Math.min(1, Math.max(0, g));
  }

  setGains(gainsDb: number[]): void {
    if (!this._active?.filters?.length) return;
    for (let i = 0; i < this._active.filters.length; i++) {
      const v = gainsDb[i];
      this._active.filters[i]!.gain.value =
        typeof v === "number" && Number.isFinite(v) ? v : 0;
    }
  }

  destroy(): void {
    if (!this._active) return;
    try {
      this._active.source.disconnect();
      for (const f of this._active.filters) f.disconnect();
      this._active.outputGain?.disconnect();
      this._active.analyser?.disconnect();
    } catch {
      /* элемент уже уничтожен */
    }
    this._active = null;
  }

  async resumeContext(): Promise<void> {
    const ctx = this._audioContext;
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _getOrCreateContext(): AudioContext {
    if (!this._audioContext) {
      this._audioContext = new AudioContext({ latencyHint: "playback" });
    }
    return this._audioContext;
  }

  private _loadInitial(): StoredEqState {
    try {
      const raw = localStorage.getItem(EQ_STORAGE_KEY);
      if (raw) {
        const p = parseStoredState(raw);
        if (p) return p;
      }
    } catch {
      /* ignore */
    }
    return { gains: defaultEqGains(), presetId: "flat" };
  }

  private _save(): void {
    try {
      localStorage.setItem(
        EQ_STORAGE_KEY,
        JSON.stringify({
          gains: this.bandsDb.value.map(clampDb),
          presetId: this.presetId.value,
        }),
      );
    } catch {
      /* ignore */
    }
  }
}

// ── Default singleton ────────────────────────────────────────────────────────

export const equalizer = new Equalizer();
