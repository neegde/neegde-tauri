<script setup>
import { computed } from "vue";
import { EQ_BANDS, EQ_PRESETS, EQ_MIN_DB, EQ_MAX_DB } from "../../audio/equalizerConfig.js";
import {
  eqBandsDb,
  eqPresetId,
  applyEqPreset,
  resetEqFlat,
  setEqBand,
} from "../../audio/equalizerState.js";

const presetSelectValue = computed(() =>
  eqPresetId.value === "custom" ? "__custom__" : eqPresetId.value
);

function fmtDb(v) {
  if (!Number.isFinite(v)) return "0";
  const rounded = Math.round(v * 2) / 2;
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function onSliderInput(index, ev) {
  setEqBand(index, Number(ev.target.value));
}

function onPresetSelect(ev) {
  const v = ev.target.value;
  if (v === "__custom__") return;
  applyEqPreset(v);
}
</script>

<template src="./EqualizerPanel.html"></template>

<style scoped src="./EqualizerPanel.scoped.css"></style>

