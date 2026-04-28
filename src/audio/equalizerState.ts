/**
 * Thin delegate on top of the unified {@link ./Equalizer.ts} singleton.
 * Reactive state + mutators are methods on the class; this module exposes
 * them with the legacy names used by the settings panel and main bootstrap.
 */

import { equalizer, presetGainsById } from "./Equalizer.js";

/** Усиление по полосам, dB */
export const eqBandsDb = equalizer.bandsDb;
/** id пресета или "custom" */
export const eqPresetId = equalizer.presetId;

export function applyEqPreset(id: string): void { equalizer.applyPreset(id); }
export function resetEqFlat(): void { equalizer.resetFlat(); }
export function setEqBand(index: number, db: number): void { equalizer.setBand(index, db); }

export { presetGainsById };
