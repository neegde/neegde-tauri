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

<template>
  <div class="eq-panel">
    <p class="eq-intro">
      Настройка тембра для воспроизведения. Работает сразу для текущего трека;
      настройки сохраняются на этом устройстве.
    </p>

    <div class="eq-toolbar">
      <div class="eq-preset-field">
        <label class="eq-preset-label" for="eq-preset-select">Пресет</label>
        <select
          id="eq-preset-select"
          class="login-input eq-preset-select"
          :value="presetSelectValue"
          aria-label="Пресет эквалайзера"
          @change="onPresetSelect($event)"
        >
          <option v-for="p in EQ_PRESETS" :key="p.id" :value="p.id" :title="p.hint">
            {{ p.name }}
          </option>
          <option value="__custom__">Свой профиль</option>
        </select>
      </div>
      <button
        type="button"
        class="eq-reset"
        @click="resetEqFlat"
      >
        Сбросить
      </button>
    </div>

    <div class="eq-sliders" role="group" aria-label="Полосы эквалайзера">
      <div
        v-for="(b, i) in EQ_BANDS"
        :key="b.freq"
        class="eq-col"
      >
        <span class="eq-db" :class="{ 'eq-db--pos': eqBandsDb[i] > 0, 'eq-db--neg': eqBandsDb[i] < 0 }">
          {{ fmtDb(eqBandsDb[i]) }}
        </span>
        <div class="eq-slider-wrap">
          <input
            :id="`eq-band-${i}`"
            type="range"
            class="eq-slider"
            :min="EQ_MIN_DB"
            :max="EQ_MAX_DB"
            step="0.5"
            :value="eqBandsDb[i]"
            :aria-label="`Усиление ${b.label} Гц`"
            @input="onSliderInput(i, $event)"
          />
        </div>
        <label class="eq-hz" :for="`eq-band-${i}`">{{ b.label }}</label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.eq-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.eq-intro {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--muted);
}

.eq-toolbar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: end;
}

.eq-preset-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.eq-preset-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.eq-preset-select {
  width: 100%;
  margin: 0;
  cursor: pointer;
}

.eq-reset {
  font-size: 12px;
  font-weight: 600;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
  white-space: nowrap;
  align-self: end;
}
.eq-reset:hover {
  color: var(--text);
  border-color: var(--muted);
  background: rgba(255, 255, 255, 0.05);
}

.eq-sliders {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 4px;
  padding: 8px 4px 4px;
  border-radius: 12px;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.04) 0%,
    rgba(0, 0, 0, 0.12) 100%
  );
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.eq-col {
  flex: 1 0 44px;
  min-width: 38px;
  max-width: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.eq-db {
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--muted2, #888);
  min-height: 14px;
}
.eq-db--pos { color: var(--accent); }
.eq-db--neg { color: #6eb5ff; }

.eq-slider-wrap {
  height: 132px;
  width: 100%;
  max-width: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.eq-slider-wrap::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 8px;
  bottom: 8px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: rgba(255, 255, 255, 0.1);
  pointer-events: none;
}

.eq-slider {
  width: 118px;
  height: 6px;
  transform: rotate(-90deg);
  transform-origin: center center;
  cursor: pointer;
  accent-color: var(--accent);
  background: transparent;
}
.eq-slider::-webkit-slider-runnable-track {
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.12);
}
.eq-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
  margin-top: -4.5px;
  border: 2px solid rgba(255, 255, 255, 0.95);
}
.eq-slider::-moz-range-track {
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.12);
}
.eq-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid rgba(255, 255, 255, 0.95);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45);
}

.eq-hz {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--muted);
  cursor: default;
}

[data-theme="light"] .eq-slider::-webkit-slider-runnable-track {
  background: rgba(0, 0, 0, 0.12);
}
[data-theme="light"] .eq-slider::-moz-range-track {
  background: rgba(0, 0, 0, 0.12);
}
[data-theme="light"] .eq-slider-wrap::before {
  background: rgba(0, 0, 0, 0.08);
}
</style>
