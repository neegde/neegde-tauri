import { ref, watch } from "vue";
import {
  EQ_PRESETS, EQ_STORAGE_KEY, parseStoredState, defaultEqGains, clampDb,
} from "./equalizerConfig.js";
import { setEqualizerGains } from "./equalizerGraph.js";

function loadInitial(): { gains: number[]; presetId: string } {
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

const initial = loadInitial();

/** Усиление по полосам, dB */
export const eqBandsDb = ref<number[]>(initial.gains.map(clampDb));
/** id пресета или "custom" */
export const eqPresetId = ref<string>(initial.presetId);

function save(): void {
  try {
    localStorage.setItem(
      EQ_STORAGE_KEY,
      JSON.stringify({
        gains: eqBandsDb.value.map(clampDb),
        presetId: eqPresetId.value,
      }),
    );
  } catch {
    /* ignore */
  }
}

watch(
  [eqBandsDb, eqPresetId],
  () => {
    save();
    setEqualizerGains(eqBandsDb.value);
  },
  { deep: true },
);

export function presetGainsById(id: string): number[] | null {
  return EQ_PRESETS.find((p) => p.id === id)?.gains ?? null;
}

export function applyEqPreset(id: string): void {
  const g = presetGainsById(id);
  if (!g) return;
  eqPresetId.value = id;
  eqBandsDb.value = g.map(clampDb);
}

export function resetEqFlat(): void {
  applyEqPreset("flat");
}

export function setEqBand(index: number, db: number): void {
  const i = index | 0;
  if (i < 0 || i >= eqBandsDb.value.length) return;
  const next = eqBandsDb.value.slice();
  next[i] = clampDb(db);
  eqBandsDb.value = next;
  eqPresetId.value = "custom";
}
