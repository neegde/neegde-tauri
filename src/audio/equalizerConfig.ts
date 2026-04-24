/**
 * Thin re-export of equalizer config constants and pure helpers.
 * The single source of truth is {@link ./Equalizer.ts}; this module exists
 * so existing imports (settings panel, state module) keep resolving.
 */
export {
  EQ_BANDS,
  EQ_MIN_DB,
  EQ_MAX_DB,
  EQ_PRESETS,
  EQ_STORAGE_KEY,
  clampDb,
  defaultEqGains,
  parseStoredState,
  presetGainsById,
  type EqPreset,
  type StoredEqState,
} from "./Equalizer.js";
